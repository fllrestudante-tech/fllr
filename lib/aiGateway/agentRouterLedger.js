// Ledger persistente do orcamento do AgentRouter (Fase 10 / Commit 2).
//
// Infraestrutura PURA: cria/consulta linhas em agentrouter_budget_ledger
// (estado atual) e agentrouter_budget_events (trilha append-only, migration
// 0014). NAO integra com lib/aiGateway/aiGateway.js, lib/agentrouterClient.js,
// supervisor, .env, config.toml ou rede -- isso fica pra um commit de
// integracao separado (Commit 3+). Nada aqui chama nenhum provider de IA.
//
// Dinheiro sempre em micros de dolar (1 USD = 1_000_000), inteiro, nunca
// float -- somas agregadas usam SUM() do proprio SQLite (aritmetica de 64
// bits), nunca soma em ponto-flutuante JS. Toda funcao de escrita roda
// dentro de BEGIN IMMEDIATE (db.transaction(fn).immediate()) -- adquire o
// lock de escritor ANTES de ler o estado atual, eliminando a corrida
// classica de duas conexoes lendo 'reserved' e ambas tentando transicionar.
//
// Toda transicao grava, na MESMA transacao, um evento append-only em
// agentrouter_budget_events -- se o evento nao puder ser gravado (ex:
// violacao de CHECK), a atualizacao da linha principal tambem eh revertida
// (rollback automatico do better-sqlite3 quando a funcao lanca). O modulo
// nunca expoe UPDATE/DELETE publico sobre agentrouter_budget_events -- so
// INSERT, sempre via insertEvent() interna.
//
// Relogio 100% injetavel -- toda funcao recebe nowMs, nenhuma chama
// Date.now() internamente (mesmo padrao de
// lib/aiGateway/costMetrics.js::computeAiCostMetrics({now, ...})).

const MAX_SAFE_MICROS_USD = 1_000_000_000_000; // teto operacional: US$1.000.000 em micros (folga generosa acima do teto real de US$10/dia)

const TOKEN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/; // idempotencyKey, correlationId, requestId
const MODEL_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/; // model, priceSource
const SHORT_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,40}$/; // taskClass, pricingTableVersion, metadataCode
const TIMEZONE_PATTERN = /^[A-Za-z0-9_/+-]{1,64}$/; // budgetWindowTimezone (IANA: "America/Sao_Paulo")
const EVIDENCE_REF_PATTERN = /^[A-Za-z0-9 _.:#/-]{1,200}$/; // evidenceReference
const ACTOR_REF_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/; // actorReference

const EVIDENCE_TYPES = new Set(["agentrouter_panel", "agentrouter_invoice", "provider_support", "manual_verified_no_charge"]);
const ACTOR_TYPES = new Set(["system", "operator", "reconciliation_script"]);
const PRICE_SOURCE_STATUSES = new Set(["confirmed", "observed", "unknown"]);

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}
class InvalidFieldError extends LedgerError {
  constructor(field, detail) {
    super("INVALID_FIELD", `Campo invalido: ${field} -- ${detail}`);
    this.field = field;
  }
}
class NegativeAmountError extends LedgerError {
  constructor(field) {
    super("NEGATIVE_AMOUNT", `Valor monetario negativo nao permitido: ${field}`);
    this.field = field;
  }
}
class AmountExceedsCeilingError extends LedgerError {
  constructor(field, value) {
    super("AMOUNT_EXCEEDS_CEILING", `Valor de ${field} (${value}) excede o teto de seguranca (${MAX_SAFE_MICROS_USD})`);
    this.field = field;
  }
}
class InvalidWindowError extends LedgerError {
  constructor(detail) {
    super("INVALID_WINDOW", `Janela de orcamento invalida: ${detail}`);
  }
}
class IdempotencyConflictError extends LedgerError {
  constructor(key) {
    super("IDEMPOTENCY_CONFLICT", `idempotency_key "${key}" ja existe com payload canonico diferente`);
    this.idempotencyKey = key;
  }
}
class ReservationNotFoundError extends LedgerError {
  constructor(key) {
    super("RESERVATION_NOT_FOUND", `Nenhuma reserva encontrada para idempotency_key "${key}"`);
    this.idempotencyKey = key;
  }
}
class InvalidTransitionError extends LedgerError {
  constructor(key, from, to) {
    super("INVALID_TRANSITION", `Transicao invalida para "${key}": nao esta em ${from} (destino pretendido: ${to})`);
    this.idempotencyKey = key;
  }
}
class CannotReleaseAfterSendIntentError extends LedgerError {
  constructor(key) {
    super(
      "CANNOT_RELEASE_AFTER_SEND_INTENT",
      `Reserva "${key}" ja teve send_intent_at gravado -- nao pode ser liberada, use markWorstCaseCharged`
    );
    this.idempotencyKey = key;
  }
}
class ReconcileMustNotExceedOriginalError extends LedgerError {
  constructor(key) {
    super("RECONCILE_EXCEEDS_ORIGINAL", `Valor reconciliado nao pode exceder o valor efetivo atual/original para "${key}"`);
    this.idempotencyKey = key;
  }
}
class InvalidEvidenceTypeError extends LedgerError {
  constructor(value) {
    super("INVALID_EVIDENCE_TYPE", `evidenceType invalido: ${JSON.stringify(value)}`);
  }
}
class UnsafeSumError extends LedgerError {
  constructor(detail) {
    super("UNSAFE_SUM", `Soma agregada fora do intervalo inteiro seguro: ${detail}`);
  }
}

