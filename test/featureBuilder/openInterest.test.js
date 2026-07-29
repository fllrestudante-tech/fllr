const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { upsertAssetStatistics } = require("../../lib/knowledgeBase/assetStatisticsStore");
const { buildOpenInterestFeatures } = require("../../lib/featureBuilder/openInterest");

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const WINDOW = { windowCandles: 100, coveragePct: 95, freshnessScore: 100, missingRate: 0.05, duplicateRate: 0, gapRate: 0, sampleSize: 100, effectiveSampleSize: 95, confidence: 95, computedAt: new Date().toISOString() };
const BASE_METRIC = {
  sampleSize: 100, avg: 1000, median: 1000, stddev: 100, min: 500, max: 1500,
  p10: 800, p25: 900, p50: 1000, p75: 1100, p90: 1200, p95: 1300, p99: 1400,
  mad: 50, iqr: 200, trimmedMean: 1000, winsorizedMean: 1000, skewness: 0, kurtosis: 0,
  currentValue: 1000, trend: "flat", velocity: 0, acceleration: 0,
  stabilityScore: 90, quality: "high", confidence: 95,
};

function seedOi(db, percentile, zscore) {
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: WINDOW, metrics: { openInterest: { ...BASE_METRIC, percentileCurrent: percentile, zscoreCurrent: zscore, driftPct: 0, persistence: 1, compressionExpansion: "stable" } } });
}

test("buildOpenInterestFeatures: sem estatística -- OIExpansion UNKNOWN", () => {
  const db = freshDb();
  const [oi] = buildOpenInterestFeatures(db, "SOLUSDT");
  assert.equal(oi.interpretation.state, "UNKNOWN");
  db.close();
});

test("buildOpenInterestFeatures: percentil 97 (OI crescendo) -> OIExpansion EXTREME/above", () => {
  const db = freshDb();
  seedOi(db, 97, 3);
  const [oi] = buildOpenInterestFeatures(db, "SOLUSDT");
  assert.equal(oi.interpretation.state, "EXTREME");
  assert.equal(oi.interpretation.direction, "above");
  db.close();
});

test("buildOpenInterestFeatures: percentil 3 (OI baixo) -> OIExpansion NORMAL (não é expansão, é queda)", () => {
  const db = freshDb();
  seedOi(db, 3, -3);
  const [oi] = buildOpenInterestFeatures(db, "SOLUSDT");
  assert.equal(oi.interpretation.state, "NORMAL");
  db.close();
});
