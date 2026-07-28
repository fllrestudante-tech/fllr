const test = require("node:test");
const assert = require("node:assert/strict");

// require isolado por teste (Map de módulo é compartilhado entre testes no
// mesmo processo) -- usamos delete do cache pra cada teste ver um registry
// limpo, evitando que um registerSignal vaze pro teste seguinte.
function freshSignals() {
  delete require.cache[require.resolve("../../lib/knowledgeBase/signals")];
  return require("../../lib/knowledgeBase/signals");
}

test("listSignals: vazio por padrão (nenhum sinal real registrado ainda)", () => {
  const signals = freshSignals();
  assert.deepEqual(signals.listSignals(), []);
});

test("registerSignal/getSignal: registra e recupera um sinal de teste", () => {
  const signals = freshSignals();
  signals.registerSignal("testSignal", (db, symbol) => ({ testField: `${symbol}-ok` }));

  assert.deepEqual(signals.listSignals(), ["testSignal"]);
  assert.deepEqual(signals.getSignal("testSignal", null, "SOLUSDT"), { testField: "SOLUSDT-ok" });
});

test("getSignal: sinal não cadastrado devolve null", () => {
  const signals = freshSignals();
  assert.equal(signals.getSignal("naoExiste", null, "SOLUSDT"), null);
});
