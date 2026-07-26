const test = require("node:test");
const assert = require("node:assert/strict");
const { runReplay, gradeOutcome, extractNewEvents, computeStats, computeTransitions, classifyDirectionalOutcome, directionForBrain } = require("../lib/replayEngine");

function candle(t, open, high, low, close, volume) {
  return [t, open, high, low, close, volume];
}
function flatCandle(t, price) {
  return candle(t, price, price, price, price, 1);
}

// Fixtures verificadas rodando o código real (script descartável) antes
// de fixar os asserts -- mesma disciplina de sempre.

// --- gradeOutcome (pura) ---

test("gradeOutcome: sem candles futuros suficientes -- PENDING", () => {
  const candles = Array.from({ length: 50 }, (_, i) => flatCandle(i * 60000, 100 + i * 0.1));
  assert.deepEqual(gradeOutcome(candles, 45, 30, 0.3, "FUSED_BULLISH"), { outcome: "PENDING", forwardReturnPct: null, maxAdverseExcursionPct: null });
});

test("gradeOutcome: contexto bullish e preço sobe além do threshold -- SUCCESS", () => {
  const candles = Array.from({ length: 50 }, (_, i) => flatCandle(i * 60000, 100 + i * 0.1));
  const result = gradeOutcome(candles, 10, 30, 0.3, "FUSED_BULLISH");
  assert.equal(result.outcome, "SUCCESS");
  assert.ok(result.forwardReturnPct > 0.3);
});

test("gradeOutcome: contexto bullish mas preço cai além do threshold -- FAIL", () => {
  const candles = Array.from({ length: 50 }, (_, i) => flatCandle(i * 60000, 100 - i * 0.1));
  const result = gradeOutcome(candles, 10, 30, 0.3, "FUSED_BULLISH");
  assert.equal(result.outcome, "FAIL");
  assert.ok(result.forwardReturnPct < -0.3);
});

test("gradeOutcome: contexto neutro -- NOT_GRADED mesmo com retorno calculável, sem excursão adversa (nenhuma direção apostada)", () => {
  const candles = Array.from({ length: 50 }, (_, i) => flatCandle(i * 60000, 100 + i * 0.1));
  const result = gradeOutcome(candles, 10, 30, 0.3, "FUSED_NEUTRAL");
  assert.equal(result.outcome, "NOT_GRADED");
  assert.equal(typeof result.forwardReturnPct, "number");
  assert.equal(result.maxAdverseExcursionPct, null);
});

test("gradeOutcome: retorno dentro do threshold -- INCONCLUSIVE", () => {
  const candles = Array.from({ length: 50 }, () => flatCandle(0, 100));
  const result = gradeOutcome(candles, 10, 30, 0.3, "FUSED_BULLISH");
  assert.deepEqual(result, { outcome: "INCONCLUSIVE", forwardReturnPct: 0, maxAdverseExcursionPct: 0 });
});

test("gradeOutcome: maxAdverseExcursionPct mede o pior mergulho contra a direção, não só o retorno final", () => {
  const candles = [candle(0, 100, 100, 100, 100, 1), candle(1, 100, 100, 95, 98, 1), candle(2, 98, 105, 97, 105, 1)];
  const result = gradeOutcome(candles, 0, 2, 0.3, "FUSED_BULLISH");
  assert.equal(result.outcome, "SUCCESS");
  assert.equal(result.forwardReturnPct, 5);
  assert.equal(result.maxAdverseExcursionPct, 5);
});

// --- classifyDirectionalOutcome / directionForBrain (puras) ---

test("classifyDirectionalOutcome: sem direção -- NOT_GRADED", () => {
  assert.equal(classifyDirectionalOutcome(null, 1.0, 0.3), "NOT_GRADED");
});

test("directionForBrain: extrai a direção certa de cada Brain (bull/bear/null), inclusive quando não há bloco/zona dominante", () => {
  assert.equal(directionForBrain("market", { market: { trend: { state: "TRENDING_BULL" } } }), "bull");
  assert.equal(directionForBrain("structure", { structure: { trend: { bias: "bearish" } } }), "bear");
  assert.equal(directionForBrain("liquidity", { liquidity: { state: "LIQUIDITY_ABOVE" } }), "bull");
  assert.equal(directionForBrain("context", { context: { state: "FUSED_NEUTRAL" } }), null);
  assert.equal(directionForBrain("fvg", { fvg: { imbalanceDirection: "bullish" } }), "bull");
  assert.equal(directionForBrain("orderBlock", { orderBlock: { dominantBlock: null } }), null);
  assert.equal(directionForBrain("institutional", { institutional: { dominantZone: { direction: "bearish" } } }), "bear");
});

// --- extractNewEvents (pura) ---

test("extractNewEvents: só evidência mais nova que o último snapshot, ordenada cronologicamente, com o Brain de origem", () => {
  const brains = {
    structure: { evidence: [{ type: "BOS", timestamp: "2026-01-01T00:05:00.000Z" }, { type: "CHOCH", timestamp: "2026-01-01T00:01:00.000Z" }] },
    liquidity: { evidence: [{ type: "SWEEP_HIGH", timestamp: "2026-01-01T00:03:00.000Z" }] },
    fvg: { evidence: [] },
    orderBlock: { evidence: [] },
  };
  const lastSnapshotTime = new Date("2026-01-01T00:02:00.000Z").getTime();
  assert.deepEqual(extractNewEvents(brains, lastSnapshotTime), [
    { brain: "liquidity", type: "SWEEP_HIGH", timestamp: "2026-01-01T00:03:00.000Z" },
    { brain: "structure", type: "BOS", timestamp: "2026-01-01T00:05:00.000Z" },
  ]);
});

