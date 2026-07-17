const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../lib/infra/db");
const { insertAlertHistory, queryAlertsHistory } = require("../lib/alertsHistory");

function tmpDbPath(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("insertAlertHistory + queryAlertsHistory: grava e lê de volta", () => {
  const dbPath = tmpDbPath("alerts.db");
  const db = openDb(dbPath);

  insertAlertHistory(db, { severity: "ERROR", source: "bybit_collector", message: "caiu", count: 3, occurredAt: "2026-07-16T10:00:00.000Z" });
  insertAlertHistory(db, { severity: "WARNING", source: "funding", message: "atrasado", occurredAt: "2026-07-16T11:00:00.000Z" });

  const all = queryAlertsHistory(db);
  db.close();
  cleanup(dbPath);

  assert.equal(all.length, 2);
  assert.equal(all[0].source, "funding"); // mais recente primeiro
  assert.equal(all[1].count, 3);
});

test("queryAlertsHistory: filtra por source", () => {
  const dbPath = tmpDbPath("alerts-filtro.db");
  const db = openDb(dbPath);

  insertAlertHistory(db, { severity: "ERROR", source: "bybit_collector", message: "caiu", occurredAt: "2026-07-16T10:00:00.000Z" });
  insertAlertHistory(db, { severity: "ERROR", source: "fear_greed_collector", message: "caiu", occurredAt: "2026-07-16T10:00:00.000Z" });

  const result = queryAlertsHistory(db, { source: "bybit_collector" });
  db.close();
  cleanup(dbPath);

  assert.equal(result.length, 1);
  assert.equal(result[0].source, "bybit_collector");
});

test("queryAlertsHistory: filtra por severity e since", () => {
  const dbPath = tmpDbPath("alerts-since.db");
  const db = openDb(dbPath);

  insertAlertHistory(db, { severity: "CRITICAL", source: "banco", message: "corrompido", occurredAt: "2026-07-15T10:00:00.000Z" });
  insertAlertHistory(db, { severity: "CRITICAL", source: "banco", message: "corrompido de novo", occurredAt: "2026-07-16T10:00:00.000Z" });
  insertAlertHistory(db, { severity: "WARNING", source: "funding", message: "atrasado", occurredAt: "2026-07-16T11:00:00.000Z" });

  const result = queryAlertsHistory(db, { severity: "CRITICAL", since: "2026-07-16T00:00:00.000Z" });
  db.close();
  cleanup(dbPath);

  assert.equal(result.length, 1);
  assert.equal(result[0].message, "corrompido de novo");
});
