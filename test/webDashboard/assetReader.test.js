const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { upsertAsset } = require("../../lib/knowledgeBase/assetStore");
const { readAssetsList, readAsset, readTradesForSymbol } = require("../../lib/webDashboard/assetReader");

function tmpDbPath(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("readAssetsList: usa symbols injetado quando fornecido", () => {
  assert.deepEqual(readAssetsList({ symbols: ["BTCUSDT", "ETHUSDT"] }), ["BTCUSDT", "ETHUSDT"]);
});

test("readAsset: identity vem de asset (upsertAsset), sem lançar erro sem statistics computada", () => {
  const dbPath = tmpDbPath("asset.db");
  const db = openDb(dbPath);
  upsertAsset(db, "BTCUSDT", { baseAsset: "BTC", quoteAsset: "USDT", category: "crypto" });
  db.close();

  const result = readAsset("BTCUSDT", { dbPath });
  cleanup(dbPath);

  assert.equal(result.symbol, "BTCUSDT");
  assert.equal(result.identity.baseAsset, "BTC");
  assert.equal(result.statistics, null); // sem estatística computada pra esse window -- honesto, não lança
  assert.equal(result.features.length, 8);
  assert.equal(result.history.available, false);
});

test("readAsset: banco inexistente devolve fallback honesto em todos os campos", () => {
  const result = readAsset("BTCUSDT", { dbPath: tmpDbPath("nao-existe.db") });
  assert.equal(result.identity, null);
  assert.deepEqual(result.features, []);
  assert.equal(result.coverage, null);
});

test("readTradesForSymbol: config.symbol tem trades reais (ou lista vazia se não houver arquivo)", () => {
  const config = require("../../config");
  const result = readTradesForSymbol(config.symbol);
  assert.equal(result.available, true);
  assert.ok(Array.isArray(result.trades));
});

test("readTradesForSymbol: símbolo diferente de config.symbol é honestamente indisponível (trades.jsonl não marca símbolo)", () => {
  const result = readTradesForSymbol("UM_SIMBOLO_QUE_NAO_E_O_CONFIGURADO");
  assert.equal(result.available, false);
  assert.deepEqual(result.trades, []);
});
