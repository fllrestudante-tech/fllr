const test = require("node:test");
const assert = require("node:assert/strict");
const { extractTicker } = require("../../lib/narrativeEngine/extractTicker");

test("extractTicker: reconhece par USDT sem $/# (ex: UNIUSDT)", () => {
  assert.deepEqual(extractTicker("UNIUSDT — Estrutura parecida com LDO"), { ticker: "UNI", pair: "UNIUSDT" });
});

test("extractTicker: reconhece par perpétuo com sufixo .P", () => {
  assert.deepEqual(extractTicker("BTCUSDT.P | Atualização"), { ticker: "BTC", pair: "BTCUSDT.P" });
});

test("extractTicker: reconhece cashtag", () => {
  assert.deepEqual(extractTicker("$BTC vai romper"), { ticker: "BTC", pair: null });
});

test("extractTicker: reconhece ticker nu só se estiver na lista curada", () => {
  assert.deepEqual(extractTicker("LDO segue esticando"), { ticker: "LDO", pair: null });
});

test("extractTicker: NÃO confunde jargão (SV/TP/SL) com ticker", () => {
  assert.deepEqual(extractTicker("Vale colocar no radar e ativar o 4H em SV para buscar o TP"), { ticker: null, pair: null });
});

test("extractTicker: texto sem ticker nenhum retorna null/null", () => {
  assert.deepEqual(extractTicker("Bom dia pessoal, cenário de hoje é de cautela"), { ticker: null, pair: null });
});

test("extractTicker: texto vazio não quebra", () => {
  assert.deepEqual(extractTicker(""), { ticker: null, pair: null });
  assert.deepEqual(extractTicker(null), { ticker: null, pair: null });
});
