const test = require("node:test");
const assert = require("node:assert/strict");
const { compareValues, evaluateCrossSourceStatus, compareProviders } = require("../lib/crossSourceValidation");

test("compareValues: valores idênticos -> divergência 0", () => {
  const result = compareValues([100, 200, 300], [100, 200, 300]);
  assert.equal(result.avgDivergencePct, 0);
});

test("compareValues: divergência calculada corretamente", () => {
  const result = compareValues([100], [101]); // 1% de diferença
  assert.ok(Math.abs(result.avgDivergencePct - 0.9901) < 0.01);
});

test("compareValues: amostras vazias ou de tamanhos diferentes retornam null com motivo", () => {
  assert.equal(compareValues([], [1]).avgDivergencePct, null);
  assert.equal(compareValues([1, 2], [1]).avgDivergencePct, null);
});

test("evaluateCrossSourceStatus: só 1 provider disponível -> N/A (estado esperado hoje, não é erro)", () => {
  const result = evaluateCrossSourceStatus({ providersAvailable: 1, providersOperational: 1 });
  assert.equal(result.status, "N/A");
  assert.equal(result.reason, "Only one market data provider available.");
});

test("evaluateCrossSourceStatus: 2 providers mas 1 indisponível -> WARNING", () => {
  const result = evaluateCrossSourceStatus({ providersAvailable: 2, providersOperational: 1 });
  assert.equal(result.status, "WARNING");
});

test("evaluateCrossSourceStatus: 2 providers operacionais dentro do limite -> ok", () => {
  const result = evaluateCrossSourceStatus({ providersAvailable: 2, providersOperational: 2, divergencePct: 0.1, maxDivergencePct: 0.5 });
  assert.equal(result.status, "ok");
});

test("evaluateCrossSourceStatus: 2 providers operacionais além do limite -> ERROR", () => {
  const result = evaluateCrossSourceStatus({ providersAvailable: 2, providersOperational: 2, divergencePct: 5, maxDivergencePct: 0.5 });
  assert.equal(result.status, "ERROR");
  assert.ok(result.reason.includes("5.00%"));
});

test("compareProviders: com apenas Bybit hoje (1 provider) -> sempre N/A, nunca chama a comparação numérica", () => {
  const result = compareProviders([100, 101], [], { providersAvailable: 1, providersOperational: 1 });
  assert.equal(result.status, "N/A");
  assert.equal(result.comparison.avgDivergencePct, null);
});

test("compareProviders: cenário futuro simulado com 2 providers (dado fake) -- prova que a lógica já funciona sem Binance existir de verdade", () => {
  const bybitPrices = [64000, 64010, 64020];
  const binancePricesFake = [64005, 64012, 64018]; // divergência pequena, dentro do limite
  const result = compareProviders(bybitPrices, binancePricesFake, { providersAvailable: 2, providersOperational: 2, maxDivergencePct: 0.5 });
  assert.equal(result.status, "ok");
  assert.ok(result.comparison.avgDivergencePct < 0.5);
});

test("compareProviders: divergência grande entre 2 providers fake -> ERROR", () => {
  const bybitPrices = [64000];
  const binancePricesFake = [70000]; // ~9% de diferença, bem acima do limite
  const result = compareProviders(bybitPrices, binancePricesFake, { providersAvailable: 2, providersOperational: 2, maxDivergencePct: 0.5 });
  assert.equal(result.status, "ERROR");
});
