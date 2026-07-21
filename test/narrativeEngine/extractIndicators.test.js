const test = require("node:test");
const assert = require("node:assert/strict");
const { extractIndicators } = require("../../lib/narrativeEngine/extractIndicators");

test("extractIndicators: identifica menções macro (Fed/FOMC/CPI/ETF)", () => {
  const features = extractIndicators("mercado espera decisão do FOMC e dado de CPI, ETFs seguem monitorados");
  assert.equal(features.fomc, true);
  assert.equal(features.cpi, true);
  assert.equal(features.etf, true);
});

test("extractIndicators: identifica funding/open interest/liquidez", () => {
  const features = extractIndicators("funding positivo, open interest subindo, liquidez concentrada acima");
  assert.equal(features.funding, true);
  assert.equal(features.openInterest, true);
  assert.equal(features.liquidity, true);
});

test("extractIndicators: sem menção nenhuma retorna tudo false", () => {
  const features = extractIndicators("Bom dia pessoal");
  assert.ok(Object.values(features).every((v) => v === false));
});
