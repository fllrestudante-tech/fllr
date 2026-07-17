const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateByProvider, computeOperationalReliability, computeSourceReliability, buildSourceReliabilityRegistry } = require("../lib/sourceReliability");

test("aggregateByProvider: agrupa domínios do mesmo provider (Bybit) pelo mínimo", () => {
  const result = aggregateByProvider({ candles: 100, funding: 60, open_interest: 100 });
  assert.equal(result.bybit, 60);
});

test("aggregateByProvider: ignora domínios com score não numérico", () => {
  const result = aggregateByProvider({ fear_greed: 100, btc_dominance: null });
  assert.equal(result.fear_greed, 100);
  assert.equal(result.coingecko, undefined); // btc_dominance era null, não entra
});

test("computeOperationalReliability: média dos 3 pilares disponíveis", () => {
  const result = computeOperationalReliability({ apiHealthScore: 100, freshnessScore: 100, dataConfidenceScore: 100 });
  assert.equal(result.score, 100);
});

test("computeOperationalReliability: pilar ausente sai da média, não conta como 0", () => {
  const result = computeOperationalReliability({ apiHealthScore: 100, freshnessScore: null, dataConfidenceScore: null });
  assert.equal(result.score, 100);
});

test("computeOperationalReliability: nenhum pilar disponível -> null", () => {
  const result = computeOperationalReliability({});
  assert.equal(result.score, null);
});

test("computeSourceReliability: sempre traz predictiveReliability:null (reservado, fase futura)", () => {
  const result = computeSourceReliability("bybit", { apiHealthScore: 100 });
  assert.equal(result.provider, "bybit");
  assert.equal(result.predictiveReliability, null);
  assert.equal(result.operationalReliability.score, 100);
});

test("buildSourceReliabilityRegistry: constrói o registro completo a partir dos 3 mapas -- exemplo do usuário (Bybit 99.8, CoinGecko 99.2, CoinMarketCal 96.1, FRED 100)", () => {
  const registry = buildSourceReliabilityRegistry({
    apiHealthByDomain: {
      candles: { score: 99.8 },
      btc_dominance: { score: 99.2 },
      coinmarketcal: { score: 96.1 },
      fred: { score: 100 },
    },
    freshnessByDomain: {},
    dataConfidenceByDomain: {},
  });

  assert.equal(registry.bybit.operationalReliability.score, 99.8);
  assert.equal(registry.coingecko.operationalReliability.score, 99.2);
  assert.equal(registry.coinmarketcal.operationalReliability.score, 96.1);
  assert.equal(registry.fred.operationalReliability.score, 100);
  assert.equal(registry.bybit.predictiveReliability, null);
});
