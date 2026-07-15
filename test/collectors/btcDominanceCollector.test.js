const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { createEventBus } = require("../../lib/infra/eventBus");
const { collectBtcDominance } = require("../../lib/collectors/btcDominanceCollector");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-dominance-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

function fakeGlobalData(overrides = {}) {
  return {
    market_cap_percentage: { btc: 56.34, eth: 9.84 },
    total_market_cap: { usd: 2303848653386.4 },
    total_volume: { usd: 76889255596.47 },
    market_cap_change_percentage_24h_usd: 2.93,
    updated_at: 1784106338,
    ...overrides,
  };
}

test("collectBtcDominance: grava snapshot (converte timestamp de segundos pra ms) e emite evento", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const events = [];
  eventBus.on("btc_dominance.updated", (e) => events.push(e));

  const fakeClient = { getGlobalMarketData: async () => fakeGlobalData() };
  const result = await collectBtcDominance(db, eventBus, fakeClient);
  const rows = db.prepare("SELECT * FROM btc_dominance").all();
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].btc_dominance_pct, 56.34);
  assert.equal(rows[0].eth_dominance_pct, 9.84);
  assert.equal(rows[0].snapshot_time, 1784106338000);
  assert.equal(rows[0].source, "coingecko");
  assert.equal(events.length, 1);
});

test("collectBtcDominance: mesmo snapshot_time (cache da CoinGecko não virou) não duplica", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const fakeClient = { getGlobalMarketData: async () => fakeGlobalData() };

  await collectBtcDominance(db, eventBus, fakeClient);
  const second = await collectBtcDominance(db, eventBus, fakeClient);
  const rows = db.prepare("SELECT * FROM btc_dominance").all();
  db.close();
  cleanup(dbPath);

  assert.equal(second.inserted, false);
  assert.equal(rows.length, 1);
});

test("collectBtcDominance: snapshot_time novo (cache virou) grava linha nova", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  let calls = 0;
  const fakeClient = {
    getGlobalMarketData: async () => {
      calls++;
      return fakeGlobalData({ updated_at: calls === 1 ? 1784106338 : 1784107000 });
    },
  };

  await collectBtcDominance(db, eventBus, fakeClient);
  await collectBtcDominance(db, eventBus, fakeClient);
  const rows = db.prepare("SELECT * FROM btc_dominance").all();
  db.close();
  cleanup(dbPath);

  assert.equal(rows.length, 2);
});

test("collectBtcDominance: resposta sem market_cap_percentage.btc não grava nem emite", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  let called = false;
  eventBus.on("btc_dominance.updated", () => (called = true));

  const fakeClient = { getGlobalMarketData: async () => ({ market_cap_percentage: {} }) };
  const result = await collectBtcDominance(db, eventBus, fakeClient);
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, false);
  assert.equal(called, false);
});
