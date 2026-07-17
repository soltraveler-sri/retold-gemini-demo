import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  accessConfigStatus,
  authSecretOrNull,
  budgetKey,
  budgetLimitCents,
  budgetTtlSeconds,
  issueSessionCookie,
  readIdentity,
  redisCredentials,
  type AccessDenial,
  type Identity,
} from "./access";

const VISITOR_COOKIE = "retold_visitor";
const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const REDIS_TIMEOUT_MS = 3_000;

/**
 * Global circuit breaker and the signed-in identity's budget are checked and
 * incremented in one script. Splitting them across two round-trips would let a
 * budget be charged for a generation the global cap then refuses, and would let
 * concurrent requests race past either limit.
 *
 * KEYS: 1 global day counter, 2 identity budget (cents)
 * ARGV: 1 global cap, 2 global TTL, 3 cost, 4 budget limit, 5 budget TTL (0 = never)
 */
const RESERVE_CAPACITY_SCRIPT = `
local global_count = tonumber(redis.call("GET", KEYS[1]) or "0")
if global_count >= tonumber(ARGV[1]) then
  return "global-cap-reached"
end

local spent = tonumber(redis.call("GET", KEYS[2]) or "0")
local cost = tonumber(ARGV[3])
if spent + cost > tonumber(ARGV[4]) then
  return "budget-exhausted"
end

local next_global = redis.call("INCR", KEYS[1])
if next_global == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
end

redis.call("INCRBY", KEYS[2], cost)
local budget_ttl = tonumber(ARGV[5])
if budget_ttl > 0 and redis.call("TTL", KEYS[2]) < 0 then
  redis.call("EXPIRE", KEYS[2], budget_ttl)
end

return "allowed"
`;

type Environment = Readonly<Record<string, string | undefined>>;

export type CapacityReservationResult =
  | "allowed"
  | "global-cap-reached"
  | "budget-exhausted";

export interface CapacityReservation {
  globalKey: string;
  budgetKey: string;
  globalCap: number;
  globalTtlSeconds: number;
  costCents: number;
  budgetLimitCents: number;
  budgetTtlSeconds: number;
}

export interface CapacityRedis {
  reserve(input: CapacityReservation): Promise<CapacityReservationResult>;
}

export type GenerationCapacityDecision =
  | { allowed: true; setCookies: readonly string[] }
  | {
      allowed: false;
      denial: AccessDenial | "global-cap-reached";
      message: string;
      setCookies: readonly string[];
    };

export interface GenerationCapacityOptions {
  request: Request;
  resource: string;
  resourceLabel: string;
  dailyCapEnvironmentVariable: string;
  visitorCapEnvironmentVariable: string;
  defaultDailyCap: number;
  defaultVisitorCap: number;
  realGeneration: boolean;
  /** Measured cost of this generation, charged to the signed-in identity. */
  costCents: number;
  environment?: Environment;
  redis?: CapacityRedis;
  now?: Date;
  randomVisitorId?: () => string;
}

interface UpstashResponse {
  result?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function sign(secret: string, purpose: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(`${purpose}\0${payload}`)
    .digest("base64url");
}

function secureCookieAttribute(request: Request): string {
  return new URL(request.url).protocol === "https:" ? "; Secure" : "";
}

function serializeCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  request: Request,
): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureCookieAttribute(request)}`;
}

function parseCookies(request: Request): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

function validVisitorId(cookie: string | undefined, secret: string): string | null {
  if (!cookie) return null;
  const [version, visitorId, signature, ...extra] = cookie.split(".");
  if (
    version !== "v1" ||
    !visitorId ||
    !signature ||
    extra.length > 0 ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(visitorId)
  ) {
    return null;
  }

  const payload = `${version}.${visitorId}`;
  return constantTimeTextEqual(
    signature,
    sign(secret, "visitor", payload),
  )
    ? visitorId
    : null;
}

function visitorIdentity(
  request: Request,
  secret: string,
  randomVisitorId: () => string,
): { id: string; setCookie: string | null } {
  const existing = validVisitorId(
    parseCookies(request).get(VISITOR_COOKIE),
    secret,
  );
  if (existing) return { id: existing, setCookie: null };

  const id = randomVisitorId();
  const payload = `v1.${id}`;
  const value = `${payload}.${sign(secret, "visitor", payload)}`;
  return {
    id,
    setCookie: serializeCookie(
      VISITOR_COOKIE,
      value,
      VISITOR_COOKIE_MAX_AGE_SECONDS,
      request,
    ),
  };
}

function requestIp(request: Request): string {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "unknown";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

function privateDigest(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secret)
    .update(`${purpose}\0${value}`)
    .digest("hex");
}

function parseCap(value: string | undefined, fallback: number): number | null {
  const candidate = value?.trim();
  if (!candidate) return fallback;
  if (!/^\d+$/.test(candidate)) return null;
  const cap = Number(candidate);
  return Number.isSafeInteger(cap) ? cap : null;
}

function secondsUntilCounterExpiry(now: Date): number {
  const nextDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((nextDay - now.getTime()) / 1_000) + 3_600);
}

function isCapacityReservationResult(
  value: unknown,
): value is CapacityReservationResult {
  return (
    value === "allowed" ||
    value === "global-cap-reached" ||
    value === "budget-exhausted"
  );
}

export function createUpstashCapacityRedis(
  url: string,
  token: string,
  fetchImplementation: typeof fetch = fetch,
): CapacityRedis {
  return {
    async reserve(input) {
      const response = await fetchImplementation(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          "EVAL",
          RESERVE_CAPACITY_SCRIPT,
          2,
          input.globalKey,
          input.budgetKey,
          input.globalCap,
          input.globalTtlSeconds,
          input.costCents,
          input.budgetLimitCents,
          input.budgetTtlSeconds,
        ]),
        cache: "no-store",
        signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Upstash returned HTTP ${response.status}.`);
      }

      const value: unknown = await response.json();
      if (!isRecord(value)) throw new Error("Upstash returned invalid JSON.");
      const payload: UpstashResponse = value;
      if (typeof payload.error === "string") {
        throw new Error("Upstash rejected the capacity reservation.");
      }
      if (!isCapacityReservationResult(payload.result)) {
        throw new Error("Upstash returned an invalid reservation result.");
      }
      return payload.result;
    },
  };
}

