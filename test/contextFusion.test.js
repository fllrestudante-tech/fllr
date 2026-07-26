const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fuseContext,
  directionFromMarket,
  directionFromStructure,
  directionFromLiquidity,
  detectConflicts,
  confidencePenaltyFor,
} = require("../lib/brains/contextFusion");

function brainResult({ state, confidence, score = 50, reasons = ["r"], missingEvidence = [], extra = {} }) {
  return {
    state,
    confidence,
    score,
    reasons,
    evidence: [],
    missingEvidence,
    metadata: { generatedAt: "2026-01-01T00:00:00.000Z", sourceDataTime: 1000, processingMs: 1, dependsOn: [] },
    ...extra,
  };
}

function marketResult({ trendState = "TRENDING_BULL", confidence = 80, missingEvidence = ["ADX"] } = {}) {
  return brainResult({ state: "MARKET_FAVORABLE", confidence, reasons: ["Tendência: r-market"], missingEvidence, extra: { trend: { state: trendState }, sentiment: {}, risk: {} } });
}
function structureResult({ bias = "bullish", confidence = 80, missingEvidence = ["Fair Value Gap (FVG)"] } = {}) {
  return brainResult({ state: "GOOD", confidence, reasons: ["r-structure"], missingEvidence, extra: { trend: { bias, quality: "GOOD", persistence: 10 } } });
}
function liquidityResult({ state = "LIQUIDITY_ABOVE", confidence = 80, missingEvidence = ["Order Blocks"] } = {}) {
  return brainResult({ state, confidence, reasons: ["r-liquidity"], missingEvidence, extra: { zones: { above: [], below: [] }, sweeps: [] } });
}

// --- funções puras isoladas ---

test("directionFromMarket: TRENDING_BULL/BEAR/RANGING mapeiam pra bull/bear/null", () => {
  assert.equal(directionFromMarket({ trend: { state: "TRENDING_BULL" } }), "bull");
  assert.equal(directionFromMarket({ trend: { state: "TRENDING_BEAR" } }), "bear");
  assert.equal(directionFromMarket({ trend: { state: "RANGING" } }), null);
});

test("directionFromStructure: bullish/bearish/null", () => {
  assert.equal(directionFromStructure({ trend: { bias: "bullish" } }), "bull");
  assert.equal(directionFromStructure({ trend: { bias: "bearish" } }), "bear");
  assert.equal(directionFromStructure({ trend: { bias: null } }), null);
});

test("directionFromLiquidity: SWEPT_HIGH=bear, SWEPT_LOW=bull, LIQUIDITY_ABOVE=bull, LIQUIDITY_BELOW=bear, BALANCED=null", () => {
  assert.equal(directionFromLiquidity({ state: "SWEPT_HIGH" }), "bear");
  assert.equal(directionFromLiquidity({ state: "SWEPT_LOW" }), "bull");
  assert.equal(directionFromLiquidity({ state: "LIQUIDITY_ABOVE" }), "bull");
  assert.equal(directionFromLiquidity({ state: "LIQUIDITY_BELOW" }), "bear");
  assert.equal(directionFromLiquidity({ state: "BALANCED" }), null);
});

test("detectConflicts: só conta quando os dois lados têm direção não-nula e discordam", () => {
  assert.deepEqual(detectConflicts({ A: "bull", B: "bull", C: "bear" }), ["A aponta alta, mas C aponta baixa", "B aponta alta, mas C aponta baixa"]);
  assert.deepEqual(detectConflicts({ A: "bull", B: null, C: "bull" }), []); // B nulo nunca gera conflito
  assert.deepEqual(detectConflicts({ A: "bull", B: "bull", C: "bull" }), []);
});

test("confidencePenaltyFor: 0 conflitos=sem penalidade, 1=0.7x, 2+=0.4x", () => {
  assert.equal(confidencePenaltyFor(0), 1);
  assert.equal(confidencePenaltyFor(1), 0.7);
  assert.equal(confidencePenaltyFor(2), 0.4);
  assert.equal(confidencePenaltyFor(3), 0.4);
});

// --- fuseContext (integração) ---

