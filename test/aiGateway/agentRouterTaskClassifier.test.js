const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyAgentRouterCall,
  KNOWN_TRIGGER_TO_TASK_CLASS,
  RESERVED_UNUSED_TASK_CLASSES,
  UnknownTriggerReasonError,
  AgentRouterTaskClassificationError,
} = require("../../lib/aiGateway/agentRouterTaskClassifier");

function assertThrowsCode(fn, ErrorClass, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ErrorClass, `esperado ${ErrorClass.name}, veio ${err.constructor.name}: ${err.message}`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

test("classifyAgentRouterCall: quant_signal -> normal_analysis", () => {
  assert.equal(classifyAgentRouterCall({ triggerReason: "quant_signal" }), "normal_analysis");
});

test("classifyAgentRouterCall: heartbeat -> triage", () => {
  assert.equal(classifyAgentRouterCall({ triggerReason: "heartbeat" }), "triage");
});

test("classifyAgentRouterCall: trigger desconhecido -> UnknownTriggerReasonError (fail-closed, nao classifica silenciosamente)", () => {
  assertThrowsCode(() => classifyAgentRouterCall({ triggerReason: "made_up_reason" }), UnknownTriggerReasonError, "UNKNOWN_TRIGGER_REASON");
});

test("classifyAgentRouterCall: trigger ausente (opts vazio) -> UnknownTriggerReasonError", () => {
  assertThrowsCode(() => classifyAgentRouterCall({}), UnknownTriggerReasonError);
});

test("classifyAgentRouterCall: sem argumento nenhum -> UnknownTriggerReasonError", () => {
  assertThrowsCode(() => classifyAgentRouterCall(), UnknownTriggerReasonError);
});

test("classifyAgentRouterCall: triggerReason null -> UnknownTriggerReasonError", () => {
  assertThrowsCode(() => classifyAgentRouterCall({ triggerReason: null }), UnknownTriggerReasonError);
});

test("classifyAgentRouterCall: triggerReason nao-string (numero/objeto) -> UnknownTriggerReasonError", () => {
  assertThrowsCode(() => classifyAgentRouterCall({ triggerReason: 42 }), UnknownTriggerReasonError);
  assertThrowsCode(() => classifyAgentRouterCall({ triggerReason: { quant_signal: true } }), UnknownTriggerReasonError);
});

test("classifyAgentRouterCall: 'no_relevant_context'/'context_unchanged'/'min_interval_not_elapsed' (motivos de NAO-chamada do decisionCyclePolicy) tambem sao rejeitados -- so os 2 motivos de chamada real sao conhecidos", () => {
  for (const triggerReason of ["no_relevant_context", "context_unchanged", "min_interval_not_elapsed"]) {
    assertThrowsCode(() => classifyAgentRouterCall({ triggerReason }), UnknownTriggerReasonError);
  }
});

test("UnknownTriggerReasonError e uma AgentRouterTaskClassificationError", () => {
  try {
    classifyAgentRouterCall({ triggerReason: "x" });
    assert.fail("deveria ter lancado");
  } catch (err) {
    assert.ok(err instanceof AgentRouterTaskClassificationError);
    assert.ok(err instanceof UnknownTriggerReasonError);
  }
});

test("KNOWN_TRIGGER_TO_TASK_CLASS: exatamente os 2 triggers conhecidos hoje, valores sao tokens curtos em ingles", () => {
  assert.deepEqual(Object.keys(KNOWN_TRIGGER_TO_TASK_CLASS).sort(), ["heartbeat", "quant_signal"]);
  for (const taskClass of Object.values(KNOWN_TRIGGER_TO_TASK_CLASS)) {
    assert.match(taskClass, /^[a-z_]+$/);
  }
  assert.equal(KNOWN_TRIGGER_TO_TASK_CLASS.quant_signal, "normal_analysis");
  assert.equal(KNOWN_TRIGGER_TO_TASK_CLASS.heartbeat, "triage");
});

test("KNOWN_TRIGGER_TO_TASK_CLASS esta congelado (Object.freeze)", () => {
  assert.ok(Object.isFrozen(KNOWN_TRIGGER_TO_TASK_CLASS));
});

test("RESERVED_UNUSED_TASK_CLASSES: as 4 classes restantes do budget policy (Commit 3), nenhuma usada por um trigger conhecido hoje", () => {
  assert.deepEqual(
    [...RESERVED_UNUSED_TASK_CLASSES].sort(),
    ["critical_review", "deep_analysis", "health_check", "research_innovation"]
  );
  const usedClasses = new Set(Object.values(KNOWN_TRIGGER_TO_TASK_CLASS));
  for (const reserved of RESERVED_UNUSED_TASK_CLASSES) {
    assert.ok(!usedClasses.has(reserved), `${reserved} nao deveria estar em uso por nenhum trigger conhecido`);
  }
  assert.ok(Object.isFrozen(RESERVED_UNUSED_TASK_CLASSES));
});

test("classifyAgentRouterCall e pura: mesma entrada sempre produz a mesma saida, sem efeito colateral observavel", () => {
  const opts = { triggerReason: "quant_signal" };
  const r1 = classifyAgentRouterCall(opts);
  const r2 = classifyAgentRouterCall(opts);
  assert.equal(r1, r2);
  assert.deepEqual(opts, { triggerReason: "quant_signal" }); // nao mutou a entrada
});
