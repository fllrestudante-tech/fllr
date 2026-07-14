const test = require("node:test");
const assert = require("node:assert/strict");
const { createHealthRegistry } = require("../lib/health");

test("runChecks: agrega o resultado de cada check registrado", async () => {
  const registry = createHealthRegistry();
  registry.registerCheck("a", async () => ({ status: "ok", details: {} }));
  registry.registerCheck("b", async () => ({ status: "down", details: { error: "x" } }));

  const results = await registry.runChecks();
  assert.deepEqual(Object.keys(results).sort(), ["a", "b"]);
  assert.equal(results.a.status, "ok");
  assert.equal(results.b.status, "down");
});

test("runChecks: check que lança exceção vira status down, não derruba os outros", async () => {
  const registry = createHealthRegistry();
  registry.registerCheck("quebrado", async () => {
    throw new Error("boom");
  });
  registry.registerCheck("ok", async () => ({ status: "ok", details: {} }));

  const results = await registry.runChecks();
  assert.equal(results.quebrado.status, "down");
  assert.equal(results.quebrado.details.error, "boom");
  assert.equal(results.ok.status, "ok");
});

test("detectTransitions: primeira rodada nunca gera transição (sem status anterior)", () => {
  const registry = createHealthRegistry();
  const transitions = registry.detectTransitions({ a: { status: "ok" } });
  assert.deepEqual(transitions, []);
});

test("detectTransitions: detecta mudança de status entre rodadas", () => {
  const registry = createHealthRegistry();
  registry.detectTransitions({ a: { status: "ok" } });
  const transitions = registry.detectTransitions({ a: { status: "down" } });
  assert.deepEqual(transitions, [{ name: "a", from: "ok", to: "down" }]);
});

test("detectTransitions: status repetido não gera transição", () => {
  const registry = createHealthRegistry();
  registry.detectTransitions({ a: { status: "ok" } });
  const transitions = registry.detectTransitions({ a: { status: "ok" } });
  assert.deepEqual(transitions, []);
});
