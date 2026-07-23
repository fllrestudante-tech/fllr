const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../config");
const signal = require("../lib/signal");
const { computeMetrics, isCandidateBetter, MAX_HOLD_CANDLES, simulate } = require("../lib/backtest");

// Fase D1: MAX_HOLD_CANDLES precisa vir de config.maxHoldMinutes (single
// source of truth com o time stop ao vivo, lib/tradeLifecycle.js), não mais
// uma constante local desacoplada do que a produção realmente faz.
test("MAX_HOLD_CANDLES é derivado de config.maxHoldMinutes / intervalMinutes", () => {
  const intervalMinutes = Number(config.interval) || 1;
  const expected = Math.max(1, Math.round(config.maxHoldMinutes / intervalMinutes));
  assert.equal(MAX_HOLD_CANDLES, expected);
});

test("computeMetrics: array vazio retorna tudo zerado", () => {
  const m = computeMetrics([]);
  assert.equal(m.totalTrades, 0);
  assert.equal(m.winRate, 0);
  assert.equal(m.profitFactor, 0);
  assert.equal(m.expectancy, 0);
  assert.equal(m.sharpe, 0);
});

test("computeMetrics: winRate, profitFactor e expectância batem com o cálculo manual", () => {
  const m = computeMetrics([0.02, -0.01, 0.02, -0.01, 0.02]);
  assert.equal(m.totalTrades, 5);
  assert.equal(m.winRate, 0.6); // 3 wins em 5
  assert.ok(Math.abs(m.profitFactor - 3) < 1e-9); // grossGain 0.06 / grossLoss 0.02
  assert.ok(Math.abs(m.expectancy - 0.008) < 1e-9); // média de (0.02,0.02,0.02,-0.01,-0.01)
});

test("computeMetrics: sem perdas, profitFactor cai pro grossGain (evita Infinity)", () => {
  const m = computeMetrics([0.02, 0.02, 0.02]);
  assert.equal(m.winRate, 1);
  assert.ok(Math.abs(m.profitFactor - 0.06) < 1e-9);
  assert.equal(m.sharpe, 0); // stdev zero (todos os trades iguais) -> sharpe definido como 0
});

test("computeMetrics: retornos simétricos em torno de zero dão sharpe zero", () => {
  const m = computeMetrics([0.01, -0.01, 0.01, -0.01]);
  assert.equal(m.expectancy, 0);
  assert.equal(m.sharpe, 0);
});

test("isCandidateBetter: rejeita amostra pequena mesmo com expectância melhor", () => {
  const baseline = { totalTrades: 50, expectancy: 0.001, maxDrawdown: 0.05 };
  const candidate = { totalTrades: 4, expectancy: 0.01, maxDrawdown: 0.02 };
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, false);
  assert.match(decision.reason, /amostra insuficiente/);
});

test("isCandidateBetter: aceita candidato quando baseline não tem histórico", () => {
  const baseline = { totalTrades: 0, expectancy: 0, maxDrawdown: 0 };
  const candidate = { totalTrades: 10, expectancy: 0.001, maxDrawdown: 0.1 };
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, true);
});

test("isCandidateBetter: rejeita quando expectância não melhora", () => {
  const baseline = { totalTrades: 30, expectancy: 0.01, maxDrawdown: 0.05 };
  const candidate = { totalTrades: 30, expectancy: 0.005, maxDrawdown: 0.02 };
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, false);
  assert.match(decision.reason, /expectância não melhorou/);
});

test("isCandidateBetter: rejeita quando drawdown piora além da tolerância de 10%", () => {
  const baseline = { totalTrades: 30, expectancy: 0.005, maxDrawdown: 0.05 };
  const candidate = { totalTrades: 30, expectancy: 0.01, maxDrawdown: 0.06 }; // 0.06 > 0.05*1.1
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, false);
  assert.match(decision.reason, /drawdown piorou/);
});

