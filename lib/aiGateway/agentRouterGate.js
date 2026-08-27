// Gate do AgentRouter -- Fase 10 / Commit 4c2. Ponte PURA entre a
// identidade já commitada (agentRouterTaskClassifier.js/Commit 4a,
// agentRouterAssessmentKey.js/Commit 4a+4c1) e o transporte orçamentado já
// commitado (agentRouterBudgetedClient.js/Commit 4b) -- este módulo NUNCA
// importa ../infra/db, ./agentRouterBudgetPolicy nem
// ./agentRouterBudgetedClient diretamente: `dbProvider`, `policy` e
// `createBudgetedClient` são SEMPRE injetados pelo chamador (aiGateway.js).
// Isso é deliberado (correção de revisão do usuário, 2026-08-25): o
// caminho com a flag desligada precisa ficar ESTRUTURALMENTE isolado --
// aiGateway.js só faz `require()` dos módulos pesados (SQLite/policy/
// wrapper) DENTRO da branch habilitada, então um teste com a flag
// desligada pode provar (via require.cache) que esses módulos nunca
// chegam a carregar, não só que não são usados.
//
// Nenhuma chamada de rede/IA acontece aqui -- `realRunAgentRouterPrompt`
// também é sempre injetado, nunca lib/agentrouterClient.js importado
// diretamente.
const crypto = require("crypto");
const taskClassifier = require("./agentRouterTaskClassifier");
const assessmentKeyModule = require("./agentRouterAssessmentKey");
const promptBuilderEnglish = require("./promptBuilderEnglish");
const assessmentSchema = require("./assessmentSchema");

class AgentRouterGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

/**
 * computeQuantFingerprint(quant) devolve `null` para quant ausente/undefined
 * -- é o contrato de COMPATIBILIDADE deliberado do Commit 4c1 (callers que
 * não têm dado quantitativo disponível degradam bem). Sob o gate, essa
 * degradação NÃO é aceitável: a identidade do AgentRouter deve sempre
 * amarrar num fingerprint real. Este erro é a política MAIS ESTRITA deste
 * módulo por cima do contrato lenient do 4c1 -- nunca muda
 * agentRouterAssessmentKey.js.
 */
class MissingQuantFingerprintError extends AgentRouterGateError {
  constructor() {
    super("MISSING_QUANT_FINGERPRINT", "AgentRouter gate: context.quant is missing -- cannot compute a quantitative fingerprint");
  }
}

/** Defensivo -- getAssessment() com o gate ligado mas sem opts.assessmentMeta (integração incompleta upstream). */
class MissingAssessmentMetaError extends AgentRouterGateError {
  constructor() {
    super("MISSING_ASSESSMENT_META", "AgentRouter gate: assessmentMeta is required when the budget gate is enabled");
  }
}

// =====================================================================
// Serialização SANITIZADA do caminho fatal -- NUNCA lê err.message/stack/
// err.sql/err.path ou qualquer propriedade de conteúdo livre. Só o `.code`
// (allowlist positiva e fechada) decide a mensagem pública -- que é sempre
// um dos literais fixos abaixo, nunca interpolação de valor recebido.
// Código desconhecido (incluindo um .code que passe no formato mas não
// esteja na allowlist) vira o genérico AGENTROUTER_FATAL. Cobre TODAS as
// classes de erro alcançáveis por este caminho: agentRouterTaskClassifier.js,
// agentRouterAssessmentKey.js, este módulo, agentRouterBudgetPolicy.js,
// agentRouterLedger.js (propagado tal como vem pelo wrapper) e
// agentRouterBudgetedClient.js.
//
// DÍVIDA DE NOMENCLATURA (deliberada, não resolvida nesta correção mínima):
// sanitizeAgentRouterFatalError() também passou a ser reaproveitada por
// aiGateway.js no caminho de FALLBACK PERMITIDO (fallbackAllowed===true,
// status:"error", não "agentrouter_fatal") -- exatamente pra nunca precisar
// de uma segunda tabela de mensagens públicas. O nome da função ficou
// semanticamente impreciso (nem todo chamador é o caminho fatal), mas
// renomear exigiria autorização própria; ver GLOBAL_BUDGET_EXHAUSTED/
// CATEGORY_BUDGET_EXHAUSTED abaixo, os dois únicos códigos desta allowlist
// que hoje só são alcançados por esse caminho não-fatal.
// =====================================================================
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/;

