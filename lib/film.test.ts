import assert from "node:assert/strict";
import test from "node:test";

import { issueSessionCookie } from "./access";

import {
  buildFilmPrompt,
  capReachedError,
  checkFilmGenerationCapacity,
  FilmError,
  filmErrorFromOmniFailure,
  isRealOmniEnabled,
  parseFilmRequestBody,
  resolveFilmSelection,
} from "./film";
import { FILM_PROGRESS_STAGES, simulateFilmProgress } from "./film-stages";
import type {
  CapacityRedis,
  CapacityReservation,
  CapacityReservationResult,
} from "./generation-capacity";
import { createUpstashCapacityRedis } from "./generation-capacity";
import { OmniModelError } from "./omni";

const CAP_TEST_NOW = new Date("2026-07-17T12:00:00.000Z");
const VISITOR_ID = "visitor-test-identifier-0001";

class MemoryCapacityRedis implements CapacityRedis {
  readonly reservations: CapacityReservation[] = [];
  private readonly counts = new Map<string, number>();
  private readonly spend = new Map<string, number>();

  async reserve(
    input: CapacityReservation,
  ): Promise<CapacityReservationResult> {
    this.reservations.push(input);
    const globalCount = this.counts.get(input.globalKey) ?? 0;
    if (globalCount >= input.globalCap) return "global-cap-reached";

    const spent = this.spend.get(input.budgetKey) ?? 0;
    if (spent + input.costCents > input.budgetLimitCents) {
      return "budget-exhausted";
    }

    this.counts.set(input.globalKey, globalCount + 1);
    this.spend.set(input.budgetKey, spent + input.costCents);
    return "allowed";
  }
}

class UnreachableCapacityRedis implements CapacityRedis {
  calls = 0;

  async reserve(): Promise<CapacityReservationResult> {
    this.calls += 1;
    throw new Error("Simulated Redis outage");
  }
}

function capacityEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    MOCK_OMNI: "0",
    GEMINI_API_KEY: "unit-test-key",
    UPSTASH_REDIS_REST_URL: "https://mock-redis.invalid",
    UPSTASH_REDIS_REST_TOKEN: "unit-test-redis-secret",
    DAILY_FILM_CAP: "15",
    VISITOR_FILM_CAP: "2",
    AUTH_SECRET: "a-sufficiently-long-test-secret-value",
    ADMIN_EMAILS: "maintainer@example.com",
    GUEST_EMAILS: "guest@example.com",
    ADMIN_ACCESS_CODE: "admin-code",
    GUEST_ACCESS_CODE: "guest-code",
    ADMIN_MONTHLY_BUDGET_USD: "100",
    GUEST_LIFETIME_BUDGET_USD: "15",
    ...overrides,
  };
}

function capacityRequest(
  ip: string,
  cookie?: string,
  query = "",
): Request {
  const headers = new Headers({ "x-forwarded-for": ip });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`https://retold.example/api/film${query}`, { headers });
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

/** Real generation now requires an identity; these tests exercise caps, not auth. */
function signedInRequest(
  ip: string,
  tier: "admin" | "guest" = "admin",
  environment: Readonly<Record<string, string | undefined>> = capacityEnvironment(),
  query = "",
): Request {
  const email = tier === "admin" ? "maintainer@example.com" : "guest@example.com";
  const cookie = cookiePair(issueSessionCookie(email, environment, CAP_TEST_NOW)!);
  return capacityRequest(ip, cookie, query);
}

function fixedCapacityDependencies(
  redis: CapacityRedis,
  environment: Readonly<Record<string, string | undefined>>,
) {
  return {
    environment,
    redis,
    now: CAP_TEST_NOW,
    randomVisitorId: () => VISITOR_ID,
  };
}

function expectInvalidInput(run: () => unknown): FilmError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof FilmError);
    assert.equal(error.code, "invalid-input");
    return error;
  }
  throw new Error("Expected invalid input.");
}

