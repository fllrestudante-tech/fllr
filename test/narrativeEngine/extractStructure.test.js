const test = require("node:test");
const assert = require("node:assert/strict");
const { extractStructure } = require("../../lib/narrativeEngine/extractStructure");

test("extractStructure: identifica múltiplos padrões na mesma mensagem", () => {
  const features = extractStructure(
    "O BTC mantém topos e fundos ascendentes no 4H, trabalhando dentro de uma cunha ascendente e testando a resistência principal"
  );
  assert.equal(features.higherHighsLows, true);
  assert.equal(features.ascendingWedge, true);
  assert.equal(features.resistance, true);
  assert.equal(features.support, false);
  assert.equal(features.breakout, false);
});

test("extractStructure: 'canal' (do Telegram) não é confundido com padrão gráfico -- não existe feature 'channel'", () => {
  const features = extractStructure("esse canal vai postar mais atualizações");
  assert.equal("channel" in features, false);
});

test("extractStructure: mensagem sem termo técnico nenhum retorna tudo false", () => {
  const features = extractStructure("Bom dia pessoal");
  assert.ok(Object.values(features).every((v) => v === false));
});