export async function checkGenerationCapacity(
  options: GenerationCapacityOptions,
): Promise<GenerationCapacityDecision> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? new Date();

  // Mock generation touches no paid service, so it needs no identity and no
  // Redis. Anonymous visitors must keep the full demo, including showcase.
  if (!options.realGeneration) return { allowed: true, setCookies: [] };

  // DEMO_UNLOCK no longer bypasses budgets: it mints an admin-tier session that
  // is metered like any other. A live presentation still works; an unbounded
  // spend path does not exist.
  const setCookies: string[] = [];
  const unlocked = unlockAdminSession(options.request, environment, now);
  if (unlocked?.cookie) setCookies.push(unlocked.cookie);

  const identity =
    unlocked?.identity ?? readIdentity(options.request, environment, now);
  if (!identity) {
    return {
      allowed: false,
      denial: "auth-required",
      message: `Live ${options.resourceLabel} generation runs on a paid model and is available by invitation. Showcase films and the walkthrough are free.`,
      setCookies,
    };
  }

  const config = accessConfigStatus(environment);
  const secret = authSecretOrNull(environment);
  const dailyCap = parseCap(
    environment[options.dailyCapEnvironmentVariable],
    options.defaultDailyCap,
  );
  const redis_ = redisCredentials(environment);
  const url = redis_?.url;
  const token = redis_?.token;

  // Fail closed: a misconfigured demo must never mean unmetered spend.
  if (!config.configured || !secret || dailyCap === null || !url || !token) {
    console.error(
      `[capacity] Refusing real ${options.resourceLabel} generation: ${config.reason ?? "cap or Redis configuration is missing"}.`,
    );
    return {
      allowed: false,
      denial: "misconfigured",
      message: `Live ${options.resourceLabel} generation is temporarily unavailable. Showcase content is still available.`,
      setCookies,
    };
  }

  const date = now.toISOString().slice(0, 10);
  const redis = options.redis ?? createUpstashCapacityRedis(url, token);

  let result: CapacityReservationResult;
  try {
    result = await redis.reserve({
      globalKey: `retold:capacity:${options.resource}:${date}:global`,
      budgetKey: budgetKey(identity, secret, now),
      globalCap: dailyCap,
      globalTtlSeconds: secondsUntilCounterExpiry(now),
      costCents: options.costCents,
      budgetLimitCents: budgetLimitCents(identity.tier, environment),
      budgetTtlSeconds: budgetTtlSeconds(identity.tier),
    });
  } catch {
    console.error(
      `[capacity] Redis unavailable or misconfigured; refusing real ${options.resourceLabel} generation.`,
    );
    return {
      allowed: false,
      denial: "misconfigured",
      message: `Live ${options.resourceLabel} generation is temporarily unavailable. Showcase content is still available.`,
      setCookies,
    };
  }

  if (result === "global-cap-reached") {
    return {
      allowed: false,
      denial: "global-cap-reached",
      message: `Today's live ${options.resourceLabel} limit has been reached. Showcase content is still available.`,
      setCookies,
    };
  }
  if (result === "budget-exhausted") {
    return {
      allowed: false,
      denial: "budget-exhausted",
      message:
        identity.tier === "guest"
          ? "You've used your full demo credit. Showcase films and the walkthrough are still available."
          : "This month's generation budget is used up. Showcase content is still available.",
      setCookies,
    };
  }
  return { allowed: true, setCookies };
}

/**
 * DEMO_UNLOCK (`?key=`) signs the visitor in as the first configured admin,
 * so presentation access is metered against the admin budget like any other.
 */
function unlockAdminSession(
  request: Request,
  environment: Environment,
  now: Date,
): { identity: Identity; cookie: string } | null {
  const configured = environment.DEMO_UNLOCK?.trim();
  if (!configured) return null;

  const supplied = new URL(request.url).searchParams.get("key");
  if (!supplied) return null;

  const adminEmail = (environment.ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .find((entry) => entry.length > 0);
  if (!adminEmail) return null;

  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const configuredDigest = createHash("sha256").update(configured).digest();
  if (!timingSafeEqual(suppliedDigest, configuredDigest)) return null;

  const cookie = issueSessionCookie(adminEmail, environment, now);
  if (!cookie) return null;
  return { identity: { email: adminEmail, tier: "admin" }, cookie };
}
