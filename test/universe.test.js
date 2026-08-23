const test = require("node:test");
const assert = require("node:assert/strict");
const { getUniverse, parseSymbolList, parseBaseQuote } = require("../lib/universe");

test("parseSymbolList: separa por vírgula, remove espaços, maiúsculas", () => {
  assert.deepEqual(parseSymbolList(" btcusdt, ethusdt ,SOLUSDT"), ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
});

test("parseSymbolList: string vazia ou undefined devolve array vazio", () => {
  assert.deepEqual(parseSymbolList(""), []);
  assert.deepEqual(parseSymbolList(undefined), []);
});

test("parseSymbolList: entradas vazias entre vírgulas são descartadas", () => {
  assert.deepEqual(parseSymbolList("BTCUSDT,,ETHUSDT,"), ["BTCUSDT", "ETHUSDT"]);
});

test("getUniverse: usa MARKET_SYMBOLS do env quando presente", () => {
  const universe = getUniverse({ env: { MARKET_SYMBOLS: "BTCUSDT,ETHUSDT" }, fallbackSymbol: "SOLUSDT" });
  assert.deepEqual(universe.symbols, ["BTCUSDT", "ETHUSDT"]);
});

test("getUniverse: sem MARKET_SYMBOLS cai pro fallbackSymbol (comportamento atual preservado)", () => {
  const universe = getUniverse({ env: {}, fallbackSymbol: "SOLUSDT" });
  assert.deepEqual(universe.symbols, ["SOLUSDT"]);
});

test("getUniverse: sem MARKET_SYMBOLS e fallbackSymbol vazio devolve array vazio", () => {
  const universe = getUniverse({ env: {}, fallbackSymbol: "" });
  assert.deepEqual(universe.symbols, []);
});

test("getUniverse: omitindo fallbackSymbol usa config.symbol (comportamento default do bot)", () => {
  const config = require("../config");
  const universe = getUniverse({ env: {} });
  assert.deepEqual(universe.symbols, [config.symbol]);
});

test("getUniverse: deduplica símbolos repetidos no env", () => {
  const universe = getUniverse({ env: { MARKET_SYMBOLS: "BTCUSDT,BTCUSDT,ETHUSDT" }, fallbackSymbol: "SOLUSDT" });
  assert.deepEqual(universe.symbols, ["BTCUSDT", "ETHUSDT"]);
});

test("parseBaseQuote: separa por sufixo de quote conhecido (USDT/USDC/USD)", () => {
  assert.deepEqual(parseBaseQuote("BTCUSDT"), { baseAsset: "BTC", quoteAsset: "USDT" });
  assert.deepEqual(parseBaseQuote("ETHUSDC"), { baseAsset: "ETH", quoteAsset: "USDC" });
  assert.deepEqual(parseBaseQuote("BTCUSD"), { baseAsset: "BTC", quoteAsset: "USD" });
});

test("parseBaseQuote: prefere o sufixo mais específico (USDT antes de USD)", () => {
  assert.deepEqual(parseBaseQuote("SOLUSDT"), { baseAsset: "SOL", quoteAsset: "USDT" });
});

test("parseBaseQuote: símbolo sem sufixo conhecido devolve quoteAsset null", () => {
  assert.deepEqual(parseBaseQuote("XAUUSD+"), { baseAsset: "XAUUSD+", quoteAsset: null });
});
