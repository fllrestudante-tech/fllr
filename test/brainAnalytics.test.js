const test = require("node:test");
const assert = require("node:assert/strict");
const { computeBrainAccuracy, computeMarginalContribution, computeRedundancy, evaluateDecisionBrainReadiness, unanimousDirection } = require("../lib/brainAnalytics");

// Fixtures fabricadas diretamente como snapshots (sem rodar runReplay/
// candles reais -- mesma economia de teste de computeStats/
// computeTransitions em lib/replayEngine.js), verificadas via script
// descartável antes de fixar os asserts.

test("unanimousDirection: só concorda se TODOS tiverem direção não-nula e igual", () => {
  assert.equal(unanimousDirection(["bull", "bull", "bull"]), "bull");
  assert.equal(unanimousDirection(["bull", "bear", "bull"]), null);
  assert.equal(unanimousDirection(["bull", null, "bull"]), null);
});

// --- computeBrainAccuracy ---

function marketSnap(direction, forwardReturnPct) {
  return { brains: { market: { direction } }, forwardReturnPct };
}

test("computeBrainAccuracy: acerto/erro/flat classificados corretamente contra o retorno real, sem chamada nunca conta", () => {
  const snapshots = [
    marketSnap("bull", 1.0),
    marketSnap("bull", 2.0),
    marketSnap("bull", 0.5),
    marketSnap("bull", -1.0), // errou: apostou bull, real foi bear
    marketSnap("bull", 0.0), // errou: apostou bull, real ficou flat
    marketSnap("bear", -1.0),
    marketSnap("bear", -0.8),
    marketSnap("bear", 1.0), // errou: apostou bear, real foi bull
    marketSnap(null, 0.5), // sem aposta -- não conta
  ];
  assert.deepEqual(computeBrainAccuracy(snapshots, "market", 0.3), { brainKey: "market", totalCalls: 8, accuracy: 63, precision: 63, recall: 71 });
});

test("computeBrainAccuracy: sem nenhuma aposta -- zerado, não quebra", () => {
  const snapshots = [marketSnap(null, 1.0), marketSnap(null, -1.0)];
  assert.deepEqual(computeBrainAccuracy(snapshots, "market", 0.3), { brainKey: "market", totalCalls: 0, accuracy: 0, precision: 0, recall: 0 });
});

test("computeBrainAccuracy: classe sem nenhuma ocorrência é excluída da média (não vira 0 artificial)", () => {
  // só apostas "bull", nenhuma "bear" -- precision/recall de bear não deveriam existir, então a média usa só bull
  const snapshots = [marketSnap("bull", 1.0), marketSnap("bull", 2.0)];
  const result = computeBrainAccuracy(snapshots, "market", 0.3);
  assert.equal(result.accuracy, 100);
  assert.equal(result.precision, 100);
  assert.equal(result.recall, 100);
});

// --- computeMarginalContribution ---

function comboSnap(market, structure, liquidity, fvg, forwardReturnPct) {
  return { brains: { market: { direction: market }, structure: { direction: structure }, liquidity: { direction: liquidity }, fvg: { direction: fvg } }, forwardReturnPct };
}

test("computeMarginalContribution: escada de unanimidade crescente -- amostra encolhe e acurácia muda a cada nível", () => {
  const snapshots = [
    comboSnap("bull", "bull", "bull", "bull", 1.0), // unânime em todos, acerto
    comboSnap("bull", "bull", "bull", "bear", 1.0), // unânime até liquidity, fvg quebra
    comboSnap("bull", "bear", "bull", "bull", -1.0), // só market unânime (k=1)
    comboSnap("bull", "bull", "bear", "bull", 1.0), // unânime até structure (k=2), liquidity quebra
    comboSnap(null, "bull", "bull", "bull", 1.0), // market sem direção -- nunca conta unânime
  ];
  assert.deepEqual(computeMarginalContribution(snapshots, ["market", "structure", "liquidity", "fvg"], 0.3), [
    { combo: ["market"], sampleSize: 4, accuracy: 75 },
    { combo: ["market", "structure"], sampleSize: 3, accuracy: 100 },
    { combo: ["market", "structure", "liquidity"], sampleSize: 2, accuracy: 100 },
    { combo: ["market", "structure", "liquidity", "fvg"], sampleSize: 1, accuracy: 100 },
  ]);
});

