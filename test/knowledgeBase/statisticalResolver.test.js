const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { upsertAssetStatistics } = require("../../lib/knowledgeBase/assetStatisticsStore");
const { resolveMetricSignal, pickDefaultWindow } = require("../../lib/knowledgeBase/statisticalResolver");

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const METRIC = {
  sampleSize: 100, avg: 1, median: 1, stddev: 0.1, min: 0.5, max: 1.5,
  p10: 0.8, p25: 0.9, p50: 1, p75: 1.1, p90: 1.2, p95: 1.3, p99: 1.4,
  mad: 0.05, iqr: 0.2, trimmedMean: 1, winsorizedMean: 1, skewness: 0, kurtosis: 0,
  currentValue: 1.3, zscoreCurrent: 2.5, percentileCurrent: 96, driftPct: 3,
  trend: "rising", velocity: 0.01, acceleration: 0, persistence: 2, compressionExpansion: "stable",
  stabilityScore: 90, quality: "high", confidence: 95,
};
const WINDOW = { windowCandles: 100, coveragePct: 95, freshnessScore: 100, missingRate: 0.05, duplicateRate: 0, gapRate: 0, sampleSize: 100, effectiveSampleSize: 95, confidence: 95, computedAt: new Date().toISOString() };

test("pickDefaultWindow: prefere 90 quando tem dado real", () => {
  const windows = [{ window_days: 7, sample_size: 168 }, { window_days: 30, sample_size: 720 }, { window_days: 90, sample_size: 2160 }];
  assert.equal(pickDefaultWindow(windows), 90);
});

test("pickDefaultWindow: sem 90, prefere 30", () => {
  const windows = [{ window_days: 7, sample_size: 168 }, { window_days: 30, sample_size: 720 }, { window_days: 90, sample_size: 0 }];
  assert.equal(pickDefaultWindow(windows), 30);
});

test("pickDefaultWindow: sem 90 nem 30 com dado, pega a maior janela com dado real", () => {
  const windows = [{ window_days: 7, sample_size: 168 }, { window_days: 30, sample_size: 0 }, { window_days: 90, sample_size: 0 }];
  assert.equal(pickDefaultWindow(windows), 7);
});

test("pickDefaultWindow: nenhuma janela tem dado, cai na maior existente mesmo assim (não inventa)", () => {
  const windows = [{ window_days: 7, sample_size: 0 }, { window_days: 730, sample_size: 0 }];
  assert.equal(pickDefaultWindow(windows), 730);
});

test("pickDefaultWindow: nenhuma janela computada ainda devolve null", () => {
  assert.equal(pickDefaultWindow([]), null);
  assert.equal(pickDefaultWindow(null), null);
});

test("resolveMetricSignal: sem nenhuma estatística computada devolve null", () => {
  const db = freshDb();
  assert.equal(resolveMetricSignal(db, "SOLUSDT", "funding"), null);
  db.close();
});

test("resolveMetricSignal: janela explícita lê exatamente o que foi gravado", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: WINDOW, metrics: { funding: METRIC } });

  const signal = resolveMetricSignal(db, "SOLUSDT", "funding", { windowDays: 30 });
  assert.equal(signal.value, 1.3);
  assert.equal(signal.zscore, 2.5);
  assert.equal(signal.percentile, 96);
  assert.equal(signal.trend, "rising");
  assert.equal(signal.windowDaysUsed, 30);
  db.close();
});

test("resolveMetricSignal: sem windowDays explícito, aplica pickDefaultWindow (90 disponível)", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: WINDOW, metrics: { funding: METRIC } });
  upsertAssetStatistics(db, "SOLUSDT", "global", 90, { window: WINDOW, metrics: { funding: { ...METRIC, currentValue: 2 } } });

  const signal = resolveMetricSignal(db, "SOLUSDT", "funding");
  assert.equal(signal.windowDaysUsed, 90);
  assert.equal(signal.value, 2);
  db.close();
});

test("resolveMetricSignal: métrica não computada nessa janela devolve null", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: WINDOW, metrics: { funding: METRIC } });

  assert.equal(resolveMetricSignal(db, "SOLUSDT", "openInterest", { windowDays: 30 }), null);
  db.close();
});