function assertRestrictedString(value, fieldName, pattern, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new InvalidFieldError(fieldName, "obrigatorio");
  }
  if (typeof value !== "string") throw new InvalidFieldError(fieldName, "deve ser string");
  // eslint-disable-next-line no-control-regex -- deteccao proposital de NUL/CR/LF/controles
  if (/[\x00-\x1f\x7f]/.test(value)) throw new InvalidFieldError(fieldName, "contem caractere de controle (NUL/CR/LF/etc)");
  if (!pattern.test(value)) throw new InvalidFieldError(fieldName, "fora do formato/tamanho permitido");
  return value;
}

function assertSafeMicros(value, fieldName, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new InvalidFieldError(fieldName, "obrigatorio");
  }
  if (!Number.isSafeInteger(value)) throw new InvalidFieldError(fieldName, "deve ser inteiro seguro (Number.isSafeInteger)");
  if (value < 0) throw new NegativeAmountError(fieldName);
  if (value > MAX_SAFE_MICROS_USD) throw new AmountExceedsCeilingError(fieldName, value);
  return value;
}

function assertNonNegativeInt(value, fieldName, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new InvalidFieldError(fieldName, "obrigatorio");
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidFieldError(fieldName, "deve ser inteiro nao-negativo");
  return value;
}

function assertMs(value, fieldName, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new InvalidFieldError(fieldName, "obrigatorio");
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidFieldError(fieldName, "deve ser epoch ms inteiro nao-negativo");
  return value;
}

function msToIso(ms) {
  return new Date(ms).toISOString();
}

// Payload canonico da idempotencia -- exatamente estes campos. NUNCA nowMs,
// id do banco, status ou timestamps ISO derivados (esses sao gerados pelo
// servidor, nao fazem parte da "mesma intencao de reserva" do chamador).
function canonicalPayload({
  correlationId,
  model,
  taskClass,
  estimatedMicrosUsd,
  reservedMicrosUsd,
  priceSource,
  priceSourceStatus,
  pricingTableVersion,
  budgetWindowStartMs,
  budgetWindowEndMs,
  budgetWindowTimezone,
  expiresAtMs,
}) {
  return JSON.stringify({
    correlationId,
    model,
    taskClass,
    estimatedMicrosUsd,
    reservedMicrosUsd,
    priceSource: priceSource ?? null,
    priceSourceStatus,
    pricingTableVersion,
    budgetWindowStartMs,
    budgetWindowEndMs,
    budgetWindowTimezone,
    expiresAtMs: expiresAtMs ?? null,
  });
}

// Payload canonico REDUZIDO, sem campos de janela -- usado SOMENTE por
// resolvePolicyIdempotentReservation() (helper especifico do modulo de
// politica, Commit 3). reserveBudget() e seu canonicalPayload() completo
// (com janela) permanecem 100% inalterados -- este e um payload SEPARADO,
// nao uma variante do outro. A janela e' atribuida pelo servidor/politica a
// cada reserva nova (nao faz parte da intencao logica do chamador), entao
// nunca deve, por si so, bloquear o reconhecimento de um retry.
function canonicalPayloadWithoutWindow({
  correlationId,
  model,
  taskClass,
  estimatedMicrosUsd,
  priceSource,
  priceSourceStatus,
  pricingTableVersion,
  expiresAtMs,
}) {
  return JSON.stringify({
    correlationId,
    model,
    taskClass,
    estimatedMicrosUsd,
    priceSource: priceSource ?? null,
    priceSourceStatus,
    pricingTableVersion,
    expiresAtMs: expiresAtMs ?? null,
  });
}

function rowToPublicShape(row) {
  return row ? { ...row } : null;
}

