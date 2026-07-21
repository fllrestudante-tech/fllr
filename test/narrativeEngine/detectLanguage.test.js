const test = require("node:test");
const assert = require("node:assert/strict");
const { detectLanguage } = require("../../lib/narrativeEngine/detectLanguage");

test("detectLanguage: identifica pt-BR por acentos e stopwords", () => {
  assert.equal(detectLanguage("O mercado está mais forte hoje, não é para todos"), "pt-BR");
});

test("detectLanguage: identifica inglês quando não há sinal de português", () => {
  assert.equal(detectLanguage("The market is strong and this will continue"), "en");
});

test("detectLanguage: texto vazio/sem sinal retorna unknown", () => {
  assert.equal(detectLanguage(""), "unknown");
  assert.equal(detectLanguage("BTC"), "unknown");
});
