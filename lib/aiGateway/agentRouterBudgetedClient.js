// Cliente orcamentado do AgentRouter -- maquina de estados que envolve o
// transporte real (SEMPRE injetado, nunca lib/agentrouterClient.js
// importado aqui) com o gate preventivo dos Commits 2/3 (ledger + politica)
// e o claim atomico do Commit 4b. Fase 10 / Commit 4b: modulo standalone,
// AINDA NAO referenciado por lib/aiGateway/aiGateway.js nem por nenhum
// provider -- wiring fica para o Commit 4c, fora do escopo daqui.
//
// Ordem real de execucao de runAgentRouterPrompt():
//   getDb -> sweepExpiredReservations -> policy.tryReserve -> inspecao do
//   estado -> claimForSending -> transporte injetado -> markWorstCaseCharged
//   -> retorno ou erro.
// policy.tryReserve() NAO executa sweep -- por isso o sweep e' chamado
// explicitamente aqui, ANTES de tryReserve, a cada tentativa.
//
// Preco do AgentRouter permanece "unknown" neste commit -- nenhuma tabela
// de preco inventada: estimatedMicrosUsd=0, priceSource=null,
// priceSourceStatus="unknown", pricingTableVersion="unpriced-v1". A
// politica (Commit 3) ja reserva o teto INTEIRO da classe nesse regime.
//
// fallbackAllowed e' anotado EXPLICITAMENTE em todo erro que sai daqui --
// nunca herdado por omissao. Allowlist POSITIVA e estrita: so
// GlobalBudgetExhaustedError/CategoryBudgetExhaustedError (orcamento
// esgotado, nenhuma chamada de rede) e erro de transporte relancado DEPOIS
// de markWorstCaseCharged() ter tido sucesso recebem true. Todo o resto --
// incluindo qualquer forma de SQLITE_BUSY (reserva ou claim), claim ja
// reivindicado, tentativa anterior ambigua, estado ja contabilizado sem
// resposta, estado terminal sem cobranca, e falha de contabilizacao pos-
// resposta -- e' false. Erro desconhecido tambem e' false por padrao.
//
// Relogio 100% injetavel (nowFn) -- nenhuma chamada a Date.now() interna.
const { openDb } = require("../infra/db");
const ledger = require("./agentRouterLedger");
const budgetPolicy = require("./agentRouterBudgetPolicy");

// --- Erros nomeados do wrapper ---

class AgentRouterBudgetedClientError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
    this.fallbackAllowed = false; // default seguro -- todo throw sobrescreve explicitamente quando comprovadamente seguro
  }
}
class PriorAttemptAmbiguousError extends AgentRouterBudgetedClientError {
  constructor(idempotencyKey) {
    super(
      "PRIOR_ATTEMPT_AMBIGUOUS",
      `Reservation "${idempotencyKey}" already has a send intent recorded by a previous attempt -- not resending`
    );
    this.idempotencyKey = idempotencyKey;
  }
}
class AlreadyAccountedNoResponseStoredError extends AgentRouterBudgetedClientError {
  constructor(idempotencyKey, status) {
    super(
      "ALREADY_ACCOUNTED_NO_RESPONSE_STORED",
      `Reservation "${idempotencyKey}" is already accounted for (status=${status}), but no response was persisted -- a retry cannot return a response`
    );
    this.idempotencyKey = idempotencyKey;
    this.status = status;
  }
}
class AssessmentAlreadyReleasedError extends AgentRouterBudgetedClientError {
  constructor(idempotencyKey, status) {
    super("ASSESSMENT_ALREADY_RELEASED", `Reservation "${idempotencyKey}" is already in a terminal, uncharged state (status=${status})`);
    this.idempotencyKey = idempotencyKey;
    this.status = status;
  }
}
class AccountingFailedAfterResponseError extends AgentRouterBudgetedClientError {
  constructor(idempotencyKey, options) {
    super(
      "ACCOUNTING_FAILED_AFTER_RESPONSE",
      `Failed to account for reservation "${idempotencyKey}" after the transport call settled -- potentially inconsistent state`,
      options
    );
    this.idempotencyKey = idempotencyKey;
    // fallbackAllowed permanece false (default da classe base) -- nunca sobrescrito aqui
  }
}
class AtomicClaimUnavailableError extends AgentRouterBudgetedClientError {
  constructor(idempotencyKey, options) {
    super("ATOMIC_CLAIM_UNAVAILABLE", `Could not claim the send intent for "${idempotencyKey}" (writer lock not obtained)`, options);
    this.idempotencyKey = idempotencyKey;
  }
}
class UnexpectedFatalError extends AgentRouterBudgetedClientError {
  constructor(context, options) {
    super("UNEXPECTED_FATAL", `Unexpected error while processing "${context}" -- treated as fatal by default`, options);
    this.context = context;
  }
}

