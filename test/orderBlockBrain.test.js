const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeOrderBlocks, classifyLifecycleStage, computeStrength } = require("../lib/brains/orderBlockBrain");

function candle(t, open, high, low, close, volume) {
  return [t, open, high, low, close, volume];
}
function flatCandle(t, price) {
  return candle(t, price, price, price, price, 1);
}
function brainResult(overrides = {}) {
  return {
    state: "X",
    confidence: 80,
    score: 50,
    reasons: ["r"],
    evidence: [],
    missingEvidence: [],
    metadata: { generatedAt: "2026-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

const LIFECYCLE_OPTS = { confirmAge: 3, mitigationThreshold: 0.5, exhaustionLookback: 50 };

// --- classifyLifecycleStage (pura, cobre os 6 estágios que ela decide --
// ACTIVE é promovido no nível do Brain, coberto no teste de integração) ---

test("classifyLifecycleStage: nunca tocado e idade < confirmAge -- DETECTED", () => {
  const block = { createdIndex: 100 };
  const lifecycleData = { touched: false, maxPenetrationPct: 0, brokenAtIndex: null };
  assert.equal(classifyLifecycleStage(block, lifecycleData, { now: 101, ...LIFECYCLE_OPTS }), "DETECTED");
});

test("classifyLifecycleStage: nunca tocado e idade >= confirmAge -- CONFIRMED", () => {
  const block = { createdIndex: 100 };
  const lifecycleData = { touched: false, maxPenetrationPct: 0, brokenAtIndex: null };
  assert.equal(classifyLifecycleStage(block, lifecycleData, { now: 110, ...LIFECYCLE_OPTS }), "CONFIRMED");
});

test("classifyLifecycleStage: tocado mas penetração abaixo do threshold -- TESTED", () => {
  const block = { createdIndex: 100 };
  const lifecycleData = { touched: true, maxPenetrationPct: 0.2, brokenAtIndex: null };
  assert.equal(classifyLifecycleStage(block, lifecycleData, { now: 110, ...LIFECYCLE_OPTS }), "TESTED");
});

test("classifyLifecycleStage: penetração no threshold ou acima -- MITIGATED", () => {
  const block = { createdIndex: 100 };
  const lifecycleData = { touched: true, maxPenetrationPct: 0.5, brokenAtIndex: null };
  assert.equal(classifyLifecycleStage(block, lifecycleData, { now: 110, ...LIFECYCLE_OPTS }), "MITIGATED");
});

test("classifyLifecycleStage: rompido há pouco tempo -- BROKEN", () => {
  const block = { createdIndex: 100 };
  const lifecycleData = { touched: true, maxPenetrationPct: 1, brokenAtIndex: 150 };
  assert.equal(classifyLifecycleStage(block, lifecycleData, { now: 160, ...LIFECYCLE_OPTS }), "BROKEN");
});

test("classifyLifecycleStage: rompido há mais que exhaustionLookback candles sem nova atividade -- INVALIDATED", () => {
  const block = { createdIndex: 100 };
  const lifecycleData = { touched: true, maxPenetrationPct: 1, brokenAtIndex: 150 };
  assert.equal(classifyLifecycleStage(block, lifecycleData, { now: 250, ...LIFECYCLE_OPTS }), "INVALIDATED");
});

// --- computeStrength (pura) ---

test("computeStrength: magnitude do movimento até o candle de confirmação, escalada e limitada a 100", () => {
  const block = { direction: "bullish", high: 10, confirmedAtIndex: 1 };
  const candles = [flatCandle(0, 0), candle(1, 10, 10.1, 9.9, 10.05, 1)];
  assert.equal(computeStrength(block, candles), 10);
});

// --- analyzeOrderBlocks (integração) ---
// Fixture verificado rodando o código real (script descartável) antes de
// fixar os asserts -- candle oposto (bearish) imediatamente antes do
// candle impulsivo (bullish) que carrega o evento BOS.

function fixtureWithOneBlock() {
  const padding = Array.from({ length: 200 }, (_, i) => flatCandle(i * 60000, 10));
  const obCandle = candle(200 * 60000, 10, 10.5, 9.5, 9.8, 1);
  const impulseCandle = candle(201 * 60000, 12, 16, 11, 15, 1);
  const afterCandles = Array.from({ length: 5 }, (_, i) => candle((202 + i) * 60000, 13, 14, 13, 13.5, 1));
  return [...padding, obCandle, impulseCandle, ...afterCandles];
}

function structureWithBOS(bias) {
  return brainResult({ trend: { bias }, evidence: [{ type: "BOS", payload: { candleIndex: 201, direction: "bullish" } }] });
}

const liquidityBull = () => brainResult({ state: "LIQUIDITY_ABOVE" });
const liquidityBear = () => brainResult({ state: "LIQUIDITY_BELOW" });
const contextBull = () => brainResult({ state: "FUSED_BULLISH" });
const contextBear = () => brainResult({ state: "FUSED_BEARISH" });

test("analyzeOrderBlocks: dado insuficiente -- EMPTY/0/0, forma completa mesmo vazia", () => {
  const result = analyzeOrderBlocks({ candles: [], structure: structureWithBOS("bullish"), liquidity: liquidityBull(), context: contextBull(), ...LIFECYCLE_OPTS });
  assert.equal(result.state, "EMPTY");
  assert.equal(result.confidence, 0);
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, ["dado histórico insuficiente"]);
  assert.deepEqual(result.zones, []);
  assert.deepEqual(result.activeBlocks, []);
});

test("analyzeOrderBlocks: único bloco confirmado -- promovido a ACTIVE, alinhado com os 3 contextos -- score alto", () => {
  const result = analyzeOrderBlocks({ candles: fixtureWithOneBlock(), structure: structureWithBOS("bullish"), liquidity: liquidityBull(), context: contextBull(), ...LIFECYCLE_OPTS });
  assert.equal(result.state, "ACTIVE");
  assert.equal(result.score, 100);
  assert.equal(result.activeBlocks.length, 1);
  assert.ok(result.reasons[0].includes("alinhado com o contexto"));
});

test("analyzeOrderBlocks: mesmo bloco, mas contexto inteiro contra -- score baixo, reasons diz 'baixa prioridade'", () => {
  const result = analyzeOrderBlocks({ candles: fixtureWithOneBlock(), structure: structureWithBOS("bearish"), liquidity: liquidityBear(), context: contextBear(), ...LIFECYCLE_OPTS });
  assert.equal(result.state, "ACTIVE");
  assert.equal(result.score, 0);
  assert.ok(result.reasons[0].includes("baixa prioridade"));
});

test("analyzeOrderBlocks: evidence tipado e metadata.dependsOn/missingEvidence apontam pro Institutional Context", () => {
  const result = analyzeOrderBlocks({ candles: fixtureWithOneBlock(), structure: structureWithBOS("bullish"), liquidity: liquidityBull(), context: contextBull(), ...LIFECYCLE_OPTS });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].type, "BULLISH_OB");
  assert.equal(typeof result.evidence[0].confidence, "number");
  assert.equal(typeof result.evidence[0].weight, "number");
  assert.equal(typeof result.evidence[0].timestamp, "string");
  assert.deepEqual(result.metadata.dependsOn, ["candles", "structure_brain", "liquidity_brain", "context_fusion"]);
  assert.deepEqual(result.missingEvidence, ["Institutional Context (Liquidity+FVG+Order Blocks)"]);
});
