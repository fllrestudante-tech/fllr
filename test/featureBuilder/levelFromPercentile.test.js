const test = require("node:test");
const assert = require("node:assert/strict");
const { levelFromPercentile } = require("../../lib/featureBuilder/levelFromPercentile");

test("levelFromPercentile: thresholds default (95/80/20/5)", () => {
  assert.deepEqual(levelFromPercentile(98), { level: "EXTREME", direction: "above" });
  assert.deepEqual(levelFromPercentile(85), { level: "HIGH", direction: "above" });
  assert.deepEqual(levelFromPercentile(50), { level: "NORMAL", direction: "neutral" });
  assert.deepEqual(levelFromPercentile(15), { level: "LOW", direction: "below" });
  assert.deepEqual(levelFromPercentile(2), { level: "EXTREME", direction: "below" });
});

test("levelFromPercentile: percentile null devolve UNKNOWN, não lança erro", () => {
  assert.deepEqual(levelFromPercentile(null), { level: "UNKNOWN", direction: "neutral" });
  assert.deepEqual(levelFromPercentile(undefined), { level: "UNKNOWN", direction: "neutral" });
});

test("levelFromPercentile: thresholds customizados, independentes do default", () => {
  assert.deepEqual(levelFromPercentile(90, { extreme: 99, high: 85, low: 15, extremeLow: 1 }), { level: "HIGH", direction: "above" });
});
