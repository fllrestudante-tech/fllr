const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { getAssetStatistics, upsertAssetStatistics } = require("../../lib/knowledgeBase/assetStatisticsStore");

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const SAMPLE_METRIC = {
  sampleSize: 100, avg: 1.5, median: 1.4, stddev: 0.3, min: 0.5, max: 3,
  p10: 1, p25: 1.2, p50: 1.4, p75: 1.6, p90: 1.9, p95: 2.1, p99: 2.5,
  mad: 0.2, iqr: 0.4, trimmedMean: 1.45, winsorizedMean: 1.48,
  skewness: 0.1, kurtosis: -0.2,
  currentValue: 1.8, zscoreCurrent: 1.0, percentileCurrent: 88,
  driftPct: 5.2, trend: "rising", velocity: 0.01, acceleration: 0.001,
  persistence: 3, compressionExpansion: "stable",
  stabilityScore: 80, quality: "high", confidence: 95,
};

const SAMPLE_WINDOW = {
  windowCandles: 168, coveragePct: 95, freshnessScore: 100, missingRate: 0.05,
  duplicateRate: 0, gapRate: 0.01, sampleSize: 168, effectiveSampleSize: 160,
  confidence: 90, computedAt: new Date().toISOString(),
};

test("getAssetStatistics: sem linha devolve null", () => {
  const db = freshDb();
  assert.equal(getAssetStatistics(db, "SOLUSDT", "global", 30), null);
  db.close();
});

test("upsertAssetStatistics: grava window (version=1) e as métricas passadas", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: SAMPLE_WINDOW, metrics: { atr: SAMPLE_METRIC, funding: SAMPLE_METRIC } });

  const result = getAssetStatistics(db, "SOLUSDT", "global", 30);
  assert.equal(result.window.version, 1);
  assert.equal(result.window.sample_size, 168);
  assert.equal(result.metrics.atr.avg, 1.5);
  assert.equal(result.metrics.funding.trend, "rising");
  assert.equal(result.metrics.volume, undefined, "métrica não passada não deveria aparecer");
  db.close();
});

test("upsertAssetStatistics: recompute substitui a linha inteira (replace, não merge parcial) e incrementa version", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: SAMPLE_WINDOW, metrics: { atr: SAMPLE_METRIC } });

  const changedMetric = { ...SAMPLE_METRIC, avg: 999, trend: "falling" };
  const result = upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: { ...SAMPLE_WINDOW, sampleSize: 200 }, metrics: { atr: changedMetric } });

  assert.equal(result.window.version, 2);
  assert.equal(result.window.sample_size, 200);
  assert.equal(result.metrics.atr.avg, 999, "replace completo -- valor antigo (1.5) não deveria sobreviver");
  assert.equal(result.metrics.atr.trend, "falling");
  db.close();
});

test("upsertAssetStatistics: (symbol, scope, windowDays) diferentes não colidem", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "SOLUSDT", "global", 7, { window: SAMPLE_WINDOW, metrics: { atr: SAMPLE_METRIC } });
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: SAMPLE_WINDOW, metrics: { atr: { ...SAMPLE_METRIC, avg: 2.5 } } });

  assert.equal(getAssetStatistics(db, "SOLUSDT", "global", 7).metrics.atr.avg, 1.5);
  assert.equal(getAssetStatistics(db, "SOLUSDT", "global", 30).metrics.atr.avg, 2.5);
  db.close();
});
