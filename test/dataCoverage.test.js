const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { coverageWindowMs, computeCoverage, countRowsInWindow, sampleCoverage } = require("../lib/dataCoverage");
const { openDb } = require("../lib/infra/db");

function tmpDbPath(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("coverageWindowMs: pelo menos 20 ocorrências esperadas ou 1h, o que for maior", () => {
  assert.equal(coverageWindowMs(60 * 1000), 60 * 60 * 1000); // candles 1min -> 20min < 1h, usa 1h
  assert.equal(coverageWindowMs(24 * 60 * 60 * 1000), 20 * 24 * 60 * 60 * 1000); // fear_greed 24h -> 20 dias > 1h
});

test("computeCoverage: proporção simples, capada em 100%", () => {
  assert.equal(computeCoverage(30, 60).coveragePct, 50);
  assert.equal(computeCoverage(80, 60).coveragePct, 100); // mais dado que o esperado não passa de 100%
  assert.equal(computeCoverage(60, 60).coveragePct, 100);
});

test("computeCoverage: expectedCount inválido retorna null com motivo, não divide por zero", () => {
  const result = computeCoverage(10, 0);
  assert.equal(result.coveragePct, null);
  assert.ok(result.reason);
});

test("countRowsInWindow + sampleCoverage: contra um banco real (candles)", () => {
  const dbPath = tmpDbPath("coverage.db");
  const db = openDb(dbPath);
  const now = Date.now();

  const insert = db.prepare(
    "INSERT INTO candles (uuid, exchange, symbol, interval, open_time, open, high, low, close, volume, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  // 30 candles de 1min nos últimos 30min (esperado seria 60 numa janela de 1h)
  for (let i = 0; i < 30; i++) {
    const openTime = now - i * 60000;
    insert.run(`uuid-${i}`, "bybit", "BTCUSDT", "1", openTime, 100, 101, 99, 100.5, 10, new Date(openTime).toISOString());
  }

  const count = countRowsInWindow(db, "candles", "open_time", 60 * 60 * 1000, now);
  assert.equal(count, 30);

  const coverage = sampleCoverage("candles", db, { now });
  db.close();
  cleanup(dbPath);

  assert.equal(coverage.actualCount, 30);
  assert.equal(coverage.expectedCount, 60); // janela de 1h / intervalo de 1min
  assert.equal(coverage.coveragePct, 50);
});

test("sampleCoverage: domínio orientado a evento (fora do DOMAIN_TABLES) reporta null com motivo honesto", () => {
  const dbPath = tmpDbPath("coverage-evento.db");
  const db = openDb(dbPath);
  const result = sampleCoverage("coinmarketcal", db);
  db.close();
  cleanup(dbPath);
  assert.equal(result.coveragePct, null);
  assert.ok(result.reason.includes("evento"));
});
