const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { upsertAssetStatistics } = require("../../lib/knowledgeBase/assetStatisticsStore");
const { buildVolatilityFeatures } = require("../../lib/featureBuilder/volatility");

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
  currentValue: 1, zscoreCurrent: 0, percentileCurrent: 50, driftPct: 0, trend: "flat", velocity: 0, acceleration: 0,
  stabilityScore: 90, quality: "high", confidence: 95,
};

function seedAtr(db, fields) {
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: WINDOW, metrics: { atr: { ...BASE_METRIC, ...fields } } });
}

test("buildVolatilityFeatures: sem estatística -- 3 Features UNKNOWN", () => {
  const db = freshDb();
  const [expansion, compression, persistence] = buildVolatilityFeatures(db, "SOLUSDT");
  assert.equal(expansion.interpretation.state, "UNKNOWN");
  assert.equal(compression.interpretation.state, "UNKNOWN");
  assert.equal(persistence.interpretation.state, "UNKNOWN");
  db.close();
});

test("buildVolatilityFeatures: compressionExpansion=expanding -> VolatilityExpansion HIGH, Compression NORMAL", () => {
  const db = freshDb();
  seedAtr(db, { compressionExpansion: "expanding", persistence: 1 });

  const [expansion, compression] = buildVolatilityFeatures(db, "SOLUSDT");
  assert.equal(expansion.interpretation.state, "HIGH");
  assert.equal(expansion.id, "FEATURE_VOLATILITY_EXPANSION");
  assert.equal(compression.interpretation.state, "NORMAL");
  db.close();
});

test("buildVolatilityFeatures: compressionExpansion=compressing -> Compression HIGH, Expansion NORMAL", () => {
  const db = freshDb();
  seedAtr(db, { compressionExpansion: "compressing", persistence: 1 });

  const [expansion, compression] = buildVolatilityFeatures(db, "SOLUSDT");
  assert.equal(expansion.interpretation.state, "NORMAL");
  assert.equal(compression.interpretation.state, "HIGH");
  db.close();
});

test("buildVolatilityFeatures: persistence >= 3 -> VolatilityPersistence HIGH", () => {
  const db = freshDb();
  seedAtr(db, { compressionExpansion: "stable", persistence: 4 });

  const [, , persistence] = buildVolatilityFeatures(db, "SOLUSDT");
  assert.equal(persistence.interpretation.state, "HIGH");
  db.close();
});

test("buildVolatilityFeatures: persistence < 3 -> VolatilityPersistence NORMAL", () => {
  const db = freshDb();
  seedAtr(db, { compressionExpansion: "stable", persistence: 1 });

  const [, , persistence] = buildVolatilityFeatures(db, "SOLUSDT");
  assert.equal(persistence.interpretation.state, "NORMAL");
  db.close();
});
