const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { getAsset, upsertAsset } = require("../../lib/knowledgeBase/assetStore");

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

test("getAsset: sem linha devolve null (não fabrica fallback)", () => {
  const db = freshDb();
  assert.equal(getAsset(db, "SOLUSDT"), null);
  db.close();
});

test("upsertAsset: cria com version=1 e defaults de proveniência", () => {
  const db = freshDb();
  const asset = upsertAsset(db, "SOLUSDT", { sector: "L1", tags: ["infra", "l1"] });

  assert.equal(asset.version, 1);
  assert.equal(asset.sector, "L1");
  assert.deepEqual(asset.tags, ["infra", "l1"]);
  assert.equal(asset.origin, "manual");
  assert.equal(asset.confidence, 100);
  db.close();
});

test("upsertAsset: atualização preserva campos não mencionados e incrementa version", () => {
  const db = freshDb();
  upsertAsset(db, "SOLUSDT", { sector: "L1", tags: ["infra"] });
  const updated = upsertAsset(db, "SOLUSDT", { narrative: "Infrastructure" });

  assert.equal(updated.version, 2);
  assert.equal(updated.sector, "L1", "sector gravado antes não pode ser perdido por um update parcial");
  assert.deepEqual(updated.tags, ["infra"]);
  assert.equal(updated.narrative, "Infrastructure");
  db.close();
});

test("upsertAsset: proveniência customizada não é sobrescrita por defaults em updates seguintes", () => {
  const db = freshDb();
  upsertAsset(db, "SOLUSDT", { sector: "L1", origin: "external", confidence: 70 });
  const updated = upsertAsset(db, "SOLUSDT", { narrative: "Infrastructure" });

  assert.equal(updated.origin, "external");
  assert.equal(updated.confidence, 70);
  db.close();
});

test("upsertAsset: relations é gravado e lido como array, não string", () => {
  const db = freshDb();
  const asset = upsertAsset(db, "SOLUSDT", { relations: [{ targetSymbol: "BTCUSDT", type: "correlates_with" }] });

  assert.deepEqual(asset.relations, [{ targetSymbol: "BTCUSDT", type: "correlates_with" }]);
  db.close();
});
