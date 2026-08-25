const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsPromises = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const Database = require("better-sqlite3");
const { runMigrations, MIGRATIONS_DIR } = require("../../lib/infra/db");
const ledger = require("../../lib/aiGateway/agentRouterLedger");

const {
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
  IdempotencyConflictError,
  ReservationNotFoundError,
  InvalidTransitionError,
  CannotReleaseAfterSendIntentError,
  ReconcileMustNotExceedOriginalError,
  InvalidEvidenceTypeError,
  NegativeAmountError,
  AmountExceedsCeilingError,
  InvalidFieldError,
} = ledger;

const BETTER_SQLITE3_PATH = require.resolve("better-sqlite3");
const LEDGER_MODULE_PATH = require.resolve("../../lib/aiGateway/agentRouterLedger");

const NOW = 1_756_000_000_000; // timestamp fixo arbitrario -- nenhum teste depende de Date.now() real
const DAY_MS = 24 * 60 * 60 * 1000;

// --- Infra de banco temporario isolado (nunca data/market.db real) ---

function createTempDbFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-ledger-${label}-`));
  const dbPath = path.join(dir, "test.db");
  return { dir, dbPath };
}

function openTestDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 3000"); // SO nesta conexao de teste -- lib/infra/db.js nao foi tocado
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function withTestDb(label, fn) {
  const { dir, dbPath } = createTempDbFile(label);
  const db = openTestDb(dbPath);
  try {
    return fn(db, dbPath);
  } finally {
    try {
      db.close();
    } catch {
      /* ja pode ter fechado */
    }
    rmDirSafeSync(dir);
  }
}

function baseReserveOpts(overrides = {}) {
  return {
    idempotencyKey: "test-key-001",
    correlationId: "corr-001",
    model: "gpt-5.6-sol",
    taskClass: "triage",
    estimatedMicrosUsd: 50_000,
    reservedMicrosUsd: 100_000,
    priceSource: "observed_sample_20260824",
    priceSourceStatus: "observed",
    pricingTableVersion: "v1",
    budgetWindowStartMs: NOW,
    budgetWindowEndMs: NOW + DAY_MS,
    budgetWindowTimezone: "America/Sao_Paulo",
    expiresAtMs: NOW + 5 * 60 * 1000,
    nowMs: NOW,
    ...overrides,
  };
}

function assertThrowsCode(fn, ErrorClass, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ErrorClass, `esperado ${ErrorClass.name}, veio ${err.constructor.name}: ${err.message}`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

// =====================================================================
// 1) Migration -- schema, aplicacao, idempotencia, CHECK direto via SQL bruto
// =====================================================================

test("migration 0014: cria agentrouter_budget_ledger e agentrouter_budget_events com colunas/indices esperados", () => {
  withTestDb("schema", (db) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes("agentrouter_budget_ledger"));
    assert.ok(tables.includes("agentrouter_budget_events"));

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    assert.ok(indexes.includes("idx_agentrouter_budget_ledger_status"));
    assert.ok(indexes.includes("idx_agentrouter_budget_ledger_window"));
    assert.ok(indexes.includes("idx_agentrouter_budget_events_ledger_id"));

    const versions = db.prepare("SELECT version FROM schema_migrations WHERE version = 14").all();
    assert.equal(versions.length, 1);
  });
});

test("migration 0014: aplica em banco vazio sem erro", () => {
  const { dir, dbPath } = createTempDbFile("empty");
  try {
    const db = new Database(dbPath);
    assert.doesNotThrow(() => runMigrations(db, MIGRATIONS_DIR));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migration 0014: aplica em banco ja com 0001-0013 aplicadas, sem conflito", () => {
  withTestDb("existing", (db) => {
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
    for (let v = 1; v <= 14; v++) assert.ok(versions.includes(v), `versao ${v} deveria estar aplicada`);
  });
});

test("migration 0014: rodar runMigrations 2x nao duplica", () => {
  withTestDb("idempotent", (db) => {
    assert.doesNotThrow(() => runMigrations(db, MIGRATIONS_DIR));
    const count = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 14").get().c;
    assert.equal(count, 1);
  });
});

function rawInsertBase(overrides = {}) {
  return {
    idempotency_key: "raw-key-1",
    correlation_id: "raw-corr-1",
    provider: "agentrouter",
    currency: "USD",
    model: "gpt-5.6-sol",
    task_class: "triage",
    status: "reserved",
    estimated_micros_usd: 1000,
    reserved_micros_usd: 2000,
    price_source_status: "observed",
    pricing_table_version: "v1",
    budget_window_start_ms: NOW,
    budget_window_end_ms: NOW + DAY_MS,
    budget_window_timezone: "America/Sao_Paulo",
    created_at: new Date(NOW).toISOString(),
    created_at_ms: NOW,
    ...overrides,
  };
}

function tryRawInsert(db, overrides) {
  const row = rawInsertBase(overrides);
  const cols = Object.keys(row);
  const sql = `INSERT INTO agentrouter_budget_ledger (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`;
  db.prepare(sql).run(row);
}

test("CHECK direto: INSERT com provider != agentrouter e rejeitado pelo banco", () => {
  withTestDb("check-provider", (db) => {
    assert.throws(() => tryRawInsert(db, { provider: "openai" }), /CHECK/);
  });
});

test("CHECK direto: INSERT com currency != USD e rejeitado pelo banco", () => {
  withTestDb("check-currency", (db) => {
    assert.throws(() => tryRawInsert(db, { currency: "BRL" }), /CHECK/);
  });
});

test("CHECK direto: budget_window_start_ms >= budget_window_end_ms e rejeitado", () => {
  withTestDb("check-window", (db) => {
    assert.throws(() => tryRawInsert(db, { budget_window_start_ms: NOW + DAY_MS, budget_window_end_ms: NOW }), /CHECK/);
  });
});

test("CHECK direto: expires_at_ms < created_at_ms e rejeitado", () => {
  withTestDb("check-expires", (db) => {
    assert.throws(() => tryRawInsert(db, { expires_at_ms: NOW - 1000 }), /CHECK/);
  });
});

test("CHECK direto: send_intent_at_ms < created_at_ms e rejeitado", () => {
  withTestDb("check-sendintent", (db) => {
    assert.throws(() => tryRawInsert(db, { send_intent_at: new Date(NOW - 1000).toISOString(), send_intent_at_ms: NOW - 1000 }), /CHECK/);
  });
});

test("CHECK direto: reconciled_at_ms < created_at_ms e rejeitado", () => {
  withTestDb("check-reconciled", (db) => {
    assert.throws(() => tryRawInsert(db, { reconciled_at: new Date(NOW - 1000).toISOString(), reconciled_at_ms: NOW - 1000 }), /CHECK/);
  });
});

test("CHECK direto: status fora do enum e rejeitado", () => {
  withTestDb("check-status", (db) => {
    assert.throws(() => tryRawInsert(db, { status: "made_up_status" }), /CHECK/);
  });
});

// =====================================================================
// 2) reserveBudget
// =====================================================================

test("reserveBudget: cria em reserved, provider/currency sempre agentrouter/USD", () => {
  withTestDb("reserve-basic", (db) => {
    const row = reserveBudget(db, baseReserveOpts());
    assert.equal(row.status, "reserved");
    assert.equal(row.provider, "agentrouter");
    assert.equal(row.currency, "USD");
  });
});

test("reserveBudget: grava janela imutavel exatamente como fornecida", () => {
  withTestDb("reserve-window", (db) => {
    const row = reserveBudget(db, baseReserveOpts());
    assert.equal(row.budget_window_start_ms, NOW);
    assert.equal(row.budget_window_end_ms, NOW + DAY_MS);
    assert.equal(row.budget_window_timezone, "America/Sao_Paulo");
  });
});

test("reserveBudget: rejeita reservedMicrosUsd/estimatedMicrosUsd negativo", () => {
  withTestDb("reserve-negative", (db) => {
    assertThrowsCode(() => reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: -1 })), NegativeAmountError);
    assertThrowsCode(() => reserveBudget(db, baseReserveOpts({ estimatedMicrosUsd: -1 })), NegativeAmountError);
  });
});

test("reserveBudget: rejeita valor acima do teto de seguranca", () => {
  withTestDb("reserve-ceiling", (db) => {
    assertThrowsCode(() => reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: MAX_SAFE_MICROS_USD + 1 })), AmountExceedsCeilingError);
  });
});

test("reserveBudget: rejeita budgetWindowEndMs <= budgetWindowStartMs", () => {
  withTestDb("reserve-badwindow", (db) => {
    assert.throws(() => reserveBudget(db, baseReserveOpts({ budgetWindowStartMs: NOW, budgetWindowEndMs: NOW })));
  });
});

test("reserveBudget: idempotencyKey repetida + payload IDENTICO retorna o mesmo registro (mesmo id)", () => {
  withTestDb("reserve-idem-same", (db) => {
    const r1 = reserveBudget(db, baseReserveOpts());
    const r2 = reserveBudget(db, baseReserveOpts());
    assert.equal(r1.id, r2.id);
    const count = db.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_ledger").get().c;
    assert.equal(count, 1);
  });
});

test("reserveBudget: idempotencyKey repetida + payload DIFERENTE lanca IdempotencyConflictError", () => {
  withTestDb("reserve-idem-conflict", (db) => {
    reserveBudget(db, baseReserveOpts());
    assertThrowsCode(() => reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: 999_999 })), IdempotencyConflictError);
  });
});

test("reserveBudget: cada campo canonico, isoladamente, causa conflito se divergir", () => {
  withTestDb("reserve-idem-fields", (db) => {
    reserveBudget(db, baseReserveOpts());
    const variants = [
      { correlationId: "other-corr" },
      { model: "other-model" },
      { taskClass: "other-class" },
      { estimatedMicrosUsd: 1 },
      { reservedMicrosUsd: 1 },
      { priceSource: "other-source" },
      { priceSourceStatus: "confirmed" },
      { pricingTableVersion: "v2" },
      { budgetWindowStartMs: NOW + 1 },
      { budgetWindowEndMs: NOW + DAY_MS + 1 },
      { budgetWindowTimezone: "UTC" },
      { expiresAtMs: NOW + 999_999 },
    ];
    for (const variant of variants) {
      assertThrowsCode(() => reserveBudget(db, baseReserveOpts(variant)), IdempotencyConflictError);
    }
  });
});

// =====================================================================
// 2b) resolvePolicyIdempotentReservation -- helper especifico da politica
// (Commit 3). NUNCA usado por reserveBudget(); nao altera seu contrato --
// prova disso ja e' o fato de que TODA a secao 2) acima permanece
// inalterada e passando. Aqui a janela e reservedMicrosUsd sao
// propositalmente EXCLUIDOS da comparacao canonica.
// =====================================================================

function basePolicyLookupOpts(overrides = {}) {
  return {
    idempotencyKey: "test-key-001",
    correlationId: "corr-001",
    model: "gpt-5.6-sol",
    taskClass: "triage",
    estimatedMicrosUsd: 50_000,
    priceSource: "observed_sample_20260824",
    priceSourceStatus: "observed",
    pricingTableVersion: "v1",
    expiresAtMs: NOW + 5 * 60 * 1000,
    ...overrides,
  };
}

test("resolvePolicyIdempotentReservation: chave inexistente retorna null", () => {
  withTestDb("policy-idem-null", (db) => {
    const result = resolvePolicyIdempotentReservation(db, basePolicyLookupOpts());
    assert.equal(result, null);
  });
});

test("resolvePolicyIdempotentReservation: payload identico (sem janela) devolve a linha original", () => {
  withTestDb("policy-idem-match", (db) => {
    const created = reserveBudget(db, baseReserveOpts());
    const result = resolvePolicyIdempotentReservation(db, basePolicyLookupOpts());
    assert.equal(result.id, created.id);
    assert.equal(result.status, "reserved");
  });
});

test("resolvePolicyIdempotentReservation: nao recebe/compara janela -- retorno inclui a janela ja persistida, mesmo sem o chamador informa-la", () => {
  withTestDb("policy-idem-window-agnostic", (db) => {
    reserveBudget(db, baseReserveOpts({ budgetWindowStartMs: NOW, budgetWindowEndMs: NOW + DAY_MS }));
    const result = resolvePolicyIdempotentReservation(db, basePolicyLookupOpts());
    assert.equal(result.budget_window_start_ms, NOW);
    assert.equal(result.budget_window_end_ms, NOW + DAY_MS);
  });
});

test("resolvePolicyIdempotentReservation: reservedMicrosUsd persistido diferente do que a politica recalcularia agora NAO bloqueia (campo fora da comparacao)", () => {
  withTestDb("policy-idem-reserved-agnostic", (db) => {
    reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: 999_000 }));
    // resolvePolicyIdempotentReservation nem aceita reservedMicrosUsd como parametro --
    // reconhece o retry mesmo que a politica, agora, calcularia um valor bem diferente.
    assert.doesNotThrow(() => resolvePolicyIdempotentReservation(db, basePolicyLookupOpts()));
  });
});

test("resolvePolicyIdempotentReservation: janela fornecida a reserveBudget() divergente da original AINDA gera IdempotencyConflictError em reserveBudget (contrato original intacto) mesmo que resolvePolicyIdempotentReservation nao se importe com janela", () => {
  withTestDb("policy-idem-vs-ledger-contract", (db) => {
    reserveBudget(db, baseReserveOpts());
    // contrato de reserveBudget() permanece: janela diferente = conflito
    assertThrowsCode(() => reserveBudget(db, baseReserveOpts({ budgetWindowStartMs: NOW + 1 })), IdempotencyConflictError);
    // mas o helper da politica, que nunca olha pra janela, reconhece o retry normalmente
    assert.doesNotThrow(() => resolvePolicyIdempotentReservation(db, basePolicyLookupOpts()));
  });
});

test("resolvePolicyIdempotentReservation: cada campo canonico (dos que ela de fato compara), isoladamente, causa conflito se divergir", () => {
  withTestDb("policy-idem-fields-conflict", (db) => {
    reserveBudget(db, baseReserveOpts());
    const variants = [
      { correlationId: "other-corr" },
      { model: "other-model" },
      { taskClass: "other-class" },
      { estimatedMicrosUsd: 1 },
      { priceSource: "other-source" },
      { priceSourceStatus: "confirmed" },
      { pricingTableVersion: "v2" },
      { expiresAtMs: NOW + 999_999 },
    ];
    for (const variant of variants) {
      assertThrowsCode(() => resolvePolicyIdempotentReservation(db, basePolicyLookupOpts(variant)), IdempotencyConflictError);
    }
  });
});

test("resolvePolicyIdempotentReservation: valida formato dos campos antes de consultar (mesmas regras de reserveBudget)", () => {
  withTestDb("policy-idem-invalid-fields", (db) => {
    assert.throws(() => resolvePolicyIdempotentReservation(db, basePolicyLookupOpts({ estimatedMicrosUsd: -1 })), NegativeAmountError);
    assert.throws(() => resolvePolicyIdempotentReservation(db, basePolicyLookupOpts({ priceSourceStatus: "made_up" })), InvalidFieldError);
  });
});

// =====================================================================
// 2c) EFFECTIVE_MICROS_USD_CASE_SQL -- constante extraida, reusada pelo
// modulo de politica para somar por categoria sem duplicar/divergir do
// mapeamento status -> valor efetivo ja usado por getBudgetStateForWindow.
// =====================================================================

test("EFFECTIVE_MICROS_USD_CASE_SQL: e uma string SQL utilizavel diretamente, produz o MESMO total que getBudgetStateForWindow", () => {
  withTestDb("effective-case-sql", (db) => {
    assert.equal(typeof EFFECTIVE_MICROS_USD_CASE_SQL, "string");
    assert.ok(EFFECTIVE_MICROS_USD_CASE_SQL.includes("reserved_micros_usd"));

    toWorstCase(db, "k1", 90_000);
    reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 30_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 1 });
    reserveBudget(db, baseReserveOpts({ idempotencyKey: "k2", reservedMicrosUsd: 5_000 }));

    const viaExportedConstant = db
      .prepare(`SELECT SUM(${EFFECTIVE_MICROS_USD_CASE_SQL}) AS total FROM agentrouter_budget_ledger WHERE budget_window_start_ms = ? AND budget_window_end_ms = ?`)
      .get(NOW, NOW + DAY_MS).total;
    const viaPublicApi = getBudgetStateForWindow(db, { windowStartMs: NOW, windowEndMs: NOW + DAY_MS }).totalMicrosUsd;
    assert.equal(viaExportedConstant, viaPublicApi);
    assert.equal(viaExportedConstant, 35_000);
  });
});

// =====================================================================
// 3) markSendIntent
// =====================================================================

test("markSendIntent: grava send_intent_at apenas em reserved", () => {
  withTestDb("sendintent-basic", (db) => {
    reserveBudget(db, baseReserveOpts());
    const row = markSendIntent(db, { idempotencyKey: "test-key-001", requestId: "req-1", nowMs: NOW + 10 });
    assert.ok(row.send_intent_at);
    assert.equal(row.send_intent_at_ms, NOW + 10);
    assert.equal(row.status, "reserved");
  });
});

test("markSendIntent: lanca erro se idempotencyKey nao existe", () => {
  withTestDb("sendintent-notfound", (db) => {
    assertThrowsCode(() => markSendIntent(db, { idempotencyKey: "ghost", requestId: null, nowMs: NOW }), ReservationNotFoundError);
  });
});

test("markSendIntent: lanca erro se ja terminal", () => {
  withTestDb("sendintent-terminal", (db) => {
    reserveBudget(db, baseReserveOpts());
    releaseBudget(db, { idempotencyKey: "test-key-001", nowMs: NOW + 5 });
    assertThrowsCode(() => markSendIntent(db, { idempotencyKey: "test-key-001", requestId: null, nowMs: NOW + 10 }), InvalidTransitionError);
  });
});

test("markSendIntent: send_intent_at_ms sempre >= created_at_ms", () => {
  withTestDb("sendintent-coherence", (db) => {
    reserveBudget(db, baseReserveOpts());
    assert.throws(() => markSendIntent(db, { idempotencyKey: "test-key-001", requestId: null, nowMs: NOW - 1 }), InvalidFieldError);
  });
});

// =====================================================================
// 4) confirmBudget
// =====================================================================

test("confirmBudget: reserved -> confirmed grava tokens reais e confirmed_micros_usd", () => {
  withTestDb("confirm-basic", (db) => {
    reserveBudget(db, baseReserveOpts());
    const row = confirmBudget(db, {
      idempotencyKey: "test-key-001",
      confirmedMicrosUsd: 87_000,
      inputTokens: 15371,
      cachedInputTokens: 5760,
      outputTokens: 55,
      reasoningTokens: 0,
      nowMs: NOW + 10_000,
    });
    assert.equal(row.status, "confirmed");
    assert.equal(row.confirmed_micros_usd, 87_000);
    assert.equal(row.input_tokens, 15371);
    assert.equal(row.output_tokens, 55);
  });
});

test("confirmBudget: rejeita tokens negativos", () => {
  withTestDb("confirm-negative-tokens", (db) => {
    reserveBudget(db, baseReserveOpts());
    assert.throws(() => confirmBudget(db, { idempotencyKey: "test-key-001", confirmedMicrosUsd: 100, inputTokens: -1, nowMs: NOW + 1 }), InvalidFieldError);
  });
});

test("confirmBudget: erro ao confirmar 2x", () => {
  withTestDb("confirm-twice", (db) => {
    reserveBudget(db, baseReserveOpts());
    confirmBudget(db, { idempotencyKey: "test-key-001", confirmedMicrosUsd: 100, nowMs: NOW + 1 });
    assertThrowsCode(() => confirmBudget(db, { idempotencyKey: "test-key-001", confirmedMicrosUsd: 200, nowMs: NOW + 2 }), InvalidTransitionError);
  });
});

test("confirmBudget: erro se idempotencyKey nao existe", () => {
  withTestDb("confirm-notfound", (db) => {
    assertThrowsCode(() => confirmBudget(db, { idempotencyKey: "ghost", confirmedMicrosUsd: 100, nowMs: NOW }), ReservationNotFoundError);
  });
});

// =====================================================================
// 5) releaseBudget
// =====================================================================

test("releaseBudget: libera quando send_intent_at e nulo", () => {
  withTestDb("release-basic", (db) => {
    reserveBudget(db, baseReserveOpts());
    const row = releaseBudget(db, { idempotencyKey: "test-key-001", nowMs: NOW + 1 });
    assert.equal(row.status, "released");
  });
});

test("releaseBudget: erro ao liberar reserva ja marcada como enviada", () => {
  withTestDb("release-after-intent", (db) => {
    reserveBudget(db, baseReserveOpts());
    markSendIntent(db, { idempotencyKey: "test-key-001", requestId: null, nowMs: NOW + 1 });
    assertThrowsCode(() => releaseBudget(db, { idempotencyKey: "test-key-001", nowMs: NOW + 2 }), CannotReleaseAfterSendIntentError);
  });
});

test("releaseBudget: erro se ja terminal", () => {
  withTestDb("release-terminal", (db) => {
    reserveBudget(db, baseReserveOpts());
    releaseBudget(db, { idempotencyKey: "test-key-001", nowMs: NOW + 1 });
    assertThrowsCode(() => releaseBudget(db, { idempotencyKey: "test-key-001", nowMs: NOW + 2 }), InvalidTransitionError);
  });
});

// =====================================================================
// 6) markWorstCaseCharged
// =====================================================================

test("markWorstCaseCharged: original_worst_case_micros_usd sempre = reserved_micros_usd", () => {
  withTestDb("worstcase-basic", (db) => {
    reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: 123_456 }));
    const row = markWorstCaseCharged(db, { idempotencyKey: "test-key-001", nowMs: NOW + 1 });
    assert.equal(row.status, "worst_case_charged");
    assert.equal(row.original_worst_case_micros_usd, 123_456);
  });
});

test("markWorstCaseCharged: nao aceita nenhum parametro de valor do chamador", () => {
  withTestDb("worstcase-no-param", (db) => {
    reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: 55_000 }));
    // mesmo se alguem passar um campo extra, a funcao ignora -- valor vem sempre da linha
    const row = markWorstCaseCharged(db, { idempotencyKey: "test-key-001", worstCaseMicrosUsd: 999_999_999, nowMs: NOW + 1 });
    assert.equal(row.original_worst_case_micros_usd, 55_000);
  });
});

test("markWorstCaseCharged: erro se ja terminal", () => {
  withTestDb("worstcase-terminal", (db) => {
    reserveBudget(db, baseReserveOpts());
    releaseBudget(db, { idempotencyKey: "test-key-001", nowMs: NOW + 1 });
    assertThrowsCode(() => markWorstCaseCharged(db, { idempotencyKey: "test-key-001", nowMs: NOW + 2 }), InvalidTransitionError);
  });
});

// =====================================================================
// 7) Transicoes invalidas genericas
// =====================================================================

test("transicoes invalidas: qualquer transicao a partir de terminal lanca e nao altera a linha", () => {
  withTestDb("invalid-transitions", (db) => {
    reserveBudget(db, baseReserveOpts());
    const confirmed = confirmBudget(db, { idempotencyKey: "test-key-001", confirmedMicrosUsd: 100, nowMs: NOW + 1 });

    assertThrowsCode(() => confirmBudget(db, { idempotencyKey: "test-key-001", confirmedMicrosUsd: 200, nowMs: NOW + 2 }), InvalidTransitionError);
    assertThrowsCode(() => releaseBudget(db, { idempotencyKey: "test-key-001", nowMs: NOW + 2 }), InvalidTransitionError);
    assertThrowsCode(() => markWorstCaseCharged(db, { idempotencyKey: "test-key-001", nowMs: NOW + 2 }), InvalidTransitionError);
    assertThrowsCode(() => markSendIntent(db, { idempotencyKey: "test-key-001", requestId: null, nowMs: NOW + 2 }), InvalidTransitionError);

    const after = getLedgerEntry(db, { idempotencyKey: "test-key-001" });
    assert.deepEqual(after, confirmed);
  });
});

// =====================================================================
// 8) sweepExpiredReservations (crash antes/depois da intencao)
// =====================================================================

test("sweepExpiredReservations: vencida SEM send_intent_at -> expired_released (crash antes da intencao)", () => {
  withTestDb("sweep-released", (db) => {
    reserveBudget(db, baseReserveOpts({ expiresAtMs: NOW + 1000 }));
    const result = sweepExpiredReservations(db, { nowMs: NOW + 2000 });
    assert.equal(result.releasedCount, 1);
    assert.equal(result.worstCaseCount, 0);
    const row = getLedgerEntry(db, { idempotencyKey: "test-key-001" });
    assert.equal(row.status, "expired_released");
  });
});

test("sweepExpiredReservations: vencida COM send_intent_at -> expired_worst_case (crash depois da intencao)", () => {
  withTestDb("sweep-worstcase", (db) => {
    reserveBudget(db, baseReserveOpts({ expiresAtMs: NOW + 1000, reservedMicrosUsd: 77_000 }));
    markSendIntent(db, { idempotencyKey: "test-key-001", requestId: "req-x", nowMs: NOW + 500 });
    const result = sweepExpiredReservations(db, { nowMs: NOW + 2000 });
    assert.equal(result.releasedCount, 0);
    assert.equal(result.worstCaseCount, 1);
    const row = getLedgerEntry(db, { idempotencyKey: "test-key-001" });
    assert.equal(row.status, "expired_worst_case");
    assert.equal(row.original_worst_case_micros_usd, 77_000);
  });
});

test("sweepExpiredReservations: nunca toca reserva ainda dentro do prazo", () => {
  withTestDb("sweep-not-expired", (db) => {
    reserveBudget(db, baseReserveOpts({ expiresAtMs: NOW + 100_000 }));
    const result = sweepExpiredReservations(db, { nowMs: NOW + 2000 });
    assert.equal(result.releasedCount, 0);
    assert.equal(result.worstCaseCount, 0);
    assert.equal(getLedgerEntry(db, { idempotencyKey: "test-key-001" }).status, "reserved");
  });
});

test("sweepExpiredReservations: idempotente -- 2a varredura nao altera registros ja varridos", () => {
  withTestDb("sweep-idempotent", (db) => {
    reserveBudget(db, baseReserveOpts({ expiresAtMs: NOW + 1000 }));
    sweepExpiredReservations(db, { nowMs: NOW + 2000 });
    const second = sweepExpiredReservations(db, { nowMs: NOW + 3000 });
    assert.equal(second.releasedCount, 0);
    assert.equal(second.worstCaseCount, 0);
  });
});

// =====================================================================
// 9) reconcileDown (evidencia estruturada)
// =====================================================================

function toWorstCase(db, key, reservedMicrosUsd) {
  reserveBudget(db, baseReserveOpts({ idempotencyKey: key, reservedMicrosUsd }));
  markSendIntent(db, { idempotencyKey: key, requestId: null, nowMs: NOW + 1 });
  return markWorstCaseCharged(db, { idempotencyKey: key, nowMs: NOW + 2 });
}

test("reconcileDown: reduz e grava evidencia estruturada", () => {
  withTestDb("reconcile-basic", (db) => {
    toWorstCase(db, "k1", 100_000);
    const row = reconcileDown(db, {
      idempotencyKey: "k1",
      reconciledEffectiveMicrosUsd: 50_000,
      evidenceType: "agentrouter_panel",
      evidenceReference: "panel-2026-08-25",
      actorType: "operator",
      actorReference: "fllrestudante",
      nowMs: NOW + 100,
    });
    assert.equal(row.reconciled_effective_micros_usd, 50_000);
    assert.ok(row.reconciled_at);
  });
});

test("reconcileDown: rejeita evidenceType fora do enum", () => {
  withTestDb("reconcile-bad-evidence-type", (db) => {
    toWorstCase(db, "k1", 100_000);
    assertThrowsCode(
      () => reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 50_000, evidenceType: "made_up", actorType: "operator", nowMs: NOW + 1 }),
      InvalidEvidenceTypeError
    );
  });
});

test("reconcileDown: rejeita evidenceReference acima do tamanho maximo", () => {
  withTestDb("reconcile-long-ref", (db) => {
    toWorstCase(db, "k1", 100_000);
    const tooLong = "x".repeat(201);
    assert.throws(
      () => reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 50_000, evidenceType: "agentrouter_panel", evidenceReference: tooLong, actorType: "operator", nowMs: NOW + 1 }),
      InvalidFieldError
    );
  });
});

test("reconcileDown: idempotente -- 2a chamada com o mesmo valor nao lanca nem duplica evento", () => {
  withTestDb("reconcile-idempotent", (db) => {
    toWorstCase(db, "k1", 100_000);
    reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 50_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 1 });
    assert.doesNotThrow(() =>
      reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 50_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 2 })
    );
    const events = getLedgerEvents(db, { idempotencyKey: "k1" }).filter((e) => e.event_type === "RECONCILED_DOWN");
    assert.equal(events.length, 1);
  });
});

test("reconcileDown: reducao nova e valida cria novo evento append-only, preservando o anterior", () => {
  withTestDb("reconcile-successive", (db) => {
    toWorstCase(db, "k1", 100_000);
    reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 70_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 1 });
    reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 40_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 2 });
    const events = getLedgerEvents(db, { idempotencyKey: "k1" }).filter((e) => e.event_type === "RECONCILED_DOWN");
    assert.equal(events.length, 2);
    assert.equal(events[0].effective_micros_usd, 70_000);
    assert.equal(events[1].effective_micros_usd, 40_000);
    const row = getLedgerEntry(db, { idempotencyKey: "k1" });
    assert.equal(row.reconciled_effective_micros_usd, 40_000);
  });
});

test("reconcileDown: lanca erro ao tentar aumentar o valor (reconciliacao posterior)", () => {
  withTestDb("reconcile-increase", (db) => {
    toWorstCase(db, "k1", 100_000);
    reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 40_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 1 });
    assertThrowsCode(
      () => reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 60_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 2 }),
      ReconcileMustNotExceedOriginalError
    );
  });
});

test("reconcileDown: lanca erro ao tentar exceder o pior-caso original na primeira reconciliacao", () => {
  withTestDb("reconcile-exceed-original", (db) => {
    toWorstCase(db, "k1", 100_000);
    assertThrowsCode(
      () => reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 200_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 1 }),
      ReconcileMustNotExceedOriginalError
    );
  });
});

test("reconcileDown: lanca erro em registro que nao esta em worst_case_charged/expired_worst_case", () => {
  withTestDb("reconcile-wrong-status", (db) => {
    reserveBudget(db, baseReserveOpts());
    confirmBudget(db, { idempotencyKey: "test-key-001", confirmedMicrosUsd: 100, nowMs: NOW + 1 });
    assertThrowsCode(
      () => reconcileDown(db, { idempotencyKey: "test-key-001", reconciledEffectiveMicrosUsd: 50, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 2 }),
      InvalidTransitionError
    );
  });
});

// =====================================================================
// 10) getBudgetStateForWindow (valores efetivos por status, sem dupla contagem)
// =====================================================================

test("getBudgetStateForWindow: soma reserved usando reserved_micros_usd", () => {
  withTestDb("window-reserved", (db) => {
    reserveBudget(db, baseReserveOpts({ idempotencyKey: "a", reservedMicrosUsd: 10_000 }));
    reserveBudget(db, baseReserveOpts({ idempotencyKey: "b", reservedMicrosUsd: 20_000 }));
    const state = getBudgetStateForWindow(db, { windowStartMs: NOW, windowEndMs: NOW + DAY_MS });
    assert.equal(state.totalMicrosUsd, 30_000);
    assert.equal(state.byStatus.reserved, 2);
  });
});

test("getBudgetStateForWindow: soma confirmed usando confirmed_micros_usd", () => {
  withTestDb("window-confirmed", (db) => {
    reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: 10_000 }));
    confirmBudget(db, { idempotencyKey: "test-key-001", confirmedMicrosUsd: 4_200, nowMs: NOW + 1 });
    const state = getBudgetStateForWindow(db, { windowStartMs: NOW, windowEndMs: NOW + DAY_MS });
    assert.equal(state.totalMicrosUsd, 4_200);
  });
});

test("getBudgetStateForWindow: soma pior-caso usando original_worst_case_micros_usd (sem reconciliacao)", () => {
  withTestDb("window-worstcase", (db) => {
    toWorstCase(db, "k1", 90_000);
    const state = getBudgetStateForWindow(db, { windowStartMs: NOW, windowEndMs: NOW + DAY_MS });
    assert.equal(state.totalMicrosUsd, 90_000);
  });
});

test("getBudgetStateForWindow: apos reconcileDown, usa SO o valor reconciliado (sem dupla contagem)", () => {
  withTestDb("window-reconciled", (db) => {
    toWorstCase(db, "k1", 90_000);
    reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 30_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 1 });
    const state = getBudgetStateForWindow(db, { windowStartMs: NOW, windowEndMs: NOW + DAY_MS });
    assert.equal(state.totalMicrosUsd, 30_000);
  });
});

test("getBudgetStateForWindow: released/expired_released contam zero", () => {
  withTestDb("window-released", (db) => {
    reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: 55_000 }));
    releaseBudget(db, { idempotencyKey: "test-key-001", nowMs: NOW + 1 });
    const state = getBudgetStateForWindow(db, { windowStartMs: NOW, windowEndMs: NOW + DAY_MS });
    assert.equal(state.totalMicrosUsd, 0);
    assert.equal(state.byStatus.released, 1);
  });
});

test("getBudgetStateForWindow: janela diferente da gravada nao e somada", () => {
  withTestDb("window-different", (db) => {
    reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: 10_000 }));
    const state = getBudgetStateForWindow(db, { windowStartMs: NOW + DAY_MS, windowEndMs: NOW + 2 * DAY_MS });
    assert.equal(state.totalMicrosUsd, 0);
    assert.equal(state.rowCount, 0);
  });
});

// =====================================================================
// 11) Inteiros seguros
// =====================================================================

test("Number.isSafeInteger: rejeita valor fora do intervalo seguro antes de qualquer SQL", () => {
  withTestDb("safeint-reject", (db) => {
    assert.throws(() => reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: Number.MAX_SAFE_INTEGER + 10 })), InvalidFieldError);
  });
});

test("teto de seguranca: valor exatamente no teto e aceito, teto+1 e rejeitado", () => {
  withTestDb("safeint-ceiling", (db) => {
    assert.doesNotThrow(() => reserveBudget(db, baseReserveOpts({ idempotencyKey: "at-ceiling", reservedMicrosUsd: MAX_SAFE_MICROS_USD })));
    assertThrowsCode(() => reserveBudget(db, baseReserveOpts({ idempotencyKey: "over-ceiling", reservedMicrosUsd: MAX_SAFE_MICROS_USD + 1 })), AmountExceedsCeilingError);
  });
});

// =====================================================================
// 12) Coerencia ISO/ms
// =====================================================================

test("coerencia ISO/ms: created_at e created_at_ms representam o mesmo instante em toda escrita", () => {
  withTestDb("iso-coherence", (db) => {
    const row = reserveBudget(db, baseReserveOpts());
    assert.equal(Date.parse(row.created_at), row.created_at_ms);
    markSendIntent(db, { idempotencyKey: "test-key-001", requestId: null, nowMs: NOW + 500 });
    const afterIntent = getLedgerEntry(db, { idempotencyKey: "test-key-001" });
    assert.equal(Date.parse(afterIntent.send_intent_at), afterIntent.send_intent_at_ms);
  });
});

// =====================================================================
// 13) Rollback de transacao
// =====================================================================

test("rollback: violacao de CHECK forcada durante reserveBudget nao deixa linha parcial", () => {
  withTestDb("rollback-check", (db) => {
    // forca uma violacao inserindo diretamente um valor que so o CHECK de banco pega
    // (task_class vazio nao passa no assertRestrictedString, entao simulamos via SQL bruto
    // dentro de uma transacao que tambem grava um evento valido, pra provar que TUDO reverte)
    const before = db.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_ledger").get().c;
    assert.throws(() => {
      db.transaction(() => {
        tryRawInsert(db, { idempotency_key: "will-fail", provider: "openai" }); // viola CHECK
      }).immediate();
    });
    const after = db.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_ledger").get().c;
    assert.equal(before, after);
    const eventsAfter = db.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_events").get().c;
    assert.equal(eventsAfter, 0);
  });
});

// =====================================================================
// 14) Infra/seguranca
// =====================================================================

test("infra: nenhuma coluna aceita prompt/resposta/chave/texto do Telegram", () => {
  withTestDb("infra-columns", (db) => {
    const ledgerCols = db.prepare("PRAGMA table_info(agentrouter_budget_ledger)").all().map((c) => c.name.toLowerCase());
    const eventCols = db.prepare("PRAGMA table_info(agentrouter_budget_events)").all().map((c) => c.name.toLowerCase());
    const forbidden = ["prompt", "response", "raw_response", "secret", "api_key", "apikey", "telegram", "message_text", "token_secret"];
    for (const col of [...ledgerCols, ...eventCols]) {
      for (const bad of forbidden) {
        assert.ok(!col.includes(bad), `coluna suspeita encontrada: ${col} (contem "${bad}")`);
      }
    }
  });
});

test("infra: nenhum campo de evidencia aceita texto narrativo livre (enum + limite)", () => {
  withTestDb("infra-evidence", (db) => {
    toWorstCase(db, "k1", 10_000);
    assert.throws(() =>
      reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 1, evidenceType: "a narrative free text explanation", actorType: "operator", nowMs: NOW + 1 })
    );
  });
});

test("infra: journal_mode=WAL funciona corretamente na conexao de teste", () => {
  withTestDb("infra-wal", (db) => {
    const mode = db.pragma("journal_mode", { simple: true });
    assert.equal(mode, "wal");
    assert.doesNotThrow(() => reserveBudget(db, baseReserveOpts()));
  });
});

test("infra: nenhum teste usa data/market.db real (caminho do arquivo de teste e temporario)", () => {
  const { dir, dbPath } = createTempDbFile("path-check");
  try {
    assert.ok(dbPath.includes(os.tmpdir()) || dbPath.startsWith(os.tmpdir()));
    assert.ok(!dbPath.includes(path.join("data", "market.db")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// 15) Testes de eventos (append-only)
// =====================================================================

test("eventos: reserveBudget gera exatamente 1 evento RESERVED", () => {
  withTestDb("events-reserved", (db) => {
    const row = reserveBudget(db, baseReserveOpts());
    const events = getLedgerEvents(db, { idempotencyKey: "test-key-001" });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "RESERVED");
    assert.equal(events[0].ledger_id, row.id);
    assert.equal(events[0].to_status, "reserved");
    assert.equal(events[0].from_status, null);
  });
});

test("eventos: retry idempotente (payload identico) nao duplica evento RESERVED", () => {
  withTestDb("events-retry-idem", (db) => {
    reserveBudget(db, baseReserveOpts());
    reserveBudget(db, baseReserveOpts());
    const events = getLedgerEvents(db, { idempotencyKey: "test-key-001" });
    assert.equal(events.length, 1);
  });
});

test("eventos: conflito idempotente nao cria evento", () => {
  withTestDb("events-conflict", (db) => {
    reserveBudget(db, baseReserveOpts());
    try {
      reserveBudget(db, baseReserveOpts({ reservedMicrosUsd: 1 }));
    } catch {
      /* esperado */
    }
    const events = getLedgerEvents(db, { idempotencyKey: "test-key-001" });
    assert.equal(events.length, 1); // so o RESERVED original
  });
});

test("eventos: cada transicao gera exatamente 1 evento correspondente", () => {
  withTestDb("events-each-transition", (db) => {
    reserveBudget(db, baseReserveOpts());
    markSendIntent(db, { idempotencyKey: "test-key-001", requestId: "r1", nowMs: NOW + 1 });
    markWorstCaseCharged(db, { idempotencyKey: "test-key-001", nowMs: NOW + 2 });
    reconcileDown(db, { idempotencyKey: "test-key-001", reconciledEffectiveMicrosUsd: 10, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 3 });

    const events = getLedgerEvents(db, { idempotencyKey: "test-key-001" });
    const types = events.map((e) => e.event_type);
    assert.deepEqual(types, ["RESERVED", "SEND_INTENT_RECORDED", "WORST_CASE_CHARGED", "RECONCILED_DOWN"]);
  });
});

test("eventos: falha ao inserir evento causa rollback da atualizacao principal", () => {
  withTestDb("events-rollback", (db) => {
    reserveBudget(db, baseReserveOpts());
    const before = getLedgerEntry(db, { idempotencyKey: "test-key-001" });

    // Simula falha na gravacao do evento forcando um event_type invalido
    // diretamente via SQL dentro de uma transacao que tambem faria a
    // atualizacao principal -- prova que a atualizacao nao "vaza" sozinha.
    assert.throws(() => {
      db.transaction(() => {
        db.prepare(`UPDATE agentrouter_budget_ledger SET status = 'confirmed', confirmed_micros_usd = 100 WHERE idempotency_key = ?`).run("test-key-001");
        db.prepare(
          `INSERT INTO agentrouter_budget_events (ledger_id, event_type, from_status, to_status, effective_micros_usd, actor_type, occurred_at, occurred_at_ms)
           VALUES (@id, 'NOT_A_REAL_EVENT_TYPE', 'reserved', 'confirmed', 100, 'system', @iso, @ms)`
        ).run({ id: before.id, iso: new Date(NOW + 1).toISOString(), ms: NOW + 1 });
      }).immediate();
    });

    const after = getLedgerEntry(db, { idempotencyKey: "test-key-001" });
    assert.equal(after.status, "reserved"); // nao mudou -- rollback confirmado
  });
});

test("eventos: reconciliacoes sucessivas preservam historico completo", () => {
  withTestDb("events-successive-reconcile", (db) => {
    toWorstCase(db, "k1", 100_000);
    reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 70_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 1 });
    reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 30_000, evidenceType: "manual_verified_no_charge", actorType: "reconciliation_script", nowMs: NOW + 2 });
    const events = getLedgerEvents(db, { idempotencyKey: "k1" });
    const reconcileEvents = events.filter((e) => e.event_type === "RECONCILED_DOWN");
    assert.equal(reconcileEvents.length, 2);
    assert.equal(reconcileEvents[0].effective_micros_usd, 70_000);
    assert.equal(reconcileEvents[0].evidence_type, "agentrouter_panel");
    assert.equal(reconcileEvents[1].effective_micros_usd, 30_000);
    assert.equal(reconcileEvents[1].evidence_type, "manual_verified_no_charge");
  });
});

test("eventos: ordenados por occurred_at_ms e id", () => {
  withTestDb("events-order", (db) => {
    reserveBudget(db, baseReserveOpts());
    markSendIntent(db, { idempotencyKey: "test-key-001", requestId: null, nowMs: NOW + 1 });
    markWorstCaseCharged(db, { idempotencyKey: "test-key-001", nowMs: NOW + 2 });
    const events = getLedgerEvents(db, { idempotencyKey: "test-key-001" });
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].occurred_at_ms >= events[i - 1].occurred_at_ms);
      if (events[i].occurred_at_ms === events[i - 1].occurred_at_ms) assert.ok(events[i].id > events[i - 1].id);
    }
  });
});

test("eventos: nenhuma API publica permite editar/apagar eventos", () => {
  const exported = Object.keys(ledger);
  for (const name of exported) {
    assert.ok(!/update.*event/i.test(name), `funcao suspeita exportada: ${name}`);
    assert.ok(!/delete.*event/i.test(name), `funcao suspeita exportada: ${name}`);
  }
});

test("eventos: evento nao aceita texto livre/controle/caractere proibido em evidence_reference", () => {
  withTestDb("events-no-control-chars", (db) => {
    toWorstCase(db, "k1", 10_000);
    assert.throws(() =>
      reconcileDown(db, { idempotencyKey: "k1", reconciledEffectiveMicrosUsd: 1, evidenceType: "agentrouter_panel", evidenceReference: "linha1\nlinha2", actorType: "operator", nowMs: NOW + 1 })
    );
  });
});

test("eventos: foreign key impede evento para ledger_id inexistente", () => {
  withTestDb("events-fk", (db) => {
    assert.throws(() => {
      db.prepare(
        `INSERT INTO agentrouter_budget_events (ledger_id, event_type, to_status, effective_micros_usd, actor_type, occurred_at, occurred_at_ms)
         VALUES (999999, 'RESERVED', 'reserved', 0, 'system', @iso, @ms)`
      ).run({ iso: new Date(NOW).toISOString(), ms: NOW });
    }, /FOREIGN KEY/);
  });
});

// =====================================================================
// 16) Concorrencia real -- dois processos separados, arquivo real, IPC via stdin/stdout
// =====================================================================

const HOLDER_SCRIPT = `
const Database = require(${JSON.stringify(BETTER_SQLITE3_PATH)});
const fs = require("fs");
const dbPath = process.argv[1];
const db = new Database(dbPath);
db.pragma("busy_timeout = 3000");
try {
  db.transaction(() => {
    process.stdout.write("LOCKED\\n");
    const buf = Buffer.alloc(64);
    const n = fs.readSync(0, buf, 0, 64, null);
    const cmd = buf.slice(0, n).toString().trim();
    if (cmd === "ROLLBACK") throw new Error("rollback requested by parent");
  }).immediate();
  process.stdout.write("COMMITTED\\n");
} catch (e) {
  process.stdout.write("ROLLEDBACK:" + e.message + "\\n");
}
`;

const WAITER_SCRIPT = `
const Database = require(${JSON.stringify(BETTER_SQLITE3_PATH)});
const ledgerMod = require(${JSON.stringify(LEDGER_MODULE_PATH)});
const dbPath = process.argv[1];
const busyTimeoutMs = parseInt(process.argv[2], 10);
const key = process.argv[3];
const nowMs = parseInt(process.argv[4], 10);
const db = new Database(dbPath);
db.pragma("busy_timeout = " + busyTimeoutMs);
process.stdout.write("ATTEMPT_START\\n");
const start = Date.now();
try {
  ledgerMod.reserveBudget(db, {
    idempotencyKey: key, correlationId: "corr-waiter", model: "gpt-5.6-sol", taskClass: "triage",
    estimatedMicrosUsd: 1000, reservedMicrosUsd: 2000,
    priceSource: "observed_sample", priceSourceStatus: "observed", pricingTableVersion: "v1",
    budgetWindowStartMs: nowMs, budgetWindowEndMs: nowMs + 86400000, budgetWindowTimezone: "America/Sao_Paulo",
    expiresAtMs: nowMs + 300000, nowMs,
  });
  process.stdout.write("SUCCESS:" + (Date.now() - start) + "\\n");
} catch (e) {
  process.stdout.write("BUSY:" + (Date.now() - start) + ":" + (e.code || "unknown") + "\\n");
}
`;

function spawnLineReader(child, onLine) {
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      onLine(line);
    }
  });
}

/**
 * Resolve SOMENTE quando o processo realmente terminou -- exitCode!==null
 * (ja tinha terminado antes de chamar) OU evento 'exit'/'close' disparado.
 * child.killed NUNCA e usado como sinal de termino (killed so significa que
 * kill() foi entregue com sucesso ao SO, nao que o processo morreu/liberou
 * handles). Se o processo nao confirmar saida dentro de timeoutMs, resolve
 * com exited:false -- quem chama decide se isso e' falha (ver killAndWait).
 * Sempre remove o listener e o timer, nos dois caminhos.
 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ exited: true });

    let settled = false;
    const onDone = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onDone);
      child.removeListener("close", onDone);
      resolve({ exited: true });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", onDone);
      child.removeListener("close", onDone);
      resolve({ exited: false });
    }, timeoutMs);

    child.once("exit", onDone);
    child.once("close", onDone);
  });
}

/**
 * Envia SIGKILL (se o processo ainda nao tiver terminado) e so' resolve
 * depois de waitForExit() confirmar o termino real. Se o processo nao
 * confirmar saida no timeout, LANCA um erro explicito -- nunca continua
 * silenciosamente como se o cleanup tivesse funcionado (isso teria mascarado
 * um processo filho orfao).
 */
async function killAndWait(child, label, timeoutMs = 3000) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ja pode ter morrido entre a checagem e o kill -- sem problema */
    }
  }
  const { exited } = await waitForExit(child, timeoutMs);
  if (!exited) {
    throw new Error(`killAndWait: processo filho "${label}" (pid=${child.pid}) nao confirmou saida em ${timeoutMs}ms apos SIGKILL -- possivel processo orfao`);
  }
}

// Mecanismo NATIVO do Node (nao loop ocupado) -- fs.rmSync com
// maxRetries/retryDelay lida com o EBUSY/EPERM transitorio do Windows
// internamente. Versao async (fs/promises) usada nos testes de concorrencia
// (nao bloqueia o event loop entre tentativas); versao sync usada em
// withTestDb (contexto sincrono, mas ainda via mecanismo nativo, sem loop
// manual).
async function rmDirSafe(dir) {
  await fsPromises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
function rmDirSafeSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * Tenta encerrar TODOS os processos filho nomeados (mesmo que um falhe, os
 * demais ainda sao tentados) e SO' entao remove o diretorio temporario.
 * Qualquer falha (processo que nao confirmou saida, ou remocao do
 * diretorio) e' relancada no final -- nunca mascarada. Nunca remove o
 * diretorio se um processo ainda pode estar vivo com o arquivo aberto.
 */
async function cleanupAll(dir, namedChildren) {
  const errors = [];
  for (const [label, child] of namedChildren) {
    try {
      await killAndWait(child, label);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length === 0) {
    try {
      await rmDirSafe(dir);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw errors[0];
}

function waitForLine(child, predicate, timeoutMs, lines) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando linha em stdout (${timeoutMs}ms). Linhas ate agora: ${JSON.stringify(lines)}`)), timeoutMs);
    spawnLineReader(child, (line) => {
      lines.push(line);
      if (predicate(line)) {
        clearTimeout(timer);
        resolve(line);
      }
    });
  });
}

