import assert from "node:assert/strict";
import test from "node:test";

import { isRefusal, isTransient } from "./scene-image";

/**
 * These strings are REAL errors observed from the live API, not invented ones.
 * The classifier decides whether a visitor is told "your prompt was unsafe" or
 * "something went wrong" — accusing someone of an unsafe prompt when the real
 * cause is our own misconfiguration is the worst possible failure here.
 */
const CONFIG_ERROR_400 =
  "BadRequestError: 400 The parameter 'safety_settings' is not available on the Gemini API but it is available on the Gemini Enterprise Agent Platform.";
const REAL_LIKENESS_REFUSAL =
  "BadRequestError: 400 Input blocked: Sorry, we can't create videos with real people's names or likenesses. Please remove the reference and try again.";

test("a configuration 400 is NOT reported as a safety refusal", () => {
  // This exact error made every scene request fail while telling visitors their
  // innocuous prompt was unsafe. The word "safety" appearing in a parameter
  // name must never imply the model refused anything.
  assert.equal(isRefusal(new Error(CONFIG_ERROR_400)), false);
});

test("a real likeness refusal IS classified as a refusal", () => {
  assert.equal(isRefusal(new Error(REAL_LIKENESS_REFUSAL)), true);
});

test("unrelated errors are not refusals", () => {
  assert.equal(isRefusal(new Error("500 Internal error")), false);
  assert.equal(isRefusal(new Error("fetch failed")), false);
  assert.equal(isRefusal(new Error("The parameter 'policy_id' is invalid")), false);
  assert.equal(isRefusal(new Error("503 Service temporarily unavailable")), false);
});

test("transient errors are retryable and are not refusals", () => {
  for (const message of ["429 rate limit", "503 unavailable", "fetch failed", "ECONNRESET"]) {
    assert.equal(isTransient(new Error(message)), true, message);
    assert.equal(isRefusal(new Error(message)), false, message);
  }
  assert.equal(isTransient(new Error(REAL_LIKENESS_REFUSAL)), false, "a refusal must not be retried");
});
