const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { computeCapitalSummary, readTrading, readTodayVsAllTime } = require("../../lib/webDashboard/tradingReader");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function writeJsonl(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("computeCapitalSummary: array vazio devolve zeros honestos, não null implícito", () => {
  const result = computeCapitalSummary([]);
  assert.equal(result.totalPnlUsd, 0);
  assert.equal(result.biggestWinUsd, null);
  assert.equal(result.biggestLossUsd, null);
});

test("computeCapitalSummary: soma total e identifica maior ganho/perda", () => {
  const trades = [{ pnlUsd: 100 }, { pnlUsd: -40 }, { pnlUsd: 25 }];
  const result = computeCapitalSummary(trades);
  assert.equal(result.totalPnlUsd, 85);
  assert.equal(result.biggestWinUsd, 100);
  assert.equal(result.biggestLossUsd, -40);
  assert.equal(result.tradesAnalyzed, 3);
});

test("readTrading: contra um arquivo real, devolve metrics/equityCurve/capital/lucroPorDia/exitAnalytics coerentes", () => {
  const file = tmpFile("trades.jsonl");
  writeJsonl(file, [
    { event: "wait" },
    { event: "order_closed_manually_pnl", reason: "signal_reversal", time: "2026-07-29T10:00:00.000Z", pnlUsd: 50, pnlPct: 0.01 },
    { event: "order_closed_manually_pnl", reason: "time_stop", time: "2026-07-29T12:00:00.000Z", pnlUsd: -20, pnlPct: -0.005 },
  ]);

  const result = readTrading({ window: "all", filePath: file });
  fs.unlinkSync(file);

  assert.equal(result.window, "all");
  assert.equal(result.metrics.tradesAnalyzed, 2);
  assert.equal(result.capital.totalPnlUsd, 30);
  assert.equal(result.equityCurve.length, 2);
  assert.equal(result.equityCurve[1].cumulativePnlUsd, 30);
  assert.equal(result.lucroPorDia.length, 1);
  assert.ok(result.exitAnalytics);
});

test("readTrading: window diferente de 'all' aplica o filtro de janela", () => {
  // computeTradingHealthForWindow calcula a janela a partir do relógio real
  // (Date.now()), não de um "now" injetável -- por isso os timestamps do
  // fixture têm que ser relativos ao momento real do teste, nunca datas
  // fixas no passado (uma data fixa vira "fora da janela" sozinha conforme
  // o tempo passa, sem nenhuma mudança no código sob teste).
  const file = tmpFile("trades-window.jsonl");
  const now = Date.now();
  writeJsonl(file, [
    { event: "order_closed_manually_pnl", time: new Date(now - 60 * 60 * 1000).toISOString(), pnlUsd: 10, pnlPct: 0.01 }, // 1h atrás
    { event: "order_closed_manually_pnl", time: new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(), pnlUsd: 999, pnlPct: 0.5 }, // 60 dias atrás -- fora de qualquer janela curta (7d)
  ]);

  const result = readTrading({ window: "7d", filePath: file });
  fs.unlinkSync(file);

  assert.equal(result.metrics.tradesAnalyzed, 1);
});

test("readTodayVsAllTime: devolve today e allTime a partir do mesmo arquivo", () => {
  const file = tmpFile("today-vs-alltime.jsonl");
  writeJsonl(file, [{ event: "order_closed_manually_pnl", time: new Date().toISOString(), pnlUsd: 15, pnlPct: 0.01 }]);

  const result = readTodayVsAllTime({ filePath: file });
  fs.unlinkSync(file);

  assert.equal(result.allTime.tradesAnalyzed, 1);
  assert.equal(result.today.tradesAnalyzed, 1);
});
