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
const budgetPolicy = require("../../lib/aiGateway/agentRouterBudgetPolicy");
const budgetedClient = require("../../lib/aiGateway/agentRouterBudgetedClient");

const {
  createBudgetedAgentRouterClient,
  createLazyDbProvider,
  computeExpiresAtMs,
  EXPIRY_MARGIN_MS_DEFAULT,
  PriorAttemptAmbiguousError,
  AlreadyAccountedNoResponseStoredError,
  AssessmentAlreadyReleasedError,
  AccountingFailedAfterResponseError,
  AtomicClaimUnavailableError,
  UnexpectedFatalError,
} = budgetedClient;

const BETTER_SQLITE3_PATH = require.resolve("better-sqlite3");
const BUDGET_POLICY_MODULE_PATH = require.resolve("../../lib/aiGateway/agentRouterBudgetPolicy");
const BUDGETED_CLIENT_MODULE_PATH = require.resolve("../../lib/aiGateway/agentRouterBudgetedClient");

const NOW = 1_756_000_000_000;
const TIMEOUT_MS = 60_000;
const GRACEFUL_SHUTDOWN_MS = 5_000;
// Mesmo valor que o wrapper computa internamente com os defaults acima
// (nowFn -> NOW, margem default) -- usado quando um teste pre-cria uma
// reserva manualmente e depois espera que o wrapper a RECONHEÇA como
// retry (expiresAtMs faz parte do payload canonico comparado pela
// politica -- um valor diferente causaria IdempotencyConflictError em vez
// de reconhecimento de retry).
const EXPECTED_EXPIRES_AT_MS = NOW + TIMEOUT_MS + GRACEFUL_SHUTDOWN_MS + budgetedClient.EXPIRY_MARGIN_MS_DEFAULT;

// =====================================================================
// Infra de teste -- SQLite real em arquivo temporario (mesma disciplina
// dos Commits 2/3). Transporte SEMPRE fake, nunca lib/agentrouterClient.js
// real. Zero rede em qualquer teste deste arquivo.
// =====================================================================

function createTempDbFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-budgeted-client-${label}-`));
  const dbPath = path.join(dir, "test.db");
  return { dir, dbPath };
}

function openTestDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 3000");
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function rmDirSafeSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
function rmDirSafe(dir) {
  return fsPromises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function withTestDb(label, fn) {
  const { dir, dbPath } = createTempDbFile(label);
  const db = openTestDb(dbPath);
  const dbProvider = { getDb: () => db, closeDb: () => { try { db.close(); } catch { /* ja fechado */ } } };
  try {
    return await fn(db, dbProvider, dbPath);
  } finally {
    try {
      db.close();
    } catch {
      /* ja pode ter fechado */
    }
    rmDirSafeSync(dir);
  }
}

function testPolicyConfig(overrides = {}) {
  return {
    nominalCapMicrosUsd: 10_000_000,
    operationalCapMicrosUsd: 9_000_000,
    reconciliationMarginMicrosUsd: 1_000_000,
    categoryCapsMicrosUsd: { triage: 1_800_000, recurring_analysis: 3_150_000, research_innovation: 2_700_000, event_review_reserve: 1_350_000 },
    perCallLimitsMicrosUsd: { health_check: 100_000, triage: 100_000, normal_analysis: 200_000, deep_analysis: 500_000, research_innovation: 1_000_000, critical_review: 500_000 },
    taskClassToCategory: {
      health_check: "triage",
      triage: "triage",
      normal_analysis: "recurring_analysis",
      deep_analysis: "recurring_analysis",
      research_innovation: "research_innovation",
      critical_review: "event_review_reserve",
    },
    observedMarginRatio: 0.5,
    minAbsoluteMicrosUsd: 10_000,
    timezone: "America/Sao_Paulo",
    windowStartLocal: "00:00",
    ...overrides,
  };
}

function createPolicy(overrides) {
  return budgetPolicy.createAgentRouterBudgetPolicy(testPolicyConfig(overrides));
}

function baseMetadata(overrides = {}) {
  return {
    assessmentKey: "test-assessment-key-001",
    attemptId: "attempt-id-001",
    taskClass: "triage",
    ...overrides,
  };
}

/** Fake transporte -- registra cada chamada (args exatos recebidos) e conta invocacoes. Nunca toca rede. */
function makeFakeTransport(implFn) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return implFn(args);
  };
  fn.calls = calls;
  return fn;
}

function makeClient({ dbProvider, policy, transport, timeoutMs = TIMEOUT_MS, gracefulShutdownMs = GRACEFUL_SHUTDOWN_MS, marginMs, nowFn }) {
  return createBudgetedAgentRouterClient({
    dbProvider,
    policy: policy || createPolicy(),
    realRunAgentRouterPrompt: transport,
    timeoutMs,
    gracefulShutdownMs,
    codexCommand: "codex-fake-not-a-real-command",
    marginMs,
    nowFn: nowFn || (() => NOW),
  });
}

function assertThrowsCode(fn, ErrorClass, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ErrorClass, `esperado ${ErrorClass.name}, veio ${err.constructor.name}: ${err.message}`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

function countLedgerRows(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_ledger").get().c;
}

// =====================================================================
// 1) computeExpiresAtMs -- formula pura e injetavel
// =====================================================================

test("computeExpiresAtMs: nowMs + timeoutMs + gracefulShutdownMs + margem (default)", () => {
  const v = computeExpiresAtMs({ nowMs: 1000, timeoutMs: 60_000, gracefulShutdownMs: 5_000 });
  assert.equal(v, 1000 + 60_000 + 5_000 + EXPIRY_MARGIN_MS_DEFAULT);
});

test("computeExpiresAtMs: margem injetavel", () => {
  const v = computeExpiresAtMs({ nowMs: 0, timeoutMs: 10, gracefulShutdownMs: 5, marginMs: 1 });
  assert.equal(v, 16);
});

test("computeExpiresAtMs: rejeita valores negativos/nao-inteiros", () => {
  assert.throws(() => computeExpiresAtMs({ nowMs: -1, timeoutMs: 1, gracefulShutdownMs: 1 }));
  assert.throws(() => computeExpiresAtMs({ nowMs: 1, timeoutMs: 1.5, gracefulShutdownMs: 1 }));
});

// =====================================================================
// 2) createLazyDbProvider -- lifecycle da conexao, encapsulado (nao mais
// singleton global)
// =====================================================================

test("createLazyDbProvider: abertura lazy -- openDbFn nao e chamado ate a primeira getDb()", () => {
  let openCalls = 0;
  const provider = createLazyDbProvider({ openDbFn: () => { openCalls++; return { close() {} }; } });
  assert.equal(openCalls, 0);
  provider.getDb();
  assert.equal(openCalls, 1);
});

test("createLazyDbProvider: getDb() devolve a MESMA instancia em chamadas sucessivas (singleton por provider)", () => {
  const provider = createLazyDbProvider({ openDbFn: () => ({ close() {}, marker: Math.random() }) });
  const a = provider.getDb();
  const b = provider.getDb();
  assert.equal(a, b);
});

test("createLazyDbProvider: dois providers independentes NUNCA compartilham handle", () => {
  const p1 = createLazyDbProvider({ openDbFn: () => ({ close() {}, id: "p1" }) });
  const p2 = createLazyDbProvider({ openDbFn: () => ({ close() {}, id: "p2" }) });
  assert.notEqual(p1.getDb(), p2.getDb());
  assert.equal(p1.getDb().id, "p1");
  assert.equal(p2.getDb().id, "p2");
});

test("createLazyDbProvider: closeDb() e idempotente (2 chamadas seguidas sem erro)", () => {
  let closeCalls = 0;
  const provider = createLazyDbProvider({ openDbFn: () => ({ close: () => { closeCalls++; } }) });
  provider.getDb();
  provider.closeDb();
  assert.doesNotThrow(() => provider.closeDb());
  assert.equal(closeCalls, 1); // 2a chamada nao tenta fechar de novo (db ja e null)
});

test("createLazyDbProvider: reabertura depois de close() cria uma instancia NOVA valida", () => {
  let openCalls = 0;
  const provider = createLazyDbProvider({ openDbFn: () => { openCalls++; return { close() {}, generation: openCalls }; } });
  const first = provider.getDb();
  provider.closeDb();
  const second = provider.getDb();
  assert.notEqual(first, second);
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
});

test("createLazyDbProvider: closeDb() nunca lanca mesmo se db.close() lancar", () => {
  const provider = createLazyDbProvider({ openDbFn: () => ({ close: () => { throw new Error("close falhou"); } }) });
  provider.getDb();
  assert.doesNotThrow(() => provider.closeDb());
});

test("createLazyDbProvider: open() falhando na primeira chamada, tentativa posterior tenta reabrir corretamente", () => {
  let attempt = 0;
  const provider = createLazyDbProvider({
    openDbFn: () => {
      attempt++;
      if (attempt === 1) throw new Error("falha simulada na primeira abertura");
      return { close() {}, attempt };
    },
  });
  assert.throws(() => provider.getDb(), /falha simulada/);
  const db = provider.getDb(); // segunda tentativa -- nao ficou "travado" na falha anterior
  assert.equal(db.attempt, 2);
});

// =====================================================================
// 3) Fluxo feliz -- transporte chamado exatamente 1x, sucesso -> pior
// caso persistido (preco unknown), resposta real devolvida
// =====================================================================

test("runAgentRouterPrompt: fluxo feliz -- reserva -> claim -> transporte 1x -> worst_case_charged -> devolve resposta real", async () => {
  await withTestDb("happy-path", async (db, dbProvider) => {
    const transport = makeFakeTransport(async () => ({ text: '{"bias":"neutral"}', usage: null, threadId: "t1", meta: {} }));
    const client = makeClient({ dbProvider, transport });

    const raw = await client.runAgentRouterPrompt({ system: "SYS", user: "USR", model: "gpt-5.6-sol", metadata: baseMetadata() });

    assert.equal(transport.calls.length, 1);
    assert.deepEqual(raw, { text: '{"bias":"neutral"}', usage: null, threadId: "t1", meta: {} });

    const row = ledger.getLedgerEntry(db, { idempotencyKey: "ar:test-assessment-key-001" });
    assert.equal(row.status, "worst_case_charged");
    assert.equal(row.price_source_status, "unknown");
    assert.equal(row.estimated_micros_usd, 0);
    assert.equal(row.price_source, null);
    assert.equal(row.pricing_table_version, "unpriced-v1");
    assert.equal(row.request_id, "attempt-id-001");
  });
});

test("runAgentRouterPrompt: pior caso reservado = teto INTEIRO da classe (preco unknown -> sem tabela inventada)", async () => {
  await withTestDb("happy-path-worstcase-amount", async (db, dbProvider) => {
    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport });
    await client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata({ taskClass: "triage" }) });
    const row = ledger.getLedgerEntry(db, { idempotencyKey: "ar:test-assessment-key-001" });
    assert.equal(row.original_worst_case_micros_usd, 100_000); // teto de triage
  });
});

// =====================================================================
// 4) Transporte falha -- pior caso ainda persiste, erro relancado com
// fallbackAllowed=true (unico caso positivo alem de orcamento esgotado)
// =====================================================================

test("runAgentRouterPrompt: transporte falha -> markWorstCaseCharged AINDA roda, erro de transporte relancado com fallbackAllowed=true", async () => {
  await withTestDb("transport-fails", async (db, dbProvider) => {
    const transportError = Object.assign(new Error("codex exited non-zero"), { code: "AGENTROUTER_EXIT_NONZERO" });
    const transport = makeFakeTransport(async () => {
      throw transportError;
    });
    const client = makeClient({ dbProvider, transport });

    await assert.rejects(
      () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
      (err) => {
        assert.equal(err, transportError); // o MESMO erro original, so anotado
        assert.equal(err.fallbackAllowed, true);
        return true;
      }
    );

    const row = ledger.getLedgerEntry(db, { idempotencyKey: "ar:test-assessment-key-001" });
    assert.equal(row.status, "worst_case_charged");
  });
});

// =====================================================================
// 5) Orcamento esgotado -- zero chamadas de transporte, fallbackAllowed=true
// =====================================================================

test("runAgentRouterPrompt: orcamento global esgotado -> tryReserve lanca, transporte 0 chamadas, fallbackAllowed=true", async () => {
  await withTestDb("budget-exhausted-global", async (db, dbProvider) => {
    const policy = createPolicy({
      operationalCapMicrosUsd: 50_000,
      nominalCapMicrosUsd: 51_000,
      reconciliationMarginMicrosUsd: 1_000,
      categoryCapsMicrosUsd: { triage: 50_000, recurring_analysis: 0, research_innovation: 0, event_review_reserve: 0 },
      perCallLimitsMicrosUsd: { ...testPolicyConfig().perCallLimitsMicrosUsd, triage: 50_000 },
    });
    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, policy, transport });

    // esgota o orcamento com uma reserva direta na politica (fora do wrapper)
    policy.tryReserve(db, {
      idempotencyKey: "other-key",
      correlationId: "other",
      model: "m",
      taskClass: "triage",
      estimatedMicrosUsd: 0,
      priceSource: null,
      priceSourceStatus: "unknown",
      pricingTableVersion: "unpriced-v1",
      expiresAtMs: EXPECTED_EXPIRES_AT_MS,
      nowMs: NOW,
    });

    await assert.rejects(
      () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
      (err) => {
        assert.ok(err instanceof budgetPolicy.GlobalBudgetExhaustedError);
        assert.equal(err.fallbackAllowed, true);
        return true;
      }
    );
    assert.equal(transport.calls.length, 0);
  });
});

test("runAgentRouterPrompt: EstimatedCostExceedsPerCallLimitError/UnknownTaskClassError/InvalidBudgetPolicyError -> fallbackAllowed=FALSE (nao esta na allowlist positiva)", async () => {
  await withTestDb("preflight-errors-false", async (db, dbProvider) => {
    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport });
    await assert.rejects(
      () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata({ taskClass: "not_a_real_class" }) }),
      (err) => {
        assert.ok(err instanceof budgetPolicy.UnknownTaskClassError);
        assert.equal(err.fallbackAllowed, false);
        return true;
      }
    );
    assert.equal(transport.calls.length, 0);
  });
});

// =====================================================================
// 6) SQLITE_BUSY -- reserva e claim -- AMBOS agora fallbackAllowed=FALSE
// (correcao desta rodada; antes eu tinha marcado como true)
// =====================================================================

test("SQLITE_BUSY em policy.tryReserve() (lock real de outra conexao) -> AtomicReservationUnavailableError, fallbackAllowed=FALSE, transporte 0 chamadas", async () => {
  await withTestDb("busy-reserve", async (db, dbProvider, dbPath) => {
    // sweep mockado -- isola o teste no lock especifico do TRYRESERVE, nao do sweep
    // (ambos precisam de BEGIN IMMEDIATE, entao sem isso o sweep pegaria o busy primeiro)
    const originalSweep = ledger.sweepExpiredReservations;
    ledger.sweepExpiredReservations = () => ({ releasedCount: 0, worstCaseCount: 0 });

    const lockDb = new Database(dbPath);
    lockDb.pragma("busy_timeout = 0");
    lockDb.exec("BEGIN IMMEDIATE");
    try {
      db.pragma("busy_timeout = 150");
      const transport = makeFakeTransport(async () => ({ text: "{}" }));
      const client = makeClient({ dbProvider, transport });
      await assert.rejects(
        () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
        (err) => {
          assert.ok(err instanceof budgetPolicy.AtomicReservationUnavailableError);
          assert.equal(err.fallbackAllowed, false);
          return true;
        }
      );
      assert.equal(transport.calls.length, 0);
    } finally {
      ledger.sweepExpiredReservations = originalSweep;
      lockDb.exec("COMMIT");
      lockDb.close();
    }
  });
});

test("SQLITE_BUSY em claimForSending() (reserva ja existe, lock real durante o claim) -> AtomicClaimUnavailableError, fallbackAllowed=FALSE, transporte 0 chamadas", async () => {
  await withTestDb("busy-claim", async (db, dbProvider, dbPath) => {
    const idempotencyKey = "ar:test-assessment-key-001";
    const realPolicy = createPolicy();
    const created = realPolicy.tryReserve(db, {
      idempotencyKey,
      correlationId: "test-assessment-key-001",
      model: "m",
      taskClass: "triage",
      estimatedMicrosUsd: 0,
      priceSource: null,
      priceSourceStatus: "unknown",
      pricingTableVersion: "unpriced-v1",
      expiresAtMs: EXPECTED_EXPIRES_AT_MS,
      nowMs: NOW,
    });
    assert.equal(created.status, "reserved");

    // Mock policy.tryReserve -- so devolve a linha ja criada, sem tocar o
    // banco de novo (isola o teste no lock especifico do CLAIM, nao da
    // reserva -- sweepExpiredReservations tambem e mockado pelo mesmo motivo).
    const mockPolicy = { tryReserve: () => ({ ...created }) };
    const originalSweep = ledger.sweepExpiredReservations;
    ledger.sweepExpiredReservations = () => ({ releasedCount: 0, worstCaseCount: 0 });

    const lockDb = new Database(dbPath);
    lockDb.pragma("busy_timeout = 0");
    lockDb.exec("BEGIN IMMEDIATE");
    try {
      db.pragma("busy_timeout = 150");
      const transport = makeFakeTransport(async () => ({ text: "{}" }));
      const client = makeClient({ dbProvider, policy: mockPolicy, transport });
      await assert.rejects(
        () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
        (err) => {
          assert.ok(err instanceof AtomicClaimUnavailableError);
          assert.equal(err.fallbackAllowed, false);
          return true;
        }
      );
      assert.equal(transport.calls.length, 0);
    } finally {
      ledger.sweepExpiredReservations = originalSweep;
      lockDb.exec("COMMIT");
      lockDb.close();
    }
  });
});

// =====================================================================
// 7) Retry -- sem intencao prossegue normalmente; com intencao ativa NUNCA
// reenvia, fallbackAllowed=false
// =====================================================================

test("runAgentRouterPrompt: retry com a MESMA assessmentKey, reserva ainda sem intencao -> reconhecido pela politica, prossegue pro claim normalmente (nao cria segunda linha)", async () => {
  await withTestDb("retry-no-intent", async (db, dbProvider) => {
    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport });

    // Simula uma reserva PRE-EXISTENTE sem intencao (ex.: uma tentativa
    // anterior que reservou mas nunca chegou a chamar o transporte).
    const policy = createPolicy();
    policy.tryReserve(db, {
      idempotencyKey: "ar:test-assessment-key-001",
      correlationId: "test-assessment-key-001",
      model: "m",
      taskClass: "triage",
      estimatedMicrosUsd: 0,
      priceSource: null,
      priceSourceStatus: "unknown",
      pricingTableVersion: "unpriced-v1",
      expiresAtMs: EXPECTED_EXPIRES_AT_MS,
      nowMs: NOW,
    });
    assert.equal(countLedgerRows(db), 1);

    const raw = await client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() });
    assert.ok(raw);
    assert.equal(transport.calls.length, 1);
    assert.equal(countLedgerRows(db), 1); // nenhuma linha nova criada
  });
});

test("runAgentRouterPrompt: retry ATIVO (intencao ja registrada, ainda dentro do prazo) -> PriorAttemptAmbiguousError, NUNCA reenvia, fallbackAllowed=false", async () => {
  await withTestDb("retry-active-intent", async (db, dbProvider) => {
    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport });

    const policy = createPolicy();
    const created = policy.tryReserve(db, {
      idempotencyKey: "ar:test-assessment-key-001",
      correlationId: "test-assessment-key-001",
      model: "m",
      taskClass: "triage",
      estimatedMicrosUsd: 0,
      priceSource: null,
      priceSourceStatus: "unknown",
      pricingTableVersion: "unpriced-v1",
      expiresAtMs: EXPECTED_EXPIRES_AT_MS,
      nowMs: NOW,
    });
    ledger.claimForSending(db, { idempotencyKey: created.idempotency_key, requestId: "other-attempt-in-flight", nowMs: NOW + 1 });

    await assert.rejects(
      () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
      (err) => {
        assert.ok(err instanceof PriorAttemptAmbiguousError);
        assert.equal(err.fallbackAllowed, false);
        return true;
      }
    );
    assert.equal(transport.calls.length, 0);
  });
});

// =====================================================================
// 7b) Retry com relogio REALMENTE avancado -- correcao pos-implementacao
// (expiresAtMs saiu da comparacao canonica de resolvePolicyIdempotentReservation).
// NENHUM teste desta secao reusa a mesma constante de nowMs entre a criacao
// e o retry -- e' exatamente isso que prova que o bug foi corrigido.
// =====================================================================

test("runAgentRouterPrompt: retry alguns segundos depois (relogio GENUINAMENTE diferente), ainda ativa sem intencao -> reconhecida como a MESMA avaliacao, prossegue pro claim (nunca IdempotencyConflictError)", async () => {
  await withTestDb("real-clock-retry-no-intent", async (db, dbProvider) => {
    const CREATE_NOW = NOW;
    const RETRY_NOW = NOW + 7_000; // 7s depois -- nao reusa CREATE_NOW nem nenhuma constante de vencimento
    const createdExpiresAtMs = computeExpiresAtMs({ nowMs: CREATE_NOW, timeoutMs: TIMEOUT_MS, gracefulShutdownMs: GRACEFUL_SHUTDOWN_MS });

    const policy = createPolicy();
    policy.tryReserve(db, {
      idempotencyKey: "ar:test-assessment-key-001",
      correlationId: "test-assessment-key-001",
      model: "m",
      taskClass: "triage",
      estimatedMicrosUsd: 0,
      priceSource: null,
      priceSourceStatus: "unknown",
      pricingTableVersion: "unpriced-v1",
      expiresAtMs: createdExpiresAtMs,
      nowMs: CREATE_NOW,
    });

    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    // O retry usa um relogio DIFERENTE -- a politica recalcularia um
    // expiresAtMs diferente do original se ainda fosse comparado; o teste
    // so passa se o helper realmente ignora expiresAtMs na comparacao.
    const client = makeClient({ dbProvider, transport, nowFn: () => RETRY_NOW });

    const raw = await client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() });
    assert.ok(raw);
    assert.equal(transport.calls.length, 1);
    assert.equal(countLedgerRows(db), 1); // nenhuma linha nova criada pelo retry

    const row = ledger.getLedgerEntry(db, { idempotencyKey: "ar:test-assessment-key-001" });
    assert.equal(row.expires_at_ms, createdExpiresAtMs, "vencimento ORIGINAL preservado -- retry nunca estende o lease");
  });
});

test("runAgentRouterPrompt: retry alguns segundos depois, COM intencao ja registrada (ainda ativa) -> PriorAttemptAmbiguousError, NUNCA IdempotencyConflictError, NUNCA reenvia", async () => {
  await withTestDb("real-clock-retry-ambiguous", async (db, dbProvider) => {
    const CREATE_NOW = NOW;
    const RETRY_NOW = NOW + 3_000;
    const createdExpiresAtMs = computeExpiresAtMs({ nowMs: CREATE_NOW, timeoutMs: TIMEOUT_MS, gracefulShutdownMs: GRACEFUL_SHUTDOWN_MS });

    const policy = createPolicy();
    const created = policy.tryReserve(db, {
      idempotencyKey: "ar:test-assessment-key-001",
      correlationId: "test-assessment-key-001",
      model: "m",
      taskClass: "triage",
      estimatedMicrosUsd: 0,
      priceSource: null,
      priceSourceStatus: "unknown",
      pricingTableVersion: "unpriced-v1",
      expiresAtMs: createdExpiresAtMs,
      nowMs: CREATE_NOW,
    });
    ledger.claimForSending(db, { idempotencyKey: created.idempotency_key, requestId: "other-attempt-in-flight", nowMs: CREATE_NOW + 1 });

    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport, nowFn: () => RETRY_NOW });

    await assert.rejects(
      () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
      (err) => {
        assert.ok(err instanceof PriorAttemptAmbiguousError, `esperava PriorAttemptAmbiguousError, veio ${err.constructor.name}: ${err.message}`);
        assert.notEqual(err.constructor.name, "IdempotencyConflictError");
        assert.equal(err.fallbackAllowed, false);
        return true;
      }
    );
    assert.equal(transport.calls.length, 0);

    const row = ledger.getLedgerEntry(db, { idempotencyKey: "ar:test-assessment-key-001" });
    assert.equal(row.expires_at_ms, createdExpiresAtMs, "vencimento original preservado -- retry nao alterou a linha");
  });
});

test("runAgentRouterPrompt: retry BEM depois do vencimento original, COM intencao registrada -> sweep interno converte pra expired_worst_case PRIMEIRO, so entao o wrapper devolve o erro terminal correspondente (nunca reenvia, nunca IdempotencyConflictError)", async () => {
  await withTestDb("real-clock-retry-after-expiry-with-intent", async (db, dbProvider) => {
    const CREATE_NOW = NOW;
    const createdExpiresAtMs = computeExpiresAtMs({ nowMs: CREATE_NOW, timeoutMs: TIMEOUT_MS, gracefulShutdownMs: GRACEFUL_SHUTDOWN_MS });
    const RETRY_NOW = createdExpiresAtMs + 5_000; // bem depois do vencimento ORIGINAL

    const policy = createPolicy();
    const created = policy.tryReserve(db, {
      idempotencyKey: "ar:test-assessment-key-001",
      correlationId: "test-assessment-key-001",
      model: "m",
      taskClass: "triage",
      estimatedMicrosUsd: 0,
      priceSource: null,
      priceSourceStatus: "unknown",
      pricingTableVersion: "unpriced-v1",
      expiresAtMs: createdExpiresAtMs,
      nowMs: CREATE_NOW,
    });
    ledger.claimForSending(db, { idempotencyKey: created.idempotency_key, requestId: "attempt-that-crashed", nowMs: CREATE_NOW + 1 });
    // NUNCA chama markWorstCaseCharged -- simula crash logo apos o claim

    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport, nowFn: () => RETRY_NOW });

    await assert.rejects(
      () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
      (err) => {
        assert.ok(err instanceof AlreadyAccountedNoResponseStoredError);
        assert.equal(err.status, "expired_worst_case");
        assert.equal(err.fallbackAllowed, false);
        return true;
      }
    );
    assert.equal(transport.calls.length, 0);

    const row = ledger.getLedgerEntry(db, { idempotencyKey: created.idempotency_key });
    assert.equal(row.status, "expired_worst_case"); // sweep INTERNO do wrapper ja resolveu, antes da inspecao de estado
    assert.equal(row.expires_at_ms, createdExpiresAtMs, "vencimento original preservado mesmo apos a varredura");
    assert.equal(countLedgerRows(db), 1); // nenhuma linha adicional criada pelo retry
  });
});

test("runAgentRouterPrompt: retry BEM depois do vencimento original, SEM intencao registrada -> sweep interno converte pra expired_released PRIMEIRO, wrapper devolve AssessmentAlreadyReleasedError", async () => {
  await withTestDb("real-clock-retry-after-expiry-no-intent", async (db, dbProvider) => {
    const CREATE_NOW = NOW;
    const createdExpiresAtMs = computeExpiresAtMs({ nowMs: CREATE_NOW, timeoutMs: TIMEOUT_MS, gracefulShutdownMs: GRACEFUL_SHUTDOWN_MS });
    const RETRY_NOW = createdExpiresAtMs + 5_000;

    const policy = createPolicy();
    policy.tryReserve(db, {
      idempotencyKey: "ar:test-assessment-key-001",
      correlationId: "test-assessment-key-001",
      model: "m",
      taskClass: "triage",
      estimatedMicrosUsd: 0,
      priceSource: null,
      priceSourceStatus: "unknown",
      pricingTableVersion: "unpriced-v1",
      expiresAtMs: createdExpiresAtMs,
      nowMs: CREATE_NOW,
    });
    // SEM claim -- simula crash ANTES da intencao de envio

    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport, nowFn: () => RETRY_NOW });

    await assert.rejects(
      () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
      (err) => {
        assert.ok(err instanceof AssessmentAlreadyReleasedError);
        assert.equal(err.status, "expired_released");
        return true;
      }
    );
    assert.equal(transport.calls.length, 0);
    assert.equal(countLedgerRows(db), 1);
  });
});

// =====================================================================
// 8) Estados terminais -- nunca simula resposta, sempre erro nomeado,
// fallbackAllowed=false, transporte 0 chamadas
// =====================================================================

const ACCOUNTED_STATUSES = ["confirmed", "worst_case_charged", "expired_worst_case"];
for (const status of ACCOUNTED_STATUSES) {
  test(`runAgentRouterPrompt: retry sobre reserva ja contabilizada (status=${status}) -> AlreadyAccountedNoResponseStoredError, transporte 0, fallbackAllowed=false`, async () => {
    await withTestDb(`accounted-${status}`, async (db, dbProvider) => {
      const transport = makeFakeTransport(async () => ({ text: "{}" }));
      const client = makeClient({ dbProvider, transport });

      const policy = createPolicy();
      if (status === "confirmed") {
        const created = policy.tryReserve(db, {
          idempotencyKey: "ar:test-assessment-key-001",
          correlationId: "test-assessment-key-001",
          model: "m",
          taskClass: "triage",
          estimatedMicrosUsd: 0,
          priceSource: null,
          priceSourceStatus: "unknown",
          pricingTableVersion: "unpriced-v1",
          expiresAtMs: EXPECTED_EXPIRES_AT_MS,
          nowMs: NOW,
        });
        ledger.confirmBudget(db, { idempotencyKey: created.idempotency_key, confirmedMicrosUsd: 1, nowMs: NOW + 1 });
      } else if (status === "worst_case_charged") {
        const created = policy.tryReserve(db, {
          idempotencyKey: "ar:test-assessment-key-001",
          correlationId: "test-assessment-key-001",
          model: "m",
          taskClass: "triage",
          estimatedMicrosUsd: 0,
          priceSource: null,
          priceSourceStatus: "unknown",
          pricingTableVersion: "unpriced-v1",
          expiresAtMs: EXPECTED_EXPIRES_AT_MS,
          nowMs: NOW,
        });
        ledger.claimForSending(db, { idempotencyKey: created.idempotency_key, requestId: "prior-attempt", nowMs: NOW + 1 });
        ledger.markWorstCaseCharged(db, { idempotencyKey: created.idempotency_key, nowMs: NOW + 2 });
      } else if (status === "expired_worst_case") {
        // expiresAtMs precisa bater com o que o wrapper recalcularia no
        // retry (EXPECTED_EXPIRES_AT_MS -- faz parte do payload canonico),
        // entao o sweep varre usando um nowMs bem DEPOIS desse valor (nunca
        // via markWorstCaseCharged direto) para alcancar genuinamente o
        // status expired_worst_case, nao worst_case_charged.
        const created = policy.tryReserve(db, {
          idempotencyKey: "ar:test-assessment-key-001",
          correlationId: "test-assessment-key-001",
          model: "m",
          taskClass: "triage",
          estimatedMicrosUsd: 0,
          priceSource: null,
          priceSourceStatus: "unknown",
          pricingTableVersion: "unpriced-v1",
          expiresAtMs: EXPECTED_EXPIRES_AT_MS,
          nowMs: NOW,
        });
        ledger.claimForSending(db, { idempotencyKey: created.idempotency_key, requestId: "prior-attempt", nowMs: NOW + 100 });
        const swept = ledger.sweepExpiredReservations(db, { nowMs: EXPECTED_EXPIRES_AT_MS + 1 });
        assert.equal(swept.worstCaseCount, 1);
      }

      await assert.rejects(
        () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
        (err) => {
          assert.ok(err instanceof AlreadyAccountedNoResponseStoredError);
          assert.equal(err.fallbackAllowed, false);
          return true;
        }
      );
      assert.equal(transport.calls.length, 0);
    });
  });
}

const RELEASED_STATUSES = ["released"];
for (const status of RELEASED_STATUSES) {
  test(`runAgentRouterPrompt: retry sobre reserva terminal sem cobranca (status=${status}) -> AssessmentAlreadyReleasedError, transporte 0, fallbackAllowed=false`, async () => {
    await withTestDb(`released-${status}`, async (db, dbProvider) => {
      const transport = makeFakeTransport(async () => ({ text: "{}" }));
      const client = makeClient({ dbProvider, transport });

      const policy = createPolicy();
      const created = policy.tryReserve(db, {
        idempotencyKey: "ar:test-assessment-key-001",
        correlationId: "test-assessment-key-001",
        model: "m",
        taskClass: "triage",
        estimatedMicrosUsd: 0,
        priceSource: null,
        priceSourceStatus: "unknown",
        pricingTableVersion: "unpriced-v1",
        expiresAtMs: EXPECTED_EXPIRES_AT_MS,
        nowMs: NOW,
      });
      ledger.releaseBudget(db, { idempotencyKey: created.idempotency_key, nowMs: NOW + 1 });

      await assert.rejects(
        () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
        (err) => {
          assert.ok(err instanceof AssessmentAlreadyReleasedError);
          assert.equal(err.fallbackAllowed, false);
          return true;
        }
      );
      assert.equal(transport.calls.length, 0);
    });
  });
}

test("runAgentRouterPrompt: estado expired_released (via sweep real) -> AssessmentAlreadyReleasedError, transporte 0", async () => {
  await withTestDb("expired-released-via-sweep", async (db, dbProvider) => {
    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport });

    const policy = createPolicy();
    policy.tryReserve(db, {
      idempotencyKey: "ar:test-assessment-key-001",
      correlationId: "test-assessment-key-001",
      model: "m",
      taskClass: "triage",
      estimatedMicrosUsd: 0,
      priceSource: null,
      priceSourceStatus: "unknown",
      pricingTableVersion: "unpriced-v1",
      expiresAtMs: EXPECTED_EXPIRES_AT_MS,
      nowMs: NOW,
    });
    ledger.sweepExpiredReservations(db, { nowMs: EXPECTED_EXPIRES_AT_MS + 1 }); // sem intencao -> expired_released

    // nowFn do wrapper volta a NOW (igual a criacao original) -- o
    // expiresAtMs recalculado precisa bater com o valor ja persistido pra
    // o retry ser reconhecido (payload canonico), mesmo a linha ja tendo
    // sido varrida externamente acima com um nowMs mais tarde
    const client2 = makeClient({ dbProvider, transport, nowFn: () => NOW });
    await assert.rejects(
      () => client2.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
      (err) => {
        assert.ok(err instanceof AssessmentAlreadyReleasedError);
        assert.equal(err.status, "expired_released");
        return true;
      }
    );
    assert.equal(transport.calls.length, 0);
  });
});

// =====================================================================
// 9) Falha contabil pos-resposta -- sucesso ou falha do transporte,
// AccountingFailedAfterResponseError sempre fallbackAllowed=false
// =====================================================================

test("runAgentRouterPrompt: contabilizacao falha DEPOIS de transporte bem-sucedido -> AccountingFailedAfterResponseError, fallbackAllowed=false, causa preservada", async () => {
  await withTestDb("accounting-fails-after-success", async (db, dbProvider) => {
    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport });

    const originalMarkWorstCase = ledger.markWorstCaseCharged;
    const accountingError = new Error("disco cheio simulado");
    ledger.markWorstCaseCharged = () => {
      throw accountingError;
    };
    try {
      await assert.rejects(
        () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
        (err) => {
          assert.ok(err instanceof AccountingFailedAfterResponseError);
          assert.equal(err.fallbackAllowed, false);
          assert.equal(err.cause, accountingError);
          assert.equal(err.transportError, undefined); // transporte teve SUCESSO -- nao ha erro de transporte pra preservar
          return true;
        }
      );
    } finally {
      ledger.markWorstCaseCharged = originalMarkWorstCase;
    }
    assert.equal(transport.calls.length, 1); // o transporte FOI chamado -- so a contabilizacao pos-resposta falhou
  });
});

test("runAgentRouterPrompt: falha DUPLA -- transporte falha E contabilizacao falha -> AccountingFailedAfterResponseError primario, com .transportError preservando a causa de transporte original", async () => {
  await withTestDb("double-failure", async (db, dbProvider) => {
    const transportError = new Error("timeout simulado");
    const transport = makeFakeTransport(async () => {
      throw transportError;
    });
    const client = makeClient({ dbProvider, transport });

    const originalMarkWorstCase = ledger.markWorstCaseCharged;
    const accountingError = new Error("erro de integridade simulado");
    ledger.markWorstCaseCharged = () => {
      throw accountingError;
    };
    try {
      await assert.rejects(
        () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
        (err) => {
          assert.ok(err instanceof AccountingFailedAfterResponseError, "o erro CONTABIL deve ser o primario");
          assert.equal(err.fallbackAllowed, false);
          assert.equal(err.cause, accountingError);
          assert.equal(err.transportError, transportError, "a causa de TRANSPORTE deve estar preservada, nao perdida");
          return true;
        }
      );
    } finally {
      ledger.markWorstCaseCharged = originalMarkWorstCase;
    }
  });
});

// =====================================================================
// 10) Sweep falha -- propaga, zero reserva criada, zero transporte
// =====================================================================

test("runAgentRouterPrompt: sweepExpiredReservations falha -> erro propaga, ZERO reserva criada, ZERO chamada de transporte", async () => {
  await withTestDb("sweep-fails", async (db, dbProvider) => {
    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport });

    const originalSweep = ledger.sweepExpiredReservations;
    const sweepError = new Error("falha de sweep simulada");
    ledger.sweepExpiredReservations = () => {
      throw sweepError;
    };
    try {
      await assert.rejects(
        () => client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: baseMetadata() }),
        (err) => {
          assert.equal(err.fallbackAllowed, false);
          return true;
        }
      );
    } finally {
      ledger.sweepExpiredReservations = originalSweep;
    }
    assert.equal(countLedgerRows(db), 0);
    assert.equal(transport.calls.length, 0);
  });
});

// =====================================================================
// 11) Fronteira de dados -- o transporte NUNCA recebe metadata/ledger/db
// =====================================================================

test("runAgentRouterPrompt: o transporte injetado recebe EXATAMENTE {system,user,model,timeoutMs,gracefulShutdownMs,codexCommand} -- nunca metadata, ledger ou db", async () => {
  await withTestDb("transport-arg-boundary", async (db, dbProvider) => {
    const transport = makeFakeTransport(async () => ({ text: "{}" }));
    const client = makeClient({ dbProvider, transport, timeoutMs: 12_345, gracefulShutdownMs: 678 });

    await client.runAgentRouterPrompt({ system: "SYS", user: "USR", model: "gpt-5.6-sol", metadata: baseMetadata() });

    assert.equal(transport.calls.length, 1);
    const args = transport.calls[0];
    assert.deepEqual(Object.keys(args).sort(), ["codexCommand", "gracefulShutdownMs", "model", "system", "timeoutMs", "user"].sort());
    assert.equal(args.system, "SYS");
    assert.equal(args.user, "USR");
    assert.equal(args.model, "gpt-5.6-sol");
    assert.equal(args.timeoutMs, 12_345);
    assert.equal(args.gracefulShutdownMs, 678);
    assert.equal(args.codexCommand, "codex-fake-not-a-real-command");
    assert.equal(args.metadata, undefined);
    assert.equal(args.db, undefined);
    assert.equal(args.ledger, undefined);
  });
});

// =====================================================================
// 12) Higiene do modulo -- zero rede, zero Date.now() oculto
// =====================================================================

test("modulo: nenhum require REAL de rede/HTTP/lib/agentrouterClient (fora de comentarios que so explicam a decisao)", () => {
  const source = fs.readFileSync(require.resolve("../../lib/aiGateway/agentRouterBudgetedClient"), "utf8");
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!codeOnly.includes('require("http")'));
  assert.ok(!codeOnly.includes('require("https")'));
  assert.ok(!/require\([^)]*agentrouterClient/.test(codeOnly), "nao deveria haver nenhum require() real de lib/agentrouterClient.js");
});

test("modulo: nenhum USO REAL de Date.now() no codigo (fora de comentarios) -- relogio 100% injetavel via nowFn", () => {
  const source = fs.readFileSync(require.resolve("../../lib/aiGateway/agentRouterBudgetedClient"), "utf8");
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // a UNICA ocorrencia aceitavel e' o default do parametro nowFn = Date.now
  const matches = codeOnly.match(/Date\.now/g) || [];
  assert.equal(matches.length, 1, `esperava exatamente 1 ocorrencia (o default nowFn = Date.now), veio ${matches.length}`);
  assert.ok(codeOnly.includes("nowFn = Date.now"));
});

// =====================================================================
// 13) Concorrencia real -- 2 processos, arquivo real, transporte fake
// INLINE em cada script filho (zero rede)
// =====================================================================

function waitForLine(child, predicate, timeoutMs, lines) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando linha em stdout (${timeoutMs}ms). Linhas ate agora: ${JSON.stringify(lines)}`)), timeoutMs);
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        lines.push(line);
        if (predicate(line)) {
          clearTimeout(timer);
          resolve(line);
        }
      }
    });
  });
}

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

