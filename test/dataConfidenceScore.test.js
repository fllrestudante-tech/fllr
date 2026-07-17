const test = require("node:test");
const assert = require("node:assert/strict");
const { computeDataConfidenceScore, gapsToScore } = require("../lib/dataConfidenceScore");

test("gapsToScore: zero gaps -> 100", () => {
  assert.equal(gapsToScore(0), 100);
});

test("gapsToScore: cada gap desconta 15 pontos, nunca abaixo de 0", () => {
  assert.equal(gapsToScore(1), 85);
  assert.equal(gapsToScore(10), 0);
});

test("gapsToScore: não numérico retorna null", () => {
  assert.equal(gapsToScore(null), null);
});

test("computeDataConfidenceScore: tudo perfeito -> 100", () => {
  const result = computeDataConfidenceScore({ coveragePct: 100, gapsCount: 0, sanityPassRate: 100 });
  assert.equal(result.score, 100);
});

test("computeDataConfidenceScore: pilar ausente (null) sai da média, não conta como 0", () => {
  // domínio sem sanity check aplicável (ex: não é candles) -- só coverage+gaps
  const result = computeDataConfidenceScore({ coveragePct: 100, gapsCount: 0, sanityPassRate: null });
  assert.equal(result.score, 100); // não devia cair pra ~57 por causa do null
});

test("computeDataConfidenceScore: nenhum pilar disponível retorna null com motivo", () => {
  const result = computeDataConfidenceScore({});
  assert.equal(result.score, null);
  assert.ok(result.reason);
});

test("computeDataConfidenceScore: mistura realista -- coverage baixo arrasta o score pra baixo", () => {
  const result = computeDataConfidenceScore({ coveragePct: 30, gapsCount: 0, sanityPassRate: 100 });
  assert.ok(result.score < 100 && result.score > 30);
});
