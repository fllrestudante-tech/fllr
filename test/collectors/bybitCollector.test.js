const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { createEventBus } = require("../../lib/infra/eventBus");
const { collectCandles, collectFunding, collectOpenInterest, collectTicker, collectLongShortRatio, runCollector } = require("../../lib/collectors/bybitCollector");

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

test("collectTicker: grava snapshot e emite ticker.updated a cada chamada (sem chave de idempotência)", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const events = [];
  eventBus.on("ticker.updated", (e) => events.push(e));

  const fakeTicker = {
    lastPrice: "65000",
    markPrice: "65010",
    indexPrice: "65005",
    bid1Price: "64999",
    ask1Price: "65001",
    volume24h: "1000",
    turnover24h: "65000000",
    price24hPcnt: "0.02",
    fundingRate: "0.0001",
    openInterest: "500",
  };
  const fakeClient = { getTickers: async () => [fakeTicker] };
  const opts = { exchange: "bybit", symbol: "BTCUSDT" };

  await collectTicker(db, eventBus, fakeClient, opts);
  await collectTicker(db, eventBus, fakeClient, opts); // segunda chamada -- observação nova, não duplicata

  const rows = db.prepare("SELECT * FROM tickers_snapshot").all();
  db.close();
  cleanup(dbPath);

  assert.equal(rows.length, 2); // ambas gravadas -- ticker não tem chave natural de idempotência
  assert.equal(rows[0].last_price, 65000);
  assert.equal(rows[0].mark_price, 65010);
  assert.equal(events.length, 2);
});

test("collectTicker: lista vazia não grava nem emite", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  let called = false;
  eventBus.on("ticker.updated", () => (called = true));

  const fakeClient = { getTickers: async () => [] };
  const result = await collectTicker(db, eventBus, fakeClient, { exchange: "bybit", symbol: "BTCUSDT" });
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, false);
  assert.equal(called, false);
});

test("collectLongShortRatio: grava e emite long_short_ratio.updated", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const events = [];
  eventBus.on("long_short_ratio.updated", (e) => events.push(e));

  const fakeClient = { getLongShortRatio: async () => [{ buyRatio: "0.55", sellRatio: "0.45", timestamp: "7000" }] };
  const result = await collectLongShortRatio(db, eventBus, fakeClient, { exchange: "bybit", symbol: "BTCUSDT" });
  const rows = db.prepare("SELECT * FROM long_short_ratio").all();
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].buy_ratio, 0.55);
  assert.equal(events.length, 1);
});

test("collectLongShortRatio: mesmo snapshot_time não duplica", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const fakeClient = { getLongShortRatio: async () => [{ buyRatio: "0.55", sellRatio: "0.45", timestamp: "7000" }] };
  const opts = { exchange: "bybit", symbol: "BTCUSDT" };

  await collectLongShortRatio(db, eventBus, fakeClient, opts);
  const second = await collectLongShortRatio(db, eventBus, fakeClient, opts);
  const rows = db.prepare("SELECT * FROM long_short_ratio").all();
  db.close();
  cleanup(dbPath);

  assert.equal(second.inserted, false);
  assert.equal(rows.length, 1);
});

// Fase A (expansão multi-asset) -- runCollector agora cobre uma lista de
// símbolos (intervals.symbols override, sem depender de env var no teste),
// espalhados pelo requestScheduler em vez de rodar 1 símbolo só.

function fakeMultiSymbolClient() {
  let candleTime = 1000;
  return {
    getKlines: async () => {
      candleTime += 60000;
      return [
        [candleTime - 60000, "10", "12", "9", "11", "5"],
        [candleTime, "11", "13", "10", "12", "7"], // último "em formação", ignorado
      ];
    },
    getFundingHistory: async () => [{ fundingRate: "0.0001", fundingRateTimestamp: String(Date.now()) }],
    getOpenInterest: async () => [{ openInterest: "1000", timestamp: String(Date.now()) }],
    getTickers: async () => [
      { lastPrice: "100", markPrice: "100", indexPrice: "100", bid1Price: "99", ask1Price: "101", volume24h: "10", turnover24h: "1000", price24hPcnt: "0.01", fundingRate: "0.0001", openInterest: "1000" },
    ],
    getLongShortRatio: async () => [{ buyRatio: "0.5", sellRatio: "0.5", timestamp: String(Date.now()) }],
  };
}