// Unico ponto que grava em agentrouter_budget_events -- sempre INSERT,
// nunca UPDATE/DELETE. Chamada sempre de dentro da mesma transacao IMMEDIATE
// que altera agentrouter_budget_ledger.
function insertEvent(
  db,
  { ledgerId, eventType, fromStatus, toStatus, effectiveMicrosUsd, evidenceType = null, evidenceReference = null, actorType, actorReference = null, metadataCode = null, nowMs }
) {
  db.prepare(
    `
    INSERT INTO agentrouter_budget_events
      (ledger_id, event_type, from_status, to_status, effective_micros_usd,
       evidence_type, evidence_reference, actor_type, actor_reference, metadata_code,
       occurred_at, occurred_at_ms)
    VALUES (@ledgerId, @eventType, @fromStatus, @toStatus, @effectiveMicrosUsd,
            @evidenceType, @evidenceReference, @actorType, @actorReference, @metadataCode,
            @occurredAt, @occurredAtMs)
  `
  ).run({
    ledgerId,
    eventType,
    fromStatus,
    toStatus,
    effectiveMicrosUsd,
    evidenceType,
    evidenceReference,
    actorType,
    actorReference,
    metadataCode,
    occurredAt: msToIso(nowMs),
    occurredAtMs: nowMs,
  });
}

// Valor efetivo por status, extraido para reuso (Commit 3 / modulo de
// politica soma por categoria com esta MESMA expressao, evitando duas
// definicoes divergentes do mesmo mapeamento status -> valor efetivo).
// Comportamento identico ao CASE que ja existia inline em
// getBudgetStateForWindow -- extracao pura, sem mudanca de logica.
const EFFECTIVE_MICROS_USD_CASE_SQL = `
  CASE status
    WHEN 'reserved' THEN reserved_micros_usd
    WHEN 'confirmed' THEN confirmed_micros_usd
    WHEN 'worst_case_charged' THEN COALESCE(reconciled_effective_micros_usd, original_worst_case_micros_usd)
    WHEN 'expired_worst_case' THEN COALESCE(reconciled_effective_micros_usd, original_worst_case_micros_usd)
    ELSE 0
  END
`;

function getRowByKey(db, idempotencyKey) {
  return db.prepare(`SELECT * FROM agentrouter_budget_ledger WHERE idempotency_key = ?`).get(idempotencyKey);
}

function getRowById(db, id) {
  return db.prepare(`SELECT * FROM agentrouter_budget_ledger WHERE id = ?`).get(id);
}

/**
 * Cria uma reserva em status 'reserved'. provider/currency NUNCA sao
 * parametros -- o modulo hardcoda 'agentrouter'/'USD' (o CHECK do banco eh
 * defesa adicional, nao a unica linha de defesa). Idempotente por
 * idempotencyKey: payload canonico identico -> retorna o registro existente
 * sem novo evento; payload diferente -> IdempotencyConflictError.
 */