const KNOWN_FATAL_ERROR_MESSAGES = Object.freeze({
  // agentRouterTaskClassifier.js (Commit 4a)
  UNKNOWN_TRIGGER_REASON: "AgentRouter call rejected: unknown or missing trigger reason",
  // agentRouterAssessmentKey.js (Commit 4a/4c1)
  INVALID_ASSESSMENT_KEY_INPUT: "AgentRouter call rejected: invalid assessment identity input",
  INVALID_ASSESSMENT_KEY_OUTPUT: "AgentRouter call rejected: computed assessment identity failed validation",
  UNRECOGNIZED_ASSESSMENT_KEY_FIELD: "AgentRouter call rejected: unrecognized assessment identity field",
  INVALID_ATTEMPT_ID: "AgentRouter call rejected: invalid attempt id",
  INVALID_QUANT_FINGERPRINT_INPUT: "AgentRouter call rejected: invalid quantitative fingerprint input",
  INVALID_QUANT_SIGNAL: "AgentRouter call rejected: invalid quantitative signal",
  // este módulo
  MISSING_QUANT_FINGERPRINT: "AgentRouter call rejected: quantitative fingerprint unavailable",
  MISSING_ASSESSMENT_META: "AgentRouter call rejected: assessment metadata unavailable",
  // agentRouterBudgetPolicy.js (Commit 3)
  UNKNOWN_TASK_CLASS: "AgentRouter call rejected: unknown task class",
  UNRECOGNIZED_RESERVE_FIELD: "AgentRouter call rejected: budget reservation field not recognized",
  ATOMIC_RESERVATION_UNAVAILABLE: "AgentRouter call rejected: budget ledger busy",
  INVALID_BUDGET_POLICY: "AgentRouter call rejected: invalid budget policy configuration",
  INVALID_TIMEZONE: "AgentRouter call rejected: invalid budget policy timezone",
  INVALID_WINDOW_START: "AgentRouter call rejected: invalid budget policy window",
  ESTIMATED_COST_EXCEEDS_PER_CALL_LIMIT: "AgentRouter call rejected: exceeds per-call budget limit",
  // agentRouterLedger.js (Commit 2), propagado tal como vem por
  // classifyPreflightError/classifyClaimError/classifySweepError
  INVALID_FIELD: "AgentRouter call rejected: invalid ledger field",
  NEGATIVE_AMOUNT: "AgentRouter call rejected: invalid ledger amount",
  AMOUNT_EXCEEDS_CEILING: "AgentRouter call rejected: ledger amount exceeds safety ceiling",
  INVALID_WINDOW: "AgentRouter call rejected: invalid budget window",
  IDEMPOTENCY_CONFLICT: "AgentRouter call rejected: idempotency conflict",
  RESERVATION_NOT_FOUND: "AgentRouter call rejected: reservation not found",
  INVALID_TRANSITION: "AgentRouter call rejected: invalid ledger state transition",
  CANNOT_RELEASE_AFTER_SEND_INTENT: "AgentRouter call rejected: cannot release after send intent",
  RECONCILE_EXCEEDS_ORIGINAL: "AgentRouter call rejected: reconciliation exceeds original amount",
  INVALID_EVIDENCE_TYPE: "AgentRouter call rejected: invalid ledger evidence type",
  UNSAFE_SUM: "AgentRouter call rejected: unsafe ledger aggregate",
  ALREADY_CLAIMED: "AgentRouter call rejected: send intent already claimed",
  CORRUPT_SEND_INTENT_STATE: "AgentRouter call rejected: corrupt send intent state",
  CLAIM_AFTER_EXPIRY: "AgentRouter call rejected: claim attempted after expiry",
  // agentRouterBudgetedClient.js (Commit 4b)
  PRIOR_ATTEMPT_AMBIGUOUS: "AgentRouter call rejected: prior attempt state ambiguous",
  ALREADY_ACCOUNTED_NO_RESPONSE_STORED: "AgentRouter call rejected: reservation already accounted without response",
  ASSESSMENT_ALREADY_RELEASED: "AgentRouter call rejected: reservation already released",
  ACCOUNTING_FAILED_AFTER_RESPONSE: "AgentRouter call rejected: accounting failed after response",
  ATOMIC_CLAIM_UNAVAILABLE: "AgentRouter call rejected: send-intent claim busy",
  UNEXPECTED_FATAL: "AgentRouter call rejected: unexpected internal error",
  // agentRouterBudgetPolicy.js (Commit 3) -- classifyPreflightError() em
  // agentRouterBudgetedClient.js marca estes dois com fallbackAllowed=true,
  // então NUNCA chegam ao caminho fatal acima (break); só ao caminho de
  // fallback permitido de aiGateway.js, que passou a reaproveitar esta
  // mesma allowlist/função pra nunca persistir err.message bruto ali também.
  GLOBAL_BUDGET_EXHAUSTED: "AgentRouter budget is exhausted.",
  CATEGORY_BUDGET_EXHAUSTED: "AgentRouter category budget is exhausted.",
});

const GENERIC_FATAL_ERROR_CODE = "AGENTROUTER_FATAL";
const GENERIC_FATAL_ERROR_MESSAGE = "AgentRouter call rejected: internal error";

/**
 * NUNCA lê err.message/err.stack/qualquer propriedade de conteúdo livre --
 * só `.code`, comparado contra a allowlist FECHADA acima. Um erro cujo
 * `.code` não esteja na allowlist (mesmo que passe no formato de
 * sanitizeErrorCode de aiGateway.js) vira o genérico AGENTROUTER_FATAL,
 * nunca herda uma mensagem inventada a partir do erro real.
 */
