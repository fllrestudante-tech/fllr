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

test("janela deslizante: antes de windowMs passar, lastWindow continua null e a janela aberta acumula", () => {
  let t = 0;
  const m = createCollectorMetrics({ now: () => t, windowMs: 1000 });
  m.recordSuccess("candles", { inserted: true });
  t += 500;
  m.recordSuccess("candles", { inserted: false });
  const metrics = m.getMetrics();
  assert.equal(metrics.candles.lastWindow, null);
  assert.equal(metrics.candles.windowRuns, 2);
  assert.equal(metrics.candles.windowInserted, 1);
});

test("janela deslizante: fecha sozinha na próxima chamada depois de windowMs, reseta a janela aberta", () => {
  let t = 0;
  const m = createCollectorMetrics({ now: () => t, windowMs: 1000 });
  m.recordSuccess("candles", { inserted: true });
  m.recordFailure("candles", new Error("x"));
  t = 1500; // passou da janela de 1000ms
  m.recordSuccess("candles", { inserted: true }); // essa chamada fecha a janela anterior antes de contar

  const metrics = m.getMetrics();
  assert.equal(metrics.candles.lastWindow.runs, 2);
  assert.equal(metrics.candles.lastWindow.inserted, 1);
  assert.equal(metrics.candles.lastWindow.errors, 1);
  assert.equal(metrics.candles.lastWindow.durationMs, 1500);
  // janela nova já reflete só a chamada que disparou o fechamento
  assert.equal(metrics.candles.windowRuns, 1);
  assert.equal(metrics.candles.windowInserted, 1);
  assert.equal(metrics.candles.windowErrors, 0);
});

test("janela deslizante: domínios diferentes têm janelas independentes", () => {
  let t = 0;
  const m = createCollectorMetrics({ now: () => t, windowMs: 1000 });
  m.recordSuccess("candles", { inserted: true });
  t = 2000;
  m.recordSuccess("funding", { inserted: true }); // dispara ensure() de funding com windowStartedAt=2000, não deveria fechar sozinho
  assert.equal(m.getMetrics().funding.lastWindow, null);
});

test("clock injetado (now) default é Date.now -- comportamento em produção não muda", () => {
  const m = createCollectorMetrics();
  const before = Date.now();
  m.recordSuccess("candles", { inserted: true });
  const lastRunAt = new Date(m.getMetrics().candles.lastRunAt).getTime();
  assert.ok(lastRunAt >= before);
});
