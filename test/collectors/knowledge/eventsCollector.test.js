const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../../lib/infra/db");
const { createEventBus } = require("../../../lib/infra/eventBus");
const { upsertEvent, collectFromProvider } = require("../../../lib/collectors/knowledge/eventsCollector");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-events-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

function baseNormalized(overrides = {}) {
  return {
    sourceEventId: "evt-1",
    title: "Evento teste",
    description: "desc",
    category: "unlock",
    assets: ["SOL"],
    eventTime: 1784100000000,
    confirmed: true,
    sourceUrl: "https://example.com",
    ...overrides,
  };
}

test("upsertEvent: primeira vez insere, aplica defaults de categoria e grava assets", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  const result = upsertEvent(db, "test-provider", baseNormalized());
  const row = db.prepare("SELECT * FROM market_events WHERE id = ?").get(result.eventId);
  const assets = db.prepare("SELECT asset FROM market_event_assets WHERE event_id = ?").all(result.eventId).map((r) => r.asset);
  db.close();
  cleanup(dbPath);

  assert.equal(result.action, "inserted");
  assert.equal(row.severity, 2); // default de "unlock"
  assert.equal(row.expected_volatility, "MEDIUM");
  assert.equal(row.market_scope, "SOL");
  assert.deepEqual(assets, ["SOL"]);
  assert.equal(row.recorded_at, row.updated_at);
});

test("upsertEvent: mesma entrada de novo não muda nada (unchanged)", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  upsertEvent(db, "test-provider", baseNormalized());
  const second = upsertEvent(db, "test-provider", baseNormalized());
  const count = db.prepare("SELECT COUNT(*) c FROM market_events").get().c;
  db.close();
  cleanup(dbPath);

  assert.equal(second.action, "unchanged");
  assert.equal(count, 1);
});

test("upsertEvent: título mudou -- atualiza e avança updated_at", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  const first = upsertEvent(db, "test-provider", baseNormalized());
  const second = upsertEvent(db, "test-provider", baseNormalized({ title: "Título revisado" }));
  const row = db.prepare("SELECT * FROM market_events WHERE id = ?").get(first.eventId);
  db.close();
  cleanup(dbPath);

  assert.equal(second.action, "updated");
  assert.equal(row.title, "Título revisado");
});

test("upsertEvent: sem event_time válido é ignorado", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  const result = upsertEvent(db, "test-provider", baseNormalized({ eventTime: null }));
  const count = db.prepare("SELECT COUNT(*) c FROM market_events").get().c;
  db.close();
  cleanup(dbPath);

  assert.equal(result.action, "skipped_invalid");
  assert.equal(count, 0);
});

test("collectFromProvider: provider fake gera eventos, emite market_event.created e registra métricas", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const created = [];
  eventBus.on("market_event.created", (e) => created.push(e));

  const fakeProvider = {
    name: "fake",
    fetchRawEvents: async () => [{ id: 1 }],
    normalize: (raw) => baseNormalized({ sourceEventId: `fake-${raw.id}` }),
  };
  const { createCollectorMetrics } = require("../../../lib/collectors/collectorMetrics");
  const metrics = createCollectorMetrics();

  await collectFromProvider(db, eventBus, fakeProvider, {}, metrics);
  const count = db.prepare("SELECT COUNT(*) c FROM market_events").get().c;
  db.close();
  cleanup(dbPath);

  assert.equal(count, 1);
  assert.equal(created.length, 1);
  assert.equal(metrics.getMetrics().fake.totalInserted, 1);
});

test("collectFromProvider: falha do provider é isolada, registra erro nas métricas", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const eventBus = createEventBus();
  const fakeProvider = {
    name: "fake-quebrado",
    fetchRawEvents: async () => {
      throw new Error("fonte fora do ar");
    },
    normalize: () => ({}),
  };
  const { createCollectorMetrics } = require("../../../lib/collectors/collectorMetrics");
  const metrics = createCollectorMetrics();

  await collectFromProvider(db, eventBus, fakeProvider, {}, metrics);
  db.close();
  cleanup(dbPath);

  assert.equal(metrics.getMetrics()["fake-quebrado"].totalErrors, 1);
});
