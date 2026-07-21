const test = require("node:test");
const assert = require("node:assert/strict");
const { computeConfidenceBreakdown, MAX_TOTAL } = require("../../lib/narrativeEngine/confidenceBreakdown");

test("computeConfidenceBreakdown: soma pesos de cada componente presente e explica o total", () => {
  const result = computeConfidenceBreakdown({
    ticker: "BTC",
    direction: "LONG",
    timeframe: "4H",
    priceMentioned: null,
    structure: { resistance: true },
    indicators: {},
    signalType: "Breakout",
  });

  assert.equal(result.breakdown.ticker, 20);
  assert.equal(result.breakdown.direction, 15);
  assert.equal(result.breakdown.timeframe, 15);
  assert.equal(result.breakdown.price, 0); // price sempre pesa 0 no v0, mesmo ausente
  assert.equal(result.breakdown.technicalTerms, 20);
  assert.equal(result.breakdown.signalPattern, 15);
  assert.equal(result.total, 85);
  assert.equal(result.confidence, 1);
});

test("computeConfidenceBreakdown: mensagem sem sinal nenhum tem confidence 0", () => {
  const result = computeConfidenceBreakdown({});
  assert.equal(result.total, 0);
  assert.equal(result.confidence, 0);
});

test("computeConfidenceBreakdown: price mencionado nunca soma pontos (peso 0 deliberado)", () => {
  const result = computeConfidenceBreakdown({ priceMentioned: "US$ 45.230" });
  assert.equal(result.breakdown.price, 0);
});

test("computeConfidenceBreakdown: MAX_TOTAL é a soma de todos os pesos (85)", () => {
  assert.equal(MAX_TOTAL, 85);
});
