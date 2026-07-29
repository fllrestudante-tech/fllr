const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { upsertAssetStatistics } = require("../../lib/knowledgeBase/assetStatisticsStore");
const { buildLiquidityFeatures } = require("../../lib/featureBuilder/liquidity");

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const WINDOW = { windowCandles: 100, coveragePct: 95, freshnessScore: 100, missingRate: 0.05, duplicateRate: 0, gapRate: 0, sampleSize: 100, effectiveSampleSize: 95, confidence: 95, computedAt: new Date().toISOString() };
const BASE_METRIC = {
  sampleSize: 100, avg: 0.001, median: 0.001, stddev: 0.0001, min: 0.0005, max: 0.002,
  p10: 0.0008, p25: 0.0009, p50: 0.001, p75: 0.0011, p90: 0.0012, p95: 0.0013, p99: 0.0014,
  mad: 0.00005, iqr: 0.0002, trimmedMean: 0.001, winsorizedMean: 0.001, skewness: 0, kurtosis: 0,
  currentValue: 0.001, trend: "flat", velocity: 0, acceleration: 0,
  stabilityScore: 90, quality: "high", confidence: 95,
};

function seedSpread(db, percentile, zscore) {
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: WINDOW, metrics: { spread: { ...BASE_METRIC, percentileCurrent: percentile, zscoreCurrent: zscore, driftPct: 0, persistence: 1, compressionExpansion: "stable" } } });
}

test("buildLiquidityFeatures: sem estatística -- SpreadExpansion UNKNOWN", () => {
  const db = freshDb();
  const [spread] = buildLiquidityFeatures(db, "SOLUSDT");
  assert.equal(spread.interpretation.state, "UNKNOWN");
  db.close();
});

test("buildLiquidityFeatures: percentil 97 (spread alargado) -> SpreadExpansion EXTREME/above", () => {
  const db = freshDb();
  seedSpread(db, 97, 3);
  const [spread] = buildLiquidityFeatures(db, "SOLUSDT");
  assert.equal(spread.interpretation.state, "EXTREME");
  assert.equal(spread.interpretation.direction, "above");
  assert.equal(spread.id, "FEATURE_SPREAD_EXPANSION");
  db.close();
});

test("buildLiquidityFeatures: percentil 3 (spread estreito) -> SpreadExpansion NORMAL (não conta 'abaixo' como expansão)", () => {
  const db = freshDb();
  seedSpread(db, 3, -3);
  const [spread] = buildLiquidityFeatures(db, "SOLUSDT");
  assert.equal(spread.interpretation.state, "NORMAL");
  db.close();
});
