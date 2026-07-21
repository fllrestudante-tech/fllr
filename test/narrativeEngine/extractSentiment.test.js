const test = require("node:test");
const assert = require("node:assert/strict");
const { extractSentiment } = require("../../lib/narrativeEngine/extractSentiment");

test("extractSentiment: bullish por termos reais do histórico auditado (esticando/força compradora)", () => {
  const result = extractSentiment("LDO segue esticando, demonstrando força compradora");
  assert.equal(result.sentiment, "bullish");
  assert.ok(result.confidence > 0);
});

test("extractSentiment: bearish por termos reais (tendência baixista/devolveu a alta)", () => {
  const result = extractSentiment("Nasdaq devolveu quase toda alta do dia, tendência baixista no radar");
  assert.equal(result.sentiment, "bearish");
});

test("extractSentiment: neutro sem termos ou empate", () => {
  const result = extractSentiment("Bom dia pessoal");
  assert.equal(result.sentiment, "neutral");
  assert.equal(result.confidence, 0);
});

test("extractSentiment: texto vazio não quebra", () => {
  const result = extractSentiment("");
  assert.equal(result.sentiment, "neutral");
  assert.equal(result.confidence, 0);
});
