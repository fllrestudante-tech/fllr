const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkBybit, checkBacktest, checkTelegramRadar, checkDatabase } = require("../lib/healthChecks");
const { openDb } = require("../lib/infra/db");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${name}`);
}

test("checkBybit: chamada rápida com sucesso reporta ok com latência", async () => {
  const fakeClient = { getKlines: async () => [] };
  const result = await checkBybit(fakeClient);
  assert.equal(result.status, "ok");
  assert.equal(typeof result.details.latencyMs, "number");
});

test("checkBybit: latência acima do limite reporta degraded", async () => {
  const fakeClient = { getKlines: async () => [] };
  const result = await checkBybit(fakeClient, { degradedLatencyMs: -1 }); // qualquer latência >= 0 excede -1
  assert.equal(result.status, "degraded");
});

test("checkBybit: falha na chamada reporta down", async () => {
  const fakeClient = {
    getKlines: async () => {
      throw new Error("ENOTFOUND");
    },
  };
  const result = await checkBybit(fakeClient);
  assert.equal(result.status, "down");
  assert.equal(result.details.error, "ENOTFOUND");
});

test("checkBacktest: arquivo inexistente reporta not_implemented", () => {
  const result = checkBacktest(tmpFile("nao-existe.json"));
  assert.equal(result.status, "not_implemented");
});

test("checkBacktest: histórico recente reporta ok", () => {
  const file = tmpFile("tuning-recente.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ history: [{ ranAt: new Date(now - 1000).toISOString(), promoted: true }] }));
  const result = checkBacktest(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "ok");
  assert.equal(result.details.promoted, true);
});

test("checkBacktest: histórico velho (mais de 2x o intervalo configurado) reporta degraded", () => {
  const file = tmpFile("tuning-velho.json");
  const now = Date.now();
  const dezesseisHorasAtras = now - 16 * 60 * 60 * 1000; // config default backtestIntervalHours=6 -> tolerância 12h
  fs.writeFileSync(file, JSON.stringify({ history: [{ ranAt: new Date(dezesseisHorasAtras).toISOString(), promoted: false }] }));
  const result = checkBacktest(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "degraded");
});

test("checkBacktest: arquivo corrompido reporta down", () => {
  const file = tmpFile("tuning-corrompido.json");
  fs.writeFileSync(file, "{ nao é json");
  const result = checkBacktest(file);
  fs.unlinkSync(file);
  assert.equal(result.status, "down");
});

test("checkTelegramRadar: arquivo de heartbeat inexistente reporta not_implemented", () => {
  const result = checkTelegramRadar(tmpFile("nao-existe.json"));
  assert.equal(result.status, "not_implemented");
});

test("checkTelegramRadar: heartbeat recente reporta ok", () => {
  const file = tmpFile("health-recente.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ lastHeartbeatAt: new Date(now - 1000).toISOString(), status: "connected" }));
  const result = checkTelegramRadar(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "ok");
});

test("checkTelegramRadar: heartbeat velho (mais de 5min) reporta down", () => {
  const file = tmpFile("health-velho.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ lastHeartbeatAt: new Date(now - 10 * 60 * 1000).toISOString() }));
  const result = checkTelegramRadar(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "down");
});

test("checkDatabase: arquivo inexistente reporta not_implemented", () => {
  const result = checkDatabase(tmpFile("market-nao-existe.db"));
  assert.equal(result.status, "not_implemented");
});

test("checkDatabase: banco válido (com migrações aplicadas) reporta ok", () => {
  const dbPath = tmpFile("market-valido.db");
  const db = openDb(dbPath);
  db.close();

  const result = checkDatabase(dbPath);
  fs.unlinkSync(dbPath);
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });

  assert.equal(result.status, "ok");
});

test("checkDatabase: arquivo corrompido (não é SQLite) reporta down", () => {
  const dbPath = tmpFile("market-corrompido.db");
  fs.writeFileSync(dbPath, "isso nao e um banco sqlite");

  const result = checkDatabase(dbPath);
  fs.unlinkSync(dbPath);

  assert.equal(result.status, "down");
});
