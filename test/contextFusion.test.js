const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fuseContext,
  directionFromMarket,
  directionFromStructure,
  directionFromLiquidity,
  computeMajorityDirection,
  detectConflicts,
  confidencePenaltyFor,
  computeDominantNarrative,
  computeSecondaryNarrative,
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

test("computeMajorityDirection: 2-1 tem vencedor claro", () => {
  assert.equal(computeMajorityDirection(["bull", "bull", "bear"]), "bull");
  assert.equal(computeMajorityDirection(["bear", "bear", "bull"]), "bear");
});

test("computeMajorityDirection: empate (1-1) ou tudo null -- sem maioria", () => {
  assert.equal(computeMajorityDirection(["bull", "bear", null]), null);
  assert.equal(computeMajorityDirection([null, null, null]), null);
});

test("detectConflicts: com maioria clara, só o lado minoritário conflita", () => {
  const brains = [
    { shortName: "Market", brain: brainResult({ confidence: 80, reasons: ["m"] }), direction: "bull" },
    { shortName: "Structure", brain: brainResult({ confidence: 80, reasons: ["s"] }), direction: "bull" },
    { shortName: "Liquidity", brain: brainResult({ confidence: 80, reasons: ["l"] }), direction: "bear" },
  ];
  const conflicts = detectConflicts(brains, computeMajorityDirection(brains.map((b) => b.direction)));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].brain, "Liquidity");
});

test("detectConflicts: empate 1-1 sem maioria -- os dois lados discordantes são marcados (simétrico)", () => {
  const brains = [
    { shortName: "Market", brain: brainResult({ confidence: 80, reasons: ["m"] }), direction: "bull" },
    { shortName: "Structure", brain: brainResult({ confidence: 80, reasons: ["s"] }), direction: "bear" },
    { shortName: "Liquidity", brain: brainResult({ confidence: 80, reasons: ["l"] }), direction: null },
  ];
  const conflicts = detectConflicts(brains, computeMajorityDirection(brains.map((b) => b.direction)));
  assert.equal(conflicts.length, 2);
  assert.deepEqual(
    conflicts.map((c) => c.brain).sort(),
    ["Market", "Structure"]
  );
});

test("detectConflicts: todos concordando -- nenhum conflito", () => {
  const brains = [
    { shortName: "Market", brain: brainResult({ confidence: 80 }), direction: "bull" },
    { shortName: "Structure", brain: brainResult({ confidence: 80 }), direction: "bull" },
    { shortName: "Liquidity", brain: brainResult({ confidence: 80 }), direction: "bull" },
  ];
  const conflicts = detectConflicts(brains, computeMajorityDirection(brains.map((b) => b.direction)));
  assert.deepEqual(conflicts, []);
});

test("confidencePenaltyFor: 0 conflitos=sem penalidade, 1=0.7x, 2+=0.4x", () => {
  assert.equal(confidencePenaltyFor(0), 1);
  assert.equal(confidencePenaltyFor(1), 0.7);
  assert.equal(confidencePenaltyFor(2), 0.4);
  assert.equal(confidencePenaltyFor(3), 0.4);
});

test("computeDominantNarrative: bullish/bearish/neutral básicos", () => {
  assert.equal(computeDominantNarrative("FUSED_BULLISH", { state: "GOOD" }), "Continuação de Alta");
  assert.equal(computeDominantNarrative("FUSED_BEARISH", { state: "EXCELLENT" }), "Continuação de Baixa");
  assert.equal(computeDominantNarrative("FUSED_NEUTRAL", { state: "NEUTRAL" }), "Indecisão");
});

test("computeDominantNarrative: sinaliza estrutura enfraquecendo (WEAK/BROKEN) mesmo com bias dominante", () => {
  assert.equal(computeDominantNarrative("FUSED_BULLISH", { state: "WEAK" }), "Alta com Estrutura Enfraquecendo");
  assert.equal(computeDominantNarrative("FUSED_BEARISH", { state: "BROKEN" }), "Baixa com Estrutura Enfraquecendo");
});

test("computeSecondaryNarrative: null sem conflito -- não fabrica narrativa à toa", () => {
  assert.equal(computeSecondaryNarrative([]), null);
});

test("computeSecondaryNarrative: pega o conflito mais severo quando há mais de um", () => {
  const conflicts = [
    { brain: "Market", severity: "low", reason: "r1" },
    { brain: "Liquidity", severity: "high", reason: "r2" },
  ];
  assert.equal(computeSecondaryNarrative(conflicts), "Possível divergência: Liquidity discorda (r2)");
});

// --- fuseContext (integração) ---

test("fuseContext: os 3 Brains concordando -- sem conflito, confidence não penalizada", () => {
  const context = fuseContext({ market: marketResult(), structure: structureResult(), liquidity: liquidityResult() });

  assert.equal(context.state, "FUSED_BULLISH");
  assert.deepEqual(context.conflicts, []);
  assert.equal(context.confidence, 80); // média dos 3 (todos 80), sem penalidade
  assert.ok(context.score > 0);
  assert.equal(context.dominantNarrative, "Continuação de Alta");
  assert.equal(context.secondaryNarrative, null);
});

test("fuseContext: maioria 2-1 -- 1 conflito, penalidade 0.7x na confidence, narrativa secundária presente", () => {
  const context = fuseContext({
    market: marketResult({ trendState: "TRENDING_BULL" }),
    structure: structureResult({ bias: "bullish" }), // concorda com market
    liquidity: liquidityResult({ state: "SWEPT_HIGH" }), // bear -- discorda da maioria (bull)
  });

  assert.equal(context.conflicts.length, 1);
  assert.equal(context.conflicts[0].brain, "Liquidity");
  assert.ok(["low", "medium", "high"].includes(context.conflicts[0].severity));
  assert.equal(context.confidence, Math.round(80 * 0.7));
  assert.ok(context.secondaryNarrative.includes("Liquidity"));
});

test("fuseContext: empate 1-1 sem terceiro desempatando -- 2 conflitos, penalidade 0.4x", () => {
  const context = fuseContext({
    market: marketResult({ trendState: "TRENDING_BULL" }),
    structure: structureResult({ bias: "bearish" }), // discorda do market
    liquidity: liquidityResult({ state: "BALANCED" }), // neutro
  });

  assert.equal(context.conflicts.length, 2);
  assert.equal(context.confidence, Math.round(80 * 0.4));
});

test("fuseContext: reasons inclui o resumo de cada Brain + os conflitos", () => {
  const context = fuseContext({ market: marketResult(), structure: structureResult({ bias: "bearish" }), liquidity: liquidityResult() });
  assert.ok(context.reasons.some((r) => r.startsWith("Market Brain:")));
  assert.ok(context.reasons.some((r) => r.startsWith("Structure Brain:")));
  assert.ok(context.reasons.some((r) => r.startsWith("Liquidity Brain:")));
  assert.ok(context.reasons.some((r) => r.includes("discorda do consenso")));
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

test("fuseContext: 3 Brains discordando (bull/bear/neutro) -- nunca quebra", () => {
  const context = fuseContext({
    market: marketResult({ trendState: "TRENDING_BULL" }),
    structure: structureResult({ bias: "bearish" }),
    liquidity: liquidityResult({ state: "BALANCED" }),
  });
  assert.ok(["FUSED_BULLISH", "FUSED_BEARISH", "FUSED_NEUTRAL"].includes(context.state));
});
