const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkOhlcValidity, checkMonotonicTimestamps, checkDuplicateTimestamps, sampleSanityChecks } = require("../lib/sanityChecks");
const { openDb } = require("../lib/infra/db");

function tmpDbPath(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("checkOhlcValidity: candles válidas passam", () => {
  const rows = [{ open: 100, high: 105, low: 98, close: 102, volume: 10 }];
  const result = checkOhlcValidity(rows);
  assert.equal(result.pass, true);
  assert.equal(result.violations, 0);
});

test("checkOhlcValidity: high < low é uma violação", () => {
  const rows = [{ open: 100, high: 95, low: 98, close: 96, volume: 10 }];
  const result = checkOhlcValidity(rows);
  assert.equal(result.pass, false);
  assert.equal(result.violations, 1);
});

test("checkOhlcValidity: close fora do range [low,high] é uma violação", () => {
  const rows = [{ open: 100, high: 105, low: 98, close: 110, volume: 10 }];
  const result = checkOhlcValidity(rows);
  assert.equal(result.pass, false);
});

test("checkOhlcValidity: volume negativo é uma violação", () => {
  const rows = [{ open: 100, high: 105, low: 98, close: 102, volume: -1 }];
  const result = checkOhlcValidity(rows);
  assert.equal(result.pass, false);
});

test("checkMonotonicTimestamps: sequência crescente passa", () => {
  assert.equal(checkMonotonicTimestamps([1, 2, 3]).pass, true);
});

test("checkMonotonicTimestamps: timestamp fora de ordem é detectado", () => {
  const result = checkMonotonicTimestamps([1, 3, 2, 4]);
  assert.equal(result.pass, false);
  assert.equal(result.outOfOrder, 1);
});

test("checkDuplicateTimestamps: sem duplicatas passa", () => {
  assert.equal(checkDuplicateTimestamps([1, 2, 3]).pass, true);
});

test("checkDuplicateTimestamps: duplicata é detectada", () => {
  const result = checkDuplicateTimestamps([1, 2, 2, 3]);
  assert.equal(result.pass, false);
  assert.equal(result.duplicates, 1);
});

test("sampleSanityChecks: contra um banco real de candles com OHLC ruim injetado", () => {
  const dbPath = tmpDbPath("sanity.db");
  const db = openDb(dbPath);
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO candles (uuid, exchange, symbol, interval, open_time, open, high, low, close, volume, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  insert.run("u1", "bybit", "BTCUSDT", "1", now - 60000, 100, 105, 98, 102, 10, new Date().toISOString());
  insert.run("u2", "bybit", "BTCUSDT", "1", now, 100, 95, 98, 96, 10, new Date().toISOString()); // high < low, ruim de propósito

  const result = sampleSanityChecks("candles", db, { windowMs: 120000, now });
  db.close();
  cleanup(dbPath);

  assert.equal(result.checks.ohlc.pass, false);
  assert.equal(result.checks.ohlc.violations, 1);
  assert.equal(result.checks.monotonic.pass, true);
  assert.equal(result.passRate, 67); // 2 de 3 checks passaram (monotonic+duplicates ok, ohlc falhou) -- 66.67% arredondado
});

test("sampleSanityChecks: domínio orientado a evento reporta null com motivo honesto", () => {
  const dbPath = tmpDbPath("sanity-evento.db");
  const db = openDb(dbPath);
  const result = sampleSanityChecks("fomc_calendar", db, { windowMs: 60000 });
  db.close();
  cleanup(dbPath);
  assert.equal(result.checks, null);
  assert.ok(result.reason.includes("evento"));
});
