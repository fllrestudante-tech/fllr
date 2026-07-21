const test = require("node:test");
const assert = require("node:assert/strict");
const { extractTimeframe } = require("../../lib/narrativeEngine/extractTimeframe");

test("extractTimeframe: formato explícito (4H)", () => {
  assert.equal(extractTimeframe("ativar o 4H em SV"), "4H");
});

test("extractTimeframe: palavra por extenso (mensal/semanal/diário)", () => {
  assert.equal(extractTimeframe("perto de iniciar uma correção no mensal"), "1M");
  assert.equal(extractTimeframe("tendência baixista no semanal"), "1W");
  assert.equal(extractTimeframe("cenário diário parecido com ontem"), "1D");
});

test("extractTimeframe: 'mensal' não é confundido com minutos (m)", () => {
  assert.equal(extractTimeframe("correção no mensal"), "1M");
});

test("extractTimeframe: sem timeframe nenhum retorna null", () => {
  assert.equal(extractTimeframe("Bom dia pessoal"), null);
  assert.equal(extractTimeframe(""), null);
});