async function killAndWait(child, label, timeoutMs = 3000) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ja pode ter morrido */
    }
  }
  const { exited } = await waitForExit(child, timeoutMs);
  if (!exited) {
    throw new Error(`killAndWait: processo filho "${label}" (pid=${child.pid}) nao confirmou saida em ${timeoutMs}ms -- possivel processo orfao`);
  }
}

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

function raceScript(attemptId) {
  return `
const Database = require(${JSON.stringify(BETTER_SQLITE3_PATH)});
const budgetPolicyMod = require(${JSON.stringify(BUDGET_POLICY_MODULE_PATH)});
const budgetedClientMod = require(${JSON.stringify(BUDGETED_CLIENT_MODULE_PATH)});
const db = new Database(process.argv[1]);
db.pragma("busy_timeout = 5000");
const dbProvider = { getDb: () => db, closeDb: () => {} };
const policy = budgetPolicyMod.createAgentRouterBudgetPolicy({
  nominalCapMicrosUsd: 10000000, operationalCapMicrosUsd: 9000000, reconciliationMarginMicrosUsd: 1000000,
  categoryCapsMicrosUsd: { triage: 1800000, recurring_analysis: 3150000, research_innovation: 2700000, event_review_reserve: 1350000 },
  perCallLimitsMicrosUsd: { health_check: 100000, triage: 100000, normal_analysis: 200000, deep_analysis: 500000, research_innovation: 1000000, critical_review: 500000 },
  taskClassToCategory: { health_check: "triage", triage: "triage", normal_analysis: "recurring_analysis", deep_analysis: "recurring_analysis", research_innovation: "research_innovation", critical_review: "event_review_reserve" },
  observedMarginRatio: 0.5, minAbsoluteMicrosUsd: 10000, timezone: "America/Sao_Paulo", windowStartLocal: "00:00",
});
let transportCalls = 0;
const client = budgetedClientMod.createBudgetedAgentRouterClient({
  dbProvider, policy,
  realRunAgentRouterPrompt: async () => { transportCalls++; return { text: "{}", usage: null, threadId: null, meta: {} }; },
  timeoutMs: 60000, gracefulShutdownMs: 5000, codexCommand: "codex-fake",
  nowFn: () => ${NOW},
});
client.runAgentRouterPrompt({ system: "s", user: "u", model: "m", metadata: { assessmentKey: "race-key", attemptId: ${JSON.stringify(attemptId)}, taskClass: "triage" } })
  .then(() => process.stdout.write("OK:" + transportCalls + "\\n"))
  .catch((e) => process.stdout.write("ERR:" + e.constructor.name + ":" + transportCalls + "\\n"));
`;
}

