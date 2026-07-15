const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { createEventBus } = require("../../lib/infra/eventBus");
const { collectFearGreed } = require("../../lib/collectors/fearGreedCollector");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-feargreed-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("collectFearGreed: grava valor novo (converte timestamp de segundos pra ms) e emite evento", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const events = [];
  eventBus.on("fear_greed.updated", (e) => events.push(e));

  const fakeClient = { getFearGreedIndex: async () => [{ value: "25", value_classification: "Extreme Fear", timestamp: "1784073600" }] };
  const result = await collectFearGreed(db, eventBus, fakeClient);
  const rows = db.prepare("SELECT * FROM fear_greed").all();
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 25);
  assert.equal(rows[0].classification, "Extreme Fear");
  assert.equal(rows[0].snapshot_time, 1784073600000);
  assert.equal(rows[0].source, "alternative.me");
  assert.equal(events.length, 1);
});

test("collectFearGreed: mesmo snapshot_time (mesma leitura diária) não duplica", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const fakeClient = { getFearGreedIndex: async () => [{ value: "25", value_classification: "Extreme Fear", timestamp: "1784073600" }] };

  await collectFearGreed(db, eventBus, fakeClient);
  const second = await collectFearGreed(db, eventBus, fakeClient);
  const rows = db.prepare("SELECT * FROM fear_greed").all();
  db.close();
  cleanup(dbPath);

  assert.equal(second.inserted, false);
  assert.equal(rows.length, 1);
});

test("collectFearGreed: lista vazia não grava nem emite", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  let called = false;
  eventBus.on("fear_greed.updated", () => (called = true));

  const fakeClient = { getFearGreedIndex: async () => [] };
  const result = await collectFearGreed(db, eventBus, fakeClient);
  db.close();
  cleanup(dbPath);

  assert.equal(result.inserted, false);
  assert.equal(called, false);
});

test("collectFearGreed: valor diferente do dia anterior grava como nova linha", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  let calls = 0;
  const fakeClient = {
    getFearGreedIndex: async () => {
      calls++;
      return calls === 1
        ? [{ value: "22", value_classification: "Extreme Fear", timestamp: "1783987200" }]
        : [{ value: "25", value_classification: "Extreme Fear", timestamp: "1784073600" }];
    },
  };

  await collectFearGreed(db, eventBus, fakeClient);
  await collectFearGreed(db, eventBus, fakeClient);
  const rows = db.prepare("SELECT * FROM fear_greed ORDER BY snapshot_time").all();
  db.close();
  cleanup(dbPath);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].value, 22);
  assert.equal(rows[1].value, 25);
});
