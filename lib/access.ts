import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Identity and spend budgets for the demo's paid features.
 *
 * The demo is public and generates on a paid model, so "who is spending" has to
 * be a real question with a real answer. Three tiers:
 *
 *   anonymous — sees the entire demo and every showcase film, spends nothing
 *   guest     — invited by email, a one-time budget across film + scene
 *   admin     — the maintainer, a per-month budget
 *
 * Budgets are denominated in cents against measured costs, not request counts:
 * the constraint being expressed is dollars.
 */

type Environment = Readonly<Record<string, string | undefined>>;

export type Tier = "admin" | "guest";

export interface Identity {
  readonly email: string;
  readonly tier: Tier;
}

export type AccessDenial =
  | "auth-required"
  | "budget-exhausted"
  | "misconfigured";

export const SESSION_COOKIE = "retold_access";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Measured costs. $0.10/sec × 10s of 720p video; ~$0.15 × 6 scene images. */
export const FILM_COST_CENTS = 100;
export const SCENE_COST_CENTS = 90;

const DEFAULT_ADMIN_MONTHLY_CENTS = 100_00;
const DEFAULT_GUEST_LIFETIME_CENTS = 15_00;
const DEFAULT_CONTACT_EMAIL = "hvmerk.work@gmail.com";

export function contactEmail(environment: Environment = process.env): string {
  return environment.CONTACT_EMAIL?.trim() || DEFAULT_CONTACT_EMAIL;
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function emailList(raw: string | undefined): readonly string[] {
  return (raw ?? "")
    .split(",")
    .map(normalizeEmail)
    .filter((entry) => entry.length > 0);
}

/**
 * Tier is ALWAYS derived from the environment allowlist, never read from the
 * session cookie. That is what makes the Vercel env var a live control surface:
 * removing an address revokes it on the very next request, even though the
 * visitor still holds a validly-signed cookie.
 */
export function resolveTier(
  email: string,
  environment: Environment = process.env,
): Tier | null {
  const normalized = normalizeEmail(email);
  if (emailList(environment.ADMIN_EMAILS).includes(normalized)) return "admin";
  if (emailList(environment.GUEST_EMAILS).includes(normalized)) return "guest";
  return null;
}

/**
 * Each tier has its own code. The maintainer's address is deliberately public
 * (it is in the contact nudge), so a single shared code would let any guest sign
 * in as the admin and claim the admin budget.
 */
function accessCodeFor(tier: Tier, environment: Environment): string | null {
  const raw =
    tier === "admin"
      ? environment.ADMIN_ACCESS_CODE
      : environment.GUEST_ACCESS_CODE;
  const code = raw?.trim();
  return code ? code : null;
}

function constantTimeEquals(left: string, right: string): boolean {
  // Compare fixed-length digests so length never leaks through timing.
  const a = createHmac("sha256", "cmp").update(left).digest();
  const b = createHmac("sha256", "cmp").update(right).digest();
  return timingSafeEqual(a, b);
}

function authSecret(environment: Environment): string | null {
  const secret = environment.AUTH_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : null;
}

export function hashEmail(email: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`email:${normalizeEmail(email)}`)
    .digest("base64url")
    .slice(0, 32);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Cookie carries only the email + expiry. Tier is re-derived on every read. */
export function issueSessionCookie(
  email: string,
  environment: Environment = process.env,
  now: Date = new Date(),
): string | null {
  const secret = authSecret(environment);
  if (!secret) return null;

  const expiresAt = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(
    JSON.stringify({ e: normalizeEmail(email), x: expiresAt }),
    "utf8",
  ).toString("base64url");
  const value = `${payload}.${sign(payload, secret)}`;
  const secure = environment.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * Returns the signed-in identity, or null. A cookie proves only which address
 * signed in; the tier attached to it is looked up fresh every time.
 */
export function readIdentity(
  request: Request,
  environment: Environment = process.env,
  now: Date = new Date(),
): Identity | null {
  const secret = authSecret(environment);
  if (!secret) return null;

  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;

  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return null;
  if (!constantTimeEquals(signature, sign(payload, secret))) return null;

  let parsed: { e?: unknown; x?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const email = typeof parsed.e === "string" ? parsed.e : null;
  const expiresAt = typeof parsed.x === "number" ? parsed.x : 0;
  if (!email || expiresAt * 1000 <= now.getTime()) return null;

  const tier = resolveTier(email, environment);
  if (!tier) return null; // revoked since the cookie was issued

  return { email: normalizeEmail(email), tier };
}

export interface SignInResult {
  readonly ok: boolean;
  readonly cookie?: string;
  readonly identity?: Identity;
}

/**
 * Verifies an address against its tier's code. Callers must not reveal which of
 * the two failed — that would let anyone enumerate the allowlist.
 */
export function signIn(
  email: string,
  code: string,
  environment: Environment = process.env,
  now: Date = new Date(),
): SignInResult {
  if (!authSecret(environment)) return { ok: false };

  const tier = resolveTier(email, environment);
  if (!tier) return { ok: false };

  const expected = accessCodeFor(tier, environment);
  if (!expected) return { ok: false };
  if (!constantTimeEquals(code.trim(), expected)) return { ok: false };

  const cookie = issueSessionCookie(email, environment, now);
  if (!cookie) return { ok: false };
  return { ok: true, cookie, identity: { email: normalizeEmail(email), tier } };
}

export function budgetLimitCents(
  tier: Tier,
  environment: Environment = process.env,
): number {
  const raw =
    tier === "admin"
      ? environment.ADMIN_MONTHLY_BUDGET_USD
      : environment.GUEST_LIFETIME_BUDGET_USD;
  const parsed = Number.parseFloat(raw ?? "");
  if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed * 100);
  return tier === "admin"
    ? DEFAULT_ADMIN_MONTHLY_CENTS
    : DEFAULT_GUEST_LIFETIME_CENTS;
}

/**
 * Admin budgets reset each calendar month (UTC); guest budgets are one-time and
 * never expire, so the key carries no period and no TTL.
 */
export function budgetKey(identity: Identity, secret: string, now: Date): string {
  const id = hashEmail(identity.email, secret);
  if (identity.tier === "admin") {
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    return `retold:budget:admin:${id}:${period}`;
  }
  return `retold:budget:guest:${id}`;
}

/** Admin keys expire after the month they cover; guest keys are permanent. */
export function budgetTtlSeconds(tier: Tier): number {
  return tier === "admin" ? 40 * 24 * 60 * 60 : 0;
}

export interface AccessConfigStatus {
  readonly configured: boolean;
  readonly reason?: string;
}

/**
 * Real spend requires a real signing secret. Without it, sessions cannot be
 * trusted, so we refuse rather than degrade to an unauthenticated free-for-all.
 */
export function accessConfigStatus(
  environment: Environment = process.env,
): AccessConfigStatus {
  if (!authSecret(environment)) {
    return {
      configured: false,
      reason: "AUTH_SECRET is missing or too short (needs 16+ characters).",
    };
  }
  return { configured: true };
}

export function authSecretOrNull(
  environment: Environment = process.env,
): string | null {
  return authSecret(environment);
}