test("runCollector: cobre todos os símbolos de intervals.symbols, não só 1", (t, done) => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const fakeClient = fakeMultiSymbolClient();
  const config = { symbol: "BTCUSDT", interval: "1" };

  const collector = runCollector(db, eventBus, fakeClient, config, {
    symbols: ["BTCUSDT", "ETHUSDT"],
    candlesMs: 100,
    fundingMs: 100,
    oiMs: 100,
    tickerMs: 100,
    longShortMs: 100,
    maxConcurrent: 4,
  });

  // janela de 100ms, 2 símbolos -> offsets [0, 50] -- 90ms dá margem pros
  // dois já terem disparado ao menos uma vez.
  setTimeout(() => {
    collector.stop();
    const candleSymbols = db.prepare("SELECT DISTINCT symbol FROM candles ORDER BY symbol").all().map((r) => r.symbol);
    db.close();
    cleanup(dbPath);

    assert.deepEqual(candleSymbols, ["BTCUSDT", "ETHUSDT"]);
    done();
  }, 90);
});

test("runCollector: auto-registra os dois símbolos em `asset` com base/quote corretos", (t, done) => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const fakeClient = fakeMultiSymbolClient();
  const config = { symbol: "BTCUSDT", interval: "1" };

  const collector = runCollector(db, eventBus, fakeClient, config, {
    symbols: ["BTCUSDT", "ETHUSDT"],
    candlesMs: 100,
    fundingMs: 100,
    oiMs: 100,
    tickerMs: 100,
    longShortMs: 100,
    maxConcurrent: 4,
  });

  setTimeout(() => {
    collector.stop();
    const assets = db.prepare("SELECT symbol, base_asset, quote_asset, category, origin FROM asset ORDER BY symbol").all();
    db.close();
    cleanup(dbPath);

    assert.deepEqual(assets, [
      { symbol: "BTCUSDT", base_asset: "BTC", quote_asset: "USDT", category: "crypto", origin: "auto-collector" },
      { symbol: "ETHUSDT", base_asset: "ETH", quote_asset: "USDT", category: "crypto", origin: "auto-collector" },
    ]);
    done();
  }, 90);
});

test("runCollector: getMetrics() reporta granularidade por símbolo (bySymbol)", (t, done) => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const fakeClient = fakeMultiSymbolClient();
  const config = { symbol: "BTCUSDT", interval: "1" };

  const collector = runCollector(db, eventBus, fakeClient, config, {
    symbols: ["BTCUSDT", "ETHUSDT"],
    candlesMs: 100,
    fundingMs: 100,
    oiMs: 100,
    tickerMs: 100,
    longShortMs: 100,
    maxConcurrent: 4,
  });

  setTimeout(() => {
    collector.stop();
    const metrics = collector.getMetrics();
    db.close();
    cleanup(dbPath);

    assert.ok(metrics.candles.bySymbol.BTCUSDT.totalRuns >= 1);
    assert.ok(metrics.candles.bySymbol.ETHUSDT.totalRuns >= 1);
    assert.ok(metrics.candles.totalRuns >= metrics.candles.bySymbol.BTCUSDT.totalRuns);
    done();
  }, 90);
});

test("runCollector: stop() cancela todos os schedulers -- nenhum tick novo depois disso", (t, done) => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const fakeClient = fakeMultiSymbolClient();
  const config = { symbol: "BTCUSDT", interval: "1" };

  const collector = runCollector(db, eventBus, fakeClient, config, {
    symbols: ["BTCUSDT"],
    candlesMs: 20,
    fundingMs: 20,
    oiMs: 20,
    tickerMs: 20,
    longShortMs: 20,
    maxConcurrent: 4,
  });

  setTimeout(() => {
    collector.stop();
    const countAfterStop = db.prepare("SELECT COUNT(*) as c FROM candles").get().c;
    setTimeout(() => {
      const countLater = db.prepare("SELECT COUNT(*) as c FROM candles").get().c;
      db.close();
      cleanup(dbPath);
      assert.equal(countLater, countAfterStop, "não deveria haver inserts novos depois do stop()");
      done();
    }, 60);
  }, 30);
});