test("concorrencia real: 2 processos disputando reserva+claim pela MESMA assessmentKey via o wrapper completo -- exatamente 1 chama o transporte fake, o total de chamadas de transporte e 1", async () => {
  const { dir, dbPath } = createTempDbFile("race-full-wrapper");
  let procA, procB;
  try {
    const setupDb = new Database(dbPath);
    runMigrations(setupDb, MIGRATIONS_DIR);
    setupDb.close();

    procA = spawn(process.execPath, ["-e", raceScript("attempt-A"), "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    procB = spawn(process.execPath, ["-e", raceScript("attempt-B"), "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

    const linesA = [];
    const linesB = [];
    const [resA, resB] = await Promise.all([
      waitForLine(procA, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesA),
      waitForLine(procB, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesB),
    ]);

    const results = [resA, resB];
    const okLines = results.filter((r) => r.startsWith("OK"));
    const errLines = results.filter((r) => r.startsWith("ERR"));
    assert.equal(okLines.length, 1, `esperava exatamente 1 OK, veio: ${JSON.stringify(results)}`);
    assert.equal(errLines.length, 1, `esperava exatamente 1 ERR, veio: ${JSON.stringify(results)}`);
    // o perdedor pode ser AlreadyClaimedError (corrida ao vivo no claim),
    // PriorAttemptAmbiguousError (viu a intencao ja registrada antes de
    // tentar), ou -- dado que o transporte fake resolve quase
    // instantaneamente -- AlreadyAccountedNoResponseStoredError (o vencedor
    // ja completou reserva+claim+transporte+worst_case_charged antes do
    // perdedor sequer terminar seu proprio tryReserve). Os 3 sao validos
    // dependendo do timing exato, todos com 0 chamadas de transporte e
    // fallbackAllowed=false.
    assert.ok(
      /ERR:(AlreadyClaimedError|PriorAttemptAmbiguousError|AlreadyAccountedNoResponseStoredError):0/.test(errLines[0]),
      `perdedor deveria ser um dos 3 erros esperados, com 0 chamadas de transporte, veio: ${errLines[0]}`
    );
    assert.equal(okLines[0], "OK:1");

    const finalDb = new Database(dbPath, { readonly: true });
    const count = finalDb.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_ledger WHERE idempotency_key = 'ar:race-key'").get().c;
    finalDb.close();
    assert.equal(count, 1, "so 1 linha, mesmo sob a corrida real reserva+claim");
  } finally {
    await cleanupAll(dir, [
      ["procA", procA],
      ["procB", procB],
    ]);
  }
});

// =====================================================================
// 14) Zero processos orfaos ao final desta suite
// =====================================================================

test("cleanup: killAndWait lanca erro explicito quando o processo nao confirma saida no timeout (nao falha silenciosamente)", async () => {
  const EventEmitter = require("events");
  const fakeChild = new EventEmitter();
  fakeChild.exitCode = null;
  fakeChild.signalCode = null;
  fakeChild.pid = 999998;
  fakeChild.kill = () => true; // nunca emite exit/close -- simula processo travado
  await assert.rejects(() => killAndWait(fakeChild, "fake-hung-process", 150), /nao confirmou saida/);
});