function reserveBudget(db, opts) {
  const idempotencyKey = assertRestrictedString(opts.idempotencyKey, "idempotencyKey", TOKEN_ID_PATTERN);
  const correlationId = assertRestrictedString(opts.correlationId, "correlationId", TOKEN_ID_PATTERN);
  const model = assertRestrictedString(opts.model, "model", MODEL_PATTERN);
  const taskClass = assertRestrictedString(opts.taskClass, "taskClass", SHORT_CODE_PATTERN);
  const priceSource = assertRestrictedString(opts.priceSource ?? null, "priceSource", MODEL_PATTERN, { nullable: true });
  if (!PRICE_SOURCE_STATUSES.has(opts.priceSourceStatus)) throw new InvalidFieldError("priceSourceStatus", "deve ser confirmed|observed|unknown");
  const priceSourceStatus = opts.priceSourceStatus;
  const pricingTableVersion = assertRestrictedString(opts.pricingTableVersion, "pricingTableVersion", SHORT_CODE_PATTERN);
  const budgetWindowTimezone = assertRestrictedString(opts.budgetWindowTimezone, "budgetWindowTimezone", TIMEZONE_PATTERN);
  const estimatedMicrosUsd = assertSafeMicros(opts.estimatedMicrosUsd, "estimatedMicrosUsd");
  const reservedMicrosUsd = assertSafeMicros(opts.reservedMicrosUsd, "reservedMicrosUsd");
  const budgetWindowStartMs = assertMs(opts.budgetWindowStartMs, "budgetWindowStartMs");
  const budgetWindowEndMs = assertMs(opts.budgetWindowEndMs, "budgetWindowEndMs");
  if (budgetWindowEndMs <= budgetWindowStartMs) throw new InvalidWindowError("budgetWindowEndMs deve ser maior que budgetWindowStartMs");
  const expiresAtMs = opts.expiresAtMs != null ? assertMs(opts.expiresAtMs, "expiresAtMs") : null;
  const nowMs = assertMs(opts.nowMs, "nowMs");

  const canonical = canonicalPayload({
    correlationId,
    model,
    taskClass,
    estimatedMicrosUsd,
    reservedMicrosUsd,
    priceSource,
    priceSourceStatus,
    pricingTableVersion,
    budgetWindowStartMs,
    budgetWindowEndMs,
    budgetWindowTimezone,
    expiresAtMs,
  });

  return db
    .transaction(() => {
      const existing = getRowByKey(db, idempotencyKey);
      if (existing) {
        const existingCanonical = canonicalPayload({
          correlationId: existing.correlation_id,
          model: existing.model,
          taskClass: existing.task_class,
          estimatedMicrosUsd: existing.estimated_micros_usd,
          reservedMicrosUsd: existing.reserved_micros_usd,
          priceSource: existing.price_source,
          priceSourceStatus: existing.price_source_status,
          pricingTableVersion: existing.pricing_table_version,
          budgetWindowStartMs: existing.budget_window_start_ms,
          budgetWindowEndMs: existing.budget_window_end_ms,
          budgetWindowTimezone: existing.budget_window_timezone,
          expiresAtMs: existing.expires_at_ms,
        });
        if (existingCanonical !== canonical) throw new IdempotencyConflictError(idempotencyKey);
        return rowToPublicShape(existing); // idempotente -- sem novo evento, sem nova linha
      }

      const iso = msToIso(nowMs);
      const info = db
        .prepare(
          `
        INSERT INTO agentrouter_budget_ledger
          (idempotency_key, correlation_id, model, task_class, status,
           estimated_micros_usd, reserved_micros_usd,
           price_source, price_source_status, pricing_table_version,
           budget_window_start_ms, budget_window_end_ms, budget_window_timezone,
           created_at, created_at_ms, expires_at, expires_at_ms)
        VALUES
          (@idempotencyKey, @correlationId, @model, @taskClass, 'reserved',
           @estimatedMicrosUsd, @reservedMicrosUsd,
           @priceSource, @priceSourceStatus, @pricingTableVersion,
           @budgetWindowStartMs, @budgetWindowEndMs, @budgetWindowTimezone,
           @createdAt, @createdAtMs, @expiresAt, @expiresAtMs)
      `
        )
        .run({
          idempotencyKey,
          correlationId,
          model,
          taskClass,
          estimatedMicrosUsd,
          reservedMicrosUsd,
          priceSource,
          priceSourceStatus,
          pricingTableVersion,
          budgetWindowStartMs,
          budgetWindowEndMs,
          budgetWindowTimezone,
          createdAt: iso,
          createdAtMs: nowMs,
          expiresAt: expiresAtMs != null ? msToIso(expiresAtMs) : null,
          expiresAtMs,
        });

      insertEvent(db, {
        ledgerId: info.lastInsertRowid,
        eventType: "RESERVED",
        fromStatus: null,
        toStatus: "reserved",
        effectiveMicrosUsd: reservedMicrosUsd,
        actorType: "system",
        nowMs,
      });

      return rowToPublicShape(getRowById(db, info.lastInsertRowid));
    })
    .immediate();
}

/**
 * Helper ESPECIFICO para o modulo de politica (Commit 3). NUNCA chamado por
 * reserveBudget() nem altera seu comportamento -- reserveBudget() continua
 * usando seu proprio canonicalPayload() completo (com janela), contrato
 * inalterado desde o Commit 2, incluindo o teste que confirma conflito
 * quando a janela diverge.
 *
 * Aqui a comparacao usa canonicalPayloadWithoutWindow() -- SEM janela e SEM
 * reservedMicrosUsd, porque ambos sao atribuidos pelo servidor/politica
 * (janela pela virada do dia civil, valor reservado pela configuracao de
 * minimo vigente no momento da chamada) e nao fazem parte da intencao
 * logica do chamador. Isso permite que uma politica reconheca corretamente
 * um retry mesmo apos a janela orcamentaria ter virado.
 *
 * - idempotencyKey nao existe -> null (chamador calcula janela/valor e cria
 *   via reserveBudget())
 * - idempotencyKey existe e os campos abaixo (exceto janela e
 *   reservedMicrosUsd) batem -> devolve a linha original, com sua janela e
 *   valor reservado ja persistidos
 * - qualquer um desses campos diverge -> IdempotencyConflictError
 *
 * Deve ser chamada de DENTRO de uma transacao ja aberta pelo chamador (vira
 * SAVEPOINT se ja em transacao -- mesma convencao das demais funcoes deste
 * modulo). Como a politica mantem o lock de escritor durante toda a sua
 * propria BEGIN IMMEDIATE, nao existe intervalo de corrida entre este
 * helper retornar null e um reserveBudget() subsequente inserir a linha.
 */
