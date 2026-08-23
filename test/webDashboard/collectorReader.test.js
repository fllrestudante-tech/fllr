const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { readCollectors } = require("../../lib/webDashboard/collectorReader");

function tmpDbPath(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function cleanupDb(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("readCollectors: 1 linha por símbolo, coverage/sanity reais contra o banco", () => {
  const dbPath = tmpDbPath("collectors.db");
  const db = openDb(dbPath);
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO candles (uuid, exchange, symbol, interval, open_time, open, high, low, close, volume, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (let i = 0; i < 60; i++) {
    const openTime = now - i * 60000;
    insert.run(`btc-${i}`, "bybit", "BTCUSDT", "1", openTime, 100, 101, 99, 100.5, 10, new Date(openTime).toISOString());
  }
  db.close();

  const result = readCollectors({ dbPath, symbols: ["BTCUSDT", "ETHUSDT"], heartbeatPath: tmpFile("nao-existe.json") });
  cleanupDb(dbPath);

  assert.deepEqual(result.universe, ["BTCUSDT", "ETHUSDT"]);
  assert.equal(result.rows.length, 2);
  const btc = result.rows.find((r) => r.symbol === "BTCUSDT");
  assert.equal(btc.coveragePct, 100);
  const eth = result.rows.find((r) => r.symbol === "ETHUSDT");
  assert.equal(eth.coveragePct, 0);
  assert.equal(result.schedulerStats, null);
  assert.equal(result.rateLimitStats, null);
});

test("readCollectors: com heartbeat, repassa schedulerStats/rateLimitStats e freshness por símbolo", () => {
  const dbPath = tmpDbPath("collectors-heartbeat.db");
  openDb(dbPath).close();
  const heartbeatPath = tmpFile("heartbeat.json");
  fs.writeFileSync(
    heartbeatPath,
    JSON.stringify({
      metrics: { candles: { bySymbol: { BTCUSDT: { lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0 } } } },
      schedulerStats: { candles: { activeCount: 1, queuedCount: 0 } },
      rateLimitStats: { totalRetries: 2, total429: 0, totalBackoffMs: 500 },
    })
  );

  const result = readCollectors({ dbPath, symbols: ["BTCUSDT"], heartbeatPath });
  cleanupDb(dbPath);
  fs.unlinkSync(heartbeatPath);

  assert.equal(result.rows[0].freshnessState, "fresh");
  assert.equal(result.rows[0].consecutiveFailures, 0);
  assert.deepEqual(result.schedulerStats, { candles: { activeCount: 1, queuedCount: 0 } });
  assert.deepEqual(result.rateLimitStats, { totalRetries: 2, total429: 0, totalBackoffMs: 500 });
});

test("readCollectors: banco inexistente devolve fallback honesto, não lança erro", () => {
  const result = readCollectors({ dbPath: tmpDbPath("nao-existe.db"), symbols: ["BTCUSDT"], heartbeatPath: tmpFile("tambem-nao-existe.json") });
  assert.equal(result.rows[0].coveragePct, null);
  assert.equal(result.rows[0].freshnessState, "sem_dado");
});
