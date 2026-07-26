const test = require("node:test");
const assert = require("node:assert/strict");
const { computeMaturityLevel, computeAllMaturityLevels, MATURITY_LEVELS } = require("../lib/researchMaturity");

// Fixtures verificadas rodando o código real (script descartável) antes
// de fixar os asserts -- mesma disciplina de sempre. Não toca em nenhum
// algoritmo de Brain/Replay/Analytics, só lê o formato de stats.json que
// eles já produzem.

test("computeMaturityLevel: Brain que não existe no código (Decision Brain) -- Level 0, mesmo com dado abundante", () => {
  const stats = { brainAccuracy: [], decisionBrainReadiness: { checks: { sampleSize: { count: 100000 } } } };
  assert.equal(computeMaturityLevel("decision", stats, 20000), 0);
});

test("computeMaturityLevel: replay nunca rodou (stats null) -- Level 1", () => {
  assert.equal(computeMaturityLevel("market", null, 20000), 1);
});

test("computeMaturityLevel: replay rodou mas o Brain não tem accuracy computada -- Level 1", () => {
  assert.equal(computeMaturityLevel("market", { brainAccuracy: [] }, 20000), 1);
});

test("computeMaturityLevel: accuracy existe mas totalCalls=0 (nenhuma aposta julgável) -- Level 1", () => {
  const stats = { brainAccuracy: [{ brainKey: "market", totalCalls: 0 }] };
  assert.equal(computeMaturityLevel("market", stats, 20000), 1);
});

test("computeMaturityLevel: replay validado mas amostra abaixo do critério de prontidão -- Level 2", () => {
  const stats = { brainAccuracy: [{ brainKey: "market", totalCalls: 50 }], decisionBrainReadiness: { checks: { sampleSize: { count: 77 } } } };
  assert.equal(computeMaturityLevel("market", stats, 20000), 2);
});

test("computeMaturityLevel: amostra bate o critério de prontidão -- Level 3, nunca mais que isso automaticamente", () => {
  const stats = { brainAccuracy: [{ brainKey: "market", totalCalls: 50 }], decisionBrainReadiness: { checks: { sampleSize: { count: 25000 } } } };
  assert.equal(computeMaturityLevel("market", stats, 20000), 3);
});

test("computeAllMaturityLevels: devolve os 7 Brains implementados + decision, cada um com label correspondente", () => {
  const stats = {
    brainAccuracy: [
      { brainKey: "market", totalCalls: 10 },
      { brainKey: "structure", totalCalls: 10 },
      { brainKey: "liquidity", totalCalls: 10 },
      { brainKey: "context", totalCalls: 10 },
      { brainKey: "fvg", totalCalls: 10 },
      { brainKey: "orderBlock", totalCalls: 10 },
      { brainKey: "institutional", totalCalls: 10 },
    ],
    decisionBrainReadiness: { checks: { sampleSize: { count: 100 } } },
  };
  const result = computeAllMaturityLevels(stats, 20000);
  assert.deepEqual(
    result.map((r) => r.brainKey),
    ["market", "structure", "liquidity", "context", "fvg", "orderBlock", "institutional", "decision"]
  );
  assert.ok(result.filter((r) => r.brainKey !== "decision").every((r) => r.level === 2 && r.label === "Replay validado"));
  assert.deepEqual(result.find((r) => r.brainKey === "decision"), { brainKey: "decision", level: 0, label: MATURITY_LEVELS[0] });
});