function resolvePolicyIdempotentReservation(db, opts) {
  const idempotencyKey = assertRestrictedString(opts.idempotencyKey, "idempotencyKey", TOKEN_ID_PATTERN);
  const correlationId = assertRestrictedString(opts.correlationId, "correlationId", TOKEN_ID_PATTERN);
  const model = assertRestrictedString(opts.model, "model", MODEL_PATTERN);
  const taskClass = assertRestrictedString(opts.taskClass, "taskClass", SHORT_CODE_PATTERN);
  const priceSource = assertRestrictedString(opts.priceSource ?? null, "priceSource", MODEL_PATTERN, { nullable: true });
  if (!PRICE_SOURCE_STATUSES.has(opts.priceSourceStatus)) throw new InvalidFieldError("priceSourceStatus", "deve ser confirmed|observed|unknown");
  const priceSourceStatus = opts.priceSourceStatus;
  const pricingTableVersion = assertRestrictedString(opts.pricingTableVersion, "pricingTableVersion", SHORT_CODE_PATTERN);
  const estimatedMicrosUsd = assertSafeMicros(opts.estimatedMicrosUsd, "estimatedMicrosUsd");
  const expiresAtMs = opts.expiresAtMs != null ? assertMs(opts.expiresAtMs, "expiresAtMs") : null;

  const canonical = canonicalPayloadWithoutWindow({
    correlationId,
    model,
    taskClass,
    estimatedMicrosUsd,
    priceSource,
    priceSourceStatus,
    pricingTableVersion,
    expiresAtMs,
  });

  const existing = getRowByKey(db, idempotencyKey);
  if (!existing) return null;

  const existingCanonical = canonicalPayloadWithoutWindow({
    correlationId: existing.correlation_id,
    model: existing.model,
    taskClass: existing.task_class,
    estimatedMicrosUsd: existing.estimated_micros_usd,
    priceSource: existing.price_source,
    priceSourceStatus: existing.price_source_status,
    pricingTableVersion: existing.pricing_table_version,
    expiresAtMs: existing.expires_at_ms,
  });

  if (existingCanonical !== canonical) throw new IdempotencyConflictError(idempotencyKey);
  return rowToPublicShape(existing);
}

/**
 * Marca a INTENCAO de envio -- nao e prova de envio (nao existe transacao
 * atomica entre SQLite e a rede). So permitido em status='reserved'.
 */
function markSendIntent(db, opts) {
  const idempotencyKey = assertRestrictedString(opts.idempotencyKey, "idempotencyKey", TOKEN_ID_PATTERN);
  const requestId = opts.requestId != null ? assertRestrictedString(opts.requestId, "requestId", TOKEN_ID_PATTERN) : null;
  const nowMs = assertMs(opts.nowMs, "nowMs");

  return db
    .transaction(() => {
      const row = getRowByKey(db, idempotencyKey);
      if (!row) throw new ReservationNotFoundError(idempotencyKey);
      if (row.status !== "reserved") throw new InvalidTransitionError(idempotencyKey, "reserved", "send_intent_recorded");
      if (nowMs < row.created_at_ms) throw new InvalidFieldError("nowMs", "anterior a created_at_ms");

      const iso = msToIso(nowMs);
      const info = db
        .prepare(
          `
        UPDATE agentrouter_budget_ledger
        SET send_intent_at = @iso, send_intent_at_ms = @nowMs, request_id = COALESCE(@requestId, request_id)
        WHERE idempotency_key = @idempotencyKey AND status = 'reserved'
      `
        )
        .run({ iso, nowMs, requestId, idempotencyKey });
      if (info.changes !== 1) throw new InvalidTransitionError(idempotencyKey, "reserved", "send_intent_recorded");

      insertEvent(db, {
        ledgerId: row.id,
        eventType: "SEND_INTENT_RECORDED",
        fromStatus: "reserved",
        toStatus: "reserved",
        effectiveMicrosUsd: row.reserved_micros_usd,
        actorType: "system",
        nowMs,
      });

      return rowToPublicShape(getRowById(db, row.id));
    })
    .immediate();
}

