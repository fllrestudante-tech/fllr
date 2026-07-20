const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const { backfillDomain, backfillCandles, backfillFunding, backfillOpenInterest } = require("../lib/backfill");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-backfill-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("backfillDomain: pagina corretamente avançando o cursor pelo maior timestamp da página", async () => {
  const pages = [
    [{ t: 0 }, { t: 1 }],
    [{ t: 2 }, { t: 3 }],
    [], // terceira chamada não tem mais nada -- para
  ];
  let call = 0;
  const inserted = [];
  const result = await backfillDomain(null, createEventBus(), {
    domain: "test",
    sinceMs: 0,
    untilMs: 10,
    fetchRange: async () => pages[call++] ?? [],
    insertRow: (row) => {
      inserted.push(row.t);
      return { inserted: true };
    },
    getTimestamp: (row) => row.t,
  });
  assert.equal(result.inserted, 4);
  assert.deepEqual(inserted, [0, 1, 2, 3]);
  assert.equal(call, 3);
});

test("backfillDomain: idempotente -- rodar 2x sobre o mesmo range só conta o que insertRow diz que inseriu de fato", async () => {
  const seen = new Set();
  const fetchRange = async () => [{ t: 5 }, { t: 6 }];
  const insertRow = (row) => {
    if (seen.has(row.t)) return { inserted: false };
    seen.add(row.t);
    return { inserted: true };
  };

  const first = await backfillDomain(null, createEventBus(), { domain: "test", sinceMs: 0, untilMs: 7, fetchRange, insertRow, getTimestamp: (r) => r.t });
  assert.equal(first.inserted, 2);

  const second = await backfillDomain(null, createEventBus(), { domain: "test", sinceMs: 0, untilMs: 7, fetchRange, insertRow, getTimestamp: (r) => r.t });
  assert.equal(second.inserted, 0, "segunda rodada não deveria inserir nada novo");
});

test("backfillDomain: página que não avança o cursor para em vez de repetir pra sempre", async () => {
  let calls = 0;
  const result = await backfillDomain(null, createEventBus(), {
    domain: "test",
    sinceMs: 0,
    untilMs: 1000,
    fetchRange: async () => {
      calls++;
      return [{ t: 0 }]; // sempre devolve o mesmo timestamp, nunca avança
    },
    insertRow: () => ({ inserted: false }),
    getTimestamp: (r) => r.t,
  });
  assert.equal(result.inserted, 0);
  assert.equal(calls, 1, "deveria parar na primeira página que não avançou, não continuar chamando");
});

test("backfillDomain: emite backfill.completed só quando algo foi inserido", async () => {
  const events = [];
  const eventBus = createEventBus();
  eventBus.on("backfill.completed", (e) => events.push(e));

  await backfillDomain(null, eventBus, {
    domain: "candles",
    sinceMs: 0,
    untilMs: 10,
    fetchRange: async () => [],
    insertRow: () => ({ inserted: false }),
    getTimestamp: () => 0,
  });
  assert.equal(events.length, 0);

  await backfillDomain(null, eventBus, {
    domain: "candles",
    sinceMs: 0,
    untilMs: 10,
    fetchRange: (function () {
      let called = false;
      return async () => {
        if (called) return [];
        called = true;
        return [{ t: 1 }];
      };
    })(),
    insertRow: () => ({ inserted: true }),
    getTimestamp: (r) => r.t,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.domain, "candles");
  assert.equal(events[0].payload.inserted, 1);
});

test("backfillCandles: usa bybitClient.getKlines com {start,end} e grava via INSERT OR IGNORE real", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();

  let callCount = 0;
  const fakeClient = {
    getKlines: async (symbol, interval, limit, { start, end }) => {
      callCount++;
      if (callCount > 1) return [];
      return [
        [start, "10", "12", "9", "11", "5"],
        [start + 60000, "11", "13", "10", "12", "7"],
      ];
    },
  };

  const result = await backfillCandles(db, eventBus, fakeClient, { symbol: "BTCUSDT", interval: "1", sinceMs: 1000, untilMs: 200000 });
  assert.equal(result.inserted, 2);

  const rows = db.prepare("SELECT open_time FROM candles ORDER BY open_time").all();
  assert.deepEqual(rows.map((r) => r.open_time), [1000, 61000]);

  db.close();
  cleanup(dbPath);
});

test("backfillCandles: rodar 2x sobre o mesmo range não duplica (idempotente via UNIQUE INDEX real)", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();

  const fakeClient = {
    getKlines: (function () {
      let called = 0;
      return async (symbol, interval, limit, { start }) => {
        called++;
        if (called % 2 === 0) return [];
        return [[start, "10", "12", "9", "11", "5"]];
      };
    })(),
  };

  await backfillCandles(db, eventBus, fakeClient, { symbol: "BTCUSDT", interval: "1", sinceMs: 1000, untilMs: 200000 });
  await backfillCandles(db, eventBus, fakeClient, { symbol: "BTCUSDT", interval: "1", sinceMs: 1000, untilMs: 200000 });

  const rows = db.prepare("SELECT count(*) as c FROM candles").all();
  assert.equal(rows[0].c, 1);

  db.close();
  cleanup(dbPath);
});

test("backfillFunding: usa startTime/endTime via bybitClient.getFundingHistory", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();

  let calls = 0;
  const fakeClient = {
    getFundingHistory: async (symbol, limit, { start }) => {
      calls++;
      if (calls > 1) return [];
      return [{ fundingRate: "0.0001", fundingRateTimestamp: String(start) }];
    },
  };

  const result = await backfillFunding(db, eventBus, fakeClient, { symbol: "BTCUSDT", sinceMs: 1000, untilMs: 999999999 });
  assert.equal(result.inserted, 1);
  const rows = db.prepare("SELECT funding_time FROM funding").all();
  assert.equal(rows[0].funding_time, 1000);

  db.close();
  cleanup(dbPath);
});

test("backfillOpenInterest: usa startTime/endTime via bybitClient.getOpenInterest", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();

  let calls = 0;
  const fakeClient = {
    getOpenInterest: async (symbol, intervalTime, limit, { start }) => {
      calls++;
      if (calls > 1) return [];
      return [{ openInterest: "1234.5", timestamp: String(start) }];
    },
  };

  const result = await backfillOpenInterest(db, eventBus, fakeClient, { symbol: "BTCUSDT", sinceMs: 1000, untilMs: 999999999 });
  assert.equal(result.inserted, 1);
  const rows = db.prepare("SELECT snapshot_time FROM open_interest").all();
  assert.equal(rows[0].snapshot_time, 1000);

  db.close();
  cleanup(dbPath);
});
