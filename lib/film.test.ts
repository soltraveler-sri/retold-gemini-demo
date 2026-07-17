import assert from "node:assert/strict";
import test from "node:test";

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

  async reserve(
    input: CapacityReservation,
  ): Promise<CapacityReservationResult> {
    this.reservations.push(input);
    const globalCount = this.counts.get(input.globalKey) ?? 0;
    const ipCount = this.counts.get(input.ipKey) ?? 0;
    const visitorCount = this.counts.get(input.visitorKey) ?? 0;

    if (globalCount >= input.globalCap) return "global-cap-reached";
    if (ipCount >= input.visitorCap || visitorCount >= input.visitorCap) {
      return "visitor-cap-reached";
    }

    for (const key of [input.globalKey, input.ipKey, input.visitorKey]) {
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }
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

test("a global film cap of 1 atomically blocks the second attempt", async () => {
  const redis = new MemoryCapacityRedis();
  const environment = capacityEnvironment({
    DAILY_FILM_CAP: "1",
    VISITOR_FILM_CAP: "5",
  });
  const dependencies = fixedCapacityDependencies(redis, environment);

  const first = await checkFilmGenerationCapacity(
    capacityRequest("203.0.113.10"),
    dependencies,
  );
  const second = await checkFilmGenerationCapacity(
    capacityRequest("203.0.113.11"),
    dependencies,
  );

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  if (second.allowed) throw new Error("Expected the global cap to be reached.");
  assert.match(second.message, /today's live film limit/i);
  assert.equal(redis.reservations.length, 2);
});

test("the per-visitor daily cap blocks either the signed visitor or its IP", async () => {
  const redis = new MemoryCapacityRedis();
  const environment = capacityEnvironment({
    DAILY_FILM_CAP: "10",
    VISITOR_FILM_CAP: "1",
  });
  const dependencies = fixedCapacityDependencies(redis, environment);
  const first = await checkFilmGenerationCapacity(
    capacityRequest("198.51.100.42"),
    dependencies,
  );
  assert.equal(first.allowed, true);
  assert.equal(first.setCookies.length, 1);

  const second = await checkFilmGenerationCapacity(
    capacityRequest(
      "198.51.100.42",
      cookiePair(first.setCookies[0]!),
    ),
    dependencies,
  );

  assert.equal(second.allowed, false);
  if (second.allowed) throw new Error("Expected the visitor cap to be reached.");
  assert.match(second.message, /you've reached/i);
});

test("the demo unlock bypasses both caps and only a signed cookie persists it", async () => {
  const redis = new MemoryCapacityRedis();
  const environment = capacityEnvironment({
    DAILY_FILM_CAP: "0",
    VISITOR_FILM_CAP: "0",
    DEMO_UNLOCK: "presentation-passphrase",
  });
  const dependencies = fixedCapacityDependencies(redis, environment);
  const unlocked = await checkFilmGenerationCapacity(
    capacityRequest(
      "192.0.2.12",
      undefined,
      "?key=presentation-passphrase",
    ),
    dependencies,
  );

  assert.equal(unlocked.allowed, true);
  assert.equal(unlocked.setCookies.length, 1);
  assert.equal(redis.reservations.length, 0);

  const unlockCookie = cookiePair(unlocked.setCookies[0]!);
  const persisted = await checkFilmGenerationCapacity(
    capacityRequest("192.0.2.12", unlockCookie),
    dependencies,
  );
  assert.equal(persisted.allowed, true);
  assert.equal(redis.reservations.length, 0);

  const lastCharacter = unlockCookie.at(-1);
  const tamperedCookie = `${unlockCookie.slice(0, -1)}${lastCharacter === "A" ? "B" : "A"}`;
  const tampered = await checkFilmGenerationCapacity(
    capacityRequest("192.0.2.12", tamperedCookie),
    dependencies,
  );
  assert.equal(tampered.allowed, false);
  assert.equal(redis.reservations.length, 1);
});

test("Redis-down refuses real generation but mock generation never touches Redis", async () => {
  const redis = new UnreachableCapacityRedis();
  const realEnvironment = capacityEnvironment();
  const real = await checkFilmGenerationCapacity(
    capacityRequest("203.0.113.99"),
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
    capacityRequest("203.0.113.99"),
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

test("Redis keys contain the UTC date and hashes, never the raw visitor IP", async () => {
  const redis = new MemoryCapacityRedis();
  const rawIp = "203.0.113.77";
  const result = await checkFilmGenerationCapacity(
    capacityRequest(rawIp),
    fixedCapacityDependencies(redis, capacityEnvironment()),
  );

  assert.equal(result.allowed, true);
  const reservation = redis.reservations[0];
  assert.ok(reservation);
  assert.match(reservation.globalKey, /:2026-07-17:global$/);
  assert.equal(reservation.ipKey.includes(rawIp), false);
  assert.match(reservation.ipKey, /:ip:[a-f0-9]{64}$/);
  assert.match(reservation.visitorKey, /:visitor:[a-f0-9]{64}$/);
});

test("the Upstash adapter reserves all counters in one EVAL command", async () => {
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
    ipKey: "ip-key",
    visitorKey: "visitor-key",
    globalCap: 15,
    visitorCap: 2,
    ttlSeconds: 43_200,
  });

  assert.equal(result, "allowed");
  assert.equal(calls, 1);
  assert.ok(Array.isArray(requestBody));
  assert.equal(requestBody[0], "EVAL");
  assert.match(String(requestBody[1]), /redis\.call\("INCR", key\)/);
  assert.deepEqual(requestBody.slice(2, 6), [
    3,
    "global-key",
    "ip-key",
    "visitor-key",
  ]);
});