/** reserved -> confirmed. Recebe tokens de uso REAL (nunca em reserveBudget). */
function confirmBudget(db, opts) {
  const idempotencyKey = assertRestrictedString(opts.idempotencyKey, "idempotencyKey", TOKEN_ID_PATTERN);
  const confirmedMicrosUsd = assertSafeMicros(opts.confirmedMicrosUsd, "confirmedMicrosUsd");
  const inputTokens = assertNonNegativeInt(opts.inputTokens ?? null, "inputTokens", { nullable: true });
  const cachedInputTokens = assertNonNegativeInt(opts.cachedInputTokens ?? null, "cachedInputTokens", { nullable: true });
  const outputTokens = assertNonNegativeInt(opts.outputTokens ?? null, "outputTokens", { nullable: true });
  const reasoningTokens = assertNonNegativeInt(opts.reasoningTokens ?? null, "reasoningTokens", { nullable: true });
  const panelObservedCostMicrosUsd = assertSafeMicros(opts.panelObservedCostMicrosUsd ?? null, "panelObservedCostMicrosUsd", { nullable: true });
  const nowMs = assertMs(opts.nowMs, "nowMs");

  return db
    .transaction(() => {
      const row = getRowByKey(db, idempotencyKey);
      if (!row) throw new ReservationNotFoundError(idempotencyKey);
      if (row.status !== "reserved") throw new InvalidTransitionError(idempotencyKey, "reserved", "confirmed");

      const info = db
        .prepare(
          `
        UPDATE agentrouter_budget_ledger
        SET status = 'confirmed', confirmed_micros_usd = @confirmedMicrosUsd,
            input_tokens = @inputTokens, cached_input_tokens = @cachedInputTokens,
            output_tokens = @outputTokens, reasoning_tokens = @reasoningTokens,
            panel_observed_cost_micros_usd = COALESCE(@panelObservedCostMicrosUsd, panel_observed_cost_micros_usd)
        WHERE idempotency_key = @idempotencyKey AND status = 'reserved'
      `
        )
        .run({ confirmedMicrosUsd, inputTokens, cachedInputTokens, outputTokens, reasoningTokens, panelObservedCostMicrosUsd, idempotencyKey });
      if (info.changes !== 1) throw new InvalidTransitionError(idempotencyKey, "reserved", "confirmed");

      insertEvent(db, {
        ledgerId: row.id,
        eventType: "CONFIRMED",
        fromStatus: "reserved",
        toStatus: "confirmed",
        effectiveMicrosUsd: confirmedMicrosUsd,
        actorType: "system",
        nowMs,
      });

      return rowToPublicShape(getRowById(db, row.id));
    })
    .immediate();
}

/** reserved -> released. So permitido se send_intent_at ainda for NULL. */
function releaseBudget(db, opts) {
  const idempotencyKey = assertRestrictedString(opts.idempotencyKey, "idempotencyKey", TOKEN_ID_PATTERN);
  const nowMs = assertMs(opts.nowMs, "nowMs");

  return db
    .transaction(() => {
      const row = getRowByKey(db, idempotencyKey);
      if (!row) throw new ReservationNotFoundError(idempotencyKey);
      if (row.status !== "reserved") throw new InvalidTransitionError(idempotencyKey, "reserved", "released");
      if (row.send_intent_at !== null) throw new CannotReleaseAfterSendIntentError(idempotencyKey);

      const info = db
        .prepare(
          `
        UPDATE agentrouter_budget_ledger SET status = 'released'
        WHERE idempotency_key = @idempotencyKey AND status = 'reserved' AND send_intent_at IS NULL
      `
        )
        .run({ idempotencyKey });
      if (info.changes !== 1) throw new InvalidTransitionError(idempotencyKey, "reserved", "released");

      insertEvent(db, {
        ledgerId: row.id,
        eventType: "RELEASED",
        fromStatus: "reserved",
        toStatus: "released",
        effectiveMicrosUsd: 0,
        actorType: "system",
        nowMs,
      });

      return rowToPublicShape(getRowById(db, row.id));
    })
    .immediate();
}

/**
 * reserved -> worst_case_charged. original_worst_case_micros_usd eh SEMPRE
 * = reserved_micros_usd -- nunca aceita valor livre do chamador (aumento
 * confirmado acima disso exigiria uma via de reconciliacao separada, fora
 * do escopo deste commit).
 */
function markWorstCaseCharged(db, opts) {
  const idempotencyKey = assertRestrictedString(opts.idempotencyKey, "idempotencyKey", TOKEN_ID_PATTERN);
  const nowMs = assertMs(opts.nowMs, "nowMs");

  return db
    .transaction(() => {
      const row = getRowByKey(db, idempotencyKey);
      if (!row) throw new ReservationNotFoundError(idempotencyKey);
      if (row.status !== "reserved") throw new InvalidTransitionError(idempotencyKey, "reserved", "worst_case_charged");

      const worstCase = row.reserved_micros_usd;
      const info = db
        .prepare(
          `
        UPDATE agentrouter_budget_ledger
        SET status = 'worst_case_charged', original_worst_case_micros_usd = @worstCase
        WHERE idempotency_key = @idempotencyKey AND status = 'reserved'
      `
        )
        .run({ worstCase, idempotencyKey });
      if (info.changes !== 1) throw new InvalidTransitionError(idempotencyKey, "reserved", "worst_case_charged");

      insertEvent(db, {
        ledgerId: row.id,
        eventType: "WORST_CASE_CHARGED",
        fromStatus: "reserved",
        toStatus: "worst_case_charged",
        effectiveMicrosUsd: worstCase,
        actorType: "system",
        nowMs,
      });

      return rowToPublicShape(getRowById(db, row.id));
    })
    .immediate();
}

