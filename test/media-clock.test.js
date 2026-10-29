import assert from "node:assert/strict";
import test from "node:test";
import { advanceMediaClock, getVideoIntervalMs } from "../src/media-clock.js";

test("source clock preserves millisecond gaps independently of burst arrival and late execution", () => {
  let previousDueAt = 1000;
  let previousTimestamp = 5000;
  for (const [timestamp, arrivalDueAt] of [[5040, 3000], [5080, 3000], [6080, 3001]]) {
    const result = advanceMediaClock({
      previousDueAt, previousTimestamp, timestamp, intervalMs: 40,
      initialDueAt: 1000, arrivalDueAt,
    });
    assert.equal(result.dueAt, 1000 + timestamp - 5000);
    assert.equal(result.corrected, false);
    previousDueAt = result.dueAt;
    previousTimestamp = timestamp;
  }
});

test("repeated, regressive, missing and excessive timestamps use bounded media intervals and retain real pauses", () => {
  for (const timestamp of [5000, 4990, null, 15001]) {
    const result = advanceMediaClock({
      previousDueAt: 1000, previousTimestamp: 5000, timestamp,
      intervalMs: 40, initialDueAt: 1000, arrivalDueAt: 1000,
    });
    assert.equal(result.dueAt, 1040);
    assert.equal(result.corrected, true);
  }
  assert.equal(advanceMediaClock({
    previousDueAt: 1000, previousTimestamp: 5000, timestamp: null,
    intervalMs: 40, initialDueAt: 1000, arrivalDueAt: 4000,
  }).dueAt, 4000);
});

test("nonstandard units require an explicit scale rather than network-based calibration", () => {
  assert.equal(advanceMediaClock({
    previousDueAt: 1000, previousTimestamp: 5000000, timestamp: 5040000,
    intervalMs: 40, initialDueAt: 1000, arrivalDueAt: 8000,
    scaleMsPerUnit: 0.001,
  }).dueAt, 1040);
});

test("video fallback validates camera intervals and never substitutes burst arrival intervals", () => {
  assert.equal(getVideoIntervalMs({ lastFrameIntervalMs: 80 }, 40), 80);
  assert.equal(getVideoIntervalMs({ lastFrameIntervalMs: 0 }, 40), 40);
  assert.equal(getVideoIntervalMs({ lastFrameIntervalMs: 65535 }, 0), 40);
  assert.equal(getVideoIntervalMs({ lastFrameIntervalMs: 1 }, NaN), 40);
});
