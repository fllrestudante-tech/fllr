const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { createEventBus } = require("../../lib/infra/eventBus");
const { collectCandles, collectFunding, collectOpenInterest } = require("../../lib/collectors/bybitCollector");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-collector-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("collectCandles: grava o penúltimo candle (o último pode estar em formação) e emite candle.closed", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const events = [];
  eventBus.on("candle.closed", (e) => events.push(e));

  const fakeClient = {
    getKlines: async () => [
      [1000, "10", "12", "9", "11", "5"], // fechado -- este é o gravado
      [2000, "11", "13", "10", "12", "7"], // em formação -- ignorado
    ],
  };

  const result = await collectCandles(db, eventBus, fakeClient, { exchange: "bybit", symbol: "BTCUSDT", interval: "1" });
  const rows = db.prepare("SELECT * FROM candles").all();
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].open_time, 1000);
  assert.equal(rows[0].close, 11);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.openTime, 1000);
});

test("collectCandles: rodar de novo com o mesmo candle não duplica nem reemite evento", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const events = [];
  eventBus.on("candle.closed", (e) => events.push(e));

  const fakeClient = {
    getKlines: async () => [
      [1000, "10", "12", "9", "11", "5"],
      [2000, "11", "13", "10", "12", "7"],
    ],
  };
  const opts = { exchange: "bybit", symbol: "BTCUSDT", interval: "1" };

  const first = await collectCandles(db, eventBus, fakeClient, opts);
  const second = await collectCandles(db, eventBus, fakeClient, opts);
  const rows = db.prepare("SELECT * FROM candles").all();
  db.close();
  cleanup(dbPath);

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(rows.length, 1);
  assert.equal(events.length, 1);
});

test("collectCandles: menos de 2 candles retornados não grava nada", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const fakeClient = { getKlines: async () => [[1000, "10", "12", "9", "11", "5"]] };

  const result = await collectCandles(db, eventBus, fakeClient, { exchange: "bybit", symbol: "BTCUSDT", interval: "1" });
  const rows = db.prepare("SELECT * FROM candles").all();
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, false);
  assert.equal(rows.length, 0);
});

test("collectFunding: grava funding novo e emite funding.updated", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const events = [];
  eventBus.on("funding.updated", (e) => events.push(e));

  const fakeClient = { getFundingHistory: async () => [{ fundingRate: "0.0001", fundingRateTimestamp: "5000" }] };
  const result = await collectFunding(db, eventBus, fakeClient, { exchange: "bybit", symbol: "BTCUSDT" });
  const rows = db.prepare("SELECT * FROM funding").all();
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].funding_time, 5000);
  assert.equal(events.length, 1);
});

test("collectFunding: mesmo funding_time não duplica", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const fakeClient = { getFundingHistory: async () => [{ fundingRate: "0.0001", fundingRateTimestamp: "5000" }] };
  const opts = { exchange: "bybit", symbol: "BTCUSDT" };

  await collectFunding(db, eventBus, fakeClient, opts);
  const second = await collectFunding(db, eventBus, fakeClient, opts);
  const rows = db.prepare("SELECT * FROM funding").all();
  db.close();
  cleanup(dbPath);

  assert.equal(second.inserted, false);
  assert.equal(rows.length, 1);
});

test("collectOpenInterest: grava OI novo e emite oi.updated", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const events = [];
  eventBus.on("oi.updated", (e) => events.push(e));

  const fakeClient = { getOpenInterest: async () => [{ openInterest: "1234.5", timestamp: "9000" }] };
  const result = await collectOpenInterest(db, eventBus, fakeClient, { exchange: "bybit", symbol: "BTCUSDT" });
  const rows = db.prepare("SELECT * FROM open_interest").all();
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].oi_value, 1234.5);
  assert.equal(events.length, 1);
});

test("collectFunding: lista vazia não grava nem emite", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  let called = false;
  eventBus.on("funding.updated", () => (called = true));

  const fakeClient = { getFundingHistory: async () => [] };
  const result = await collectFunding(db, eventBus, fakeClient, { exchange: "bybit", symbol: "BTCUSDT" });
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, false);
  assert.equal(called, false);
});
