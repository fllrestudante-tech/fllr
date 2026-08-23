const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { insertOpenIncident, closeIncident } = require("../../lib/systemIncidents");
const { insertAlertHistory } = require("../../lib/alertsHistory");
const { insertEvent } = require("../../lib/infra/db");
const { readRisk, readOpenPosition, readTimeline } = require("../../lib/webDashboard/overviewReader");

function tmpPath(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function cleanupDb(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("readRisk: circuit breaker ativo quando now < circuitBreakerUntil", () => {
  const trades = [{ pnlPct: 0.02 }, { pnlPct: -0.01 }, { pnlPct: 0.01 }, { pnlPct: -0.02 }, { pnlPct: 0.03 }];
  const result = readRisk(trades, { circuitBreakerUntil: 2000 }, 1000);
  assert.equal(result.circuitBreaker.active, true);
  assert.equal(result.circuitBreaker.until, 2000);
});

test("readRisk: circuit breaker inativo quando circuitBreakerUntil já passou", () => {
  const result = readRisk([], { circuitBreakerUntil: 1000 }, 2000);
  assert.equal(result.circuitBreaker.active, false);
});

test("readRisk: sem circuitBreakerUntil, inativo", () => {
  const result = readRisk([], { circuitBreakerUntil: null }, Date.now());
  assert.equal(result.circuitBreaker.active, false);
});

test("readRisk: kellyFraction/varCvar vêm de computeKellyFraction/computeVarCvar (reaproveitados, não recalculados aqui)", () => {
  const trades = Array.from({ length: 6 }, (_, i) => ({ pnlPct: i % 2 === 0 ? 0.02 : -0.01 }));
  const result = readRisk(trades, { circuitBreakerUntil: null }, Date.now());
  assert.ok(typeof result.kellyFraction === "number");
  assert.ok(typeof result.varCvar.var === "number");
});

test("readOpenPosition: sem posição aberta devolve { open: false }", () => {
  assert.deepEqual(readOpenPosition({ isOpened: false }), { open: false });
});

test("readOpenPosition: com posição aberta, repassa os campos relevantes de state.json", () => {
  const state = { isOpened: true, side: "Buy", entryPrice: 100, qty: 1.5, stopLossPrice: 95, takeProfitPrice: 110, trailingActivated: true, openedAt: 12345 };
  const result = readOpenPosition(state);
  assert.equal(result.open, true);
  assert.equal(result.side, "Buy");
  assert.equal(result.stopLossPrice, 95);
  assert.equal(result.trailingActivated, true);
});

test("readTimeline: mistura trade/incidente/alerta/coleta e ordena do mais recente pro mais antigo", () => {
  const dbPath = tmpPath("timeline.db");
  const db = openDb(dbPath);
  insertOpenIncident(db, { type: "NETWORK", severity: "high", rootCause: "isp", startedAt: "2026-07-30T10:00:00.000Z" });
  insertAlertHistory(db, { severity: "warning", source: "bybit_collector", message: "3 falhas seguidas", occurredAt: "2026-07-30T11:00:00.000Z" });
  insertEvent(db, { uuid: "e1", eventName: "funding.updated", payload: {}, occurredAt: "2026-07-30T09:00:00.000Z" });
  insertEvent(db, { uuid: "e2", eventName: "candle.closed", payload: {}, occurredAt: "2026-07-30T12:00:00.000Z" }); // fora da allowlist -- não deve aparecer
  db.close();

  const tradesFile = tmpPath("timeline-trades.jsonl");
  fs.writeFileSync(tradesFile, JSON.stringify({ event: "order_closed_manually_pnl", reason: "signal_reversal", time: "2026-07-30T11:30:00.000Z", pnlPct: 0.02, pnlUsd: 20 }) + "\n");

  const timeline = readTimeline({ dbPath, tradesFilePath: tradesFile, limit: 10 });
  cleanupDb(dbPath);
  fs.unlinkSync(tradesFile);

  assert.equal(timeline.length, 4, "candle.closed foi filtrado; incidente+alerta+trade+funding.updated sobram");
  assert.deepEqual(
    timeline.map((e) => e.type),
    ["trade", "alert", "incident", "collector"] // 11:30 > 11:00 > 10:00 > 09:00
  );
});