test("fuseContext: os 3 Brains concordando -- sem conflito, confidence não penalizada", () => {
  const context = fuseContext({ market: marketResult(), structure: structureResult(), liquidity: liquidityResult() });

  assert.equal(context.state, "FUSED_BULLISH");
  assert.deepEqual(context.conflicts, []);
  assert.equal(context.confidence, 80); // média dos 3 (todos 80), sem penalidade
  assert.ok(context.score > 0);
});

test("fuseContext: 1 conflito -- penalidade 0.7x na confidence", () => {
  const context = fuseContext({
    market: marketResult({ trendState: "TRENDING_BULL" }),
    structure: structureResult({ bias: "bearish" }), // discorda do market -- 1 conflito
    liquidity: liquidityResult({ state: "BALANCED" }), // neutro -- não conflita com nenhum dos dois
  });

  assert.equal(context.conflicts.length, 1);
  assert.ok(context.conflicts[0].includes("Market Brain"));
  assert.equal(context.confidence, Math.round(80 * 0.7));
});

test("fuseContext: 2 conflitos -- penalidade 0.4x na confidence", () => {
  const context = fuseContext({
    market: marketResult({ trendState: "TRENDING_BULL" }),
    structure: structureResult({ bias: "bearish" }), // discorda do market
    liquidity: liquidityResult({ state: "SWEPT_HIGH" }), // bear -- discorda do market também
  });

  assert.equal(context.conflicts.length, 2);
  assert.equal(context.confidence, Math.round(80 * 0.4));
});

test("fuseContext: reasons inclui o resumo de cada Brain + os conflitos", () => {
  const context = fuseContext({ market: marketResult(), structure: structureResult({ bias: "bearish" }), liquidity: liquidityResult() });
  assert.ok(context.reasons.some((r) => r.startsWith("Market Brain:")));
  assert.ok(context.reasons.some((r) => r.startsWith("Structure Brain:")));
  assert.ok(context.reasons.some((r) => r.startsWith("Liquidity Brain:")));
  assert.ok(context.reasons.some((r) => r.includes("aponta")));
});

test("fuseContext: evidence tipado com 1 entrada por Brain", () => {
  const context = fuseContext({ market: marketResult(), structure: structureResult(), liquidity: liquidityResult() });
  assert.equal(context.evidence.length, 3);
  assert.deepEqual(
    context.evidence.map((e) => e.type),
    ["MARKET_BRAIN", "STRUCTURE_BRAIN", "LIQUIDITY_BRAIN"]
  );
  for (const e of context.evidence) {
    assert.equal(typeof e.confidence, "number");
    assert.equal(typeof e.weight, "number");
    assert.equal(typeof e.timestamp, "string");
    assert.ok(e.payload.state);
  }
});

test("fuseContext: missingEvidence une os 3 Brains + os 3 Brains futuros ainda não construídos", () => {
  const context = fuseContext({ market: marketResult(), structure: structureResult(), liquidity: liquidityResult() });
  assert.ok(context.missingEvidence.includes("ADX"));
  assert.ok(context.missingEvidence.includes("Fair Value Gap (FVG)"));
  assert.ok(context.missingEvidence.includes("Order Blocks"));
  assert.ok(context.missingEvidence.includes("Volume Brain"));
  assert.ok(context.missingEvidence.includes("Narrative Brain"));
  assert.ok(context.missingEvidence.includes("Whale Brain"));
});

test("fuseContext: dependsOn aponta pra outros Brains, não domínios de dado cru", () => {
  const context = fuseContext({ market: marketResult(), structure: structureResult(), liquidity: liquidityResult() });
  assert.deepEqual(context.metadata.dependsOn, ["market_brain", "structure_brain", "liquidity_brain"]);
});

test("fuseContext: 3 Brains discordando (bull/bear/neutro) -- FUSED_NEUTRAL ou direção mais fraca, nunca quebra", () => {
  const context = fuseContext({
    market: marketResult({ trendState: "TRENDING_BULL" }),
    structure: structureResult({ bias: "bearish" }),
    liquidity: liquidityResult({ state: "BALANCED" }),
  });
  assert.ok(["FUSED_BULLISH", "FUSED_BEARISH", "FUSED_NEUTRAL"].includes(context.state));
});
