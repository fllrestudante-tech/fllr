const test = require("node:test");
const assert = require("node:assert/strict");
const { getCategoryDefaults, inferMarketScope } = require("../../../lib/collectors/knowledge/marketEventCategories");

test("getCategoryDefaults: fomc é nível 1 com volatilidade extrema", () => {
  const d = getCategoryDefaults("fomc");
  assert.equal(d.severity, 1);
  assert.equal(d.expectedVolatility, "EXTREME");
});

test("getCategoryDefaults: unlock é nível 2", () => {
  assert.equal(getCategoryDefaults("unlock").severity, 2);
});

test("getCategoryDefaults: ama é nível 3", () => {
  assert.equal(getCategoryDefaults("ama").severity, 3);
});

test("getCategoryDefaults: categoria desconhecida cai no default (nível 3)", () => {
  const d = getCategoryDefaults("categoria-inventada");
  assert.equal(d.severity, 3);
});

test("inferMarketScope: sem ativos é GLOBAL", () => {
  assert.equal(inferMarketScope([]), "GLOBAL");
  assert.equal(inferMarketScope(null), "GLOBAL");
});

test("inferMarketScope: múltiplos ativos sem setor comum é GLOBAL", () => {
  assert.equal(inferMarketScope(["BTC", "ETH"]), "GLOBAL");
});

test("inferMarketScope: ativo único BTC/ETH/SOL usa o próprio ticker", () => {
  assert.equal(inferMarketScope(["BTC"]), "BTC");
  assert.equal(inferMarketScope(["sol"]), "SOL");
});

test("inferMarketScope: ativo único de setor conhecido usa o setor", () => {
  assert.equal(inferMarketScope(["DOGE"]), "MEME");
  assert.equal(inferMarketScope(["AAVE"]), "DEFI");
});

test("inferMarketScope: ativo único não mapeado usa o próprio ticker", () => {
  assert.equal(inferMarketScope(["XYZ"]), "XYZ");
});
