const test = require("node:test");
const assert = require("node:assert/strict");
const { detectFVGs, trackFillState } = require("../lib/marketStructure/fvg");

function candle(t, open, high, low, close, volume) {
  return [t, open, high, low, close, volume];
}

// Fixtures verificadas rodando o código real (script descartável) antes
// de fixar os asserts -- mesma disciplina de sempre.

test("detectFVGs: bullish -- low do candle seguinte acima do high do candle anterior", () => {
  const candles = [candle(0, 9, 10, 9, 9.5, 1), candle(1, 10, 15, 10, 14, 1), candle(2, 14, 15, 12, 13, 1)];
  const gaps = detectFVGs(candles);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].direction, "bullish");
  assert.equal(gaps[0].createdIndex, 1);
  assert.equal(gaps[0].low, 10);
  assert.equal(gaps[0].high, 12);
});

test("detectFVGs: bearish -- high do candle seguinte abaixo do low do candle anterior", () => {
  const candles = [candle(0, 15, 16, 15, 15.5, 1), candle(1, 15, 15, 10, 11, 1), candle(2, 11, 13, 10, 12, 1)];
  const gaps = detectFVGs(candles);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].direction, "bearish");
  assert.equal(gaps[0].low, 13);
  assert.equal(gaps[0].high, 15);
});

test("detectFVGs: candles sobrepostos -- nenhum gap", () => {
  const candles = [candle(0, 10, 11, 9, 10, 1), candle(1, 10, 11, 9, 10, 1), candle(2, 10, 11, 9, 10, 1)];
  assert.deepEqual(detectFVGs(candles), []);
});

test("detectFVGs: série curta demais (menos de 3 candles) -- não quebra", () => {
  assert.deepEqual(detectFVGs([candle(0, 1, 1, 1, 1, 1)]), []);
  assert.deepEqual(detectFVGs([]), []);
});

test("trackFillState: candle depois não toca a zona -- ACTIVE (não tocado, não preenchido)", () => {
  const gap = { direction: "bullish", createdIndex: 1, low: 10, high: 12 };
  const candles = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 0, 0, 0, 0, 0), candle(3, 13, 14, 13, 13.5, 1)];
  assert.deepEqual(trackFillState(gap, candles), { touched: false, filled: false, filledAtIndex: null });
});

test("trackFillState: candle toca a zona mas não vai até a borda distante -- tocado, não preenchido", () => {
  const gap = { direction: "bullish", createdIndex: 1, low: 10, high: 12 };
  const candles = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 0, 0, 0, 0, 0), candle(3, 12, 12.5, 11, 12, 1)];
  assert.deepEqual(trackFillState(gap, candles), { touched: true, filled: false, filledAtIndex: null });
});

test("trackFillState: candle fecha até a borda distante -- preenchido, com índice certo", () => {
  const gap = { direction: "bullish", createdIndex: 1, low: 10, high: 12 };
  const candles = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 0, 0, 0, 0, 0), candle(3, 11, 11, 9, 10, 1)];
  assert.deepEqual(trackFillState(gap, candles), { touched: true, filled: true, filledAtIndex: 3 });
});

test("trackFillState: gap bearish -- preenchido quando o high volta até a borda distante (topo do gap)", () => {
  const gap = { direction: "bearish", createdIndex: 1, low: 13, high: 15 };
  const candles = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 0, 0, 0, 0, 0), candle(3, 14, 16, 14, 15, 1)];
  assert.deepEqual(trackFillState(gap, candles), { touched: true, filled: true, filledAtIndex: 3 });
});

test("trackFillState: sem candles depois da criação -- nada tocado/preenchido", () => {
  const gap = { direction: "bullish", createdIndex: 1, low: 10, high: 12 };
  const candles = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 0, 0, 0, 0, 0)];
  assert.deepEqual(trackFillState(gap, candles), { touched: false, filled: false, filledAtIndex: null });
});