// --- Fase D2 (Circuit Breaker) -- teste de propriedade, não de contagem
// exata de trades: hand-craft de candles que disparem os 4 indicadores
// simultaneamente (EMA/RSI/StochRSI/OBV) de forma determinística é frágil
// demais pra valer a pena. Em vez disso, geramos uma série sintética longa
// o bastante pra produzir *algum* sinal com os parâmetros default, e
// comparamos duas rodadas idênticas variando só a duração da pausa -- uma
// pausa maior nunca pode gerar MAIS trades que uma pausa menor, propriedade
// que vale independente de onde exatamente os sinais caem.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticCandles(n, seed = 42) {
  const rand = mulberry32(seed);
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    // passeio aleatório com viés alternado (favorece cruzamentos de EMA e
    // reversões de RSI/StochRSI ao longo da série, em vez de tendência única)
    const bias = Math.sin(i / 40) * 0.3;
    price += (rand() - 0.5) * 2 + bias;
    price = Math.max(price, 1);
    const high = price + rand() * 0.8;
    const low = price - rand() * 0.8;
    const close = low + rand() * (high - low);
    const volume = 100 + rand() * 50;
    out.push([i * 60000, String(price), String(high), String(low), String(close), String(volume)]);
    price = close;
  }
  return out;
}

test("simulate: pausa de circuit breaker maior nunca produz mais trades que uma pausa menor (mesma série/parâmetros)", () => {
  const candles = syntheticCandles(1500);
  const params = signal.DEFAULT_PARAMS;

  const originalPause = config.circuitBreakerPauseMs;
  const originalStreak = config.circuitBreakerLossStreak;
  try {
    config.circuitBreakerLossStreak = 1; // dispara na primeira perda -- maximiza a chance do gatilho ser exercitado no teste

    config.circuitBreakerPauseMs = 60 * 1000; // 1 candle de pausa
    const shortPause = simulate(candles, params);

    config.circuitBreakerPauseMs = 6 * 60 * 60 * 1000; // 6h de pausa (default de produção)
    const longPause = simulate(candles, params);

    assert.ok(longPause.totalTrades <= shortPause.totalTrades);
  } finally {
    config.circuitBreakerPauseMs = originalPause;
    config.circuitBreakerLossStreak = originalStreak;
  }
});

// --- Fase D3 (Break Even) -- com o R:R padrão de produção (alvo mais perto
// que o stop, rewardRiskRatio 0.4), o alvo quase sempre fecha o trade antes
// de alcançar +1R, então o break even fica estruturalmente adormecido (nem
// bug nem feature quebrada -- reflexo da config de risco atual, documentado
// aqui pra não parecer teste "furado"). Pra exercitar o caminho de verdade,
// o teste força temporariamente um R:R > 1.
test("simulate: trade que anda +1R e reverte sai no zero a zero (breakeven), não como perda cheia", () => {
  const candles = syntheticCandles(1500, 2); // seed com breakevens conhecidos (ver exploração manual)
  const params = signal.DEFAULT_PARAMS;

  const originalTarget = config.targetReturnPerTradePct;
  const originalLeverage = config.leverageMax;
  try {
    config.targetReturnPerTradePct = 0.3;
    config.leverageMax = 1; // rewardRiskRatio = 0.3/params.stopLossPct > 1 -- alvo fica mais longe que +1R

    const result = simulate(candles, params);
    assert.ok(result.breakevens > 0, "cenário deveria produzir ao menos 1 saída em breakeven");
    assert.equal(result.totalTrades, result.wins + result.losses + result.timeouts + result.breakevens);
    const zeroReturns = result.tradeReturns.filter((r) => r === 0);
    assert.equal(zeroReturns.length, result.breakevens);
  } finally {
    config.targetReturnPerTradePct = originalTarget;
    config.leverageMax = originalLeverage;
  }
});

test("isCandidateBetter: promove quando expectância melhora e drawdown está dentro da tolerância", () => {
  const baseline = { totalTrades: 30, expectancy: 0.005, maxDrawdown: 0.05 };
  const candidate = { totalTrades: 30, expectancy: 0.01, maxDrawdown: 0.054 }; // dentro de 0.055
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, true);
});
