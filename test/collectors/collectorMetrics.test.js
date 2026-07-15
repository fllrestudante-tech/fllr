const test = require("node:test");
const assert = require("node:assert/strict");
const { createCollectorMetrics } = require("../../lib/collectors/collectorMetrics");

test("recordSuccess: inserted=true incrementa totalInserted, não totalSkipped", () => {
  const m = createCollectorMetrics();
  m.recordSuccess("candles", { inserted: true, latencyMs: 100 });
  const metrics = m.getMetrics();
  assert.equal(metrics.candles.totalRuns, 1);
  assert.equal(metrics.candles.totalInserted, 1);
  assert.equal(metrics.candles.totalSkipped, 0);
  assert.equal(metrics.candles.consecutiveFailures, 0);
  assert.equal(metrics.candles.lastLatencyMs, 100);
});

test("recordSuccess: inserted=false (duplicata) incrementa totalSkipped, não totalInserted", () => {
  const m = createCollectorMetrics();
  m.recordSuccess("funding", { inserted: false });
  const metrics = m.getMetrics();
  assert.equal(metrics.funding.totalInserted, 0);
  assert.equal(metrics.funding.totalSkipped, 1);
});

test("recordFailure: incrementa totalErrors e consecutiveFailures, guarda lastError", () => {
  const m = createCollectorMetrics();
  m.recordFailure("open_interest", new Error("ENOTFOUND"));
  m.recordFailure("open_interest", new Error("ETIMEDOUT"));
  const metrics = m.getMetrics();
  assert.equal(metrics.open_interest.totalErrors, 2);
  assert.equal(metrics.open_interest.consecutiveFailures, 2);
  assert.equal(metrics.open_interest.lastError, "ETIMEDOUT");
});

test("recordSuccess após recordFailure zera consecutiveFailures", () => {
  const m = createCollectorMetrics();
  m.recordFailure("ticker", new Error("boom"));
  m.recordFailure("ticker", new Error("boom"));
  m.recordSuccess("ticker", { inserted: true });
  assert.equal(m.getMetrics().ticker.consecutiveFailures, 0);
});

test("domínios diferentes não se misturam", () => {
  const m = createCollectorMetrics();
  m.recordSuccess("candles", { inserted: true });
  m.recordFailure("funding", new Error("x"));
  const metrics = m.getMetrics();
  assert.equal(metrics.candles.totalErrors, 0);
  assert.equal(metrics.funding.totalInserted, 0);
});

test("getMetrics retorna cópia -- mutar o resultado não afeta o estado interno", () => {
  const m = createCollectorMetrics();
  m.recordSuccess("candles", { inserted: true });
  const snapshot = m.getMetrics();
  snapshot.candles.totalRuns = 999;
  assert.equal(m.getMetrics().candles.totalRuns, 1);
});