// --- expiresAtMs: formula explicita e injetavel ---

const EXPIRY_MARGIN_MS_DEFAULT = 30_000; // cobre: tempo entre o settle do transporte e a escrita de markWorstCaseCharged, e jitter de clock/agendamento
function computeExpiresAtMs({ nowMs, timeoutMs, gracefulShutdownMs, marginMs = EXPIRY_MARGIN_MS_DEFAULT }) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new UnexpectedFatalError("computeExpiresAtMs.nowMs", undefined);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new UnexpectedFatalError("computeExpiresAtMs.timeoutMs", undefined);
  if (!Number.isSafeInteger(gracefulShutdownMs) || gracefulShutdownMs < 0) throw new UnexpectedFatalError("computeExpiresAtMs.gracefulShutdownMs", undefined);
  if (!Number.isSafeInteger(marginMs) || marginMs < 0) throw new UnexpectedFatalError("computeExpiresAtMs.marginMs", undefined);
  return nowMs + timeoutMs + gracefulShutdownMs + marginMs;
}

// --- Conexao SQLite: provider lazy encapsulado, NUNCA um singleton de modulo.
// Dois providers criados separadamente NUNCA compartilham handle -- cada
// createLazyDbProvider() tem seu proprio `db` fechado sobre a closure.

function createLazyDbProvider({ openDbFn = openDb } = {}) {
  let db = null;
  return {
    getDb() {
      if (!db) db = openDbFn();
      return db;
    },
    closeDb() {
      if (db) {
        try {
          db.close();
        } catch {
          // ja pode estar fechado -- idempotente de proposito
        }
        db = null;
      }
    },
  };
}

// --- Classificacao de fallback -- allowlist POSITIVA e estrita ---

function markFallbackAllowed(err, allowed) {
  if (err && typeof err === "object") err.fallbackAllowed = allowed;
  return err;
}

/**
 * So GlobalBudgetExhaustedError/CategoryBudgetExhaustedError (orcamento
 * esgotado, nenhuma chamada de rede) recebem true. Qualquer outro erro de
 * politica/ledger conhecido (AtomicReservationUnavailableError -- SQLITE_BUSY
 * na reserva --, UnknownTaskClassError, InvalidBudgetPolicyError,
 * EstimatedCostExceedsPerCallLimitError, IdempotencyConflictError, etc.)
 * propaga tal como veio, mas com fallbackAllowed=false. Qualquer erro NAO
 * reconhecido vira UnexpectedFatalError, tambem false.
 */
function classifyPreflightError(err) {
  if (err instanceof budgetPolicy.GlobalBudgetExhaustedError || err instanceof budgetPolicy.CategoryBudgetExhaustedError) {
    return markFallbackAllowed(err, true);
  }
  if (err instanceof budgetPolicy.BudgetPolicyError || err instanceof ledger.LedgerError) {
    return markFallbackAllowed(err, false);
  }
  return markFallbackAllowed(new UnexpectedFatalError("tryReserve", { cause: err }), false);
}

/** claimForSending(): AlreadyClaimedError e qualquer LedgerError conhecido propagam com false; SQLITE_BUSY vira AtomicClaimUnavailableError, tambem false; qualquer outra coisa vira UnexpectedFatalError. */
function classifyClaimError(idempotencyKey, err) {
  if (err && err.code === "SQLITE_BUSY") {
    return markFallbackAllowed(new AtomicClaimUnavailableError(idempotencyKey, { cause: err }), false);
  }
  if (err instanceof ledger.LedgerError) {
    return markFallbackAllowed(err, false);
  }
  return markFallbackAllowed(new UnexpectedFatalError(`claimForSending:${idempotencyKey}`, { cause: err }), false);
}

function classifySweepError(err) {
  if (err instanceof ledger.LedgerError) return markFallbackAllowed(err, false);
  return markFallbackAllowed(new UnexpectedFatalError("sweepExpiredReservations", { cause: err }), false);
}

