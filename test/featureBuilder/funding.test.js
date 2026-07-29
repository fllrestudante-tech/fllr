const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { upsertAssetStatistics } = require("../../lib/knowledgeBase/assetStatisticsStore");
const { buildFundingFeatures } = require("../../lib/featureBuilder/funding");

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const WINDOW = { windowCandles: 100, coveragePct: 95, freshnessScore: 100, missingRate: 0.05, duplicateRate: 0, gapRate: 0, sampleSize: 100, effectiveSampleSize: 95, confidence: 95, computedAt: new Date().toISOString() };
const BASE_METRIC = {
  sampleSize: 100, avg: 1, median: 1, stddev: 0.1, min: 0.5, max: 1.5,
  p10: 0.8, p25: 0.9, p50: 1, p75: 1.1, p90: 1.2, p95: 1.3, p99: 1.4,
  mad: 0.05, iqr: 0.2, trimmedMean: 1, winsorizedMean: 1, skewness: 0, kurtosis: 0,
  stabilityScore: 90, quality: "high", confidence: 95,
};

test("buildFundingFeatures: sem estatística computada -- 2 Features UNKNOWN, sem lançar erro", () => {
  const db = freshDb();
  const [extreme, acceleration] = buildFundingFeatures(db, "SOLUSDT");
  assert.equal(extreme.interpretation.state, "UNKNOWN");
  assert.equal(acceleration.interpretation.state, "UNKNOWN");
  db.close();
});

test("buildFundingFeatures: percentil 97 -> FundingExtreme EXTREME/above", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, {
    window: WINDOW,
    metrics: { funding: { ...BASE_METRIC, currentValue: 1.3, percentileCurrent: 97, zscoreCurrent: 3, trend: "flat", acceleration: 0, persistence: 1, compressionExpansion: "stable", driftPct: 0, velocity: 0 } },
  });

  const [extreme] = buildFundingFeatures(db, "SOLUSDT");
  assert.equal(extreme.interpretation.state, "EXTREME");
  assert.equal(extreme.interpretation.direction, "above");
  assert.equal(extreme.id, "FEATURE_FUNDING_EXTREME");
  db.close();
});

test("buildFundingFeatures: percentil 50 -> FundingExtreme NORMAL", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, {
    window: WINDOW,
    metrics: { funding: { ...BASE_METRIC, currentValue: 1, percentileCurrent: 50, zscoreCurrent: 0, trend: "flat", acceleration: 0, persistence: 1, compressionExpansion: "stable", driftPct: 0, velocity: 0 } },
  });

  const [extreme] = buildFundingFeatures(db, "SOLUSDT");
  assert.equal(extreme.interpretation.state, "NORMAL");
  db.close();
});

test("buildFundingFeatures: trend rising + acceleration>0 -> FundingAcceleration HIGH/above", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, {
    window: WINDOW,
    metrics: { funding: { ...BASE_METRIC, currentValue: 1, percentileCurrent: 50, zscoreCurrent: 0, trend: "rising", acceleration: 0.01, persistence: 1, compressionExpansion: "stable", driftPct: 0, velocity: 0.01 } },
  });

  const [, acceleration] = buildFundingFeatures(db, "SOLUSDT");
  assert.equal(acceleration.interpretation.state, "HIGH");
  assert.equal(acceleration.interpretation.direction, "above");
  db.close();
});

test("buildFundingFeatures: trend rising + acceleration<0 (desacelerando) -> FundingAcceleration NORMAL", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, {
    window: WINDOW,
    metrics: { funding: { ...BASE_METRIC, currentValue: 1, percentileCurrent: 50, zscoreCurrent: 0, trend: "rising", acceleration: -0.01, persistence: 1, compressionExpansion: "stable", driftPct: 0, velocity: 0.01 } },
  });

  const [, acceleration] = buildFundingFeatures(db, "SOLUSDT");
  assert.equal(acceleration.interpretation.state, "NORMAL");
  db.close();
});
