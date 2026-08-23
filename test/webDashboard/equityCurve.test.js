const test = require("node:test");
const assert = require("node:assert/strict");
const { computeEquityCurve, computeEquityCandles } = require("../../lib/webDashboard/equityCurve");

test("computeEquityCurve: soma cumulativa de pnlUsd, na ordem dos trades", () => {
  const trades = [
    { time: "2026-07-28T10:00:00.000Z", pnlUsd: 100 },
    { time: "2026-07-28T11:00:00.000Z", pnlUsd: -30 },
    { time: "2026-07-28T12:00:00.000Z", pnlUsd: 50 },
  ];
  const curve = computeEquityCurve(trades);
  assert.deepEqual(
    curve.map((p) => p.cumulativePnlUsd),
    [100, 70, 120]
  );
});

test("computeEquityCurve: trade sem pnlUsd numérico conta como 0, não quebra a soma", () => {
  const trades = [{ time: "t1", pnlUsd: 100 }, { time: "t2" }, { time: "t3", pnlUsd: 50 }];
  const curve = computeEquityCurve(trades);
  assert.deepEqual(
    curve.map((p) => p.cumulativePnlUsd),
    [100, 100, 150]
  );
});

test("computeEquityCurve: array vazio devolve array vazio", () => {
  assert.deepEqual(computeEquityCurve([]), []);
});

test("computeEquityCandles: agrupa por dia, open/close nas bordas e high/low nos extremos do dia", () => {
  const trades = [
    { time: "2026-07-28T10:00:00.000Z", pnlUsd: 100 }, // dia 1: 0 -> 100
    { time: "2026-07-28T11:00:00.000Z", pnlUsd: -150 }, // dia 1: 100 -> -50 (low do dia)
    { time: "2026-07-29T09:00:00.000Z", pnlUsd: 80 }, // dia 2: -50 -> 30
  ];
  const candles = computeEquityCandles(trades, "day");
  assert.equal(candles.length, 2);

  assert.equal(candles[0].period, "2026-07-28");
  assert.equal(candles[0].open, 0);
  assert.equal(candles[0].high, 100);
  assert.equal(candles[0].low, -50);
  assert.equal(candles[0].close, -50);
  assert.equal(candles[0].trades, 2);

  assert.equal(candles[1].period, "2026-07-29");
  assert.equal(candles[1].open, -50); // abre onde o dia anterior fechou
  assert.equal(candles[1].close, 30);
  assert.equal(candles[1].high, 30);
  assert.equal(candles[1].low, -50);
});

test("computeEquityCandles: agrupamento mensal usa unit='month'", () => {
  const trades = [
    { time: "2026-07-05T00:00:00.000Z", pnlUsd: 10 },
    { time: "2026-07-20T00:00:00.000Z", pnlUsd: 20 },
    { time: "2026-08-01T00:00:00.000Z", pnlUsd: -5 },
  ];
  const candles = computeEquityCandles(trades, "month");
  assert.deepEqual(
    candles.map((c) => c.period),
    ["2026-07", "2026-08"]
  );
  assert.equal(candles[0].close, 30);
  assert.equal(candles[1].close, 25);
});

test("computeEquityCandles: array vazio devolve array vazio", () => {
  assert.deepEqual(computeEquityCandles([]), []);
});
