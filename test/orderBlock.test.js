const test = require("node:test");
const assert = require("node:assert/strict");
const { detectOrderBlocks, trackBlockLifecycleData } = require("../lib/marketStructure/orderBlock");

function candle(t, open, high, low, close, volume) {
  return [t, open, high, low, close, volume];
}

// Fixtures verificadas rodando o código real (script descartável) antes
// de fixar os asserts -- mesma disciplina de sempre.

test("detectOrderBlocks: candle oposto imediatamente antes do impulso -- acha o OB direto", () => {
  const candles = [candle(0, 10, 10.5, 9.5, 9.8, 1), candle(1, 12, 16, 11, 15, 1)];
  const evidence = [{ type: "BOS", payload: { candleIndex: 1, direction: "bullish" } }];
  assert.deepEqual(detectOrderBlocks(candles, evidence), [
    { direction: "bullish", createdIndex: 0, confirmedAtIndex: 1, low: 9.5, high: 10.5 },
  ]);
});

test("detectOrderBlocks: candle na mesma direção do impulso logo antes -- pula até achar o oposto mais atrás", () => {
  const candles = [
    candle(0, 10, 10.5, 9.5, 9.8, 1),
    candle(1, 9.8, 10.2, 9.7, 10.0, 1), // mesma direção do impulso, parte do movimento
    candle(2, 12, 16, 11, 15, 1),
  ];
  const evidence = [{ type: "BOS", payload: { candleIndex: 2, direction: "bullish" } }];
  assert.deepEqual(detectOrderBlocks(candles, evidence), [
    { direction: "bullish", createdIndex: 0, confirmedAtIndex: 2, low: 9.5, high: 10.5 },
  ]);
});

test("detectOrderBlocks: nenhum candle oposto dentro de maxLookback -- não fabrica bloco", () => {
  const candles = [candle(0, 9, 9.5, 8.5, 9.2, 1)];
  for (let i = 1; i <= 5; i++) candles.push(candle(i, 9 + i * 0.1, 9.2 + i * 0.1, 8.9 + i * 0.1, 9.1 + i * 0.1, 1));
  candles.push(candle(6, 12, 16, 11, 15, 1));
  const evidence = [{ type: "BOS", payload: { candleIndex: 6, direction: "bullish" } }];
  assert.deepEqual(detectOrderBlocks(candles, evidence, { maxLookback: 3 }), []);
});

test("detectOrderBlocks: evento CHOCH é ignorado -- Order Block clássico vem só de continuação (BOS)", () => {
  const candles = [candle(0, 10, 10.5, 9.5, 9.8, 1), candle(1, 12, 16, 11, 15, 1)];
  const evidence = [{ type: "CHOCH", payload: { candleIndex: 1, direction: "bullish" } }];
  assert.deepEqual(detectOrderBlocks(candles, evidence), []);
});

test("trackBlockLifecycleData: não tocado -- touched=false, sem penetração, sem rompimento", () => {
  const block = { direction: "bullish", confirmedAtIndex: 1, low: 10, high: 12 };
  const candles = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 13, 14, 13, 13.5, 1)];
  assert.deepEqual(trackBlockLifecycleData(block, candles), { touched: false, maxPenetrationPct: 0, brokenAtIndex: null });
});

test("trackBlockLifecycleData: tocado com penetração parcial (25%) -- abaixo do threshold de mitigação", () => {
  const block = { direction: "bullish", confirmedAtIndex: 1, low: 10, high: 12 };
  const candles = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 12, 12.5, 11.5, 12, 1)];
  assert.deepEqual(trackBlockLifecycleData(block, candles), { touched: true, maxPenetrationPct: 0.25, brokenAtIndex: null });
});

test("trackBlockLifecycleData: penetração de 75% -- mitigado (>= 50%), mas não rompido", () => {
  const block = { direction: "bullish", confirmedAtIndex: 1, low: 10, high: 12 };
  const candles = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 12, 12.5, 10.5, 11, 1)];
  assert.deepEqual(trackBlockLifecycleData(block, candles), { touched: true, maxPenetrationPct: 0.75, brokenAtIndex: null });
});

test("trackBlockLifecycleData: bullish -- close fecha além da borda distante -- rompido, com índice certo", () => {
  const block = { direction: "bullish", confirmedAtIndex: 1, low: 10, high: 12 };
  const candles = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 10.5, 10.5, 9, 9.5, 1)];
  assert.deepEqual(trackBlockLifecycleData(block, candles), { touched: true, maxPenetrationPct: 1, brokenAtIndex: 2 });
});

test("trackBlockLifecycleData: bearish -- penetração e rompimento calculados a partir do lado oposto", () => {
  const blockBear = { direction: "bearish", confirmedAtIndex: 1, low: 10, high: 12 };
  const candlesMitigado = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 10, 11, 9.5, 10.5, 1)];
  assert.deepEqual(trackBlockLifecycleData(blockBear, candlesMitigado), { touched: true, maxPenetrationPct: 0.5, brokenAtIndex: null });

  const candlesRompido = [candle(0, 0, 0, 0, 0, 0), candle(1, 0, 0, 0, 0, 0), candle(2, 11.5, 13, 11, 12.5, 1)];
  assert.deepEqual(trackBlockLifecycleData(blockBear, candlesRompido), { touched: true, maxPenetrationPct: 1, brokenAtIndex: 2 });
});
