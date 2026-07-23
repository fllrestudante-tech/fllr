const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../lib/infra/db");
const { insertOpenIncident, closeIncident } = require("../lib/systemIncidents");
const { computeAvailability } = require("../lib/platformAvailability");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-availability-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("computeAvailability: sem incidentes na janela -- 100% honesto, não estimado", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  const result = computeAvailability(db, { windowMs: 30 * 24 * 60 * 60 * 1000, now: Date.now() });

  assert.equal(result.availabilityPct, 100);
  assert.equal(result.downtimeMs, 0);
  assert.equal(result.totalIncidents, 0);
  assert.equal(result.unexpectedShutdowns, 0);
  assert.equal(result.autoRecoveries, 0);

  db.close();
  cleanup(dbPath);
});

test("computeAvailability: agrega NETWORK + SYSTEM juntos como downtime", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = Date.now();
  const windowMs = 30 * 24 * 60 * 60 * 1000;

  const netUuid = insertOpenIncident(db, { type: "NETWORK", severity: "HIGH", rootCause: "bybit_down", startedAt: now - 60000 });
  closeIncident(db, netUuid, { endedAt: now - 30000, durationMs: 30000, automaticRecovery: true });

  const sysUuid = insertOpenIncident(db, { type: "SYSTEM", severity: "HIGH", rootCause: "os_reboot", startedAt: now - 3600000 });
  closeIncident(db, sysUuid, { endedAt: now - 3600000 + 700000, durationMs: 700000, automaticRecovery: true });

  const result = computeAvailability(db, { windowMs, now });

  assert.equal(result.totalIncidents, 2);
  assert.equal(result.unexpectedShutdowns, 1); // só o SYSTEM conta como "reboot/crash inesperado"
  assert.equal(result.autoRecoveries, 2);
  assert.equal(result.downtimeMs, 730000);
  assert.ok(result.availabilityPct < 100 && result.availabilityPct > 99);

  db.close();
  cleanup(dbPath);
});

test("computeAvailability: incidente fora da janela não conta", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = Date.now();
  const windowMs = 30 * 24 * 60 * 60 * 1000;

  const oldUuid = insertOpenIncident(db, { type: "SYSTEM", severity: "HIGH", rootCause: "os_reboot", startedAt: now - windowMs - 60000 });
  closeIncident(db, oldUuid, { endedAt: now - windowMs - 30000, durationMs: 30000, automaticRecovery: true });

  const result = computeAvailability(db, { windowMs, now });

  assert.equal(result.totalIncidents, 0);
  assert.equal(result.downtimeMs, 0);

  db.close();
  cleanup(dbPath);
});