// --- computeRedundancy ---

test("computeRedundancy: taxa de concordância entre o alvo e o consenso unânime dos explicadores", () => {
  const snapshots = [
    comboSnap("bull", "bull", "bull", "bull", 1.0), // liquidity+market unânime bull, fvg concorda
    comboSnap("bull", "bull", "bull", "bear", 1.0), // liquidity+market unânime bull, fvg discorda
    comboSnap("bull", "bear", "bull", "bull", -1.0), // liquidity+market unânime bull, fvg concorda
    comboSnap("bull", "bull", "bear", "bull", 1.0), // liquidity(bear)+market(bull) não unânime -- excluído
    comboSnap(null, "bull", "bull", "bull", 1.0), // market sem direção -- não unânime -- excluído
  ];
  assert.deepEqual(computeRedundancy(snapshots, "fvg", ["liquidity", "market"]), {
    targetBrainKey: "fvg",
    explainerBrainKeys: ["liquidity", "market"],
    sampleSize: 3,
    agreementRatePct: 67,
  });
});

test("computeRedundancy: sem nenhum caso julgável -- amostra zero, não quebra", () => {
  assert.deepEqual(computeRedundancy([comboSnap(null, null, null, "bull", 1.0)], "fvg", ["liquidity", "market"]), {
    targetBrainKey: "fvg",
    explainerBrainKeys: ["liquidity", "market"],
    sampleSize: 0,
    agreementRatePct: 0,
  });
});

// --- evaluateDecisionBrainReadiness ---

function readinessSnap(outcome, contextState) {
  return { outcome, brains: { context: { state: contextState } } };
}

test("evaluateDecisionBrainReadiness: amostra insuficiente -- falha só nesse critério", () => {
  const snapshots = Array.from({ length: 10 }, () => readinessSnap("SUCCESS", "FUSED_BULLISH"));
  const result = evaluateDecisionBrainReadiness(snapshots, { minSnapshots: 20000 });
  assert.equal(result.ready, false);
  assert.deepEqual(result.checks.sampleSize, { pass: false, count: 10, required: 20000 });
});

test("evaluateDecisionBrainReadiness: regime pouco diverso (só um estado do Context) -- falha nesse critério", () => {
  const snapshots = Array.from({ length: 100 }, () => readinessSnap("SUCCESS", "FUSED_BULLISH"));
  const result = evaluateDecisionBrainReadiness(snapshots, { minSnapshots: 50 });
  assert.equal(result.checks.regimeDiversity.pass, false);
  assert.deepEqual(result.checks.regimeDiversity.counts, { FUSED_BULLISH: 100, FUSED_BEARISH: 0, FUSED_NEUTRAL: 0 });
});

test("evaluateDecisionBrainReadiness: amostra + regime OK mas instável ao longo do tempo -- falha só na estabilidade, ready=false", () => {
  const snapshots = [
    ...Array.from({ length: 25 }, () => readinessSnap("SUCCESS", "FUSED_BULLISH")),
    ...Array.from({ length: 25 }, () => readinessSnap("SUCCESS", "FUSED_BEARISH")),
    ...Array.from({ length: 25 }, () => readinessSnap("SUCCESS", "FUSED_NEUTRAL")),
    ...Array.from({ length: 25 }, () => readinessSnap("FAIL", "FUSED_BULLISH")),
  ];
  const result = evaluateDecisionBrainReadiness(snapshots, { minSnapshots: 50 });
  assert.equal(result.checks.sampleSize.pass, true);
  assert.equal(result.checks.regimeDiversity.pass, true);
  assert.equal(result.checks.stability.pass, false);
  assert.deepEqual(result.checks.stability.bucketRates, [100, 100, 100, 0]);
  assert.equal(result.ready, false);
});
