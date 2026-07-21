const test = require("node:test");
const assert = require("node:assert/strict");
const { computeSampleConfidence } = require("../lib/sampleConfidence");

test("computeSampleConfidence: 11/100 -> LOW_CONFIDENCE (fixture do usuário)", () => {
  const r = computeSampleConfidence(11);
  assert.deepEqual(r, { totalTrades: 11, target: 100, pct: 11, status: "LOW_CONFIDENCE" });
});

test("computeSampleConfidence: 57/100 -> MEDIUM_CONFIDENCE (fixture do usuário)", () => {
  const r = computeSampleConfidence(57);
  assert.equal(r.pct, 57);
  assert.equal(r.status, "MEDIUM_CONFIDENCE");
});

test("computeSampleConfidence: 108/100 -> HIGH_CONFIDENCE (fixture do usuário, acima do alvo)", () => {
  const r = computeSampleConfidence(108);
  assert.equal(r.pct, 108);
  assert.equal(r.status, "HIGH_CONFIDENCE");
});

test("computeSampleConfidence: exatamente no limiar MEDIUM (50) já conta como MEDIUM", () => {
  assert.equal(computeSampleConfidence(50).status, "MEDIUM_CONFIDENCE");
  assert.equal(computeSampleConfidence(49).status, "LOW_CONFIDENCE");
});

test("computeSampleConfidence: exatamente no alvo (100) já conta como HIGH", () => {
  assert.equal(computeSampleConfidence(100).status, "HIGH_CONFIDENCE");
  assert.equal(computeSampleConfidence(99).status, "MEDIUM_CONFIDENCE");
});

test("computeSampleConfidence: 0 trades -> LOW_CONFIDENCE, 0%", () => {
  const r = computeSampleConfidence(0);
  assert.equal(r.pct, 0);
  assert.equal(r.status, "LOW_CONFIDENCE");
});

test("computeSampleConfidence: target/mediumThreshold customizáveis", () => {
  const r = computeSampleConfidence(30, { target: 50, mediumThreshold: 25 });
  assert.equal(r.pct, 60);
  assert.equal(r.status, "MEDIUM_CONFIDENCE");
});
