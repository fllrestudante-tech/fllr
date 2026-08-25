const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  buildContextSnapshot,
  buildRiskState,
  buildPositionSnapshot,
  buildQuantSignal,
  selectLastClosedCandle,
  selectLastClosedCandleTimestampMs,
  candleEndMs,
  validateCandleTimestampMs,
  INTERVAL_DURATION_MS,
} = require("../../lib/aiGateway/contextSnapshot");
const { hashContext } = require("../../lib/aiGateway/aiGateway");

// [startTime, open, high, low, close, volume] -- mesmo shape que
// lib/bybit.js::getKlines devolve (startTime ja como number).
function candle(startTimeMs) {
  return [startTimeMs, "1", "1", "1", "1", "1"];
}

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

// =====================================================================
// candleEndMs -- duracao FIXA (numericos, D, W) e alinhamento de mes (M)
// =====================================================================

test("candleEndMs: cada intervalo numerico conhecido produz a duracao exata documentada", () => {
  const start = 1_700_000_000_000;
  for (const [interval, durationMs] of Object.entries(INTERVAL_DURATION_MS)) {
    assert.equal(candleEndMs(start, interval), start + durationMs, `intervalo "${interval}"`);
  }
});

test("candleEndMs: intervalo desconhecido -> null, nunca adivinha", () => {
  assert.equal(candleEndMs(1000, "9999"), null);
  assert.equal(candleEndMs(1000, "invalid"), null);
  assert.equal(candleEndMs(1000, undefined), null);
});

