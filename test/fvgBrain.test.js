const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeFVG, computeAlignment, scoreFromAlignment, classifyGapFillState, directionFromContext } = require("../lib/brains/fvgBrain");

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

const structureBull = () => brainResult({ trend: { bias: "bullish" } });
const structureBear = () => brainResult({ trend: { bias: "bearish" } });
const structureNeutral = () => brainResult({ trend: { bias: null } });
const liquidityBull = () => brainResult({ state: "LIQUIDITY_ABOVE" });
const liquidityBear = () => brainResult({ state: "LIQUIDITY_BELOW" });
const liquidityNeutral = () => brainResult({ state: "BALANCED" });
const contextBull = () => brainResult({ state: "FUSED_BULLISH" });
const contextBear = () => brainResult({ state: "FUSED_BEARISH" });
const contextNeutral = () => brainResult({ state: "FUSED_NEUTRAL" });

// --- funções puras isoladas ---

test("directionFromContext: FUSED_BULLISH/BEARISH/NEUTRAL mapeiam pra bull/bear/null", () => {
  assert.equal(directionFromContext({ state: "FUSED_BULLISH" }), "bull");
  assert.equal(directionFromContext({ state: "FUSED_BEARISH" }), "bear");
  assert.equal(directionFromContext({ state: "FUSED_NEUTRAL" }), null);
});

test("computeAlignment: gap bullish com os 3 contextos concordando -- 3 a favor, 0 contra", () => {
  const alignment = computeAlignment("bullish", { structure: structureBull(), liquidity: liquidityBull(), context: contextBull() });
  assert.deepEqual(alignment, { agreeing: 3, opposing: 0, totalWithDirection: 3 });
});

test("computeAlignment: gap bullish com os 3 contextos contra -- 0 a favor, 3 contra", () => {
  const alignment = computeAlignment("bullish", { structure: structureBear(), liquidity: liquidityBear(), context: contextBear() });
  assert.deepEqual(alignment, { agreeing: 0, opposing: 3, totalWithDirection: 3 });
});

test("computeAlignment: contextos neutros não contam nem a favor nem contra", () => {
  const alignment = computeAlignment("bullish", { structure: structureNeutral(), liquidity: liquidityNeutral(), context: contextNeutral() });
  assert.deepEqual(alignment, { agreeing: 0, opposing: 0, totalWithDirection: 0 });
});

test("scoreFromAlignment: totalmente alinhado=100, totalmente contra=0, neutro=50", () => {
  assert.equal(scoreFromAlignment({ agreeing: 3, opposing: 0 }), 100);
  assert.equal(scoreFromAlignment({ agreeing: 0, opposing: 3 }), 0);
  assert.equal(scoreFromAlignment({ agreeing: 0, opposing: 0 }), 50);
});

test("classifyGapFillState: ACTIVE/REBALANCING/FILLED/EXHAUSTED conforme o toque e o tempo desde o preenchimento", () => {
  const gap = { direction: "bullish", createdIndex: 1, low: 10, high: 12 };
  const naoTocado = [flatCandle(0, 0), flatCandle(1, 0), flatCandle(2, 0), candle(3, 13, 14, 13, 13.5, 1)];
  assert.equal(classifyGapFillState(gap, naoTocado, 50), "ACTIVE");

  const tocadoSemPreencher = [flatCandle(0, 0), flatCandle(1, 0), flatCandle(2, 0), candle(3, 12, 12.5, 11, 12, 1)];
  assert.equal(classifyGapFillState(gap, tocadoSemPreencher, 50), "REBALANCING");

  const preenchidoRecente = [flatCandle(0, 0), flatCandle(1, 0), flatCandle(2, 0), candle(3, 11, 11, 9, 10, 1)];
  assert.equal(classifyGapFillState(gap, preenchidoRecente, 50), "FILLED");

  const preenchidoAntigo = [...preenchidoRecente, ...Array.from({ length: 60 }, (_, i) => flatCandle((4 + i) * 60000, 10))];
  assert.equal(classifyGapFillState(gap, preenchidoAntigo, 50), "EXHAUSTED");
});

// --- analyzeFVG (integração) ---
// Fixture verificado rodando o código real (script descartável) antes de
// fixar os asserts -- padding no MESMO nível de preço do início do gap
// (evita gap artificial na fronteira entre padding e o fixture).

function fixtureWithOneGap() {
  const padding = Array.from({ length: 195 }, (_, i) => flatCandle(i * 60000, 10));
  const gapCandles = [candle(195 * 60000, 9, 10, 9, 9.5, 1), candle(196 * 60000, 10, 15, 10, 14, 1), candle(197 * 60000, 14, 15, 12, 13, 1)];
  const tailPadding = [flatCandle(198 * 60000, 13), flatCandle(199 * 60000, 13)];
  return [...padding, ...gapCandles, ...tailPadding];
}

test("analyzeFVG: dado insuficiente -- EMPTY/0/0, forma completa mesmo vazia", () => {
  const result = analyzeFVG({ candles: [], structure: structureBull(), liquidity: liquidityBull(), context: contextBull(), exhaustionLookback: 50 });
  assert.equal(result.state, "EMPTY");
  assert.equal(result.confidence, 0);
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, ["dado histórico insuficiente"]);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.nearestGap, null);
  assert.equal(result.imbalanceDirection, null);
});

test("analyzeFVG: sem nenhum gap no histórico -- EMPTY", () => {
  const noGap = Array.from({ length: 220 }, (_, i) => flatCandle(i * 60000, 10));
  const result = analyzeFVG({ candles: noGap, structure: structureBull(), liquidity: liquidityBull(), context: contextBull(), exhaustionLookback: 50 });
  assert.equal(result.state, "EMPTY");
  assert.deepEqual(result.gaps, []);
});

test("analyzeFVG: gap alinhado com os 3 contextos -- score alto, reasons diz 'alinhado com o contexto'", () => {
  const result = analyzeFVG({ candles: fixtureWithOneGap(), structure: structureBull(), liquidity: liquidityBull(), context: contextBull(), exhaustionLookback: 50 });
  assert.equal(result.state, "IMBALANCED");
  assert.equal(result.score, 100);
  assert.ok(result.reasons[0].includes("alinhado com o contexto"));
  assert.equal(result.imbalanceDirection, "bullish");
});

test("analyzeFVG: mesmo gap, mas contexto inteiro contra -- score baixo, reasons diz 'baixa prioridade'", () => {
  const result = analyzeFVG({ candles: fixtureWithOneGap(), structure: structureBear(), liquidity: liquidityBear(), context: contextBear(), exhaustionLookback: 50 });
  assert.equal(result.state, "IMBALANCED");
  assert.equal(result.score, 0);
  assert.ok(result.reasons[0].includes("baixa prioridade"));
});

test("analyzeFVG: evidence tipado e metadata.dependsOn inclui os outros Brains", () => {
  const result = analyzeFVG({ candles: fixtureWithOneGap(), structure: structureBull(), liquidity: liquidityBull(), context: contextBull(), exhaustionLookback: 50 });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].type, "BULLISH_FVG");
  assert.equal(typeof result.evidence[0].confidence, "number");
  assert.equal(typeof result.evidence[0].weight, "number");
  assert.equal(typeof result.evidence[0].timestamp, "string");
  assert.deepEqual(result.metadata.dependsOn, ["candles", "structure_brain", "liquidity_brain", "context_fusion"]);
  assert.deepEqual(result.missingEvidence, ["Order Blocks", "Institutional Context (Liquidity+FVG+Order Blocks)"]);
});
