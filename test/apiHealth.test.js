const test = require("node:test");
const assert = require("node:assert/strict");
const { computeApiHealthScore, aggregateProviderHealth } = require("../lib/apiHealth");

test("computeApiHealthScore: sem lastWindow ainda, score null", () => {
  const result = computeApiHealthScore({ lastWindow: null, consecutiveFailures: 0 });
  assert.equal(result.score, null);
});

test("computeApiHealthScore: janela sem nenhuma execução, score null", () => {
  const result = computeApiHealthScore({ lastWindow: { runs: 0, errors: 0 }, consecutiveFailures: 0 });
  assert.equal(result.score, null);
});

test("computeApiHealthScore: 0% de erro -> score 100", () => {
  const result = computeApiHealthScore({ lastWindow: { runs: 10, errors: 0 }, consecutiveFailures: 0 });
  assert.equal(result.score, 100);
});

test("computeApiHealthScore: exemplo do usuário -- CoinMarketCal com falhas -> score ~87", () => {
  // 5 de ~38 falharam -> ~13,2% erro -> score ~86,8
  const result = computeApiHealthScore({ lastWindow: { runs: 38, errors: 5 }, consecutiveFailures: 1 });
  assert.ok(result.score > 85 && result.score < 88);
});

test("aggregateProviderHealth: agrupa múltiplos domínios do mesmo provider (Bybit) pelo MÍNIMO, não média", () => {
  const apiHealthByDomain = {
    candles: { score: 100 },
    funding: { score: 60 }, // domínio ruim
    open_interest: { score: 100 },
  };
  const result = aggregateProviderHealth(apiHealthByDomain);
  assert.equal(result.bybit, 60); // mínimo, não escondido atrás da média (~86)
});

test("aggregateProviderHealth: domínio sem score (null) não quebra a agregação do provider", () => {
  const apiHealthByDomain = {
    fear_greed: { score: null },
  };
  const result = aggregateProviderHealth(apiHealthByDomain);
  assert.equal(result.fear_greed, null);
});
