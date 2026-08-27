// Máquina de estados dos documentos da Base de Conhecimento Velatrader --
// puro, sem I/O, sem SQLite. `approved_for_agentrouter` NÃO existe ainda de
// propósito (fica pro commit futuro de integração com o AgentRouter,
// conforme instruído) -- este commit só cobre até `approved_for_research`.
// Nenhum material começa aprovado: STATES.INITIAL é o único estado válido
// pra um documento recém-descoberto, e não há nenhuma aresta que entre nos
// estados de aprovação/processamento sem passar pelos intermediários.
const STATES = Object.freeze([
  "discovered",
  "cataloged",
  "processing_pending",
  "processed",
  "review_required",
  "approved_for_research",
  "rejected",
  "suspended",
  "retired",
]);

const STATE_SET = new Set(STATES);

const INITIAL_STATE = "discovered";

// Grafo de transições permitidas -- pequeno e exaustivamente testável de
// propósito (não um enum aberto). `retired` é terminal (nenhuma aresta de
// saída) -- uma vez retirado, um documento nunca volta a circular; um
// material que precisa reentrar no fluxo é um documento NOVO (novo id),
// nunca uma reversão de `retired`.
const TRANSITIONS = Object.freeze({
  discovered: ["cataloged", "retired"],
  cataloged: ["processing_pending", "suspended", "retired"],
  processing_pending: ["processed", "review_required", "suspended", "retired"],
  processed: ["review_required", "retired"],
  review_required: ["approved_for_research", "rejected", "suspended", "retired"],
  approved_for_research: ["suspended", "retired"],
  rejected: ["cataloged", "retired"],
  suspended: ["cataloged", "retired"],
  retired: [],
});

class InvalidDocumentStateError extends Error {
  constructor(state) {
    super(`Invalid document state: ${JSON.stringify(state)}`);
    this.name = this.constructor.name;
    this.code = "INVALID_DOCUMENT_STATE";
  }
}

class InvalidDocumentTransitionError extends Error {
  constructor(from, to) {
    super(`Transition not allowed: "${from}" -> "${to}"`);
    this.name = this.constructor.name;
    this.code = "INVALID_DOCUMENT_TRANSITION";
    this.from = from;
    this.to = to;
  }
}

function isValidState(state) {
  return STATE_SET.has(state);
}

function canTransition(from, to) {
  if (!isValidState(from) || !isValidState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

/** Lança InvalidDocumentStateError/InvalidDocumentTransitionError -- nunca devolve um booleano silencioso quando quem chama precisa de garantia, não de checagem opcional. */
function assertValidTransition(from, to) {
  if (!isValidState(from)) throw new InvalidDocumentStateError(from);
  if (!isValidState(to)) throw new InvalidDocumentStateError(to);
  if (!canTransition(from, to)) throw new InvalidDocumentTransitionError(from, to);
}

module.exports = {
  STATES,
  STATE_SET,
  INITIAL_STATE,
  TRANSITIONS,
  isValidState,
  canTransition,
  assertValidTransition,
  InvalidDocumentStateError,
  InvalidDocumentTransitionError,
};
