const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../lib/infra/db");
const { insertOpenIncident, closeIncident, updateResyncStatus, queryOpenIncident, queryIncidents } = require("../lib/systemIncidents");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-incidents-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("insertOpenIncident + queryOpenIncident: round-trip com ended_at NULL", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  insertOpenIncident(db, { type: "NETWORK", severity: "HIGH", rootCause: "internet_down", startedAt: 1000 });

  const open = queryOpenIncident(db, "NETWORK");
  assert.ok(open);
  assert.equal(open.root_cause, "internet_down");
  assert.equal(open.severity, "HIGH");
  assert.equal(open.ended_at, null);
  assert.equal(open.startedAt, new Date(new Date(1000).toISOString()).getTime());

  db.close();
  cleanup(dbPath);
});

test("queryOpenIncident: null quando não há incidente aberto", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  assert.equal(queryOpenIncident(db, "NETWORK"), null);
  db.close();
  cleanup(dbPath);
});

test("closeIncident: preenche ended_at/duration_ms/automatic_recovery e some de queryOpenIncident", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const uuid = insertOpenIncident(db, { type: "NETWORK", severity: "HIGH", rootCause: "bybit_down", startedAt: 0 });
  closeIncident(db, uuid, { endedAt: 44 * 60000, durationMs: 44 * 60000, automaticRecovery: true });

  assert.equal(queryOpenIncident(db, "NETWORK"), null);
  const [row] = queryIncidents(db);
  assert.equal(row.duration_ms, 44 * 60000);
  assert.equal(row.automatic_recovery, 1);
  assert.ok(row.ended_at);

  db.close();
  cleanup(dbPath);
});

test("updateResyncStatus: persiste resync_details como JSON consultável", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const uuid = insertOpenIncident(db, { type: "NETWORK", severity: "HIGH", rootCause: "internet_down", startedAt: 0 });
  closeIncident(db, uuid, { endedAt: 60000, durationMs: 60000 });
  updateResyncStatus(db, uuid, { resyncStatus: "done", resyncDetails: { candles: { expectedMissing: 1, recovered: 1 } } });

  const [row] = queryIncidents(db);
  assert.equal(row.resync_status, "done");
  assert.deepEqual(JSON.parse(row.resync_details), { candles: { expectedMissing: 1, recovered: 1 } });

  db.close();
  cleanup(dbPath);
});

test("queryIncidents: since filtra por started_at, mais recente primeiro", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const uuid1 = insertOpenIncident(db, { type: "NETWORK", severity: "HIGH", rootCause: "internet_down", startedAt: 1000 });
  closeIncident(db, uuid1, { endedAt: 1500, durationMs: 500 });
  insertOpenIncident(db, { type: "NETWORK", severity: "MEDIUM", rootCause: "telegram_down", startedAt: 2000 });

  const all = queryIncidents(db);
  assert.equal(all.length, 2);
  assert.equal(all[0].root_cause, "telegram_down"); // mais recente primeiro

  const sinceRecent = queryIncidents(db, { since: new Date(1500).toISOString() });
  assert.equal(sinceRecent.length, 1);
  assert.equal(sinceRecent[0].root_cause, "telegram_down");

  db.close();
  cleanup(dbPath);
});

test("migração 0007: UNIQUE INDEX impede 2 incidentes NETWORK abertos ao mesmo tempo", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  insertOpenIncident(db, { type: "NETWORK", severity: "HIGH", rootCause: "internet_down", startedAt: 0 });
  assert.throws(() => insertOpenIncident(db, { type: "NETWORK", severity: "HIGH", rootCause: "bybit_down", startedAt: 1000 }));
  db.close();
  cleanup(dbPath);
});