/**
 * Cria o cliente orcamentado. `dbProvider` ({getDb, closeDb}) e' sempre
 * injetado pelo chamador -- nenhuma instancia default e' criada por este
 * modulo (isso fica para o wiring do Commit 4c). `realRunAgentRouterPrompt`
 * e' o TRANSPORTE real (produção: lib/agentrouterClient.js::runAgentRouterPrompt,
 * SEMPRE injetado em teste como funcao fake -- nunca importado aqui).
 */
function createBudgetedAgentRouterClient({
  dbProvider,
  policy,
  realRunAgentRouterPrompt,
  timeoutMs,
  gracefulShutdownMs,
  codexCommand,
  marginMs = EXPIRY_MARGIN_MS_DEFAULT,
  nowFn = Date.now,
}) {
  async function runAgentRouterPrompt({ system, user, model, metadata }) {
    const db = dbProvider.getDb();
    const nowMs = nowFn();
    const idempotencyKey = "ar:" + metadata.assessmentKey;
    const attemptId = metadata.attemptId;

    // 1) sweep -- NUNCA dentro de tryReserve, a politica nao faz sweep.
    try {
      ledger.sweepExpiredReservations(db, { nowMs });
    } catch (err) {
      throw classifySweepError(err);
    }

    // 2) reserva atomica (idempotente por assessmentKey)
    let row;
    try {
      row = policy.tryReserve(db, {
        idempotencyKey,
        correlationId: metadata.assessmentKey,
        model,
        taskClass: metadata.taskClass,
        estimatedMicrosUsd: 0,
        priceSource: null,
        priceSourceStatus: "unknown",
        pricingTableVersion: "unpriced-v1",
        expiresAtMs: computeExpiresAtMs({ nowMs, timeoutMs, gracefulShutdownMs, marginMs }),
        nowMs,
      });
    } catch (err) {
      throw classifyPreflightError(err);
    }

    // 3) inspecao do estado devolvido (nova OU retry reconhecido)
    if (row.status === "confirmed" || row.status === "worst_case_charged" || row.status === "expired_worst_case") {
      throw markFallbackAllowed(new AlreadyAccountedNoResponseStoredError(idempotencyKey, row.status), false);
    }
    if (row.status === "released" || row.status === "expired_released") {
      throw markFallbackAllowed(new AssessmentAlreadyReleasedError(idempotencyKey, row.status), false);
    }
    if (row.status !== "reserved") {
      // defensivo -- o CHECK do banco limita status a 6 valores, os 5 outros
      // ja foram tratados acima; nunca deveria sobrar nada aqui.
      throw markFallbackAllowed(new UnexpectedFatalError(`unknown-status:${row.status}`, undefined), false);
    }
    if (row.send_intent_at !== null) {
      throw markFallbackAllowed(new PriorAttemptAmbiguousError(idempotencyKey), false);
    }

    // 4) claim atomico -- UNICO ponto a partir do qual o transporte pode ser chamado
    try {
      ledger.claimForSending(db, { idempotencyKey, requestId: attemptId, nowMs });
    } catch (err) {
      throw classifyClaimError(idempotencyKey, err);
    }

    // 5) transporte injetado -- NUNCA recebe metadata, ledger ou db
    let raw;
    let transportErr;
    try {
      raw = await realRunAgentRouterPrompt({ system, user, model, timeoutMs, gracefulShutdownMs, codexCommand });
    } catch (err) {
      transportErr = err;
    }

    // 6) contabilizacao -- preco "unknown" -> sempre pior caso neste commit
    try {
      ledger.markWorstCaseCharged(db, { idempotencyKey, nowMs: nowFn() });
    } catch (accountingErr) {
      const fatal = new AccountingFailedAfterResponseError(idempotencyKey, { cause: accountingErr });
      if (transportErr) fatal.transportError = transportErr; // contabil e' primario, mas preserva a causa de transporte tambem
      throw markFallbackAllowed(fatal, false);
    }

    // 7) retorno ou erro
    if (transportErr) throw markFallbackAllowed(transportErr, true); // pior caso persistiu com sucesso -- seguro fazer fallback
    return raw;
  }

  return { runAgentRouterPrompt };
}

module.exports = {
  createBudgetedAgentRouterClient,
  createLazyDbProvider,
  computeExpiresAtMs,
  EXPIRY_MARGIN_MS_DEFAULT,
  AgentRouterBudgetedClientError,
  PriorAttemptAmbiguousError,
  AlreadyAccountedNoResponseStoredError,
  AssessmentAlreadyReleasedError,
  AccountingFailedAfterResponseError,
  AtomicClaimUnavailableError,
  UnexpectedFatalError,
};