function sanitizeAgentRouterFatalError(err) {
  const rawCode = err && typeof err === "object" ? err.code : undefined;
  const known = typeof rawCode === "string" && ERROR_CODE_PATTERN.test(rawCode) && Object.hasOwn(KNOWN_FATAL_ERROR_MESSAGES, rawCode);
  if (known) return { errorCode: rawCode, message: KNOWN_FATAL_ERROR_MESSAGES[rawCode] };
  return { errorCode: GENERIC_FATAL_ERROR_CODE, message: GENERIC_FATAL_ERROR_MESSAGE };
}

/**
 * Constrói a identidade lógica (taskClass/assessmentKey) e física
 * (attemptId) de UMA tentativa do AgentRouter, e devolve um client
 * adaptado que agentrouterProvider.js chama exatamente como sempre chamou
 * (`client.runAgentRouterPrompt({system,user,model})`, 3 campos, SEM
 * metadata) -- o `metadata` real ({assessmentKey,attemptId,taskClass})
 * exigido pelo wrapper do Commit 4b é fechado por CLAUSURA aqui dentro,
 * nunca atravessa agentrouterProvider.js.
 *
 * `nowFn` NUNCA é chamado por este módulo -- só repassado, intacto, pro
 * relógio interno já auditado de createBudgetedAgentRouterClient()
 * (Commit 4b: computeExpiresAtMs/markWorstCaseCharged/sweep). A leitura
 * ÚNICA de "agora" para a identidade temporal desta avaliação
 * (lastClosedCandleTimestampMs) já aconteceu ANTES, em
 * lib/aiGateway/agentRouterAssessmentMeta.js -- este módulo nunca lê o
 * relógio por conta própria, então não há risco de uma segunda leitura
 * independente atravessar a fronteira de um candle dentro da mesma
 * avaliação.
 *
 * Lança (nunca engole) se: assessmentMeta ausente/malformado, trigger
 * desconhecido, candle ausente/inválido, quant ausente/inválido, ou
 * qualquer falha defensiva de computeAssessmentKey/createAttemptId. Todo
 * erro carrega `.partialAgentRouterIdentity` ({taskClass,assessmentKey,
 * attemptId}, cada campo `null` se ainda não calculado) -- permite ao
 * chamador (aiGateway.js) anotar o providerAttempts fatal com o que já
 * era conhecido no momento da falha, sem fabricar dado.
 */
function buildGatedAgentRouterInvocation({
  context,
  assessmentMeta,
  baseClient,
  dbProvider,
  policy,
  createBudgetedClient,
  realRunAgentRouterPrompt,
  timeoutMs,
  gracefulShutdownMs,
  codexCommand,
  nowFn = Date.now,
  randomUUIDFn = crypto.randomUUID,
}) {
  let taskClass = null;
  let assessmentKey = null;
  let attemptId = null;
  try {
    if (!assessmentMeta || typeof assessmentMeta !== "object" || Array.isArray(assessmentMeta)) {
      throw new MissingAssessmentMetaError();
    }

    taskClass = taskClassifier.classifyAgentRouterCall({ triggerReason: assessmentMeta.triggerReason });

    const quantFingerprint = assessmentKeyModule.computeQuantFingerprint(context?.quant ?? null);
    if (quantFingerprint === null) {
      throw new MissingQuantFingerprintError();
    }

    assessmentKey = assessmentKeyModule.computeAssessmentKey({
      symbol: context?.symbol,
      interval: context?.interval,
      candleTimestampMs: assessmentMeta.lastClosedCandleTimestampMs,
      triggerReason: assessmentMeta.triggerReason,
      taskClass,
      promptVersion: promptBuilderEnglish.PROMPT_VERSION,
      schemaVersion: assessmentSchema.SCHEMA_VERSION,
      regime: context?.riskState?.volatilityRegime ?? null,
      positionSide: context?.position?.side ?? null,
      quantFingerprint,
    });

    attemptId = assessmentKeyModule.createAttemptId({ randomUUIDFn });
  } catch (err) {
    if (err && typeof err === "object") err.partialAgentRouterIdentity = { taskClass, assessmentKey, attemptId };
    throw err;
  }

  const budgeted = createBudgetedClient({
    dbProvider,
    policy,
    realRunAgentRouterPrompt,
    timeoutMs,
    gracefulShutdownMs,
    codexCommand,
    nowFn,
  });

  const metadata = { assessmentKey, attemptId, taskClass };
  const client = {
    model: baseClient?.model,
    runAgentRouterPrompt: (args) => budgeted.runAgentRouterPrompt({ ...args, metadata }),
  };

  return { client, taskClass, assessmentKey, attemptId };
}

module.exports = {
  buildGatedAgentRouterInvocation,
  sanitizeAgentRouterFatalError,
  AgentRouterGateError,
  MissingQuantFingerprintError,
  MissingAssessmentMetaError,
  GENERIC_FATAL_ERROR_CODE,
  GENERIC_FATAL_ERROR_MESSAGE,
  KNOWN_FATAL_ERROR_MESSAGES,
};