test("candleEndMs: D (dia) atravessa virada de ano corretamente em UTC", () => {
  const dec31Utc = Date.UTC(2026, 11, 31, 0, 0, 0); // 2026-12-31T00:00:00Z
  const end = candleEndMs(dec31Utc, "D");
  assert.equal(new Date(end).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("candleEndMs: W (semana) atravessa virada de mes corretamente em UTC", () => {
  const feb25Utc = Date.UTC(2026, 1, 25, 0, 0, 0); // 2026-02-25T00:00:00Z
  const end = candleEndMs(feb25Utc, "W");
  assert.equal(new Date(end).toISOString(), "2026-03-04T00:00:00.000Z");
});

test("candleEndMs: M (mes) alinhado ao 1o dia UTC -- fronteira correta, incluindo Fev bissexto e meses de 30/31 dias", () => {
  assert.equal(candleEndMs(Date.UTC(2026, 0, 1, 0, 0, 0), "M"), Date.UTC(2026, 1, 1, 0, 0, 0)); // Jan(31) -> Fev
  assert.equal(candleEndMs(Date.UTC(2028, 1, 1, 0, 0, 0), "M"), Date.UTC(2028, 2, 1, 0, 0, 0)); // Fev bissexto(29) -> Mar
  assert.equal(candleEndMs(Date.UTC(2026, 3, 1, 0, 0, 0), "M"), Date.UTC(2026, 4, 1, 0, 0, 0)); // Abr(30) -> Mai
  assert.equal(candleEndMs(Date.UTC(2026, 11, 1, 0, 0, 0), "M"), Date.UTC(2027, 0, 1, 0, 0, 0)); // Dez -> virada de ano
});

test("candleEndMs: M (mes) DESALINHADO (nao comeca no dia 1 UTC 00:00:00) falha fechado -- nunca calcula 'mesmo dia do mes seguinte'", () => {
  assert.equal(candleEndMs(Date.UTC(2026, 0, 15, 0, 0, 0), "M"), null); // dia 15, nao dia 1
  assert.equal(candleEndMs(Date.UTC(2026, 0, 1, 3, 0, 0), "M"), null); // hora != 00:00:00
  assert.equal(candleEndMs(Date.UTC(2026, 0, 1, 0, 0, 1), "M"), null); // segundo != 0
});

test("candleEndMs: startTimeMs invalido (nao-numero, negativo, decimal, string) -> null", () => {
  assert.equal(candleEndMs("1700000000000", "D"), null); // string -- nunca convertida implicitamente
  assert.equal(candleEndMs(-1, "D"), null);
  assert.equal(candleEndMs(1000.5, "D"), null);
  assert.equal(candleEndMs(NaN, "D"), null);
  assert.equal(candleEndMs(null, "D"), null);
  assert.equal(candleEndMs(undefined, "D"), null);
});

// =====================================================================
// validateCandleTimestampMs -- sem coercao implicita
// =====================================================================

test("validateCandleTimestampMs: aceita apenas number inteiro seguro nao-negativo", () => {
  assert.equal(validateCandleTimestampMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(validateCandleTimestampMs(0), 0);
});

test("validateCandleTimestampMs: rejeita string numerica -- NUNCA converte implicitamente (mesma rigidez do fingerprint)", () => {
  assert.equal(validateCandleTimestampMs("1700000000000"), null);
});

test("validateCandleTimestampMs: rejeita negativo, decimal, NaN, Infinity, null, undefined, objeto", () => {
  assert.equal(validateCandleTimestampMs(-1), null);
  assert.equal(validateCandleTimestampMs(1000.5), null);
  assert.equal(validateCandleTimestampMs(NaN), null);
  assert.equal(validateCandleTimestampMs(Infinity), null);
  assert.equal(validateCandleTimestampMs(null), null);
  assert.equal(validateCandleTimestampMs(undefined), null);
  assert.equal(validateCandleTimestampMs({}), null);
});

// =====================================================================
// selectLastClosedCandle -- algoritmo definitivo, sem indice fixo
// =====================================================================

test("selectLastClosedCandle: caso comum -- ultimo candle ainda em formacao, devolve o PENULTIMO", () => {
  const candles = [candle(0), candle(60_000), candle(120_000)]; // interval "1" (60s cada)
  const result = selectLastClosedCandle(candles, "1", 122_000); // 120000+60000=180000 > now (aberto); 60000+60000=120000 <= now (fechado)
  assert.deepEqual(result, candle(60_000));
});

test("selectLastClosedCandle: CASO CRITICO -- API atrasada, ATE o ultimo candle ja fechou -- devolve o ULTIMO, nao o penultimo (prova da correcao do bug)", () => {
  const candles = [candle(0), candle(60_000), candle(120_000)];
  const result = selectLastClosedCandle(candles, "1", 999_999); // todos ja fechados havia tempo
  assert.deepEqual(result, candle(120_000), "deveria escolher o ULTIMO candle, ja que ele tambem esta genuinamente fechado");
});

test("selectLastClosedCandle: nenhum candle fechado (dados atrasados/relogio adiantado) -> null", () => {
  const candles = [candle(1_000_000)];
  assert.equal(selectLastClosedCandle(candles, "1", 1_000_001), null); // candle so fecha em 1060000
});

test("selectLastClosedCandle: array vazio -> null", () => {
  assert.equal(selectLastClosedCandle([], "1", 1_000_000), null);
});

test("selectLastClosedCandle: candles nao-array (undefined/null/string) -> null", () => {
  assert.equal(selectLastClosedCandle(undefined, "1", 1_000_000), null);
  assert.equal(selectLastClosedCandle(null, "1", 1_000_000), null);
  assert.equal(selectLastClosedCandle("not-an-array", "1", 1_000_000), null);
});

test("selectLastClosedCandle: 1 candle fechado -> devolve ele; 1 candle aberto -> null", () => {
  assert.deepEqual(selectLastClosedCandle([candle(0)], "1", 60_000), candle(0));
  assert.equal(selectLastClosedCandle([candle(0)], "1", 30_000), null);
});

test("selectLastClosedCandle: FORA DE ORDEM (descendente) -> null, nunca escolhe as cegas", () => {
  assert.equal(selectLastClosedCandle([candle(120_000), candle(60_000), candle(0)], "1", 999_999), null);
});

test("selectLastClosedCandle: TIMESTAMPS DUPLICADOS -> null (nao estritamente crescente)", () => {
  assert.equal(selectLastClosedCandle([candle(0), candle(60_000), candle(60_000)], "1", 999_999), null);
});

test("selectLastClosedCandle: candle com estrutura invalida no MEIO da serie -> null para a serie INTEIRA, nunca pula pra outro silenciosamente", () => {
  const candles = [candle(0), "not-an-array", candle(120_000)];
  assert.equal(selectLastClosedCandle(candles, "1", 999_999), null);
});

test("selectLastClosedCandle: candle com timestamp invalido (string) no meio da serie -> null para a serie inteira", () => {
  const candles = [candle(0), ["1700000060000", "1", "1", "1", "1", "1"], candle(120_000)];
  assert.equal(selectLastClosedCandle(candles, "1", 999_999), null);
});

test("selectLastClosedCandle: array vazio como candle individual -> estrutura invalida -> null", () => {
  assert.equal(selectLastClosedCandle([candle(0), []], "1", 999_999), null);
});

test("selectLastClosedCandle: intervalo desconhecido -> null (nunca adivinha duracao)", () => {
  assert.equal(selectLastClosedCandle([candle(0), candle(60_000)], "9999", 999_999), null);
});

test("selectLastClosedCandle: nowMs invalido (string/negativo/decimal) -> null", () => {
  assert.equal(selectLastClosedCandle([candle(0)], "1", "999999"), null);
  assert.equal(selectLastClosedCandle([candle(0)], "1", -1), null);
  assert.equal(selectLastClosedCandle([candle(0)], "1", 1000.5), null);
});

test("selectLastClosedCandle: nowMs e' sempre injetado -- mesmo candles/interval, nowMs diferente muda o resultado deterministicamente", () => {
  const candles = [candle(0), candle(60_000)];
  assert.deepEqual(selectLastClosedCandle(candles, "1", 61_000), candle(0)); // so o primeiro fechou
  assert.deepEqual(selectLastClosedCandle(candles, "1", 121_000), candle(60_000)); // os dois fecharam -- pega o mais recente
});

test("selectLastClosedCandle: nunca muta o array de candles nem os candles individuais", () => {
  const candles = [candle(0), candle(60_000), candle(120_000)];
  const snapshot = JSON.parse(JSON.stringify(candles));
  selectLastClosedCandle(candles, "1", 999_999);
  assert.deepEqual(candles, snapshot);
});

// =====================================================================
// selectLastClosedCandleTimestampMs -- conveniencia p/ wiring do 4c2
// (fora de escopo deste commit: so o helper puro existe/e' testado aqui)
// =====================================================================

test("selectLastClosedCandleTimestampMs: devolve so o timestamp do candle escolhido por selectLastClosedCandle", () => {
  const candles = [candle(0), candle(60_000), candle(120_000)];
  assert.equal(selectLastClosedCandleTimestampMs(candles, "1", 122_000), 60_000);
  assert.equal(selectLastClosedCandleTimestampMs(candles, "1", 999_999), 120_000);
});

test("selectLastClosedCandleTimestampMs: nenhum candle fechado -> null (mesmo contrato de selectLastClosedCandle)", () => {
  assert.equal(selectLastClosedCandleTimestampMs([candle(1_000_000)], "1", 1_000_001), null);
});

// =====================================================================
// buildContextSnapshot: NAO deve conhecer candles/interval/identidade do
// AgentRouter -- correcao pos-4c1. hashContext(context) (lib/aiGateway/
// aiGateway.js) inclui TODAS as propriedades do objeto; qualquer campo
// novo aqui mudaria o hash de toda avaliacao e poderia vazar em logs/
// prompts dependendo do consumidor, mesmo com AGENTROUTER_BUDGET_ENABLED=
// false. A identidade do AgentRouter (lastClosedCandleTimestampMs) fica
// SO nos helpers puros abaixo -- o wiring (Commit 4c2, fora de escopo)
// computara isso separadamente e passara dentro de assessmentMeta, nunca
// dentro de `context`.
// =====================================================================

test("buildContextSnapshot: assinatura NAO aceita mais candles/interval -- passar esses campos e' simplesmente ignorado (nao existe parametro pra eles)", () => {
  const candles = [candle(0), candle(60_000), candle(120_000)];
  const ctx = buildContextSnapshot({
    analysis: fakeAnalysis(), regime: "NORMAL", botState: fakeBotState(),
    contextFusion: null, quality: null, candles, interval: "1", now: 122_000,
  });
  assert.equal("lastClosedCandleTimestampMs" in ctx, false);
  assert.equal("candles" in ctx, false);
});

test("buildContextSnapshot: retorno mantem EXATAMENTE o conjunto de chaves do baseline (pre-4c1) -- nenhum campo de identidade do AgentRouter vaza pro contexto enviado a providers/prompt", () => {
  const ctx = buildContextSnapshot({ analysis: fakeAnalysis(), regime: "NORMAL", botState: fakeBotState(), contextFusion: null, quality: null });
  assert.deepEqual(
    Object.keys(ctx).sort(),
    [
      "symbol", "interval", "price", "quant", "position", "riskState",
      "market", "structure", "liquidity", "fusion", "marketQuality", "crossSourceValidation",
      "sourceReliability", "contextFusionSampledAt", "qualitySampledAt", "snapshotAt",
    ].sort()
  );
  for (const forbiddenKey of ["lastClosedCandleTimestampMs", "candles", "quantFingerprint", "assessmentKey"]) {
    assert.equal(forbiddenKey in ctx, false, `campo de identidade do AgentRouter "${forbiddenKey}" nao pode aparecer em context`);
  }
  assert.equal(ctx.quant.signal, "wait");
  assert.equal(ctx.position.isOpened, false);
  assert.equal(ctx.market, null);
});

test("buildContextSnapshot: hashContext() para input fixo produz o hash-baseline (golden value) -- prova que o shape do contexto enviado ao provider nao mudou", () => {
  const ctx = buildContextSnapshot({
    analysis: fakeAnalysis(),
    regime: "NORMAL",
    botState: fakeBotState(),
    contextFusion: null,
    quality: null,
    now: 1_755_000_000_000,
  });
  assert.equal(hashContext(ctx), "080d132ea8494991");
});
