const test = require("node:test");
const assert = require("node:assert/strict");
const { extractDirection } = require("../../lib/narrativeEngine/extractDirection");

test("extractDirection: LONG por termos de compra", () => {
  assert.equal(extractDirection("A moeda vem demonstrando força compradora"), "LONG");
});

test("extractDirection: SHORT por termos de venda", () => {
  assert.equal(extractDirection("ativo com tendência baixista, momento de short"), "SHORT");
});

test("extractDirection: sem termos nenhum retorna null", () => {
  assert.equal(extractDirection("Bom dia pessoal"), null);
});

test("extractDirection: empate (mesma contagem LONG/SHORT) retorna null, não força um lado", () => {
  assert.equal(extractDirection("aposta na reversão da tendência baixista"), null);
});

test("extractDirection: texto vazio não quebra", () => {
  assert.equal(extractDirection(""), null);
  assert.equal(extractDirection(null), null);
});
