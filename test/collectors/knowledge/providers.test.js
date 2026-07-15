const test = require("node:test");
const assert = require("node:assert/strict");
const coinMarketCalProvider = require("../../../lib/collectors/knowledge/providers/coinMarketCalProvider");
const fredProvider = require("../../../lib/collectors/knowledge/providers/fredProvider");
const fomcCalendarProvider = require("../../../lib/collectors/knowledge/providers/fomcCalendarProvider");

test("coinMarketCalProvider.normalize: mapeia título string, data e ativos", () => {
  const raw = {
    id: 123,
    title: "Solana Mainnet Upgrade",
    displayedDate: "2026-08-01T00:00:00.000Z",
    coins: [{ symbol: "sol" }],
    categories: [{ name: "Mainnet" }],
    percentage: "82",
    source: "https://example.com/proof",
  };
  const n = coinMarketCalProvider.normalize(raw);
  assert.equal(n.sourceEventId, "123");
  assert.equal(n.title, "Solana Mainnet Upgrade");
  assert.deepEqual(n.assets, ["SOL"]);
  assert.equal(n.category, "hard_fork");
  assert.equal(n.confirmed, true);
  assert.equal(n.eventTime, new Date("2026-08-01T00:00:00.000Z").getTime());
});

test("coinMarketCalProvider.normalize: título como objeto {en}, sem coins/categories", () => {
  const raw = { id: 456, title: { en: "Evento genérico" }, date_event: "2026-09-01 00:00:00" };
  const n = coinMarketCalProvider.normalize(raw);
  assert.equal(n.title, "Evento genérico");
  assert.deepEqual(n.assets, []);
  assert.equal(n.category, "other");
});

test("coinMarketCalProvider.normalize: percentage abaixo de 50 marca como não confirmado", () => {
  const raw = { id: 789, title: "Rumor", displayedDate: "2026-08-01", percentage: "20" };
  const n = coinMarketCalProvider.normalize(raw);
  assert.equal(n.confirmed, false);
});

test("fredProvider.normalize: mapeia release date pra evento macro", () => {
  const raw = { release_id: 10, date: "2026-08-12", category: "cpi", title: "Consumer Price Index (CPI)" };
  const n = fredProvider.normalize(raw);
  assert.equal(n.sourceEventId, "10-2026-08-12");
  assert.equal(n.category, "cpi");
  assert.deepEqual(n.assets, []);
  assert.equal(n.confirmed, true);
  assert.ok(n.sourceUrl.includes("rid=10"));
});

test("fomcCalendarProvider: fetchRawEvents não faz chamada de rede e devolve o calendário estático", async () => {
  const events = await fomcCalendarProvider.fetchRawEvents();
  assert.ok(events.length >= 8);
  assert.ok(events[0].start);
});

test("fomcCalendarProvider.normalize: usa o segundo dia da reunião como event_time, categoria fomc", () => {
  const n = fomcCalendarProvider.normalize({ start: "2026-01-27", end: "2026-01-28" });
  assert.equal(n.category, "fomc");
  assert.equal(n.sourceEventId, "fomc-2026-01-27");
  assert.equal(n.eventTime, new Date("2026-01-28T18:00:00Z").getTime());
});
