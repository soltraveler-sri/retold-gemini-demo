import {
  clearSessionCookie,
  contactEmail,
  readIdentity,
  redisCredentials,
  signIn,
} from "../../../lib/access";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024;
const SIGN_IN_WINDOW_SECONDS = 15 * 60;
const SIGN_IN_MAX_ATTEMPTS = 10;

/**
 * Sign-in attempts are rate limited per IP so the shared access code cannot be
 * brute forced. Redis is the source of truth when configured; without it we
 * refuse rather than allow unlimited guesses.
 */
type ThrottleResult = "ok" | "rate-limited" | "unavailable";

async function throttleSignIn(request: Request): Promise<ThrottleResult> {
  // No Redis means no way to bound guesses at the access code, and no way to
  // meter spend either — so refuse. Report it as unavailable rather than
  // pretending the visitor did something wrong.
  const credentials = redisCredentials();
  if (!credentials) return "unavailable";
  const { url, token } = credentials;

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const key = `retold:signin:${Buffer.from(ip).toString("base64url")}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        "EVAL",
        `local n = redis.call("INCR", KEYS[1])
         if n == 1 then redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1])) end
         return n`,
        1,
        key,
        SIGN_IN_WINDOW_SECONDS,
      ]),
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return "unavailable";
    const body = (await response.json()) as { result?: unknown };
    return Number(body.result ?? 0) > SIGN_IN_MAX_ATTEMPTS ? "rate-limited" : "ok";
  } catch {
    return "unavailable";
  }
}

export async function GET(request: Request): Promise<Response> {
  const identity = readIdentity(request);
  return Response.json({
    signedIn: Boolean(identity),
    email: identity?.email ?? null,
    tier: identity?.tier ?? null,
    contactEmail: contactEmail(),
  });
}

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json(
      { error: { code: "invalid-input", message: "Request is too large." } },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return Response.json(
      { error: { code: "invalid-input", message: "Invalid request." } },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null) {
    return Response.json(
      { error: { code: "invalid-input", message: "Invalid request." } },
      { status: 400 },
    );
  }

  const record = body as Record<string, unknown>;

  if (record.action === "sign-out") {
    return new Response(JSON.stringify({ signedIn: false }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": clearSessionCookie(),
      },
    });
  }

  const keys = Object.keys(record).sort().join(",");
  if (keys !== "code,email") {
    return Response.json(
      {
        error: {
          code: "invalid-input",
          message: "Request body must contain only email and code.",
        },
      },
      { status: 400 },
    );
  }

  const email = typeof record.email === "string" ? record.email : "";
  const code = typeof record.code === "string" ? record.code : "";
  if (email.length > 254 || code.length > 200) {
    return Response.json(
      { error: { code: "invalid-input", message: "Invalid request." } },
      { status: 400 },
    );
  }

  const throttle = await throttleSignIn(request);
  if (throttle === "rate-limited") {
    return Response.json(
      {
        error: {
          code: "rate-limited",
          message: "Too many attempts. Try again in a few minutes.",
        },
      },
      { status: 429 },
    );
  }
  if (throttle === "unavailable") {
    console.error("[access] Sign-in refused: Redis is unreachable or unconfigured.");
    return Response.json(
      {
        error: {
          code: "unavailable",
          message: "Sign-in is temporarily unavailable. Please try again shortly.",
        },
      },
      { status: 503 },
    );
  }

  const result = signIn(email, code);
  if (!result.ok || !result.cookie || !result.identity) {
    // Deliberately identical whether the address is unknown or the code is
    // wrong — otherwise this endpoint enumerates the allowlist.
    return Response.json(
      {
        error: {
          code: "invalid-credentials",
          message: "That email and code combination isn't recognised.",
        },
      },
      { status: 401 },
    );
  }

  return new Response(
    JSON.stringify({
      signedIn: true,
      email: result.identity.email,
      tier: result.identity.tier,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": result.cookie,
      },
    },
  );
}
