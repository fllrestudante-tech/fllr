const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { upsertAssetStatistics } = require("../../lib/knowledgeBase/assetStatisticsStore");
const { buildVolumeFeatures } = require("../../lib/featureBuilder/volume");

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const WINDOW = { windowCandles: 100, coveragePct: 95, freshnessScore: 100, missingRate: 0.05, duplicateRate: 0, gapRate: 0, sampleSize: 100, effectiveSampleSize: 95, confidence: 95, computedAt: new Date().toISOString() };
const BASE_METRIC = {
  sampleSize: 100, avg: 100, median: 100, stddev: 10, min: 50, max: 150,
  p10: 80, p25: 90, p50: 100, p75: 110, p90: 120, p95: 130, p99: 140,
  mad: 5, iqr: 20, trimmedMean: 100, winsorizedMean: 100, skewness: 0, kurtosis: 0,
  currentValue: 100, trend: "flat", velocity: 0, acceleration: 0,
  stabilityScore: 90, quality: "high", confidence: 95,
};

function seedVolume(db, percentile, zscore) {
  upsertAssetStatistics(db, "SOLUSDT", "global", 30, { window: WINDOW, metrics: { volume: { ...BASE_METRIC, percentileCurrent: percentile, zscoreCurrent: zscore, driftPct: 0, persistence: 1, compressionExpansion: "stable" } } });
}

test("buildVolumeFeatures: sem estatística -- VolumeAnomaly UNKNOWN", () => {
  const db = freshDb();
  const [volume] = buildVolumeFeatures(db, "SOLUSDT");
  assert.equal(volume.interpretation.state, "UNKNOWN");
  db.close();
});

test("buildVolumeFeatures: percentil 98 -> VolumeAnomaly EXTREME/above", () => {
  const db = freshDb();
  seedVolume(db, 98, 4);
  const [volume] = buildVolumeFeatures(db, "SOLUSDT");
  assert.equal(volume.interpretation.state, "EXTREME");
  assert.equal(volume.interpretation.direction, "above");
  db.close();
});

test("buildVolumeFeatures: percentil 2 -> VolumeAnomaly EXTREME/below (anomalia conta nas 2 direções)", () => {
  const db = freshDb();
  seedVolume(db, 2, -4);
  const [volume] = buildVolumeFeatures(db, "SOLUSDT");
  assert.equal(volume.interpretation.state, "EXTREME");
  assert.equal(volume.interpretation.direction, "below");
  db.close();
});

test("buildVolumeFeatures: percentil 50 -> VolumeAnomaly NORMAL", () => {
  const db = freshDb();
  seedVolume(db, 50, 0);
  const [volume] = buildVolumeFeatures(db, "SOLUSDT");
  assert.equal(volume.interpretation.state, "NORMAL");
  db.close();
});
