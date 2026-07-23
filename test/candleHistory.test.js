const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../lib/infra/db");
const { longestContiguousRun, toArrayFormat, readCandlesFromDb, getBacktestCandles } = require("../lib/candleHistory");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-candlehistory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

function insertCandles(db, { symbol = "BTCUSDT", interval = "1", openTimes }) {
  const insert = db.prepare(
    "INSERT INTO candles (uuid, exchange, symbol, interval, open_time, open, high, low, close, volume, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (const openTime of openTimes) {
    insert.run(`uuid-${symbol}-${openTime}`, "bybit", symbol, interval, openTime, 100, 101, 99, 100.5, 10, new Date(openTime).toISOString());
  }
}

function row(openTime) {
  return { open_time: openTime, open: 100, high: 101, low: 99, close: 100.5, volume: 10 };
}

test("longestContiguousRun: sem gap nenhum -- devolve o array inteiro", () => {
  const rows = [row(0), row(60000), row(120000), row(180000)];
  const run = longestContiguousRun(rows, 60000);
  assert.equal(run.length, 4);
});

test("longestContiguousRun: 1 gap no meio -- escolhe a fatia mais longa", () => {
  // fatia 1: 3 candles (0,60000,120000) -- fatia 2 (depois do gap): 5 candles
  const rows = [row(0), row(60000), row(120000), row(1000000), row(1060000), row(1120000), row(1180000), row(1240000)];
  const run = longestContiguousRun(rows, 60000);
  assert.equal(run.length, 5);
  assert.equal(run[0].open_time, 1000000);
});

test("longestContiguousRun: múltiplos gaps -- escolhe a maior entre todas as fatias", () => {
  const rows = [
    row(0), row(60000), // fatia A: 2
    row(1000000), row(1060000), row(1120000), row(1180000), // fatia B: 4
    row(5000000), row(5060000), row(5120000), // fatia C: 3
  ];
  const run = longestContiguousRun(rows, 60000);
  assert.equal(run.length, 4);
  assert.equal(run[0].open_time, 1000000);
});

test("longestContiguousRun: gap logo no início -- fatia útil fica no final", () => {
  const rows = [row(0), row(9999999), row(10059999), row(10119999)];
  const run = longestContiguousRun(rows, 60000);
  assert.equal(run.length, 3);
  assert.equal(run[0].open_time, 9999999);
});

test("longestContiguousRun: array vazio -- devolve vazio sem quebrar", () => {
  assert.deepEqual(longestContiguousRun([], 60000), []);
});

test("toArrayFormat: mapeia pro formato posicional [openTime,open,high,low,close,volume]", () => {
  const [arr] = toArrayFormat([row(1000)]);
  assert.deepEqual(arr, [1000, 100, 101, 99, 100.5, 10]);
});

test("readCandlesFromDb: filtra por symbol/interval/janela de tempo", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  insertCandles(db, { symbol: "BTCUSDT", interval: "1", openTimes: [0, 60000, 120000] });
  insertCandles(db, { symbol: "ETHUSDT", interval: "1", openTimes: [0, 60000] }); // outro symbol, não deve aparecer

  const rows = readCandlesFromDb(db, { symbol: "BTCUSDT", interval: "1", sinceMs: 0, untilMs: 200000 });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].open_time, 0);

  db.close();
  cleanup(dbPath);
});

test("getBacktestCandles: dado contíguo suficiente -- devolve candles + janela", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const baseTime = Date.now() - 250 * 60000; // recente, dentro da janela de lookback
  const openTimes = Array.from({ length: 250 }, (_, i) => baseTime + i * 60000);
  insertCandles(db, { openTimes });

  const result = getBacktestCandles(db, { symbol: "BTCUSDT", interval: "1", intervalMinutes: 1, lookbackDays: 30, minCandles: 200 });
  assert.ok(result);
  assert.equal(result.candles.length, 250);
  assert.equal(result.windowStart, baseTime);
  assert.equal(result.windowEnd, baseTime + 249 * 60000);

  db.close();
  cleanup(dbPath);
});

test("getBacktestCandles: dado insuficiente -- null (sinal pro fallback ao vivo)", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const baseTime = Date.now() - 50 * 60000;
  insertCandles(db, { openTimes: Array.from({ length: 50 }, (_, i) => baseTime + i * 60000) });

  const result = getBacktestCandles(db, { symbol: "BTCUSDT", interval: "1", intervalMinutes: 1, lookbackDays: 30, minCandles: 200 });
  assert.equal(result, null);

  db.close();
  cleanup(dbPath);
});

test("getBacktestCandles: trecho contíguo insuficiente mesmo com total >= minCandles -- null", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  // 2 fatias de 120 candles cada (total 240 >= 200), mas nenhuma fatia isolada chega a 200
  const baseTime = Date.now() - 20_120_000;
  const openTimesA = Array.from({ length: 120 }, (_, i) => baseTime + i * 60000);
  const openTimesB = Array.from({ length: 120 }, (_, i) => baseTime + 10_000_000 + i * 60000);
  insertCandles(db, { openTimes: [...openTimesA, ...openTimesB] });

  const result = getBacktestCandles(db, { symbol: "BTCUSDT", interval: "1", intervalMinutes: 1, lookbackDays: 30, minCandles: 200 });
  assert.equal(result, null);

  db.close();
  cleanup(dbPath);
});

test("getBacktestCandles: tabela vazia -- null", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  const result = getBacktestCandles(db, { symbol: "BTCUSDT", interval: "1", intervalMinutes: 1, lookbackDays: 30, minCandles: 200 });
  assert.equal(result, null);

  db.close();
  cleanup(dbPath);
});
