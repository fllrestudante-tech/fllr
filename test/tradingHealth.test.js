const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  readTradeEvents,
  extractClosedTrades,
  computeAverageHoldMs,
  computeMaxDrawdownFromReturns,
  computeSortino,
  computeKellyFraction,
  computeVarCvar,
  computeTradingHealth,
} = require("../lib/tradingHealth");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

function writeJsonl(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("readTradeEvents: arquivo inexistente retorna array vazio", () => {
  assert.deepEqual(readTradeEvents(tmpFile("nao-existe.jsonl")), []);
});

test("readTradeEvents: ignora linhas corrompidas sem derrubar a leitura inteira", () => {
  const file = tmpFile("com-linha-corrompida.jsonl");
  fs.writeFileSync(file, '{"event":"wait"}\n{ isso nao e json\n{"event":"order_opened"}\n');
  const events = readTradeEvents(file);
  fs.unlinkSync(file);
  assert.equal(events.length, 2);
});

test("extractClosedTrades: filtra só position_closed_externally/order_closed_manually_pnl com pnlPct numérico", () => {
  const events = [
    { event: "wait" },
    { event: "order_opened" },
    { event: "position_closed_externally", pnlPct: 0.01 },
    { event: "order_closed_manually_pnl", pnlPct: -0.02, holdMs: 60000 },
    { event: "order_closed_manually" }, // formato antigo, sem pnlPct -- deve ser ignorado
  ];
  const trades = extractClosedTrades(events);
  assert.equal(trades.length, 2);
});

test("computeAverageHoldMs: null quando nenhum trade tem holdMs (dado histórico anterior ao fix)", () => {
  assert.equal(computeAverageHoldMs([{ pnlPct: 0.01 }, { pnlPct: -0.01 }]), null);
});

test("computeAverageHoldMs: média só dos trades que têm holdMs", () => {
  const trades = [{ holdMs: 60000 }, { holdMs: 120000 }, { pnlPct: 0.01 }];
  assert.equal(computeAverageHoldMs(trades), 90000);
});

test("computeMaxDrawdownFromReturns: acompanha o pico e mede a maior queda a partir dele", () => {
  // +0.02 -> pico 0.02; -0.01 -> dd 0.01; +0.01 -> pico 0.03; -0.03 -> dd 0.03 (o maior)
  const dd = computeMaxDrawdownFromReturns([0.02, -0.01, 0.01, -0.03]);
  assert.ok(Math.abs(dd - 0.03) < 1e-9);
});

test("computeSortino: só penaliza desvio negativo (diferente de Sharpe)", () => {
  const result = computeSortino([0.02, 0.02, -0.01]);
  assert.ok(result > 0);
});

test("computeKellyFraction: null com amostra sem perdas ou sem ganhos", () => {
  assert.equal(computeKellyFraction([0.01, 0.02]), null); // sem perdas
  assert.equal(computeKellyFraction([-0.01, -0.02]), null); // sem ganhos
});

test("computeKellyFraction: calcula f* = W - (1-W)/R com dados mistos", () => {
  const result = computeKellyFraction([0.02, 0.02, -0.01]); // W=2/3, avgWin=0.02, avgLoss=0.01, R=2
  const expected = 2 / 3 - (1 / 3) / 2;
  assert.ok(Math.abs(result - expected) < 1e-9);
});

test("computeVarCvar: amostra pequena (<5) retorna null com motivo", () => {
  const result = computeVarCvar([0.01, -0.01]);
  assert.equal(result.var, null);
  assert.equal(result.cvar, null);
});

test("computeVarCvar: amostra suficiente calcula VaR/CVaR históricos", () => {
  const result = computeVarCvar([0.05, 0.03, 0.01, -0.02, -0.05, -0.08], 0.95);
  assert.equal(typeof result.var, "number");
  assert.equal(typeof result.cvar, "number");
  assert.ok(result.cvar <= result.var); // CVaR é a média da cauda, sempre <= o próprio VaR (ou igual, no pior caso)
});

test("computeTradingHealth: fixture completo -- reusa computeMetrics de lib/backtest.js e agrega hold time/analytics", () => {
  const file = tmpFile("trades-fixture.jsonl");
  writeJsonl(file, [
    { event: "wait", signal: "wait" },
    { event: "order_opened", side: "Buy" },
    { event: "position_closed_externally", pnlPct: 0.02, time: "2026-07-10T10:00:00.000Z" },
    { event: "order_closed_manually_pnl", pnlPct: -0.01, holdMs: 120000, time: "2026-07-11T14:00:00.000Z" },
    { event: "position_closed_externally", pnlPct: 0.015, time: "2026-07-12T10:00:00.000Z" },
    { event: "backtest_completed", lastRun: {} }, // não é trade real, deve ser ignorado
  ]);

  const result = computeTradingHealth(file);
  fs.unlinkSync(file);

  assert.equal(result.totalTrades, 3);
  assert.equal(result.tradesAnalyzed, 3);
  assert.ok(result.winRate > 0.5); // 2 de 3 ganharam
  assert.equal(result.tradesWithHoldData, 1);
  assert.equal(result.averageHoldMs, 120000);
  assert.ok(result.portfolioAnalytics);
  assert.ok(result.portfolioAnalytics.notImplementedYet.exposicaoPorAtivo);
});

test("computeTradingHealth: arquivo sem nenhum trade fechado retorna totalTrades=0 (não quebra)", () => {
  const file = tmpFile("trades-vazio.jsonl");
  writeJsonl(file, [{ event: "wait" }]);
  const result = computeTradingHealth(file);
  fs.unlinkSync(file);
  assert.equal(result.totalTrades, 0);
  assert.equal(result.averageHoldMs, null);
});
