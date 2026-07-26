const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrainResult } = require("../lib/brains/brainResult");

test("createBrainResult: monta o núcleo comum + metadata", () => {
  const result = createBrainResult({
    state: "GOOD",
    confidence: 80,
    score: 65,
    reasons: ["r1"],
    evidence: [{ type: "BOS" }],
    missingEvidence: ["FVG"],
    sourceDataTime: 1000,
    dependsOn: ["candles"],
  });

  assert.equal(result.state, "GOOD");
  assert.equal(result.confidence, 80);
  assert.equal(result.score, 65);
  assert.deepEqual(result.reasons, ["r1"]);
  assert.deepEqual(result.evidence, [{ type: "BOS" }]);
  assert.deepEqual(result.missingEvidence, ["FVG"]);
  assert.equal(result.metadata.sourceDataTime, 1000);
  assert.deepEqual(result.metadata.dependsOn, ["candles"]);
  assert.ok(result.metadata.generatedAt);
});

test("createBrainResult: processingMs medido de verdade a partir de startedAt", async () => {
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = createBrainResult({ state: "X", confidence: 0, score: 0, startedAt });
  assert.ok(result.metadata.processingMs >= 5);
});

test("createBrainResult: sem startedAt -- processingMs fica null (não fabrica um número)", () => {
  const result = createBrainResult({ state: "X", confidence: 0, score: 0 });
  assert.equal(result.metadata.processingMs, null);
});

test("createBrainResult: extra é mesclado no topo (campos específicos de cada Brain)", () => {
  const result = createBrainResult({
    state: "X",
    confidence: 0,
    score: 0,
    extra: { trend: { bias: "bullish" }, swings: { highs: [] } },
  });
  assert.deepEqual(result.trend, { bias: "bullish" });
  assert.deepEqual(result.swings, { highs: [] });
});

test("createBrainResult: defaults -- reasons/evidence/missingEvidence/dependsOn vazios quando não passados", () => {
  const result = createBrainResult({ state: "X", confidence: 0, score: 0 });
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.missingEvidence, []);
  assert.deepEqual(result.metadata.dependsOn, []);
});
