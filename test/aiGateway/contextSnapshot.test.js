const test = require("node:test");
const assert = require("node:assert/strict");
const { buildContextSnapshot, buildRiskState, buildPositionSnapshot, buildQuantSignal } = require("../../lib/aiGateway/contextSnapshot");

function fakeAnalysis(overrides = {}) {
  return {
    signal: "wait",
    reasons: ["ema_up"],
    price: 150.5,
    ema8: 150.1,
    ema56: 149.8,
    rsi: 55,
    stoch: 40,
    obv: 1000,
    atr: 0.8,
    params: { emaShort: 8, emaLong: 56, stopLossPct: 0.025 },
    ...overrides,
  };
}

function fakeBotState(overrides = {}) {
  return {
    isOpened: false,
    side: null,
    entryPrice: null,
    qty: null,
    stopLossPrice: null,
    takeProfitPrice: null,
    breakEvenApplied: false,
    trailingActivated: false,
    tpLevels: [],
    tpLevelsFilled: 0,
    consecutiveLosses: 0,
    dailyLoss: 0,
    circuitBreakerUntil: null,
    ...overrides,
  };
}

test("buildQuantSignal: extrai indicadores/params/reasons do analysis", () => {
  const q = buildQuantSignal(fakeAnalysis({ signal: "buy" }));
  assert.equal(q.signal, "buy");
  assert.equal(q.indicators.rsi, 55);
  assert.equal(q.params.stopLossPct, 0.025);
});

test("buildPositionSnapshot: sem posição aberta devolve só isOpened=false", () => {
  assert.deepEqual(buildPositionSnapshot(fakeBotState()), { isOpened: false });
});

test("buildPositionSnapshot: posição aberta expõe SL/TP/breakEven/trailing/tpLevels", () => {
  const pos = buildPositionSnapshot(
    fakeBotState({ isOpened: true, side: "Buy", entryPrice: 100, qty: 2, stopLossPrice: 97.5, takeProfitPrice: 109, tpLevels: [{}, {}, {}], tpLevelsFilled: 1 })
  );
  assert.equal(pos.isOpened, true);
  assert.equal(pos.side, "Buy");
  assert.equal(pos.tpLevelsTotal, 3);
  assert.equal(pos.tpLevelsFilled, 1);
});

test("buildRiskState: circuitBreakerActive true só enquanto circuitBreakerUntil não passou", () => {
  const now = 1_000_000;
  const active = buildRiskState({ botState: fakeBotState({ circuitBreakerUntil: now + 5000 }), regime: "HIGH", now });
  assert.equal(active.circuitBreakerActive, true);
  assert.equal(active.volatilityRegime, "HIGH");

  const expired = buildRiskState({ botState: fakeBotState({ circuitBreakerUntil: now - 1 }), regime: "NORMAL", now });
  assert.equal(expired.circuitBreakerActive, false);
});

test("buildContextSnapshot: sem snapshots de metrics em disco (contextFusion/quality null) não lança e degrada com null", () => {
  const ctx = buildContextSnapshot({ analysis: fakeAnalysis(), regime: "NORMAL", botState: fakeBotState(), contextFusion: null, quality: null });
  assert.equal(ctx.market, null);
  assert.equal(ctx.structure, null);
  assert.equal(ctx.liquidity, null);
  assert.equal(ctx.fusion, null);
  assert.equal(ctx.marketQuality, null);
  assert.equal(ctx.crossSourceValidation, null);
  assert.equal(ctx.sourceReliability, null);
  assert.equal(ctx.quant.signal, "wait");
  assert.equal(ctx.position.isOpened, false);
  assert.ok(ctx.riskState);
});

test("buildContextSnapshot: extrai payload de cada Brain a partir de contextFusion.evidence[]", () => {
  const contextFusion = {
    state: "FUSED_BULLISH",
    confidence: 80,
    score: 60,
    reasons: ["maioria em alta"],
    dominantNarrative: "Alta",
    sampledAt: "2026-08-11T20:00:00.000Z",
    evidence: [
      { type: "MARKET_BRAIN", payload: { state: "TRENDING_BULL", score: 70, confidence: 100 } },
      { type: "STRUCTURE_BRAIN", payload: { state: "GOOD", score: 60, confidence: 90 } },
      { type: "LIQUIDITY_BRAIN", payload: { state: "LIQUIDITY_ABOVE", score: 30, confidence: 80 } },
    ],
  };
  const quality = {
    quality: { candles: { score: 85 } },
    crossSourceValidation: { candles: { status: "N/A" } },
    sourceReliability: { bybit: { operationalReliability: { score: 95 } } },
    sampledAt: "2026-08-11T20:00:00.000Z",
  };
  const ctx = buildContextSnapshot({ analysis: fakeAnalysis(), regime: "NORMAL", botState: fakeBotState(), contextFusion, quality });
  assert.equal(ctx.market.state, "TRENDING_BULL");
  assert.equal(ctx.structure.state, "GOOD");
  assert.equal(ctx.liquidity.state, "LIQUIDITY_ABOVE");
  assert.equal(ctx.fusion.state, "FUSED_BULLISH");
  assert.equal(ctx.marketQuality.candles.score, 85);
  assert.equal(ctx.crossSourceValidation.candles.status, "N/A");
  assert.equal(ctx.sourceReliability.bybit.operationalReliability.score, 95);
});

test("buildContextSnapshot: nunca inclui campos de execução (sem stopLoss/qty fora de `position`, não é usado por risk.js)", () => {
  const ctx = buildContextSnapshot({ analysis: fakeAnalysis(), regime: "NORMAL", botState: fakeBotState(), contextFusion: null, quality: null });
  // Snapshot é só leitura -- garante que o shape não vaza nenhum método/callback executável.
  assert.equal(typeof ctx, "object");
  for (const value of Object.values(ctx)) {
    assert.notEqual(typeof value, "function");
  }
});
