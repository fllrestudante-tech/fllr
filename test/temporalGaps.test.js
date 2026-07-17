const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { detectGaps, queryRecentTimestamps, sampleGaps } = require("../lib/temporalGaps");
const { openDb } = require("../lib/infra/db");

function tmpDbPath(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("detectGaps: sem buracos além da tolerância, retorna array vazio", () => {
  const timestamps = [0, 60000, 120000, 180000]; // 1min entre cada, esperado 1min
  assert.deepEqual(detectGaps(timestamps, 60000, 2), []);
});

test("detectGaps: um buraco maior que expectedIntervalMs*tolerance é detectado", () => {
  const timestamps = [0, 60000, 60000 + 40 * 60000, 60000 + 41 * 60000]; // buraco de 40min no meio
  const gaps = detectGaps(timestamps, 60000, 2); // tolerância = 2min
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].fromMs, 60000);
  assert.equal(gaps[0].gapMs, 40 * 60000);
});

test("detectGaps: lista vazia ou com 1 elemento não gera gap (nada pra comparar)", () => {
  assert.deepEqual(detectGaps([], 60000, 2), []);
  assert.deepEqual(detectGaps([1000], 60000, 2), []);
});

test("sampleGaps: contra um banco real com um buraco de verdade em candles", () => {
  const dbPath = tmpDbPath("gaps.db");
  const db = openDb(dbPath);
  const now = 10 * 60 * 60 * 1000; // t=10h, base arbitrária

  const insert = db.prepare(
    "INSERT INTO candles (uuid, exchange, symbol, interval, open_time, open, high, low, close, volume, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  // candles normais de 1min por 5min, buraco de 30min, mais 3 candles normais
  const times = [];
  for (let i = 0; i < 5; i++) times.push(now - (60 - i) * 60000);
  for (let i = 0; i < 3; i++) times.push(now - (20 - i) * 60000); // pulo de ~30min depois do último
  times.forEach((t, i) => insert.run(`uuid-${i}`, "bybit", "BTCUSDT", "1", t, 100, 101, 99, 100, 1, new Date(t).toISOString()));

  const result = sampleGaps("candles", db, { windowMs: 70 * 60000, expectedIntervalMs: 60000, now });
  db.close();
  cleanup(dbPath);

  assert.equal(result.gapsCount, 1);
});

test("sampleGaps: domínio orientado a evento reporta null com motivo honesto", () => {
  const dbPath = tmpDbPath("gaps-evento.db");
  const db = openDb(dbPath);
  const result = sampleGaps("fred", db, { windowMs: 60000, expectedIntervalMs: 60000 });
  db.close();
  cleanup(dbPath);
  assert.equal(result.gaps, null);
  assert.ok(result.reason.includes("evento"));
});
