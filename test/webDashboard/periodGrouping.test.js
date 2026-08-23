const test = require("node:test");
const assert = require("node:assert/strict");
const { computeTradingHealthForWindow, groupTradesByPeriod } = require("../../lib/webDashboard/periodGrouping");

function trade({ time, pnlPct, pnlUsd }) {
  return { time, pnlPct, pnlUsd };
}

test("computeTradingHealthForWindow: 'all' usa todos os trades, mesma saída de computeMetrics", () => {
  const trades = [trade({ time: "2026-01-01T00:00:00.000Z", pnlPct: 0.02, pnlUsd: 20 }), trade({ time: "2026-01-02T00:00:00.000Z", pnlPct: -0.01, pnlUsd: -10 })];
  const result = computeTradingHealthForWindow(trades, "all", new Date("2026-07-30T00:00:00.000Z").getTime());
  assert.equal(result.totalTrades, 2);
  assert.equal(result.tradesAnalyzed, 2);
  assert.ok(typeof result.profitFactor === "number");
});

test("computeTradingHealthForWindow: janela '7d' filtra trades fora da janela", () => {
  const now = new Date("2026-07-30T12:00:00.000Z").getTime();
  const trades = [
    trade({ time: "2026-07-29T12:00:00.000Z", pnlPct: 0.02, pnlUsd: 20 }), // dentro de 7d
    trade({ time: "2026-06-01T12:00:00.000Z", pnlPct: -0.05, pnlUsd: -50 }), // fora de 7d
  ];
  const result = computeTradingHealthForWindow(trades, "7d", now);
  assert.equal(result.tradesAnalyzed, 1);
});

test("computeTradingHealthForWindow: janela 'today' é calendário (meia-noite UTC), não 24h rolantes", () => {
  const now = new Date("2026-07-30T01:00:00.000Z").getTime();
  const yesterday = trade({ time: "2026-07-29T20:00:00.000Z", pnlPct: 0.01, pnlUsd: 10 }); // só 5h atrás, mas é "ontem"
  const today = trade({ time: "2026-07-30T00:30:00.000Z", pnlPct: 0.02, pnlUsd: 20 });
  const result = computeTradingHealthForWindow([yesterday, today], "today", now);
  assert.equal(result.tradesAnalyzed, 1);
});

test("computeTradingHealthForWindow: janela desconhecida lança erro (falha rápido, não silencia typo)", () => {
  assert.throws(() => computeTradingHealthForWindow([], "3anos"), /janela inválida/);
});

test("groupTradesByPeriod: agrupa por dia e soma pnlUsd", () => {
  const trades = [
    trade({ time: "2026-07-29T10:00:00.000Z", pnlUsd: 100 }),
    trade({ time: "2026-07-29T18:00:00.000Z", pnlUsd: -20 }),
    trade({ time: "2026-07-30T09:00:00.000Z", pnlUsd: 50 }),
  ];
  const grouped = groupTradesByPeriod(trades, "day");
  assert.deepEqual(grouped, [
    { period: "2026-07-29", pnlUsd: 80, trades: 2 },
    { period: "2026-07-30", pnlUsd: 50, trades: 1 },
  ]);
});

test("groupTradesByPeriod: agrupa por mês", () => {
  const trades = [trade({ time: "2026-07-01T00:00:00.000Z", pnlUsd: 10 }), trade({ time: "2026-07-29T00:00:00.000Z", pnlUsd: 5 }), trade({ time: "2026-08-01T00:00:00.000Z", pnlUsd: -3 })];
  const grouped = groupTradesByPeriod(trades, "month");
  assert.deepEqual(grouped, [
    { period: "2026-07", pnlUsd: 15, trades: 2 },
    { period: "2026-08", pnlUsd: -3, trades: 1 },
  ]);
});

test("groupTradesByPeriod: array vazio devolve array vazio", () => {
  assert.deepEqual(groupTradesByPeriod([], "day"), []);
});
