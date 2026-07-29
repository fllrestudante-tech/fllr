const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { buildAllFeatures, flattenFeatures } = require("../../lib/featureBuilder");

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

test("buildAllFeatures: devolve objeto com as 5 chaves de domínio, não array plano", () => {
  const db = freshDb();
  const featuresByDomain = buildAllFeatures(db, "SOLUSDT");

  assert.deepEqual(Object.keys(featuresByDomain).sort(), ["funding", "liquidity", "openInterest", "volatility", "volume"].sort());
  assert.equal(featuresByDomain.funding.length, 2);
  assert.equal(featuresByDomain.volatility.length, 3);
  assert.equal(featuresByDomain.liquidity.length, 1);
  assert.equal(featuresByDomain.openInterest.length, 1);
  assert.equal(featuresByDomain.volume.length, 1);
  db.close();
});

test("flattenFeatures: devolve as 8 Features num array plano, todas com id único", () => {
  const db = freshDb();
  const featuresByDomain = buildAllFeatures(db, "SOLUSDT");
  const flat = flattenFeatures(featuresByDomain);

  assert.equal(flat.length, 8);
  const ids = flat.map((f) => f.id);
  assert.equal(new Set(ids).size, 8, "todos os ids devem ser únicos");
  assert.ok(ids.includes("FEATURE_FUNDING_EXTREME"));
  assert.ok(ids.includes("FEATURE_VOLATILITY_PERSISTENCE"));
  assert.ok(ids.includes("FEATURE_SPREAD_EXPANSION"));
  assert.ok(ids.includes("FEATURE_OI_EXPANSION"));
  assert.ok(ids.includes("FEATURE_VOLUME_ANOMALY"));
  db.close();
});

test("buildAllFeatures: sem nenhuma estatística computada, todas as 8 Features vêm UNKNOWN (nunca lança erro)", () => {
  const db = freshDb();
  const flat = flattenFeatures(buildAllFeatures(db, "SOLUSDT"));
  assert.ok(flat.every((f) => f.interpretation.state === "UNKNOWN"));
  db.close();
});
