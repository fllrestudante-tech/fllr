const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../lib/infra/db");
const {
  readLatestFearGreedHistory,
  readLatestFunding,
  readOpenInterestTrend,
  readLongShortSkew,
  readDominanceTrend,
  gatherMarketBrainInputs,
} = require("../lib/brains/marketBrainData");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-marketbraindata-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("readLatestFearGreedHistory: devolve mais recente primeiro, respeitando limit", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const insert = db.prepare("INSERT INTO fear_greed (uuid, source, value, classification, snapshot_time, recorded_at) VALUES (?,?,?,?,?,?)");
  insert.run("u1", "alternative.me", 25, "Fear", 1000, new Date(1000).toISOString());
  insert.run("u2", "alternative.me", 30, "Fear", 2000, new Date(2000).toISOString());
  insert.run("u3", "alternative.me", 60, "Greed", 3000, new Date(3000).toISOString());

  const history = readLatestFearGreedHistory(db, { limit: 2 });
  assert.equal(history.length, 2);
  assert.equal(history[0].value, 60);
  assert.equal(history[1].value, 30);

  db.close();
  cleanup(dbPath);
});

test("readLatestFunding: pega o funding_rate mais recente do symbol certo", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const insert = db.prepare("INSERT INTO funding (uuid, exchange, symbol, funding_rate, funding_time, recorded_at) VALUES (?,?,?,?,?,?)");
  insert.run("u1", "bybit", "BTCUSDT", 0.0001, 1000, new Date(1000).toISOString());
  insert.run("u2", "bybit", "BTCUSDT", -0.0002, 2000, new Date(2000).toISOString());
  insert.run("u3", "bybit", "ETHUSDT", 0.0005, 3000, new Date(3000).toISOString()); // outro symbol, não deve aparecer

  assert.equal(readLatestFunding(db, { symbol: "BTCUSDT" }), -0.0002);
  assert.equal(readLatestFunding(db, { symbol: "SOLUSDT" }), null);

  db.close();
  cleanup(dbPath);
});

test("readOpenInterestTrend: % de variação entre o mais recente e o mais antigo da janela", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const insert = db.prepare("INSERT INTO open_interest (uuid, exchange, symbol, oi_value, snapshot_time, recorded_at) VALUES (?,?,?,?,?,?)");
  insert.run("u1", "bybit", "BTCUSDT", 1000, 1000, new Date(1000).toISOString());
  insert.run("u2", "bybit", "BTCUSDT", 1100, 2000, new Date(2000).toISOString());

  const trend = readOpenInterestTrend(db, { symbol: "BTCUSDT", periods: 2 });
  assert.ok(Math.abs(trend - 10) < 1e-9); // (1100-1000)/1000*100 = 10%

  db.close();
  cleanup(dbPath);
});

test("readOpenInterestTrend: menos de 2 pontos -- null (não fabrica tendência)", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const insert = db.prepare("INSERT INTO open_interest (uuid, exchange, symbol, oi_value, snapshot_time, recorded_at) VALUES (?,?,?,?,?,?)");
  insert.run("u1", "bybit", "BTCUSDT", 1000, 1000, new Date(1000).toISOString());

  assert.equal(readOpenInterestTrend(db, { symbol: "BTCUSDT" }), null);

  db.close();
  cleanup(dbPath);
});

test("readLongShortSkew: buy_ratio - 0.5", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const insert = db.prepare("INSERT INTO long_short_ratio (uuid, exchange, symbol, buy_ratio, sell_ratio, snapshot_time, recorded_at) VALUES (?,?,?,?,?,?,?)");
  insert.run("u1", "bybit", "BTCUSDT", 0.6, 0.4, 1000, new Date(1000).toISOString());

  const skew = readLongShortSkew(db, { symbol: "BTCUSDT" });
  assert.ok(Math.abs(skew - 0.1) < 1e-9);

  db.close();
  cleanup(dbPath);
});

test("readDominanceTrend: % de variação da dominância BTC, sem filtro de symbol", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const insert = db.prepare(
    "INSERT INTO btc_dominance (uuid, source, btc_dominance_pct, total_market_cap_usd, total_volume_24h_usd, snapshot_time, recorded_at) VALUES (?,?,?,?,?,?,?)"
  );
  insert.run("u1", "coingecko", 56, 1, 1, 1000, new Date(1000).toISOString());
  insert.run("u2", "coingecko", 55, 1, 1, 2000, new Date(2000).toISOString());

  const trend = readDominanceTrend(db, { periods: 2 });
  assert.ok(trend < 0); // caiu de 56 pra 55

  db.close();
  cleanup(dbPath);
});

test("gatherMarketBrainInputs: monta o shape completo esperado por analyzeMarket", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  const insertFg = db.prepare("INSERT INTO fear_greed (uuid, source, value, classification, snapshot_time, recorded_at) VALUES (?,?,?,?,?,?)");
  insertFg.run("u1", "alternative.me", 40, "Fear", 1000, new Date(1000).toISOString());

  // Sem candles suficientes de propósito -- confirma que closes vem [] em vez de quebrar.
  const inputs = gatherMarketBrainInputs(db, { symbol: "BTCUSDT", interval: "1" });

  assert.deepEqual(inputs.closes, []);
  assert.equal(inputs.fearGreedHistory.length, 1);
  assert.equal(inputs.fundingRate, null);
  assert.equal(inputs.oiTrendPct, null);
  assert.equal(inputs.longShortSkew, null);
  assert.equal(inputs.dominanceTrendPct, null);

  db.close();
  cleanup(dbPath);
});
