const test = require("node:test");
const assert = require("node:assert/strict");
const { computeExitAnalytics, UNKNOWN_REASON } = require("../lib/exitAnalytics");

test("computeExitAnalytics: lista vazia retorna objeto vazio", () => {
  assert.deepEqual(computeExitAnalytics([]), {});
});

test("computeExitAnalytics: agrupa por reason, calcula trades/winRate/PnL total e médio", () => {
  const trades = [
    { reason: "time_stop", pnlPct: 0.01 },
    { reason: "time_stop", pnlPct: -0.02 },
    { reason: "trailing_stop", pnlPct: 0.03 },
    { reason: "trailing_stop", pnlPct: 0.02 },
    { reason: "trailing_stop", pnlPct: -0.01 },
  ];
  const result = computeExitAnalytics(trades);

  assert.equal(result.time_stop.trades, 2);
  assert.equal(result.time_stop.winRate, 0.5);
  assert.ok(Math.abs(result.time_stop.totalPnlPct - -0.01) < 1e-9);
  assert.ok(Math.abs(result.time_stop.avgPnlPct - -0.005) < 1e-9);

  assert.equal(result.trailing_stop.trades, 3);
  assert.ok(Math.abs(result.trailing_stop.winRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(result.trailing_stop.totalPnlPct - 0.04) < 1e-9);
});

test("computeExitAnalytics: trades sem `reason` (dados antigos, pré-Fase D) caem em UNKNOWN_REASON", () => {
  const trades = [{ pnlPct: 0.01 }, { pnlPct: -0.01 }];
  const result = computeExitAnalytics(trades);
  assert.equal(result[UNKNOWN_REASON].trades, 2);
});

test("computeExitAnalytics: trade exatamente em zero (breakeven) não conta como win", () => {
  const trades = [{ reason: "break_even", pnlPct: 0 }];
  const result = computeExitAnalytics(trades);
  assert.equal(result.break_even.winRate, 0);
  assert.equal(result.break_even.trades, 1);
});
