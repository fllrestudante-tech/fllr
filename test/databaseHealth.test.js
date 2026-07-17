const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { classifyFragmentation, sampleDatabaseHealth } = require("../lib/databaseHealth");
const { openDb } = require("../lib/infra/db");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

test("classifyFragmentation: banco vazio (page_count=0) não é fragmentação", () => {
  const result = classifyFragmentation(0, 0);
  assert.equal(result.fragmentationRatio, 0);
  assert.equal(result.vacuumNeeded, false);
});

test("classifyFragmentation: abaixo do limite não precisa de VACUUM", () => {
  const result = classifyFragmentation(10, 100); // 10%
  assert.equal(result.fragmentationRatio, 0.1);
  assert.equal(result.vacuumNeeded, false);
});

test("classifyFragmentation: acima do limite (20%) sinaliza VACUUM", () => {
  const result = classifyFragmentation(30, 100); // 30%
  assert.equal(result.fragmentationRatio, 0.3);
  assert.equal(result.vacuumNeeded, true);
});

test("sampleDatabaseHealth: arquivo inexistente reporta not_implemented", () => {
  const result = sampleDatabaseHealth(tmpFile("market-nao-existe.db"));
  assert.equal(result.status, "not_implemented");
});

test("sampleDatabaseHealth: banco válido (recém-criado via openDb) reporta ok, integridade ok, sem VACUUM necessário", () => {
  const dbPath = tmpFile("market-valido.db");
  const db = openDb(dbPath);
  db.close();

  const result = sampleDatabaseHealth(dbPath, { runIntegrityCheck: true });
  fs.unlinkSync(dbPath);
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });

  assert.equal(result.status, "ok");
  assert.equal(result.integrity.ok, true);
  assert.equal(result.vacuumNeeded, false);
  assert.equal(typeof result.sizeBytes, "number");
  assert.ok(result.sizeBytes > 0);
});

test("sampleDatabaseHealth: runIntegrityCheck:false pula o integrity_check (integrity fica null)", () => {
  const dbPath = tmpFile("market-sem-check.db");
  const db = openDb(dbPath);
  db.close();

  const result = sampleDatabaseHealth(dbPath, { runIntegrityCheck: false });
  fs.unlinkSync(dbPath);
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });

  assert.equal(result.status, "ok"); // sem integrity_check rodado, não há motivo pra reportar down
  assert.equal(result.integrity, null);
});

test("sampleDatabaseHealth: arquivo corrompido (não é SQLite) reporta down", () => {
  const dbPath = tmpFile("market-corrompido.db");
  fs.writeFileSync(dbPath, "isso nao e um banco sqlite");

  const result = sampleDatabaseHealth(dbPath);
  fs.unlinkSync(dbPath);

  assert.equal(result.status, "down");
});
