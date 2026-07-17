import assert from "node:assert/strict";
import { test } from "node:test";

import {
  budgetKey,
  budgetLimitCents,
  budgetTtlSeconds,
  issueSessionCookie,
  readIdentity,
  resolveTier,
  redisCredentials,
  signIn,
  SESSION_COOKIE,
} from "./access";

const ENV = {
  AUTH_SECRET: "a-sufficiently-long-test-secret-value",
  ADMIN_EMAILS: "maintainer@example.com",
  GUEST_EMAILS: "alice@example.com, Bob@Example.com",
  ADMIN_ACCESS_CODE: "admin-secret-code",
  GUEST_ACCESS_CODE: "guest-shared-code",
} as const;

const request = (cookie?: string): Request =>
  new Request("http://localhost/api/film", cookie ? { headers: { cookie } } : {});
const firstCookiePair = (setCookie: string): string => setCookie.split(";")[0]!;

test("a guest code cannot sign in as an admin address", () => {
  // The maintainer's address is public (it is in the contact nudge), so a single
  // shared code would hand every guest the admin budget.
  assert.equal(signIn("maintainer@example.com", "guest-shared-code", ENV).ok, false);
  assert.equal(signIn("alice@example.com", "admin-secret-code", ENV).ok, false);
});

test("tiers resolve from the allowlist, case-insensitively", () => {
  assert.equal(resolveTier("maintainer@example.com", ENV), "admin");
  assert.equal(resolveTier("BOB@example.com", ENV), "guest");
  assert.equal(resolveTier("mallory@evil.com", ENV), null);
});

test("sign-in rejects unknown addresses and wrong codes", () => {
  assert.equal(signIn("mallory@evil.com", "guest-shared-code", ENV).ok, false);
  assert.equal(signIn("alice@example.com", "wrong", ENV).ok, false);
  assert.equal(signIn("alice@example.com", "guest-shared-code", ENV).identity?.tier, "guest");
});

test("removing an address from the allowlist revokes a valid cookie", () => {
  const session = signIn("alice@example.com", "guest-shared-code", ENV);
  const cookie = firstCookiePair(session.cookie!);
  assert.equal(readIdentity(request(cookie), ENV)?.tier, "guest");

  const revoked = { ...ENV, GUEST_EMAILS: "someone-else@example.com" };
  assert.equal(readIdentity(request(cookie), revoked), null);
});

test("forged and tampered cookies are rejected", () => {
  const forged = Buffer.from(
    JSON.stringify({ e: "alice@example.com", x: 9e9, tier: "admin" }),
    "utf8",
  ).toString("base64url");
  assert.equal(readIdentity(request(`${SESSION_COOKIE}=${forged}.deadbeef`), ENV), null);

  const session = signIn("alice@example.com", "guest-shared-code", ENV);
  const tampered = firstCookiePair(session.cookie!).replace(/=(.+?)\./, (_m, p) => `=${p}x.`);
  assert.equal(readIdentity(request(tampered), ENV), null);
});

test("expired cookies are rejected", () => {
  const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const cookie = firstCookiePair(issueSessionCookie("alice@example.com", ENV, past)!);
  assert.equal(readIdentity(request(cookie), ENV), null);
});

test("fails closed without a usable AUTH_SECRET", () => {
  assert.equal(signIn("alice@example.com", "guest-shared-code", { ...ENV, AUTH_SECRET: "" }).ok, false);
  assert.equal(signIn("alice@example.com", "guest-shared-code", { ...ENV, AUTH_SECRET: "tiny" }).ok, false);
  assert.equal(issueSessionCookie("alice@example.com", { ...ENV, AUTH_SECRET: "" }), null);
});

test("fails closed when a tier has no code configured", () => {
  assert.equal(signIn("alice@example.com", "", { ...ENV, GUEST_ACCESS_CODE: "" }).ok, false);
});

test("budgets: guest is one-time, admin resets monthly", () => {
  const now = new Date("2026-07-17T00:00:00Z");
  const guest = { email: "alice@example.com", tier: "guest" } as const;
  const admin = { email: "maintainer@example.com", tier: "admin" } as const;

  assert.equal(budgetLimitCents("guest", ENV), 1500);
  assert.equal(budgetLimitCents("admin", ENV), 10000);
  assert.equal(budgetLimitCents("guest", { ...ENV, GUEST_LIFETIME_BUDGET_USD: "25" }), 2500);

  assert.equal(budgetTtlSeconds("guest"), 0, "guest credit must never expire");
  assert.ok(budgetTtlSeconds("admin") > 0);

  assert.ok(budgetKey(admin, "secret", now).endsWith(":2026-07"));
  assert.ok(!budgetKey(guest, "secret", now).includes("2026-07"));
  assert.ok(!budgetKey(guest, "secret", now).includes("alice@example.com"), "email must be hashed");
});

test("Redis credentials are accepted under either provisioning convention", () => {
  // Vercel's Upstash integration sets KV_REST_API_*; Upstash's own console
  // calls the identical REST endpoint UPSTASH_REDIS_REST_*. Same store.
  assert.deepEqual(
    redisCredentials({ KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t" }),
    { url: "https://x.upstash.io", token: "t" },
  );
  assert.deepEqual(
    redisCredentials({ UPSTASH_REDIS_REST_URL: "https://y.upstash.io", UPSTASH_REDIS_REST_TOKEN: "u" }),
    { url: "https://y.upstash.io", token: "u" },
  );
  // An explicit UPSTASH_* value wins over the Vercel-provisioned one.
  assert.equal(
    redisCredentials({
      UPSTASH_REDIS_REST_URL: "https://explicit.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "u",
      KV_REST_API_URL: "https://vercel.upstash.io",
      KV_REST_API_TOKEN: "t",
    })?.url,
    "https://explicit.upstash.io",
  );
  assert.equal(redisCredentials({}), null, "no credentials must fail closed");
  assert.equal(
    redisCredentials({ KV_REST_API_URL: "https://x.upstash.io" }),
    null,
    "a half-configured store must fail closed",
  );
});
