// Classificador puro e fail-closed: triggerReason (decisionCyclePolicy.js)
// -> taskClass (uma das 6 classes do AgentRouter budget policy, Commit 3).
// Fase 10 / Commit 4a. Sem I/O, sem config, sem rede.
//
// Fail-closed por desenho: um trigger ausente/desconhecido NUNCA vira uma
// classificação silenciosa (ex.: "cai pra triage por padrão") -- lança um
// erro nomeado, deixando a decisão explícita pra quem chama (Commit 4c).
//
// Todo texto operacional deste módulo (mensagens/códigos de erro, valores
// de taskClass) está em inglês -- taskClass pode um dia atravessar
// metadata perto da fronteira do AgentRouter. Comentários seguem em
// português.
const KNOWN_TRIGGER_TO_TASK_CLASS = Object.freeze({
  quant_signal: "normal_analysis",
  heartbeat: "triage",
});

// As outras 4 classes do budget policy (Commit 3) permanecem RESERVADAS --
// nenhum triggerReason existente hoje mapeia pra elas. Não inventamos uso.
const RESERVED_UNUSED_TASK_CLASSES = Object.freeze(["health_check", "deep_analysis", "research_innovation", "critical_review"]);

class AgentRouterTaskClassificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

class UnknownTriggerReasonError extends AgentRouterTaskClassificationError {
  constructor(triggerReason) {
    super("UNKNOWN_TRIGGER_REASON", `Cannot classify AgentRouter call: unknown or missing triggerReason (${JSON.stringify(triggerReason)})`);
    this.triggerReason = triggerReason;
  }
}

/**
 * classifyAgentRouterCall({ triggerReason }) -> taskClass (string)
 * Lança UnknownTriggerReasonError se triggerReason não for exatamente uma
 * das chaves conhecidas de KNOWN_TRIGGER_TO_TASK_CLASS.
 */
function classifyAgentRouterCall(opts = {}) {
  const triggerReason = opts.triggerReason;
  if (typeof triggerReason !== "string" || !Object.hasOwn(KNOWN_TRIGGER_TO_TASK_CLASS, triggerReason)) {
    throw new UnknownTriggerReasonError(triggerReason);
  }
  return KNOWN_TRIGGER_TO_TASK_CLASS[triggerReason];
}

module.exports = {
  classifyAgentRouterCall,
  KNOWN_TRIGGER_TO_TASK_CLASS,
  RESERVED_UNUSED_TASK_CLASSES,
  AgentRouterTaskClassificationError,
  UnknownTriggerReasonError,
};
