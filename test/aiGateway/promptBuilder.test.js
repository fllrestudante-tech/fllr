const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPrompt, SYSTEM_PROMPT } = require("../../lib/aiGateway/promptBuilder");

test("buildPrompt: system prompt é estável e não vazio", () => {
  assert.ok(SYSTEM_PROMPT.length > 0);
  assert.ok(SYSTEM_PROMPT.includes("JSON"));
  const a = buildPrompt({});
  const b = buildPrompt({});
  assert.equal(a.system, SYSTEM_PROMPT);
  assert.equal(a.system, b.system);
});

test("buildPrompt: contexto completo inclui symbol/interval/price e resumo de cada brain", () => {
  const context = {
    symbol: "SOLUSDT",
    interval: "1",
    price: 150.5,
    market: { state: "TRENDING_BULL", confidence: 70, score: 60, reasons: ["EMA50 > EMA200", "extra", "outro", "quarto"] },
    structure: { state: "STRONG", confidence: 55, score: 50, reasons: [] },
    liquidity: { state: "LIQUIDITY_ABOVE", confidence: 40, score: 30, reasons: ["liquidez acima"] },
    fusion: { state: "FUSED_BULLISH", confidence: 65, score: 58, reasons: ["maioria em alta"] },
  };
  const { user } = buildPrompt(context);
  assert.ok(user.includes("SOLUSDT"));
  assert.ok(user.includes("Preço atual: 150.5"));
  assert.ok(user.includes("Market Brain: state=TRENDING_BULL"));
  // no máximo 3 motivos por brain, mesmo que existam 4
  assert.ok(!user.includes("quarto"));
  assert.ok(user.includes("Structure Brain: state=STRONG"));
  assert.ok(user.includes("Liquidity Brain: state=LIQUIDITY_ABOVE"));
  assert.ok(user.includes("Context Fusion: state=FUSED_BULLISH"));
});

test("buildPrompt: contexto sem brains degrada pra 'não fornecido' sem lançar", () => {
  const { user } = buildPrompt({});
  assert.ok(user.includes("Símbolo: desconhecido"));
  assert.ok(user.includes("Market Brain: não fornecido"));
  assert.ok(user.includes("Structure Brain: não fornecido"));
  assert.ok(user.includes("Liquidity Brain: não fornecido"));
  assert.ok(user.includes("Context Fusion: não fornecido"));
  assert.ok(!user.includes("Preço atual"));
});

test("SYSTEM_PROMPT: exige os campos novos (confidence/marketRegime/signalQuality/riskLevel/recommendation) e deixa explícito que a IA não executa nada", () => {
  for (const field of ["confidence", "marketRegime", "signalQuality", "riskLevel", "recommendation"]) {
    assert.ok(SYSTEM_PROMPT.includes(field), `SYSTEM_PROMPT deveria mencionar "${field}"`);
  }
  assert.ok(/NUNCA/.test(SYSTEM_PROMPT));
  assert.ok(SYSTEM_PROMPT.toLowerCase().includes("motor de risco"));
});

test("buildPrompt: inclui Quant Signal/posição/risk state quando fornecidos", () => {
  const context = {
    symbol: "SOLUSDT",
    quant: {
      signal: "buy",
      reasons: ["ema_cross_up", "stoch_oversold"],
      indicators: { emaShort: 150.1, emaLong: 149.8, rsi: 55, stochRsi: 18, atr: 0.8 },
      params: { emaShort: 8, emaLong: 56 },
    },
    position: { isOpened: true, side: "Buy", qty: 2, entryPrice: 100, stopLossPrice: 97.5, takeProfitPrice: 109, breakEvenApplied: true, trailingActivated: false, tpLevelsFilled: 1, tpLevelsTotal: 3 },
    riskState: { volatilityRegime: "NORMAL", circuitBreakerActive: false, consecutiveLosses: 1, consecutiveLossesLimit: 3, dailyLossPct: 0.01, dailyLossLimitPct: 0.05 },
  };
  const { user } = buildPrompt(context);
  assert.ok(user.includes("Quant Signal: buy"));
  assert.ok(user.includes("ema_cross_up"));
  assert.ok(user.includes("Posição atual: Buy qty=2"));
  assert.ok(user.includes("breakEven=true"));
  assert.ok(user.includes("Risk State: regime de volatilidade=NORMAL"));
  assert.ok(user.includes("circuit breaker=inativo"));
});

test("buildPrompt: posição fechada aparece como 'nenhuma posição aberta', sem lançar", () => {
  const { user } = buildPrompt({ position: { isOpened: false } });
  assert.ok(user.includes("Posição atual: nenhuma posição aberta"));
});

test("buildPrompt: Market Quality/Cross-Source Validation/Source Reliability aparecem condensados quando fornecidos", () => {
  const context = {
    marketQuality: { candles: { score: 85 }, funding: { score: null } },
    crossSourceValidation: { candles: { status: "N/A" } },
    sourceReliability: { bybit: { operationalReliability: { score: 95 } } },
  };
  const { user } = buildPrompt(context);
  assert.ok(user.includes("Market Quality: candles=85, funding=N/A"));
  assert.ok(user.includes("Cross-Source Validation: candles=N/A"));
  assert.ok(user.includes("Source Reliability: bybit=95"));
});
