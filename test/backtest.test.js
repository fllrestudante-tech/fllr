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

  const originalMultiplier = config.trailingStopAtrMultiplier;
  const originalTpLevels = config.tpLevels;
  try {
    // Neutraliza trailing (D4) e TP escalonado (D5) pra isolar o
    // comportamento do break even puro -- sem isso, o TP1 padrão também
    // dispara em +1R (mesmo gatilho) e trava lucro real numa fração da
    // posição, deixando de ser um zero-a-zero exato no trade como um todo.
    config.trailingStopAtrMultiplier = { low: 1e9, normal: 1e9, high: 1e9 };
    config.tpLevels = [];

    const result = simulate(candles, params);
    assert.ok(result.breakevens > 0, "cenário deveria produzir ao menos 1 saída em breakeven");
    assert.equal(result.totalTrades, result.wins + result.losses + result.breakevens);
    const zeroReturns = result.tradeReturns.filter((r) => r === 0);
    assert.equal(zeroReturns.length, result.breakevens);
  } finally {
    config.trailingStopAtrMultiplier = originalMultiplier;
    config.tpLevels = originalTpLevels;
  }
});

// --- Fase D4 (Trailing ATR adaptativo) -- mesma ressalva do teste de D3
// acima sobre craftar sinais exatos; verifica a propriedade central: com uma
// distância de trailing pequena o bastante pra ativar fácil, trades saem
// com retornos positivos VARIÁVEIS (dependentes do caminho de preço real),
// não um valor fixo único -- prova de que o trailing está ratcheando de
// verdade, não só aplicando uma regra categórica.
test("simulate: trailing ativo produz saídas com lucro variável e positivo, dependente do caminho de preço", () => {
  const candles = syntheticCandles(1500, 1);
  const params = signal.DEFAULT_PARAMS;

  const originalMultiplier = config.trailingStopAtrMultiplier;
  const originalTpLevels = config.tpLevels;
  try {
    config.trailingStopAtrMultiplier = { low: 0.3, normal: 0.5, high: 0.8 }; // distância pequena -- ativa fácil após o break even
    config.tpLevels = []; // neutraliza TP escalonado (D5) pra isolar a contribuição do trailing

    const result = simulate(candles, params);

    const profits = result.tradeReturns.filter((r) => r > 0);
    const distinctValues = new Set(profits.map((r) => r.toFixed(10)));
    assert.ok(profits.length > 0, "deveria haver ao menos 1 saída lucrativa");
    assert.ok(distinctValues.size > 1, "retornos deveriam variar entre trades (dependentes do caminho de preço), não um valor fixo único");
  } finally {
    config.trailingStopAtrMultiplier = originalMultiplier;
    config.tpLevels = originalTpLevels;
  }
});

// --- Fase D5 (TP Escalonado) -- com um único nível cobrindo 100% da posição
// em R=1, o comportamento deveria ser idêntico a um "win binário" clássico
// (riskFraction * r * qtyPct = riskFraction), permitindo checagem exata do
// valor, ao contrário dos cenários de trailing/breakeven parcial acima
// (que dependem de caminho de preço e não têm um valor único esperado).
test("simulate: nível de TP único cobrindo 100% da posição produz retorno exato riskFraction × r", () => {
  const candles = syntheticCandles(1500, 2);
  const params = signal.DEFAULT_PARAMS;

  const originalTpLevels = config.tpLevels;
  try {
    config.tpLevels = [{ r: 1, qtyPct: 1.0 }];
    const result = simulate(candles, params);

    const expectedWin = config.riskPerTradePct * 1 * 1.0;
    const wins = result.tradeReturns.filter((r) => r > 0);
    assert.ok(wins.length > 0, "cenário deveria produzir ao menos 1 win via TP");
    for (const w of wins) {
      assert.ok(Math.abs(w - expectedWin) < 1e-9, `retorno de win deveria ser exatamente ${expectedWin}, veio ${w}`);
    }
    // Perdas continuam perda cheia -- TP em 100% não deixa "resto" pra
    // break even/trailing amortecerem o stop.
    const losses = result.tradeReturns.filter((r) => r < 0);
    for (const l of losses) {
      assert.ok(Math.abs(l - -config.riskPerTradePct) < 1e-9);
    }
  } finally {
    config.tpLevels = originalTpLevels;
  }
});

// --- Fase D5 -- dois níveis parciais (30%+30%) deixando 40% pro break even:
// um trade que bate TP1 mas depois reverte e o resto sai em breakeven
// (não em stop cheio) deve ter retorno = só a contribuição do TP1, nem
// zero puro nem perda.
test("simulate: TP1 parcial seguido de breakeven no resto produz retorno = só a fatia do TP1", () => {
  const candles = syntheticCandles(1500, 2);
  const params = signal.DEFAULT_PARAMS;

  const originalTpLevels = config.tpLevels;
  const originalMultiplier = config.trailingStopAtrMultiplier;
  try {
    config.tpLevels = [{ r: 1, qtyPct: 0.3 }]; // só TP1, resto (70%) roda no break even (sem TP2 pra simplificar)
    config.trailingStopAtrMultiplier = { low: 1e9, normal: 1e9, high: 1e9 }; // neutraliza trailing (D4)

    const result = simulate(candles, params);
    const expectedTp1Only = config.riskPerTradePct * 1 * 0.3; // contribuição do TP1, resto saiu em 0 (breakeven)
    const matches = result.tradeReturns.filter((r) => Math.abs(r - expectedTp1Only) < 1e-9);
    assert.ok(matches.length > 0, "deveria haver ao menos 1 trade onde só o TP1 contribuiu e o resto saiu em breakeven puro");
  } finally {
    config.tpLevels = originalTpLevels;
    config.trailingStopAtrMultiplier = originalMultiplier;
  }
});

test("isCandidateBetter: promove quando expectância melhora e drawdown está dentro da tolerância", () => {
  const baseline = { totalTrades: 30, expectancy: 0.005, maxDrawdown: 0.05 };
  const candidate = { totalTrades: 30, expectancy: 0.01, maxDrawdown: 0.054 }; // dentro de 0.055
  const decision = isCandidateBetter(baseline, candidate);
  assert.equal(decision.promote, true);
});