test("request parser accepts only 1–6 unique manifest ids", () => {
  assert.deepEqual(parseFilmRequestBody({ photoIds: ["birthday-01"] }), {
    photoIds: ["birthday-01"],
  });
  expectInvalidInput(() => parseFilmRequestBody({ photoIds: [] }));
  expectInvalidInput(() =>
    parseFilmRequestBody({
      photoIds: ["a", "b", "c", "d", "e", "f", "g"],
    }),
  );
  expectInvalidInput(() =>
    parseFilmRequestBody({
      photoIds: ["birthday-01"],
      imageUrl: "https://attacker.example/image.jpg",
    }),
  );
  expectInvalidInput(() =>
    parseFilmRequestBody({ photoIds: ["birthday-01", "birthday-01"] }),
  );
});

test("manifest resolution rejects unknown and cross-collection ids", () => {
  expectInvalidInput(() => resolveFilmSelection(["not-a-real-photo"]));
  expectInvalidInput(() =>
    resolveFilmSelection(["birthday-01", "wedding-01"]),
  );
});

test("selection order is chronological and prompt tags are zero-indexed", () => {
  const selection = resolveFilmSelection([
    "birthday-05",
    "birthday-01",
    "birthday-03",
  ]);
  assert.deepEqual(
    selection.photos.map((photo) => photo.id),
    ["birthday-01", "birthday-03", "birthday-05"],
  );
  assert.equal(
    buildFilmPrompt(selection.collection.promptTemplate, 3).split("\n")[0],
    "[# References <IMAGE_REF_0>@Image1 <IMAGE_REF_1>@Image2 <IMAGE_REF_2>@Image3]",
  );
});

test("paid Omni access requires both the explicit real flag and a key", () => {
  assert.equal(
    isRealOmniEnabled({ MOCK_OMNI: undefined, GEMINI_API_KEY: undefined }),
    false,
  );
  assert.equal(
    isRealOmniEnabled({ MOCK_OMNI: "1", GEMINI_API_KEY: "key" }),
    false,
  );
  assert.equal(
    isRealOmniEnabled({ MOCK_OMNI: "0", GEMINI_API_KEY: undefined }),
    false,
  );
  assert.equal(
    isRealOmniEnabled({ MOCK_OMNI: "0", GEMINI_API_KEY: "  " }),
    false,
  );
  assert.equal(
    isRealOmniEnabled({ MOCK_OMNI: "0", GEMINI_API_KEY: "key" }),
    true,
  );
});

test("budget and cap failures remain distinct structured errors", () => {
  const budget = filmErrorFromOmniFailure(
    new OmniModelError("budget-exceeded", "internal upstream detail"),
  );
  assert.equal(budget.code, "budget-exceeded");
  assert.equal(budget.status, 402);
  assert.equal(budget.message.includes("internal upstream detail"), false);

  const upstream = filmErrorFromOmniFailure(new Error("network detail"));
  assert.equal(upstream.code, "upstream-model-error");
  assert.equal(upstream.status, 502);
  assert.equal(upstream.message.includes("network detail"), false);

  const cap = capReachedError("Daily film limit reached.");
  assert.equal(cap.code, "cap-reached");
  assert.equal(cap.status, 429);
});

test("mock progress uses staged delays totaling 20–40 seconds", async () => {
  const minimumDurations: number[] = [];
  const minimum = await simulateFilmProgress(
    () => 0,
    async (durationMs) => {
      minimumDurations.push(durationMs);
    },
  );
  assert.deepEqual(
    minimumDurations,
    FILM_PROGRESS_STAGES.map((stage) => stage.minDurationMs),
  );
  assert.equal(
    minimum.reduce((total, stage) => total + stage.durationMs, 0),
    20_000,
  );

  const maximum = await simulateFilmProgress(
    () => 0.999_999_999,
    async () => undefined,
  );
  assert.equal(
    maximum.reduce((total, stage) => total + stage.durationMs, 0),
    40_000,
  );
});

