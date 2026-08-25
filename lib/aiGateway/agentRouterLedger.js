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
class AlreadyClaimedError extends LedgerError {
  constructor(key) {
    super("ALREADY_CLAIMED", `idempotency_key "${key}" ja teve a intencao de envio reivindicada -- nao pode ser reivindicada de novo`);
    this.idempotencyKey = key;
  }
}
class CorruptSendIntentStateError extends LedgerError {
  constructor(key) {
    super(
      "CORRUPT_SEND_INTENT_STATE",
      `idempotency_key "${key}" tem send_intent_at/send_intent_at_ms/request_id PARCIALMENTE preenchidos -- estado inconsistente, tratado como corrupcao (os tres campos devem estar todos NULL ou todos preenchidos)`
    );
    this.idempotencyKey = key;
  }
}
class ClaimAfterExpiryError extends LedgerError {
  constructor(key) {
    super("CLAIM_AFTER_EXPIRY", `idempotency_key "${key}" ja passou de expires_at_ms -- claimForSending recusado, deixado para sweepExpiredReservations`);
    this.idempotencyKey = key;
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

// Payload canonico REDUZIDO, sem janela E sem expiresAtMs -- usado SOMENTE
// por resolvePolicyIdempotentReservation() (helper especifico do modulo de
// politica, Commit 3). reserveBudget() e seu canonicalPayload() completo
// (com janela E expiresAtMs) permanecem 100% inalterados -- este e um
// payload SEPARADO, nao uma variante do outro.
//
// expiresAtMs foi REMOVIDO daqui nesta correcao (Fase 10 / Commit 4b,
// correcao pos-implementacao): tanto a janela quanto expiresAtMs sao
// metadados ATRIBUIDOS PELO SERVIDOR/POLITICA a cada reserva NOVA -- nunca
// fazem parte da intencao logica do chamador -- entao nenhum dos dois pode,
// por si so, bloquear o reconhecimento de um retry. O bug corrigido: o
// cliente orcamentado (Commit 4b) calcula expiresAtMs = nowMs + timeout +
// grace + margem A CADA tentativa; uma retry genuina da MESMA avaliacao
// logica, num instante de relogio diferente do da criacao original, sempre
// produziria um expiresAtMs diferente -- o que, com expiresAtMs ainda no
// payload canonico, gerava IdempotencyConflictError em vez de reconhecer o
// retry, impedindo o wrapper de sequer inspecionar o estado real da linha
// (reserved/expired_worst_case/released/etc).
function canonicalPayloadWithoutWindow({ correlationId, model, taskClass, estimatedMicrosUsd, priceSource, priceSourceStatus, pricingTableVersion }) {
  return JSON.stringify({
    correlationId,
    model,
    taskClass,
    estimatedMicrosUsd,
    priceSource: priceSource ?? null,
    priceSourceStatus,
    pricingTableVersion,
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
 * usando seu proprio canonicalPayload() completo (com janela E expiresAtMs),
 * contrato inalterado desde o Commit 2, incluindo o teste que confirma
 * conflito quando a janela OU expiresAtMs divergem numa chamada DIRETA a
 * reserveBudget().
 *
 * Aqui a comparacao usa canonicalPayloadWithoutWindow() -- SEM janela, SEM
 * reservedMicrosUsd E SEM expiresAtMs (correcao Fase 10 / Commit 4b), porque
 * os TRES sao atribuidos pelo servidor/politica no momento da CRIACAO
 * (janela pela virada do dia civil, valor reservado pela configuracao de
 * minimo vigente, expiresAtMs = nowMs + timeout + grace + margem do cliente
 * orcamentado) e nenhum deles faz parte da intencao logica do chamador.
 *
 * expiresAtMs em particular: e' definido SOMENTE na criacao da reserva. Um
 * retry NUNCA recalcula nem substitui o vencimento de uma reserva
 * existente -- este helper sempre devolve o expiresAtMs ORIGINALMENTE
 * persistido, mesmo que o chamador atual (com o relogio numa hora
 * diferente) tivesse calculado um valor diferente. Isso e' proposital: se
 * um retry pudesse "esticar" o vencimento a cada nova tentativa, uma
 * sequencia de retries perderia a garantia de expiracao segura que
 * sweepExpiredReservations() depende para recovery. Somente uma
 * assessmentKey (idempotencyKey) NOVA cria uma expiracao nova.
 *
 * - idempotencyKey nao existe -> null (chamador calcula janela/valor/
 *   expiresAtMs e cria via reserveBudget())
 * - idempotencyKey existe e os campos abaixo (exceto janela,
 *   reservedMicrosUsd e expiresAtMs) batem -> devolve a linha original,
 *   com sua janela, valor reservado E expiresAtMs ja persistidos --
 *   NUNCA atualiza a linha, NUNCA cria evento
 * - qualquer um dos campos abaixo diverge -> IdempotencyConflictError
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
  // expiresAtMs NAO e mais lido/validado aqui -- nao participa da
  // comparacao canonica (ver documentacao acima). O chamador pode
  // continuar passando opts.expiresAtMs (ex.: o wrapper orcamentado sempre
  // calcula um valor fresco a cada tentativa) -- e' simplesmente ignorado
  // por este helper.

  const canonical = canonicalPayloadWithoutWindow({ correlationId, model, taskClass, estimatedMicrosUsd, priceSource, priceSourceStatus, pricingTableVersion });

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
  });

  if (existingCanonical !== canonical) throw new IdempotencyConflictError(idempotencyKey);
  return rowToPublicShape(existing); // linha original intocada -- inclui o expires_at_ms ORIGINAL, nunca recalculado
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

/**
 * Operacao atomica de CLAIM -- diferente de markSendIntent() (que fica
 * 100% inalterado, contrato preservado). claimForSending() so reivindica
 * quando os TRES campos de intencao estao TODOS NULL
 * (send_intent_at/send_intent_at_ms/request_id) -- exclusividade real:
 * uma segunda chamada concorrente (mesmo processo ou outro) NUNCA tem
 * sucesso simultaneamente, porque a UPDATE exige os tres NULL na propria
 * WHERE. requestId e OBRIGATORIO aqui (identidade da tentativa fisica que
 * reivindicou), diferente do requestId opcional de markSendIntent().
 *
 * Preenchimento PARCIAL dos tres campos (ex.: send_intent_at preenchido
 * mas request_id NULL) nunca deveria acontecer via a API publica deste
 * modulo -- se acontecer, e' tratado como corrupcao/inconsistencia FATAL
 * (CorruptSendIntentStateError), nunca silenciosamente "reivindicado" ou
 * "livre para reivindicar".
 *
 * Tambem recusa o claim se a reserva ja passou de expires_at_ms (>=
 * nowMs) -- nesse caso a decisao correta e deixar para
 * sweepExpiredReservations() resolver, nunca reivindicar uma janela ja
 * vencida.
 *
 * Na MESMA transacao: localiza a reserva, valida elegibilidade, preenche
 * send_intent_at/send_intent_at_ms/request_id, insere exatamente 1 evento
 * SEND_INTENT_RECORDED, devolve a linha atualizada. Se o evento nao puder
 * ser inserido, toda a transacao reverte (mesmo mecanismo de rollback
 * automatico do better-sqlite3 usado em todas as demais funcoes deste
 * modulo). SQLITE_BUSY NAO e capturado aqui -- propaga cru, mesmo padrao
 * de reserveBudget/markSendIntent/etc.; quem classifica isso e o chamador.
 */
function claimForSending(db, opts) {
  const idempotencyKey = assertRestrictedString(opts.idempotencyKey, "idempotencyKey", TOKEN_ID_PATTERN);
  const requestId = assertRestrictedString(opts.requestId, "requestId", TOKEN_ID_PATTERN); // OBRIGATORIO, diferente de markSendIntent
  const nowMs = assertMs(opts.nowMs, "nowMs");

  return db
    .transaction(() => {
      const row = getRowByKey(db, idempotencyKey);
      if (!row) throw new ReservationNotFoundError(idempotencyKey);
      if (row.status !== "reserved") throw new InvalidTransitionError(idempotencyKey, "reserved", "send_intent_recorded");

      const intentFieldsFilled = [row.send_intent_at !== null, row.send_intent_at_ms !== null, row.request_id !== null];
      const filledCount = intentFieldsFilled.filter(Boolean).length;
      if (filledCount === 3) throw new AlreadyClaimedError(idempotencyKey);
      if (filledCount > 0) throw new CorruptSendIntentStateError(idempotencyKey); // 1 ou 2 preenchidos -- inconsistente
      // filledCount === 0 -- elegivel para reivindicar, segue validacao

      if (row.expires_at_ms !== null && nowMs >= row.expires_at_ms) {
        throw new ClaimAfterExpiryError(idempotencyKey);
      }
      if (nowMs < row.created_at_ms) throw new InvalidFieldError("nowMs", "anterior a created_at_ms");

      const iso = msToIso(nowMs);
      const info = db
        .prepare(
          `
        UPDATE agentrouter_budget_ledger
        SET send_intent_at = @iso, send_intent_at_ms = @nowMs, request_id = @requestId
        WHERE idempotency_key = @idempotencyKey
          AND status = 'reserved'
          AND send_intent_at IS NULL
          AND send_intent_at_ms IS NULL
          AND request_id IS NULL
      `
        )
        .run({ iso, nowMs, requestId, idempotencyKey });
      // Defensivo -- dado BEGIN IMMEDIATE (prova empirica dos Commits 2/3),
      // um concorrente real ja teria sido pego pela checagem de
      // filledCount acima (sua propria SELECT, apos aguardar o lock, ja
      // veria os campos preenchidos). Mantido por defesa em profundidade,
      // mesmo padrao redundante das demais funcoes deste modulo.
      if (info.changes !== 1) throw new AlreadyClaimedError(idempotencyKey);

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
  claimForSending,
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
  AlreadyClaimedError,
  CorruptSendIntentStateError,
  ClaimAfterExpiryError,
};