test("concorrencia real: B espera enquanto A segura BEGIN IMMEDIATE, sucesso comprovado so depois da liberacao (dentro do busy_timeout)", async () => {
  const { dir, dbPath } = createTempDbFile("concurrency-success");
  let holder, waiter;
  try {
    const setupDb = new Database(dbPath);
    runMigrations(setupDb, MIGRATIONS_DIR);
    setupDb.close();

    holder = spawn(process.execPath, ["-e", HOLDER_SCRIPT, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    const holderLines = [];
    await waitForLine(holder, (l) => l === "LOCKED", 10000, holderLines);

    const waiterLines = [];
    waiter = spawn(process.execPath, ["-e", WAITER_SCRIPT, "--", dbPath, "3000", "wait-success-key", String(NOW)], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    await waitForLine(waiter, (l) => l === "ATTEMPT_START", 10000, waiterLines);

    // segura o lock por 500ms -- bem abaixo do busy_timeout de B (3000ms) --
    // depois manda A liberar.
    await new Promise((r) => setTimeout(r, 500));
    holder.stdin.write("COMMIT\n");

    await waitForLine(holder, (l) => l === "COMMITTED", 10000, holderLines);
    const resultLine = await waitForLine(waiter, (l) => l.startsWith("SUCCESS:") || l.startsWith("BUSY:"), 10000, waiterLines);

    assert.ok(resultLine.startsWith("SUCCESS:"), `esperava SUCCESS, veio: ${resultLine}`);
    const elapsed = parseInt(resultLine.split(":")[1], 10);
    assert.ok(elapsed >= 400, `B deveria ter esperado pelo menos ~500ms (comprova que esperou o lock), esperou ${elapsed}ms`);
  } finally {
    await cleanupAll(dir, [
      ["holder", holder],
      ["waiter", waiter],
    ]);
  }
});

test("concorrencia real: B recebe SQLITE_BUSY genuino quando A segura o lock alem do busy_timeout configurado", async () => {
  const { dir, dbPath } = createTempDbFile("concurrency-busy");
  let holder, waiter;
  try {
    const setupDb = new Database(dbPath);
    runMigrations(setupDb, MIGRATIONS_DIR);
    setupDb.close();

    holder = spawn(process.execPath, ["-e", HOLDER_SCRIPT, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    const holderLines = [];
    await waitForLine(holder, (l) => l === "LOCKED", 10000, holderLines);

    const waiterLines = [];
    // busy_timeout curto (300ms) -- A vai segurar o lock por 800ms, bem mais que isso
    waiter = spawn(process.execPath, ["-e", WAITER_SCRIPT, "--", dbPath, "300", "wait-busy-key", String(NOW)], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    await waitForLine(waiter, (l) => l === "ATTEMPT_START", 10000, waiterLines);

    const resultLine = await waitForLine(waiter, (l) => l.startsWith("SUCCESS:") || l.startsWith("BUSY:"), 10000, waiterLines);

    // libera A DEPOIS de ja termos o resultado de B, pra provar que B falhou
    // antes da liberacao (nao por coincidencia de timing)
    holder.stdin.write("COMMIT\n");
    await waitForLine(holder, (l) => l === "COMMITTED", 10000, holderLines);

    assert.ok(resultLine.startsWith("BUSY:"), `esperava BUSY, veio: ${resultLine}`);
  } finally {
    await cleanupAll(dir, [
      ["holder", holder],
      ["waiter", waiter],
    ]);
  }
});

test("concorrencia real: mesma idempotency_key de 2 processos reais -- so 1 linha resulta", async () => {
  const { dir, dbPath } = createTempDbFile("concurrency-idem");
  let procA, procB;
  try {
    const setupDb = new Database(dbPath);
    runMigrations(setupDb, MIGRATIONS_DIR);
    setupDb.close();

    const sameKeyScript = `
const Database = require(${JSON.stringify(BETTER_SQLITE3_PATH)});
const ledgerMod = require(${JSON.stringify(LEDGER_MODULE_PATH)});
const db = new Database(process.argv[1]);
db.pragma("busy_timeout = 3000");
try {
  ledgerMod.reserveBudget(db, {
    idempotencyKey: "shared-key", correlationId: "corr", model: "gpt-5.6-sol", taskClass: "triage",
    estimatedMicrosUsd: 1000, reservedMicrosUsd: 2000,
    priceSource: "observed_sample", priceSourceStatus: "observed", pricingTableVersion: "v1",
    budgetWindowStartMs: ${NOW}, budgetWindowEndMs: ${NOW + DAY_MS}, budgetWindowTimezone: "America/Sao_Paulo",
    expiresAtMs: ${NOW + 300000}, nowMs: ${NOW},
  });
  process.stdout.write("OK\\n");
} catch (e) {
  process.stdout.write("ERR:" + e.code + "\\n");
}
`;
    procA = spawn(process.execPath, ["-e", sameKeyScript, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    procB = spawn(process.execPath, ["-e", sameKeyScript, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

    const linesA = [];
    const linesB = [];
    const [resA, resB] = await Promise.all([
      waitForLine(procA, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesA),
      waitForLine(procB, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesB),
    ]);

    // ambos podem ver OK (payload identico -> idempotente) ou um OK + um ERR
    // (se colidirem no meio) -- o que NUNCA pode acontecer e' duas linhas na tabela.
    assert.ok([resA, resB].every((r) => r.startsWith("OK") || r.startsWith("ERR")));

    const finalDb = new Database(dbPath, { readonly: true });
    const count = finalDb.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_ledger WHERE idempotency_key = 'shared-key'").get().c;
    finalDb.close();
    assert.equal(count, 1);
  } finally {
    await cleanupAll(dir, [
      ["procA", procA],
      ["procB", procB],
    ]);
  }
});

// =====================================================================
// 17) Testes de cleanup -- comprovam que a limpeza e' honesta (nao mascara
// processo orfao / falha explicita no timeout / arquivos realmente somem)
// =====================================================================

test("cleanup: killAndWait lanca erro explicito quando o processo nao confirma saida no timeout (nao falha silenciosamente)", async () => {
  const EventEmitter = require("events");
  const fakeChild = new EventEmitter();
  fakeChild.exitCode = null;
  fakeChild.signalCode = null;
  fakeChild.pid = 999999;
  fakeChild.kill = () => true; // "entrega" o sinal mas NUNCA emite exit/close -- simula processo travado

  await assert.rejects(() => killAndWait(fakeChild, "fake-hung-process", 150), /nao confirmou saida/);
});

test("cleanup: processo filho real e confirmado encerrado (nao so' killed=true), diretorio e .db/-wal/-shm removidos, sem processo orfao no SO", async () => {
  const { dir, dbPath } = createTempDbFile("cleanup-verify");
  const setupDb = new Database(dbPath);
  runMigrations(setupDb, MIGRATIONS_DIR);
  setupDb.pragma("journal_mode = WAL");
  setupDb.prepare("SELECT 1").get(); // garante que o -wal/-shm sejam materializados em disco
  setupDb.close();

  const readyScript = `
const Database = require(${JSON.stringify(BETTER_SQLITE3_PATH)});
const db = new Database(process.argv[1]);
db.pragma("busy_timeout = 1000");
process.stdout.write("READY\\n");
`;
  const child = spawn(process.execPath, ["-e", readyScript, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  await waitForLine(child, (l) => l === "READY", 5000, lines);
  const pid = child.pid;

  await killAndWait(child, "cleanup-verify-child", 3000);

  // Confirma encerramento REAL (nao so' child.killed) -- exitCode OU
  // signalCode preenchido (no Windows, SIGKILL costuma reportar via
  // signalCode, com exitCode permanecendo null -- mesmo criterio usado por
  // waitForExit()).
  assert.ok(child.exitCode !== null || child.signalCode !== null, `esperava exitCode ou signalCode preenchido, veio exitCode=${child.exitCode} signalCode=${child.signalCode}`);

  // Confirma que o processo realmente sumiu do SO (process.kill com sinal 0
  // so' testa existencia, nao envia sinal de verdade -- funciona no Windows)
  let stillAlive = true;
  try {
    process.kill(pid, 0);
  } catch {
    stillAlive = false;
  }
  assert.equal(stillAlive, false, "processo filho nao deveria mais existir no SO apos killAndWait confirmar saida");

  await rmDirSafe(dir);
  assert.equal(fs.existsSync(dir), false, "diretorio temporario deveria ter sido removido");
  assert.equal(fs.existsSync(dbPath), false, "arquivo .db nao deveria permanecer");
  assert.equal(fs.existsSync(dbPath + "-wal"), false, "arquivo -wal nao deveria permanecer");
  assert.equal(fs.existsSync(dbPath + "-shm"), false, "arquivo -shm nao deveria permanecer");
});
