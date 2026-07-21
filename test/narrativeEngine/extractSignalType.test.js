const test = require("node:test");
const assert = require("node:assert/strict");
const { extractSignalType } = require("../../lib/narrativeEngine/extractSignalType");
const { extractStructure } = require("../../lib/narrativeEngine/extractStructure");

test("extractSignalType: cunha ascendente tem prioridade sobre suporte/resistência genérico", () => {
  const structure = extractStructure("cunha ascendente testando a resistência, com suporte firme abaixo");
  assert.equal(extractSignalType(structure), "Ascending Wedge");
});

test("extractSignalType: suporte + resistência sem padrão mais específico vira 'Range'", () => {
  const structure = extractStructure("mercado respeitando suporte e resistência, sem definição");
  assert.equal(extractSignalType(structure), "Range");
});

test("extractSignalType: nenhum padrão retorna null", () => {
  const structure = extractStructure("Bom dia pessoal");
  assert.equal(extractSignalType(structure), null);
});

test("extractSignalType: null quando não há feature vector", () => {
  assert.equal(extractSignalType(null), null);
});
