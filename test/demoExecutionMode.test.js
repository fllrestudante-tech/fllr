const test = require("node:test");
const assert = require("node:assert/strict");
const { EXECUTION_MODES, DemoExecutionModeInvalidError, resolveDemoExecutionMode, safeResolveDemoExecutionMode } = require("../lib/demoExecutionMode");

test("resolveDemoExecutionMode: 'observe' -> devolve exatamente 'observe'", () => {
  assert.equal(resolveDemoExecutionMode({ DEMO_EXECUTION_MODE: "observe" }), EXECUTION_MODES.OBSERVE);
});

test("resolveDemoExecutionMode: 'execution' -> devolve exatamente 'execution'", () => {
  assert.equal(resolveDemoExecutionMode({ DEMO_EXECUTION_MODE: "execution" }), EXECUTION_MODES.EXECUTION);
});

test("resolveDemoExecutionMode: ausente -> lança DemoExecutionModeInvalidError, nunca assume 'observe' por omissão", () => {
  assert.throws(() => resolveDemoExecutionMode({}), DemoExecutionModeInvalidError);
});

test("resolveDemoExecutionMode: vazio -> lança", () => {
  assert.throws(() => resolveDemoExecutionMode({ DEMO_EXECUTION_MODE: "" }), DemoExecutionModeInvalidError);
});

test("resolveDemoExecutionMode: capitalização diferente ('Observe'/'OBSERVE') -> lança, comparação estrita", () => {
  assert.throws(() => resolveDemoExecutionMode({ DEMO_EXECUTION_MODE: "Observe" }), DemoExecutionModeInvalidError);
  assert.throws(() => resolveDemoExecutionMode({ DEMO_EXECUTION_MODE: "OBSERVE" }), DemoExecutionModeInvalidError);
});

test("resolveDemoExecutionMode: valor desconhecido -> lança, código DEMO_EXECUTION_MODE_INVALID", () => {
  assert.throws(
    () => resolveDemoExecutionMode({ DEMO_EXECUTION_MODE: "trade-tudo" }),
    (err) => {
      assert.equal(err.code, "DEMO_EXECUTION_MODE_INVALID");
      return true;
    }
  );
});

test("resolveDemoExecutionMode: mensagem de erro nunca inclui nenhum segredo (não recebe env com credenciais aqui, mas confirma que não há interpolação de campo sensível)", () => {
  const err = new DemoExecutionModeInvalidError("valor-arbitrario");
  assert.ok(!err.message.includes("BYBIT"));
});

test("safeResolveDemoExecutionMode: valor válido -> devolve o modo, nunca lança", () => {
  assert.equal(safeResolveDemoExecutionMode({ DEMO_EXECUTION_MODE: "observe" }), "observe");
});

test("safeResolveDemoExecutionMode: valor inválido/ausente -> null, nunca lança", () => {
  assert.equal(safeResolveDemoExecutionMode({}), null);
  assert.equal(safeResolveDemoExecutionMode({ DEMO_EXECUTION_MODE: "algo" }), null);
});

test("EXECUTION_MODES: exatamente 2 valores, 'observe' e 'execution' -- nenhum terceiro modo aceito nesta rodada", () => {
  assert.deepEqual(Object.values(EXECUTION_MODES).sort(), ["execution", "observe"]);
});
