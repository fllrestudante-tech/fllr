const test = require("node:test");
const assert = require("node:assert/strict");
const { atrSeries, classifyVolatility, classifyVolatilitySeries } = require("../lib/volatilityRegime");

// Candle: [openTime, open, high, low, close, volume] -- valores como string,
// igual ao formato real devolvido por lib/bybit.js::getKlines.
function candle(time, open, high, low, close, volume = "100") {
  return [time, String(open), String(high), String(low), String(close), volume];
}

// Gera N candles calmos (range fixo pequeno) em torno de um preço-base.
function calmCandles(n, base = 100, range = 0.2) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const price = base + i * 0.01;
    out.push(candle(i, price, price + range, price - range, price + range / 2));
  }
  return out;
}

test("atrSeries: primeiros `period` pontos ficam zerados (sem dado suficiente)", () => {
  const candles = calmCandles(20);
  const atr = atrSeries(candles, 14);
  for (let i = 0; i < 14; i++) assert.equal(atr[i], 0);
  assert.ok(atr[14] > 0);
});

test("classifyVolatility: amostra menor que o lookback retorna NORMAL (sem julgamento precoce)", () => {
  const candles = calmCandles(30); // lookback default é 50
  assert.equal(classifyVolatility(candles), "NORMAL");
});

test("classifyVolatility: candles calmos e estáveis classificam como NORMAL", () => {
  const candles = calmCandles(80, 100, 0.2);
  assert.equal(classifyVolatility(candles), "NORMAL");
});

test("classifyVolatility: range explosivo no final classifica como HIGH", () => {
  const candles = calmCandles(80, 100, 0.2);
  // últimos candles com range 10x maior que o histórico calmo
  const last = candles.length - 1;
  const price = 100 + last * 0.01;
  candles[last] = candle(last, price, price + 5, price - 5, price);
  assert.equal(classifyVolatility(candles), "HIGH");
});

test("classifyVolatility: range muito menor que o histórico classifica como LOW", () => {
  const candles = calmCandles(80, 100, 2); // histórico com range maior
  // ATR é média móvel de 14 períodos -- um único candle de range baixo não
  // move a média o suficiente (dilui entre os outros 13), precisa de uma
  // sequência cobrindo o período inteiro pra refletir volatilidade baixa de verdade.
  const flatStart = candles.length - 20;
  for (let i = flatStart; i < candles.length; i++) {
    const price = 100 + i * 0.01;
    candles[i] = candle(i, price, price + 0.05, price - 0.05, price);
  }
  assert.equal(classifyVolatility(candles), "LOW");
});

test("classifyVolatilitySeries: mesmo tamanho dos candles, e o último ponto bate com classifyVolatility", () => {
  const candles = calmCandles(80, 100, 0.2);
  const series = classifyVolatilitySeries(candles);
  assert.equal(series.length, candles.length);
  assert.equal(series[series.length - 1], classifyVolatility(candles));
});
