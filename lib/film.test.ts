import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFilmPrompt,
  capReachedError,
  FilmError,
  filmErrorFromOmniFailure,
  isRealOmniEnabled,
  parseFilmRequestBody,
  resolveFilmSelection,
} from "./film";
import { FILM_PROGRESS_STAGES, simulateFilmProgress } from "./film-stages";
import { OmniModelError } from "./omni";

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