// --- computeStats (pura) ---

test("computeStats: agrupa por combinação real de states, exclui PENDING/NOT_GRADED, successRate/avgForwardReturnPct/avgDrawdownPct/confidenceLabel corretos", () => {
  function snap(structureState, liquidityState, outcome, forwardReturnPct, maxAdverseExcursionPct) {
    return { brains: { structure: { state: structureState }, liquidity: { state: liquidityState } }, outcome, forwardReturnPct, maxAdverseExcursionPct };
  }
  const snapshots = [
    snap("GOOD", "BALANCED", "SUCCESS", 1.0, 0.2),
    snap("GOOD", "BALANCED", "SUCCESS", 2.0, 0.5),
    snap("GOOD", "BALANCED", "FAIL", -1.0, 1.5),
    snap("WEAK", "BALANCED", "FAIL", -0.5, 0.8),
    snap("GOOD", "BALANCED", "PENDING", null, null),
    snap("GOOD", "BALANCED", "NOT_GRADED", 0.1, null),
  ];
  assert.deepEqual(computeStats(snapshots, ["structure", "liquidity"]), [
    { comboKey: "structure:GOOD|liquidity:BALANCED", count: 3, successRate: 67, avgForwardReturnPct: 0.667, avgDrawdownPct: 0.733, confidenceLabel: "Baixa" },
    { comboKey: "structure:WEAK|liquidity:BALANCED", count: 1, successRate: 0, avgForwardReturnPct: -0.5, avgDrawdownPct: 0.8, confidenceLabel: "Baixa" },
  ]);
});

// --- computeTransitions (pura) ---

test("computeTransitions: colapsa repetições consecutivas, mantém só as mudanças de estado", () => {
  function ctxSnap(state, timestamp) {
    return { brains: { context: { state } }, timestamp };
  }
  const snapshots = [ctxSnap("FUSED_BULLISH", 1), ctxSnap("FUSED_BULLISH", 2), ctxSnap("FUSED_NEUTRAL", 3), ctxSnap("FUSED_NEUTRAL", 4), ctxSnap("FUSED_BEARISH", 5)];
  assert.deepEqual(computeTransitions(snapshots, "context"), [
    { state: "FUSED_BULLISH", timestamp: 1 },
    { state: "FUSED_NEUTRAL", timestamp: 3 },
    { state: "FUSED_BEARISH", timestamp: 5 },
  ]);
});

// --- runReplay (integração) ---
// Fixture verificada rodando o código real (script descartável) antes de
// fixar os asserts -- 200 candles de padding (mínimo pra nenhum Brain cair
// em "dado insuficiente") + 60 com leve tendência, o bastante pra testar
// ORQUESTRAÇÃO (cadência de passos, formato do snapshot, PENDING no fim),
// não qualidade de sinal (isso já é testado Brain a Brain).

function buildFixture() {
  const candles = [];
  for (let i = 0; i < 200; i++) candles.push(flatCandle(i * 60000, 100));
  for (let i = 0; i < 60; i++) candles.push(candle((200 + i) * 60000, 100 + i * 0.05, 100.5 + i * 0.05, 99.5 + i * 0.05, 100.1 + i * 0.05, 1));
  return candles;
}

const REPLAY_OPTIONS = {
  stepCandles: 10,
  windowCandles: 200,
  outcomeHorizonCandles: 20,
  outcomeThresholdPct: 0.3,
  structureLookback: 5,
  equalTolerancePct: 0.1,
  sweepReversalLookahead: 10,
  exhaustionLookback: 50,
  confirmAge: 3,
  mitigationThreshold: 0.5,
};

test("runReplay: cadência de passos correta e snapshot com os 7 Brains resumidos", () => {
  const candles = buildFixture();
  const snapshots = runReplay(candles, REPLAY_OPTIONS);
  const expectedSteps = Math.floor((candles.length - REPLAY_OPTIONS.windowCandles) / REPLAY_OPTIONS.stepCandles) + 1;
  assert.equal(snapshots.length, expectedSteps);
  assert.deepEqual(Object.keys(snapshots[0].brains), ["market", "structure", "liquidity", "context", "fvg", "orderBlock", "institutional"]);
});

test("runReplay: Market Brain só usa o eixo tendência -- sentimento/risco marcados como indisponíveis, sem vazamento de dado futuro", () => {
  const candles = buildFixture();
  const snapshots = runReplay(candles, REPLAY_OPTIONS);
  // confidence = média dos 3 eixos (trend com dado real=100, sentiment/risk=0 por dado indisponível) -- 33, não mais que isso
  assert.equal(snapshots[0].brains.market.confidence, 33);
});

test("runReplay: cada Brain no snapshot carrega sua própria direção (bull/bear/null), não só o state", () => {
  const candles = buildFixture();
  const snapshots = runReplay(candles, REPLAY_OPTIONS);
  for (const key of Object.keys(snapshots[0].brains)) {
    assert.ok("direction" in snapshots[0].brains[key], `${key} deveria expor direction`);
  }
});

test("runReplay: últimos passos sem candles futuros suficientes -- PENDING", () => {
  const candles = buildFixture();
  const snapshots = runReplay(candles, REPLAY_OPTIONS);
  assert.equal(snapshots[snapshots.length - 1].outcome, "PENDING");
});
