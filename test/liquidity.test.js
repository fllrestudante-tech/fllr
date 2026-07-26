const test = require("node:test");
const assert = require("node:assert/strict");
const { clusterEqualLevels, detectSweeps, annotateReversalConfirmation } = require("../lib/marketStructure/liquidity");
const { detectSwingHighs, detectSwingLows } = require("../lib/marketStructure/swingDetector");

function candle(t, open, high, low, close, volume) {
  return [t, open, high, low, close, volume];
}
function flatCandle(t, price) {
  return candle(t, price, price, price, price, 100);
}
function ramp(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + (to - from) * (i / (n - 1)));
  return out;
}

// --- clusterEqualLevels ---

test("clusterEqualLevels: 2 swings dentro da tolerância viram 1 zona com touchCount 2", () => {
  const swings = [
    { index: 5, price: 100 },
    { index: 15, price: 100.05 },
  ];
  const zones = clusterEqualLevels(swings, 0.1);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].touchCount, 2);
  assert.deepEqual(zones[0].swingIndexes, [5, 15]);
});

test("clusterEqualLevels: swings distantes não agrupam -- nenhuma zona (touchCount<2)", () => {
  const swings = [
    { index: 5, price: 100 },
    { index: 15, price: 110 },
  ];
  const zones = clusterEqualLevels(swings, 0.1);
  assert.equal(zones.length, 0);
});

test("clusterEqualLevels: 3+ swings próximos entram no mesmo cluster", () => {
  const swings = [
    { index: 1, price: 100 },
    { index: 2, price: 100.02 },
    { index: 3, price: 100.04 },
  ];
  const zones = clusterEqualLevels(swings, 0.1);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].touchCount, 3);
});

test("clusterEqualLevels: âncora fixa no primeiro membro -- não encadeia swings que só são próximos em sequência (não da ponta a ponta)", () => {
  // 100, 100.09 (dentro de 0.1% de 100), 100.18 (fora de 0.1% de 100, âncora) -- não deveria formar 1 cluster de 3
  const swings = [
    { index: 1, price: 100 },
    { index: 2, price: 100.09 },
    { index: 3, price: 100.18 },
  ];
  const zones = clusterEqualLevels(swings, 0.1);
  // 100 e 100.09 formam zona (2 toques); 100.18 fica sozinho (não vira zona)
  assert.equal(zones.length, 1);
  assert.equal(zones[0].touchCount, 2);
});

test("clusterEqualLevels: array vazio -- não quebra", () => {
  assert.deepEqual(clusterEqualLevels([], 0.1), []);
});

// --- detectSweeps + annotateReversalConfirmation ---
// Fixture verificado rodando o código real (script descartável) antes de
// fixar os asserts: 2 picos quase iguais (30, 30.2, formam zona equal
// high), seguido de um candle com pavio acima de ambos mas close de volta
// pra dentro -- sweep esperado do pico mais recente (30.2).

function sweepFixture() {
  const prices = [...ramp(10, 30, 10), ...ramp(28, 15, 10), ...ramp(16, 30.2, 10), ...ramp(28, 15, 10), ...ramp(16, 20, 5)];
  const candles = prices.map((p, i) => flatCandle(i * 60000, p));
  const sweepIdx = 32;
  candles[sweepIdx] = candle(sweepIdx * 60000, 29, 31, 28.5, 29, 100); // pavio (high=31) rompe, close=29 fecha de volta
  return candles;
}

test("detectSweeps: pavio rompe e fecha de volta pra dentro -- sweep detectado no nível mais recente", () => {
  const candles = sweepFixture();
  const lookback = 2;
  const highs = detectSwingHighs(candles, lookback);
  const lows = detectSwingLows(candles, lookback);
  const sweeps = detectSweeps(candles, highs, lows, { lookback });

  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].type, "SWEEP_HIGH");
  assert.equal(sweeps[0].index, 32);
  assert.equal(sweeps[0].level, 30.2);
});

test("detectSweeps: pavio rompe e o close TAMBÉM fecha fora -- não é sweep, é rompimento de verdade", () => {
  // Série simples: sobe, forma 1 swing high, depois fecha decisivamente acima -- sem candle de "pavio só".
  const prices = [...ramp(10, 30, 10), ...ramp(28, 15, 10), ...ramp(16, 40, 15)];
  const candles = prices.map((p, i) => flatCandle(i * 60000, p));
  const lookback = 2;
  const highs = detectSwingHighs(candles, lookback);
  const lows = detectSwingLows(candles, lookback);
  const sweeps = detectSweeps(candles, highs, lows, { lookback });
  assert.equal(sweeps.length, 0);
});

test("annotateReversalConfirmation: reversão confirmada quando o close depois vai além do low/high do próprio candle de sweep", () => {
  const candles = sweepFixture();
  const lookback = 2;
  const highs = detectSwingHighs(candles, lookback);
  const lows = detectSwingLows(candles, lookback);
  const sweeps = detectSweeps(candles, highs, lows, { lookback });
  const annotated = annotateReversalConfirmation(sweeps, candles, 10);

  assert.equal(annotated[0].reversalConfirmed, true);
});

test("annotateReversalConfirmation: candles insuficientes à frente -- null, não fabrica true/false", () => {
  const sweep = { type: "SWEEP_HIGH", index: 5, level: 100 };
  const candles = new Array(6).fill(flatCandle(0, 100)); // só 6 candles, sweep no índice 5 (o último) -- 0 candles à frente
  const annotated = annotateReversalConfirmation([sweep], candles, 10);
  assert.equal(annotated[0].reversalConfirmed, null);
});
