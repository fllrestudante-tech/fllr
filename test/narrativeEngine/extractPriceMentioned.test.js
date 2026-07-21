const test = require("node:test");
const assert = require("node:assert/strict");
const { extractPriceMentioned } = require("../../lib/narrativeEngine/extractPriceMentioned");

test("extractPriceMentioned: reconhece preço com prefixo de moeda", () => {
  assert.equal(extractPriceMentioned("alvo em US$ 45.230 pro BTC"), "US$ 45.230");
  assert.equal(extractPriceMentioned("suporte em $0,85"), "$0,85");
});

test("extractPriceMentioned: NÃO confunde número solto (timeframe/ano) com preço", () => {
  assert.equal(extractPriceMentioned("ativar o 4H em 2026"), null);
});

test("extractPriceMentioned: sem preço retorna null", () => {
  assert.equal(extractPriceMentioned("Bom dia pessoal"), null);
  assert.equal(extractPriceMentioned(""), null);
});