test("anonymous visitors are refused before any paid call", async () => {
  const redis = new MemoryCapacityRedis();
  const decision = await checkFilmGenerationCapacity(
    capacityRequest("203.0.113.10"),
    fixedCapacityDependencies(redis, capacityEnvironment()),
  );

  assert.equal(decision.allowed, false);
  if (decision.allowed) throw new Error("Expected anonymous access to be refused.");
  assert.equal(decision.denial, "auth-required");
  assert.equal(redis.reservations.length, 0, "must not touch Redis without an identity");
});

test("a global film cap of 1 atomically blocks the second attempt", async () => {
  const redis = new MemoryCapacityRedis();
  const environment = capacityEnvironment({ DAILY_FILM_CAP: "1" });
  const dependencies = fixedCapacityDependencies(redis, environment);

  const first = await checkFilmGenerationCapacity(
    signedInRequest("203.0.113.10", "admin", environment),
    dependencies,
  );
  const second = await checkFilmGenerationCapacity(
    signedInRequest("203.0.113.11", "admin", environment),
    dependencies,
  );

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  if (second.allowed) throw new Error("Expected the global cap to be reached.");
  assert.equal(second.denial, "global-cap-reached");
  assert.match(second.message, /today's live film limit/i);
});

test("a guest's credit is spent in dollars and blocks when exhausted", async () => {
  const redis = new MemoryCapacityRedis();
  // $2.50 of credit buys two $1.00 films and no more.
  const environment = capacityEnvironment({ GUEST_LIFETIME_BUDGET_USD: "2.50" });
  const dependencies = fixedCapacityDependencies(redis, environment);
  const request = () => signedInRequest("203.0.113.20", "guest", environment);

  assert.equal((await checkFilmGenerationCapacity(request(), dependencies)).allowed, true);
  assert.equal((await checkFilmGenerationCapacity(request(), dependencies)).allowed, true);

  const third = await checkFilmGenerationCapacity(request(), dependencies);
  assert.equal(third.allowed, false);
  if (third.allowed) throw new Error("Expected the guest credit to be exhausted.");
  assert.equal(third.denial, "budget-exhausted");
  assert.match(third.message, /used your full demo credit/i);
});

test("a guest cannot spend against the admin budget", async () => {
  const redis = new MemoryCapacityRedis();
  const environment = capacityEnvironment({ GUEST_LIFETIME_BUDGET_USD: "1" });
  const dependencies = fixedCapacityDependencies(redis, environment);

  await checkFilmGenerationCapacity(
    signedInRequest("203.0.113.21", "guest", environment),
    dependencies,
  );
  const guestReservation = redis.reservations.at(-1)!;
  assert.match(guestReservation.budgetKey, /^retold:budget:guest:/);
  assert.equal(guestReservation.budgetLimitCents, 100);

  await checkFilmGenerationCapacity(
    signedInRequest("203.0.113.22", "admin", environment),
    dependencies,
  );
  const adminReservation = redis.reservations.at(-1)!;
  assert.match(adminReservation.budgetKey, /^retold:budget:admin:/);
  assert.equal(adminReservation.budgetLimitCents, 10000);
  assert.notEqual(guestReservation.budgetKey, adminReservation.budgetKey);
});

test("the demo unlock grants a metered admin session, not an unlimited bypass", async () => {
  const redis = new MemoryCapacityRedis();
  const environment = capacityEnvironment({
    DEMO_UNLOCK: "presentation-passphrase",
    ADMIN_MONTHLY_BUDGET_USD: "1",
  });
  const dependencies = fixedCapacityDependencies(redis, environment);

  const unlocked = await checkFilmGenerationCapacity(
    capacityRequest("192.0.2.12", undefined, "?key=presentation-passphrase"),
    dependencies,
  );
  assert.equal(unlocked.allowed, true);
  assert.equal(unlocked.setCookies.length, 1, "unlock issues a session cookie");
  assert.equal(
    redis.reservations.length,
    1,
    "unlock must still be metered — it is not a bypass",
  );
  assert.match(redis.reservations[0]!.budgetKey, /^retold:budget:admin:/);

  // $1.00 of admin budget buys exactly one $1.00 film, even when unlocked.
  const second = await checkFilmGenerationCapacity(
    capacityRequest("192.0.2.12", cookiePair(unlocked.setCookies[0]!)),
    dependencies,
  );
  assert.equal(second.allowed, false);
  if (second.allowed) throw new Error("Expected the admin budget to be exhausted.");
  assert.equal(second.denial, "budget-exhausted");

  const wrongKey = await checkFilmGenerationCapacity(
    capacityRequest("192.0.2.12", undefined, "?key=wrong-passphrase"),
    dependencies,
  );
  assert.equal(wrongKey.allowed, false);
});

test("Redis-down refuses real generation but mock generation never touches Redis", async () => {
  const redis = new UnreachableCapacityRedis();
  const realEnvironment = capacityEnvironment();
  const real = await checkFilmGenerationCapacity(
    signedInRequest("203.0.113.99", "admin", realEnvironment),
    fixedCapacityDependencies(redis, realEnvironment),
  );

  assert.equal(real.allowed, false);
  if (real.allowed) throw new Error("Expected Redis-down to fail closed.");
  assert.match(real.message, /temporarily unavailable/i);
  assert.equal(redis.calls, 1);

  const missingRedisEnvironment = capacityEnvironment({
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
  });
  const misconfigured = await checkFilmGenerationCapacity(
    signedInRequest("203.0.113.99", "admin", missingRedisEnvironment),
    fixedCapacityDependencies(redis, missingRedisEnvironment),
  );
  assert.equal(misconfigured.allowed, false);
  assert.equal(redis.calls, 1);

  const mockEnvironment = capacityEnvironment({
    MOCK_OMNI: "1",
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
  });
  const mock = await checkFilmGenerationCapacity(
    capacityRequest("203.0.113.99"),
    fixedCapacityDependencies(redis, mockEnvironment),
  );
  assert.equal(mock.allowed, true);
  assert.equal(redis.calls, 1);
});

test("Redis keys carry the UTC date and a hashed identity, never a raw email", async () => {
  const redis = new MemoryCapacityRedis();
  const result = await checkFilmGenerationCapacity(
    signedInRequest("203.0.113.77"),
    fixedCapacityDependencies(redis, capacityEnvironment()),
  );

  assert.equal(result.allowed, true);
  const reservation = redis.reservations[0];
  assert.ok(reservation);
  assert.match(reservation.globalKey, /:2026-07-17:global$/);
  assert.equal(
    reservation.budgetKey.includes("maintainer@example.com"),
    false,
    "the budget key must never contain a raw email",
  );
  assert.match(reservation.budgetKey, /^retold:budget:(admin|guest):/);
  assert.equal(reservation.costCents, 100);
});

test("the Upstash adapter reserves the cap and the budget in one EVAL command", async () => {
  let requestBody: unknown;
  let calls = 0;
  const mockFetch: typeof fetch = async (_input, init) => {
    calls += 1;
    requestBody = JSON.parse(String(init?.body)) as unknown;
    return new Response(JSON.stringify({ result: "allowed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const redis = createUpstashCapacityRedis(
    "https://mock-redis.invalid",
    "unit-test-token",
    mockFetch,
  );
  const result = await redis.reserve({
    globalKey: "global-key",
    budgetKey: "budget-key",
    globalCap: 15,
    globalTtlSeconds: 43_200,
    costCents: 100,
    budgetLimitCents: 1500,
    budgetTtlSeconds: 0,
  });

  assert.equal(result, "allowed");
  assert.equal(calls, 1);
  assert.ok(Array.isArray(requestBody));
  assert.equal(requestBody[0], "EVAL");
  assert.match(String(requestBody[1]), /redis\.call\("INCRBY", KEYS\[2\], cost\)/);
  assert.deepEqual(requestBody.slice(2, 5), [2, "global-key", "budget-key"]);
});