/**
 * Varre reservas com expires_at_ms < nowMs. send_intent_at NULL (crash
 * ANTES da intencao) -> expired_released. send_intent_at preenchido (crash
 * DEPOIS da intencao, envio incerto) -> expired_worst_case. Idempotente:
 * so afeta linhas ainda em 'reserved'.
 */
function sweepExpiredReservations(db, opts) {
  const nowMs = assertMs(opts.nowMs, "nowMs");

  return db
    .transaction(() => {
      const candidates = db
        .prepare(
          `
        SELECT * FROM agentrouter_budget_ledger
        WHERE status = 'reserved' AND expires_at_ms IS NOT NULL AND expires_at_ms < @nowMs
      `
        )
        .all({ nowMs });

      let releasedCount = 0;
      let worstCaseCount = 0;

      for (const row of candidates) {
        if (row.send_intent_at === null) {
          const info = db
            .prepare(`UPDATE agentrouter_budget_ledger SET status = 'expired_released' WHERE id = @id AND status = 'reserved'`)
            .run({ id: row.id });
          if (info.changes === 1) {
            insertEvent(db, {
              ledgerId: row.id,
              eventType: "EXPIRED_RELEASED",
              fromStatus: "reserved",
              toStatus: "expired_released",
              effectiveMicrosUsd: 0,
              actorType: "system",
              nowMs,
            });
            releasedCount++;
          }
        } else {
          const worstCase = row.reserved_micros_usd;
          const info = db
            .prepare(
              `
            UPDATE agentrouter_budget_ledger
            SET status = 'expired_worst_case', original_worst_case_micros_usd = @worstCase
            WHERE id = @id AND status = 'reserved'
          `
            )
            .run({ id: row.id, worstCase });
          if (info.changes === 1) {
            insertEvent(db, {
              ledgerId: row.id,
              eventType: "EXPIRED_WORST_CASE",
              fromStatus: "reserved",
              toStatus: "expired_worst_case",
              effectiveMicrosUsd: worstCase,
              actorType: "system",
              nowMs,
            });
            worstCaseCount++;
          }
        }
      }

      return { releasedCount, worstCaseCount };
    })
    .immediate();
}

/**
 * So em worst_case_charged/expired_worst_case. So reduz (nunca aumenta) o
 * valor efetivo. Idempotente: mesmo valor de novo -> no-op, sem evento
 * duplicado. Evidencia SEMPRE estruturada (enum + referencia curta) --
 * nunca texto narrativo livre.
 */
function reconcileDown(db, opts) {
  const idempotencyKey = assertRestrictedString(opts.idempotencyKey, "idempotencyKey", TOKEN_ID_PATTERN);
  const reconciledEffectiveMicrosUsd = assertSafeMicros(opts.reconciledEffectiveMicrosUsd, "reconciledEffectiveMicrosUsd");
  if (!EVIDENCE_TYPES.has(opts.evidenceType)) throw new InvalidEvidenceTypeError(opts.evidenceType);
  const evidenceType = opts.evidenceType;
  const evidenceReference =
    opts.evidenceReference != null ? assertRestrictedString(opts.evidenceReference, "evidenceReference", EVIDENCE_REF_PATTERN) : null;
  if (!ACTOR_TYPES.has(opts.actorType)) throw new InvalidFieldError("actorType", "deve ser system|operator|reconciliation_script");
  const actorType = opts.actorType;
  const actorReference = opts.actorReference != null ? assertRestrictedString(opts.actorReference, "actorReference", ACTOR_REF_PATTERN) : null;
  const nowMs = assertMs(opts.nowMs, "nowMs");

  return db
    .transaction(() => {
      const row = getRowByKey(db, idempotencyKey);
      if (!row) throw new ReservationNotFoundError(idempotencyKey);
      if (row.status !== "worst_case_charged" && row.status !== "expired_worst_case") {
        throw new InvalidTransitionError(idempotencyKey, "worst_case_charged|expired_worst_case", "reconciled");
      }
      if (reconciledEffectiveMicrosUsd > row.original_worst_case_micros_usd) {
        throw new ReconcileMustNotExceedOriginalError(idempotencyKey);
      }

      const currentEffective = row.reconciled_effective_micros_usd;
      if (currentEffective !== null) {
        if (reconciledEffectiveMicrosUsd === currentEffective) {
          return rowToPublicShape(row); // idempotente, byte-identico -- sem novo evento
        }
        if (reconciledEffectiveMicrosUsd > currentEffective) {
          throw new ReconcileMustNotExceedOriginalError(idempotencyKey); // so pode manter ou reduzir de novo
        }
      }

      const iso = msToIso(nowMs);
      const info = db
        .prepare(
          `
        UPDATE agentrouter_budget_ledger
        SET reconciled_effective_micros_usd = @val, reconciled_at = @iso, reconciled_at_ms = @nowMs
        WHERE idempotency_key = @idempotencyKey
          AND status IN ('worst_case_charged', 'expired_worst_case')
          AND (reconciled_effective_micros_usd IS NULL OR reconciled_effective_micros_usd >= @val)
      `
        )
        .run({ val: reconciledEffectiveMicrosUsd, iso, nowMs, idempotencyKey });
      if (info.changes !== 1) throw new ReconcileMustNotExceedOriginalError(idempotencyKey);

      insertEvent(db, {
        ledgerId: row.id,
        eventType: "RECONCILED_DOWN",
        fromStatus: row.status,
        toStatus: row.status,
        effectiveMicrosUsd: reconciledEffectiveMicrosUsd,
        evidenceType,
        evidenceReference,
        actorType,
        actorReference,
        nowMs,
      });

      return rowToPublicShape(getRowById(db, row.id));
    })
    .immediate();
}

