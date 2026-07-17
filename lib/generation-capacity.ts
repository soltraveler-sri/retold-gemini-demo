import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const VISITOR_COOKIE = "retold_visitor";
const UNLOCK_COOKIE = "retold_demo_unlock";
const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const UNLOCK_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;
const REDIS_TIMEOUT_MS = 3_000;

const RESERVE_CAPACITY_SCRIPT = `
local global_count = tonumber(redis.call("GET", KEYS[1]) or "0")
local ip_count = tonumber(redis.call("GET", KEYS[2]) or "0")
local visitor_count = tonumber(redis.call("GET", KEYS[3]) or "0")
local global_cap = tonumber(ARGV[1])
local visitor_cap = tonumber(ARGV[2])
local ttl_seconds = tonumber(ARGV[3])

if global_count >= global_cap then
  return "global-cap-reached"
end

if ip_count >= visitor_cap or visitor_count >= visitor_cap then
  return "visitor-cap-reached"
end

for _, key in ipairs(KEYS) do
  local count = redis.call("INCR", key)
  if count == 1 then
    redis.call("EXPIRE", key, ttl_seconds)
  end
end

return "allowed"
`;

type Environment = Readonly<Record<string, string | undefined>>;

export type CapacityReservationResult =
  | "allowed"
  | "global-cap-reached"
  | "visitor-cap-reached";

export interface CapacityReservation {
  globalKey: string;
  ipKey: string;
  visitorKey: string;
  globalCap: number;
  visitorCap: number;
  ttlSeconds: number;
}

export interface CapacityRedis {
  reserve(input: CapacityReservation): Promise<CapacityReservationResult>;
}

export type GenerationCapacityDecision =
  | { allowed: true; setCookies: readonly string[] }
  | { allowed: false; message: string; setCookies: readonly string[] };

export interface GenerationCapacityOptions {
  request: Request;
  resource: string;
  resourceLabel: string;
  dailyCapEnvironmentVariable: string;
  visitorCapEnvironmentVariable: string;
  defaultDailyCap: number;
  defaultVisitorCap: number;
  realGeneration: boolean;
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

function configuredUnlock(environment: Environment): string | null {
  const unlock = environment.DEMO_UNLOCK;
  return unlock && unlock.trim().length > 0 ? unlock : null;
}

export function issueDemoUnlockCookie(
  attemptedPassphrase: string,
  request: Request,
  environment: Environment = process.env,
  now: Date = new Date(),
): string | null {
  const unlock = configuredUnlock(environment);
  if (!unlock || !constantTimeTextEqual(attemptedPassphrase, unlock)) {
    return null;
  }

  const expiresAt =
    Math.floor(now.getTime() / 1_000) + UNLOCK_COOKIE_MAX_AGE_SECONDS;
  const payload = `v1.${expiresAt}`;
  const value = `${payload}.${sign(unlock, "demo-unlock", payload)}`;
  return serializeCookie(
    UNLOCK_COOKIE,
    value,
    UNLOCK_COOKIE_MAX_AGE_SECONDS,
    request,
  );
}

function hasValidUnlockCookie(
  request: Request,
  environment: Environment,
  now: Date,
): boolean {
  const unlock = configuredUnlock(environment);
  const value = parseCookies(request).get(UNLOCK_COOKIE);
  if (!unlock || !value) return false;

  const [version, expiresText, signature, ...extra] = value.split(".");
  if (
    version !== "v1" ||
    !expiresText ||
    !signature ||
    extra.length > 0 ||
    !/^\d+$/.test(expiresText)
  ) {
    return false;
  }

  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime() / 1_000) {
    return false;
  }

  const payload = `${version}.${expiresText}`;
  return constantTimeTextEqual(
    signature,
    sign(unlock, "demo-unlock", payload),
  );
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
    value === "visitor-cap-reached"
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
          3,
          input.globalKey,
          input.ipKey,
          input.visitorKey,
          input.globalCap,
          input.visitorCap,
          input.ttlSeconds,
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

function queryUnlockCookie(
  request: Request,
  environment: Environment,
  now: Date,
): string | null {
  const attemptedPassphrase = new URL(request.url).searchParams.get("key");
  return attemptedPassphrase === null
    ? null
    : issueDemoUnlockCookie(
        attemptedPassphrase,
        request,
        environment,
        now,
      );
}

export async function checkGenerationCapacity(
  options: GenerationCapacityOptions,
): Promise<GenerationCapacityDecision> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? new Date();
  const unlockCookie = queryUnlockCookie(options.request, environment, now);

  if (unlockCookie) return { allowed: true, setCookies: [unlockCookie] };
  if (hasValidUnlockCookie(options.request, environment, now)) {
    return { allowed: true, setCookies: [] };
  }
  if (!options.realGeneration) return { allowed: true, setCookies: [] };

  const dailyCap = parseCap(
    environment[options.dailyCapEnvironmentVariable],
    options.defaultDailyCap,
  );
  const visitorCap = parseCap(
    environment[options.visitorCapEnvironmentVariable],
    options.defaultVisitorCap,
  );
  const url = environment.UPSTASH_REDIS_REST_URL?.trim();
  const token = environment.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (dailyCap === null || visitorCap === null || !url || !token) {
    return {
      allowed: false,
      message: `Live ${options.resourceLabel} generation is temporarily unavailable. Showcase content is still available.`,
      setCookies: [],
    };
  }

  const identity = visitorIdentity(
    options.request,
    token,
    options.randomVisitorId ?? (() => randomBytes(18).toString("base64url")),
  );
  const date = now.toISOString().slice(0, 10);
  const namespace = `retold:capacity:${options.resource}:${date}`;
  const redis = options.redis ?? createUpstashCapacityRedis(url, token);

  let result: CapacityReservationResult;
  try {
    result = await redis.reserve({
      globalKey: `${namespace}:global`,
      ipKey: `${namespace}:ip:${privateDigest(token, "ip", requestIp(options.request))}`,
      visitorKey: `${namespace}:visitor:${privateDigest(token, "visitor-id", identity.id)}`,
      globalCap: dailyCap,
      visitorCap,
      ttlSeconds: secondsUntilCounterExpiry(now),
    });
  } catch {
    console.error(
      `[capacity] Redis unavailable or misconfigured; refusing real ${options.resourceLabel} generation.`,
    );
    return {
      allowed: false,
      message: `Live ${options.resourceLabel} generation is temporarily unavailable. Showcase content is still available.`,
      setCookies: identity.setCookie ? [identity.setCookie] : [],
    };
  }

  const setCookies = identity.setCookie ? [identity.setCookie] : [];
  if (result === "global-cap-reached") {
    return {
      allowed: false,
      message: `Today's live ${options.resourceLabel} limit has been reached. Showcase content is still available.`,
      setCookies,
    };
  }
  if (result === "visitor-cap-reached") {
    return {
      allowed: false,
      message: `You've reached today's live ${options.resourceLabel} limit. Showcase content is still available.`,
      setCookies,
    };
  }
  return { allowed: true, setCookies };
}
