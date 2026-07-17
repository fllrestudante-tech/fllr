const test = require("node:test");
const assert = require("node:assert/strict");
const { computeFreshnessScore, computeFreshnessForDomains } = require("../lib/freshnessScore");

test("nunca teve sucesso: score 0, state never_succeeded", () => {
  const result = computeFreshnessScore("open_interest", null);
  assert.equal(result.score, 0);
  assert.equal(result.state, "never_succeeded");
  assert.equal(result.ageMs, null);
});

test("exemplo do usuário: Open Interest SLA 5min, última coleta há 2min -> 100 (fresh)", () => {
  const now = new Date("2026-07-16T08:02:00.000Z").getTime();
  const result = computeFreshnessScore("open_interest", "2026-07-16T08:00:00.000Z", now);
  assert.equal(result.score, 100);
  assert.equal(result.state, "fresh");
});

test("exemplo do usuário: Fear&Greed SLA 24h, última coleta há 13h -> 100 (fresh, porque só atualiza 1x/dia)", () => {
  const now = new Date("2026-07-16T13:00:00.000Z").getTime();
  const result = computeFreshnessScore("fear_greed", "2026-07-16T00:00:00.000Z", now);
  assert.equal(result.score, 100);
  assert.equal(result.state, "fresh");
});

test("exemplo do usuário: Open Interest SLA 5min, última coleta há 13h -> 0 (muito além da tolerância)", () => {
  const now = new Date("2026-07-16T13:00:00.000Z").getTime();
  const result = computeFreshnessScore("open_interest", "2026-07-16T00:00:00.000Z", now);
  assert.equal(result.score, 0);
  assert.equal(result.state, "stale");
});

test("zona de tolerância: decai linearmente entre expectedIntervalMs e expectedIntervalMs*toleranceMultiplier", () => {
  // open_interest: expected=5min, tolerance=2x -> decai de 5min(100) a 10min(0). Em 7min30s (metade do range de decaimento) -> ~50.
  const now = new Date("2026-07-16T08:07:30.000Z").getTime();
  const result = computeFreshnessScore("open_interest", "2026-07-16T08:00:00.000Z", now);
  assert.equal(result.state, "late");
  assert.equal(result.score, 50);
});

test("computeFreshnessForDomains: mapeia um objeto no formato de collectorMetrics.getMetrics()", () => {
  const now = new Date("2026-07-16T08:02:00.000Z").getTime();
  const domainsMetrics = {
    open_interest: { lastSuccessAt: "2026-07-16T08:00:00.000Z" },
    candles: { lastSuccessAt: null },
  };
  const result = computeFreshnessForDomains(domainsMetrics, now);
  assert.equal(result.open_interest.score, 100);
  assert.equal(result.candles.state, "never_succeeded");
});