function getLedgerEntry(db, opts) {
  const idempotencyKey = assertRestrictedString(opts.idempotencyKey, "idempotencyKey", TOKEN_ID_PATTERN);
  return rowToPublicShape(getRowByKey(db, idempotencyKey));
}

function getLedgerEvents(db, opts) {
  const idempotencyKey = assertRestrictedString(opts.idempotencyKey, "idempotencyKey", TOKEN_ID_PATTERN);
  const row = getRowByKey(db, idempotencyKey);
  if (!row) throw new ReservationNotFoundError(idempotencyKey);
  return db
    .prepare(`SELECT * FROM agentrouter_budget_events WHERE ledger_id = ? ORDER BY occurred_at_ms ASC, id ASC`)
    .all(row.id)
    .map((e) => ({ ...e }));
}

/**
 * Soma por correspondencia EXATA de janela (nunca recomputa timezone/meia-
 * noite -- isso fica pro modulo de politica, Commit 3). Valor efetivo por
 * status: reserved->reserved_micros_usd, confirmed->confirmed_micros_usd,
 * worst_case_charged/expired_worst_case->COALESCE(reconciliado, original),
 * released/expired_released->0. Soma via SUM() do SQLite (inteiro 64 bits),
 * nunca em ponto-flutuante JS -- resultado revalidado com
 * Number.isSafeInteger antes de sair.
 */
function getBudgetStateForWindow(db, opts) {
  const windowStartMs = assertMs(opts.windowStartMs, "windowStartMs");
  const windowEndMs = assertMs(opts.windowEndMs, "windowEndMs");
  if (windowEndMs <= windowStartMs) throw new InvalidWindowError("windowEndMs deve ser maior que windowStartMs");

  const totalRow = db
    .prepare(
      `
    SELECT
      SUM(${EFFECTIVE_MICROS_USD_CASE_SQL}) AS total_micros_usd,
      COUNT(*) AS row_count
    FROM agentrouter_budget_ledger
    WHERE budget_window_start_ms = @windowStartMs AND budget_window_end_ms = @windowEndMs
  `
    )
    .get({ windowStartMs, windowEndMs });

  const totalMicrosUsd = totalRow.total_micros_usd ?? 0;
  if (!Number.isSafeInteger(totalMicrosUsd)) {
    throw new UnsafeSumError(`SUM() retornou valor fora do intervalo inteiro seguro: ${totalMicrosUsd}`);
  }

  const statusRows = db
    .prepare(
      `
    SELECT status, COUNT(*) AS cnt
    FROM agentrouter_budget_ledger
    WHERE budget_window_start_ms = @windowStartMs AND budget_window_end_ms = @windowEndMs
    GROUP BY status
  `
    )
    .all({ windowStartMs, windowEndMs });
  const byStatus = {};
  for (const r of statusRows) byStatus[r.status] = r.cnt;

  return { totalMicrosUsd, rowCount: totalRow.row_count, byStatus };
}

module.exports = {
  reserveBudget,
  resolvePolicyIdempotentReservation,
  EFFECTIVE_MICROS_USD_CASE_SQL,
  markSendIntent,
  confirmBudget,
  releaseBudget,
  markWorstCaseCharged,
  sweepExpiredReservations,
  reconcileDown,
  getLedgerEntry,
  getLedgerEvents,
  getBudgetStateForWindow,
  MAX_SAFE_MICROS_USD,
  LedgerError,
  InvalidFieldError,
  NegativeAmountError,
  AmountExceedsCeilingError,
  InvalidWindowError,
  IdempotencyConflictError,
  ReservationNotFoundError,
  InvalidTransitionError,
  CannotReleaseAfterSendIntentError,
  ReconcileMustNotExceedOriginalError,
  InvalidEvidenceTypeError,
  UnsafeSumError,
};
