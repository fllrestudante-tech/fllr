const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { readFeatures, readFeaturesForSymbol } = require("../../lib/webDashboard/featureReader");

function tmpDbPath(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("readFeaturesForSymbol: sem estatística computada, todas as 8 Features vêm UNKNOWN sem lançar erro", () => {
  const dbPath = tmpDbPath("features.db");
  const db = openDb(dbPath);
  const features = readFeaturesForSymbol(db, "BTCUSDT");
  db.close();
  cleanup(dbPath);

  assert.equal(features.length, 8);
  assert.ok(features.every((f) => f.interpretation.state === "UNKNOWN"));
  assert.ok(features.every((f) => f.active === false));
});

test("readFeatures: 1 entrada por símbolo do Universe injetado, cada uma com 8 features", () => {
  const dbPath = tmpDbPath("features-universe.db");
  openDb(dbPath).close();

  const result = readFeatures({ dbPath, symbols: ["BTCUSDT", "ETHUSDT"] });
  cleanup(dbPath);

  assert.equal(result.length, 2);
  assert.equal(result[0].symbol, "BTCUSDT");
  assert.equal(result[0].features.length, 8);
  assert.equal(result[1].symbol, "ETHUSDT");
});

test("readFeatures: banco inexistente devolve fallback com features vazias, não lança erro", () => {
  const result = readFeatures({ dbPath: tmpDbPath("nao-existe.db"), symbols: ["BTCUSDT"] });
  assert.deepEqual(result, [{ symbol: "BTCUSDT", features: [] }]);
});
