const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STATES,
  INITIAL_STATE,
  TRANSITIONS,
  isValidState,
  canTransition,
  assertValidTransition,
  InvalidDocumentStateError,
  InvalidDocumentTransitionError,
} = require("../../lib/knowledgeDocuments/documentStates");

test("exatamente os 9 estados pedidos, sem 'approved_for_agentrouter' (reservado pro commit futuro de integração)", () => {
  assert.deepEqual(
    [...STATES].sort(),
    [
      "approved_for_research",
      "cataloged",
      "discovered",
      "processed",
      "processing_pending",
      "rejected",
      "retired",
      "review_required",
      "suspended",
    ].sort()
  );
  assert.ok(!STATES.includes("approved_for_agentrouter"));
});

test("estado inicial é 'discovered' -- nenhum material começa aprovado", () => {
  assert.equal(INITIAL_STATE, "discovered");
});

test("todas as transições PERMITIDAS passam em canTransition/assertValidTransition", () => {
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to} deveria ser permitido`);
      assert.doesNotThrow(() => assertValidTransition(from, to));
    }
  }
});

test("transições PROIBIDAS específicas falham", () => {
  const forbidden = [
    ["discovered", "approved_for_research"], // pula todos os intermediários
    ["discovered", "processed"],
    ["cataloged", "approved_for_research"],
    ["cataloged", "review_required"],
    ["processing_pending", "approved_for_research"], // não pode aprovar sem passar por review_required
    ["processed", "approved_for_research"],
    ["approved_for_research", "review_required"], // não retrocede depois de aprovado
    ["approved_for_research", "discovered"],
    ["rejected", "approved_for_research"], // rejeitado precisa recatalogar antes
    ["rejected", "processing_pending"],
    ["suspended", "processing_pending"], // suspenso só retoma via cataloged
    ["suspended", "review_required"],
  ];
  for (const [from, to] of forbidden) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to} NÃO deveria ser permitido`);
    assert.throws(() => assertValidTransition(from, to), InvalidDocumentTransitionError);
  }
});

test("'retired' é terminal -- nenhuma transição de saída, de nenhum estado", () => {
  assert.deepEqual(TRANSITIONS.retired, []);
  for (const state of STATES) {
    if (state === "retired") continue;
    assert.equal(canTransition("retired", state), false, `retired -> ${state} nunca deveria ser permitido`);
  }
});

test("todo estado (exceto 'retired') consegue alcançar 'retired' -- sempre existe uma saída auditável", () => {
  for (const state of STATES) {
    if (state === "retired") continue;
    assert.ok(TRANSITIONS[state].includes("retired"), `${state} deveria poder ir direto pra retired`);
  }
});

test("estado inválido (não cadastrado) lança InvalidDocumentStateError, nunca passa silenciosamente", () => {
  assert.equal(isValidState("nao_existe"), false);
  assert.equal(canTransition("nao_existe", "cataloged"), false);
  assert.throws(() => assertValidTransition("nao_existe", "cataloged"), InvalidDocumentStateError);
  assert.throws(() => assertValidTransition("discovered", "nao_existe"), InvalidDocumentStateError);
});

test("TRANSITIONS cobre exatamente os 9 estados como chaves, nenhum a mais nem a menos", () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...STATES].sort());
});

test("todo alvo de transição listada em TRANSITIONS é ele próprio um estado válido (grafo internamente consistente)", () => {
  for (const tos of Object.values(TRANSITIONS)) {
    for (const to of tos) {
      assert.equal(isValidState(to), true, `"${to}" referenciado em TRANSITIONS mas não é um estado válido`);
    }
  }
});
