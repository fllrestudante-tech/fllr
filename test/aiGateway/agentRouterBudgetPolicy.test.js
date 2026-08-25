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
const policyMod = require("../../lib/aiGateway/agentRouterBudgetPolicy");

const {
  createAgentRouterBudgetPolicy,
  resolveLocalTimeToUtcMs,
  InvalidBudgetPolicyError,
  InvalidTimezoneError,
  InvalidWindowStartError,
  UnknownTaskClassError,
  UnrecognizedReserveFieldError,
  AtomicReservationUnavailableError,
  EstimatedCostExceedsPerCallLimitError,
  GlobalBudgetExhaustedError,
  CategoryBudgetExhaustedError,
} = policyMod;

const { IdempotencyConflictError, NegativeAmountError, InvalidFieldError, markSendIntent, confirmBudget, releaseBudget, markWorstCaseCharged, sweepExpiredReservations, reconcileDown } =
  ledger;

const BETTER_SQLITE3_PATH = require.resolve("better-sqlite3");
const POLICY_MODULE_PATH = require.resolve("../../lib/aiGateway/agentRouterBudgetPolicy");

const NOW = 1_756_000_000_000; // timestamp fixo arbitrario -- nenhum teste depende de Date.now() real
const DAY_MS = 24 * 60 * 60 * 1000;

// --- Infra de banco temporario isolado (mesmo padrao de agentRouterLedger.test.js) ---

function createTempDbFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-policy-${label}-`));
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

function rmDirSafe(dir) {
  return fsPromises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
function rmDirSafeSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
// Config de teste (mesma estrutura da DEFAULT_POLICY_CONFIG, mas isolada
// aqui para nao acoplar os testes aos defaults do modulo).
// =====================================================================

function testPolicyConfig(overrides = {}) {
  return {
    nominalCapMicrosUsd: 10_000_000,
    operationalCapMicrosUsd: 9_000_000,
    reconciliationMarginMicrosUsd: 1_000_000,
    categoryCapsMicrosUsd: {
      triage: 1_800_000,
      recurring_analysis: 3_150_000,
      research_innovation: 2_700_000,
      event_review_reserve: 1_350_000,
    },
    perCallLimitsMicrosUsd: {
      health_check: 100_000,
      triage: 100_000,
      normal_analysis: 200_000,
      deep_analysis: 500_000,
      research_innovation: 1_000_000,
      critical_review: 500_000,
    },
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

function baseTryReserveOpts(overrides = {}) {
  return {
    idempotencyKey: "policy-key-001",
    correlationId: "corr-001",
    model: "gpt-5.6-sol",
    taskClass: "triage",
    estimatedMicrosUsd: 50_000,
    priceSource: "observed_sample_20260824",
    priceSourceStatus: "observed",
    pricingTableVersion: "v1",
    expiresAtMs: NOW + 5 * 60 * 1000,
    nowMs: NOW,
    ...overrides,
  };
}

// =====================================================================
// 1) createAgentRouterBudgetPolicy -- validacoes de configuracao (fail-fast
// na criacao, nunca em tempo de chamada)
// =====================================================================

test("createAgentRouterBudgetPolicy: config valida (default de teste) cria sem erro", () => {
  assert.doesNotThrow(() => createAgentRouterBudgetPolicy(testPolicyConfig()));
});

test("config: rejeita caps/limites negativos ou nao-inteiros", () => {
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ nominalCapMicrosUsd: -1 })), InvalidBudgetPolicyError);
  assertThrowsCode(
    () => createAgentRouterBudgetPolicy(testPolicyConfig({ categoryCapsMicrosUsd: { ...testPolicyConfig().categoryCapsMicrosUsd, triage: -1 } })),
    InvalidBudgetPolicyError
  );
  assertThrowsCode(
    () => createAgentRouterBudgetPolicy(testPolicyConfig({ perCallLimitsMicrosUsd: { ...testPolicyConfig().perCallLimitsMicrosUsd, triage: 1000.5 } })),
    InvalidBudgetPolicyError
  );
});

test("config: teto operacional nao pode exceder o teto nominal", () => {
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ operationalCapMicrosUsd: 10_000_001 })), InvalidBudgetPolicyError);
});

test("config: margem de reconciliacao deve ser exatamente nominal - operacional", () => {
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ reconciliationMarginMicrosUsd: 999_999 })), InvalidBudgetPolicyError);
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ reconciliationMarginMicrosUsd: 1_000_001 })), InvalidBudgetPolicyError);
});

test("config: soma das categorias deve ser exatamente igual ao teto operacional", () => {
  const cfg = testPolicyConfig();
  assertThrowsCode(
    () => createAgentRouterBudgetPolicy({ ...cfg, categoryCapsMicrosUsd: { ...cfg.categoryCapsMicrosUsd, triage: cfg.categoryCapsMicrosUsd.triage + 1 } }),
    InvalidBudgetPolicyError
  );
  assertThrowsCode(
    () => createAgentRouterBudgetPolicy({ ...cfg, categoryCapsMicrosUsd: { ...cfg.categoryCapsMicrosUsd, triage: cfg.categoryCapsMicrosUsd.triage - 1 } }),
    InvalidBudgetPolicyError
  );
});

test("config: taskClassToCategory deve referenciar categoria existente", () => {
  const cfg = testPolicyConfig();
  assertThrowsCode(
    () => createAgentRouterBudgetPolicy({ ...cfg, taskClassToCategory: { ...cfg.taskClassToCategory, triage: "categoria_inexistente" } }),
    InvalidBudgetPolicyError
  );
});

test("config: toda classe em perCallLimitsMicrosUsd precisa de categoria correspondente, e vice-versa", () => {
  const cfg = testPolicyConfig();
  const { triage, ...perCallSemTriage } = cfg.perCallLimitsMicrosUsd;
  assertThrowsCode(() => createAgentRouterBudgetPolicy({ ...cfg, perCallLimitsMicrosUsd: perCallSemTriage }), InvalidBudgetPolicyError);

  const { triage: _t, ...mapSemTriage } = cfg.taskClassToCategory;
  assertThrowsCode(() => createAgentRouterBudgetPolicy({ ...cfg, taskClassToCategory: mapSemTriage }), InvalidBudgetPolicyError);
});

test("config: observedMarginRatio deve ser finito e estar entre 0 e 1", () => {
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ observedMarginRatio: -0.1 })), InvalidBudgetPolicyError);
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ observedMarginRatio: 1.1 })), InvalidBudgetPolicyError);
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ observedMarginRatio: NaN })), InvalidBudgetPolicyError);
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ observedMarginRatio: Infinity })), InvalidBudgetPolicyError);
});

test("config: minAbsoluteMicrosUsd deve ser inteiro seguro e positivo", () => {
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ minAbsoluteMicrosUsd: 0 })), InvalidBudgetPolicyError);
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ minAbsoluteMicrosUsd: -1 })), InvalidBudgetPolicyError);
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ minAbsoluteMicrosUsd: 1000.5 })), InvalidBudgetPolicyError);
});

test("config: timezone deve ser um IANA valido reconhecido pelo Intl", () => {
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ timezone: "Not/A_Real_Zone" })), InvalidTimezoneError);
});

test("config: windowStartLocal deve estar no formato HH:MM", () => {
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ windowStartLocal: "25:00" })), InvalidBudgetPolicyError);
  assertThrowsCode(() => createAgentRouterBudgetPolicy(testPolicyConfig({ windowStartLocal: "9am" })), InvalidBudgetPolicyError);
});

test("config: objetos de configuracao sao copiados/congelados -- mutar o objeto original apos a criacao nao afeta a politica", () => {
  withTestDb("config-frozen", (db) => {
    const cfg = testPolicyConfig();
    const policy = createAgentRouterBudgetPolicy(cfg);
    cfg.categoryCapsMicrosUsd.triage = 1; // muta o objeto ORIGINAL apos a criacao
    cfg.perCallLimitsMicrosUsd.triage = 1;

    // se a politica tivesse guardado so a referencia (sem copiar), o teto por
    // chamada de "triage" agora seria 1 e esta reserva de 50_000 falharia
    const row = policy.tryReserve(db, baseTryReserveOpts());
    assert.equal(row.status, "reserved");
    assert.equal(row.reserved_micros_usd, 50_000);
  });
});

// =====================================================================
// 2) resolveLocalTimeToUtcMs / computeWindow -- DST-safe, enumeracao de
// offsets
// =====================================================================

test("resolveLocalTimeToUtcMs: horario normal (sem DST envolvido) resolve corretamente", () => {
  // America/Sao_Paulo nao observa horario de verao desde 2019 -- UTC-3 o ano todo
  const ms = resolveLocalTimeToUtcMs(2026, 6, 15, 12, 0, "America/Sao_Paulo");
  assert.equal(ms, Date.UTC(2026, 5, 15, 15, 0, 0));
});

test("resolveLocalTimeToUtcMs: gap de DST 'spring forward' (horario inexistente) e rejeitado", () => {
  // America/New_York, 2026-03-08: 02:00 -> 03:00 (offset -5 -> -4). 02:30 nunca existe.
  assertThrowsCode(() => resolveLocalTimeToUtcMs(2026, 3, 8, 2, 30, "America/New_York"), InvalidWindowStartError);
});

test("resolveLocalTimeToUtcMs: ambiguidade de DST 'fall back' -- prova concreta com os DOIS candidatos UTC reais do America/New_York", () => {
  // America/New_York, 2026-11-01: 02:00 EDT -> 01:00 EST (offset -4 -> -5, transicao as 06:00Z).
  // 01:30 local ocorre 2x: 05:30Z (ainda EDT) e 06:30Z (ja EST).
  const candidateEdt = Date.UTC(2026, 10, 1, 5, 30); // 1793511000000
  const candidateEst = Date.UTC(2026, 10, 1, 6, 30); // 1793514600000
  assert.notEqual(candidateEdt, candidateEst);

  // confirma que os DOIS candidatos realmente formatam de volta para "01:30" em America/New_York
  const fmt = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  assert.equal(fmt(candidateEdt), "01:30");
  assert.equal(fmt(candidateEst), "01:30");

  // um algoritmo que so amostra 2 offsets (naiveUtc e o offset resultante) nunca
  // alcancaria candidateEst (posterior a transicao) partindo de naiveUtc=01:30
  // tratado como UTC (muito antes das 06:00Z reais) -- o algoritmo de enumeracao
  // por faixa ampla encontra os dois e REJEITA a ambiguidade, em vez de escolher
  // silenciosamente candidateEdt.
  assertThrowsCode(() => resolveLocalTimeToUtcMs(2026, 11, 1, 1, 30, "America/New_York"), InvalidWindowStartError);
});

test("resolveLocalTimeToUtcMs: horario fora de qualquer transicao de DST (bem antes/depois) nunca e ambiguo nem inexistente", () => {
  assert.doesNotThrow(() => resolveLocalTimeToUtcMs(2026, 11, 1, 12, 0, "America/New_York")); // bem depois da transicao
  assert.doesNotThrow(() => resolveLocalTimeToUtcMs(2026, 10, 31, 12, 0, "America/New_York")); // bem antes
});

test("computeWindow: janela normal de 00:00 a 00:00 do dia seguinte (America/Sao_Paulo, sem DST)", () => {
  const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
  const nowMs = Date.UTC(2026, 7, 25, 15, 0, 0); // 2026-08-25 12:00 America/Sao_Paulo (UTC-3)
  const { windowStartMs, windowEndMs, timezone } = policy.computeWindow(nowMs);
  assert.equal(windowStartMs, Date.UTC(2026, 7, 25, 3, 0, 0)); // 2026-08-25 00:00 -03:00
  assert.equal(windowEndMs, Date.UTC(2026, 7, 26, 3, 0, 0)); // 2026-08-26 00:00 -03:00
  assert.equal(windowEndMs - windowStartMs, DAY_MS);
  assert.equal(timezone, "America/Sao_Paulo");
});

test("computeWindow: fim da janela usa a PROXIMA data civil, mesmo cruzando virada de mes", () => {
  const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
  const nowMs = Date.UTC(2027, 0, 31, 15, 0, 0); // 2027-01-31 12:00 America/Sao_Paulo
  const { windowStartMs, windowEndMs } = policy.computeWindow(nowMs);
  assert.equal(new Date(windowStartMs).toISOString(), "2027-01-31T03:00:00.000Z");
  assert.equal(new Date(windowEndMs).toISOString(), "2027-02-01T03:00:00.000Z"); // fevereiro, nao "31/01+1 invalido"
});

test("computeWindow: windowStartLocal != 00:00 -- nowMs antes do horario de inicio de hoje usa a janela de ontem->hoje", () => {
  const policy = createAgentRouterBudgetPolicy(testPolicyConfig({ windowStartLocal: "09:00" }));
  // 2026-08-25 08:00 America/Sao_Paulo -- ainda antes das 09:00 de hoje
  const nowMs = Date.UTC(2026, 7, 25, 11, 0, 0);
  const { windowStartMs, windowEndMs } = policy.computeWindow(nowMs);
  assert.equal(new Date(windowStartMs).toISOString(), "2026-08-24T12:00:00.000Z"); // 24/08 09:00 -03:00
  assert.equal(new Date(windowEndMs).toISOString(), "2026-08-25T12:00:00.000Z"); // 25/08 09:00 -03:00
  assert.ok(nowMs >= windowStartMs && nowMs < windowEndMs);
});

test("computeWindow: windowStartLocal != 00:00 -- nowMs depois do horario de inicio de hoje usa a janela de hoje->amanha", () => {
  const policy = createAgentRouterBudgetPolicy(testPolicyConfig({ windowStartLocal: "09:00" }));
  const nowMs = Date.UTC(2026, 7, 25, 13, 0, 0); // 10:00 America/Sao_Paulo -- depois das 09:00
  const { windowStartMs, windowEndMs } = policy.computeWindow(nowMs);
  assert.equal(new Date(windowStartMs).toISOString(), "2026-08-25T12:00:00.000Z");
  assert.equal(new Date(windowEndMs).toISOString(), "2026-08-26T12:00:00.000Z");
  assert.ok(nowMs >= windowStartMs && nowMs < windowEndMs);
});

test("computeWindow: rejeita nowMs invalido (negativo/decimal)", () => {
  const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
  assertThrowsCode(() => policy.computeWindow(-1), InvalidBudgetPolicyError);
  assertThrowsCode(() => policy.computeWindow(1000.5), InvalidBudgetPolicyError);
});

// =====================================================================
// 3) tryReserve -- validacao monetaria fail-closed (SEM clamp)
// =====================================================================

test("tryReserve: estimativa acima do teto por chamada da classe -> EstimatedCostExceedsPerCallLimitError, sem truncar", () => {
  withTestDb("money-estimate-over-limit", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    assertThrowsCode(
      () => policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 100_001 })), // teto de triage = 100_000
      EstimatedCostExceedsPerCallLimitError
    );
    assert.equal(countLedgerRows(db), 0); // rollback -- nada parcial
  });
});

test("tryReserve: minimo conservador calculado (minAbsoluteMicrosUsd) excedendo o teto da classe -> InvalidBudgetPolicyError, sem truncar", () => {
  withTestDb("money-minimum-over-limit", (db) => {
    // minAbsoluteMicrosUsd (300_000) > perCallLimitsMicrosUsd.triage (100_000) --
    // inconsistencia proposital, so se manifesta em priceSourceStatus=confirmed
    const policy = createAgentRouterBudgetPolicy(
      testPolicyConfig({
        minAbsoluteMicrosUsd: 300_000,
      })
    );
    assertThrowsCode(
      () => policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 1_000, priceSourceStatus: "confirmed" })),
      InvalidBudgetPolicyError
    );
    assert.equal(countLedgerRows(db), 0);
  });
});

test("tryReserve: rejeita estimatedMicrosUsd negativo (NegativeAmountError, propagado do ledger)", () => {
  withTestDb("money-negative", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    assertThrowsCode(() => policy.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: -1 })), NegativeAmountError);
    assert.equal(countLedgerRows(db), 0);
  });
});

test("tryReserve: rejeita estimatedMicrosUsd decimal (InvalidFieldError, propagado do ledger)", () => {
  withTestDb("money-decimal", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    assertThrowsCode(() => policy.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: 1000.5 })), InvalidFieldError);
    assert.equal(countLedgerRows(db), 0);
  });
});

test("tryReserve: rejeita estimatedMicrosUsd acima de Number.MAX_SAFE_INTEGER (InvalidFieldError)", () => {
  withTestDb("money-over-max-safe", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    assertThrowsCode(() => policy.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: Number.MAX_SAFE_INTEGER + 10 })), InvalidFieldError);
    assert.equal(countLedgerRows(db), 0);
  });
});

test("tryReserve: estimatedMicrosUsd = 0 e valido (zero e permitido para estimativa, diferente de minAbsoluteMicrosUsd que deve ser positivo)", () => {
  withTestDb("money-zero-estimate-ok", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    const row = policy.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: 0, priceSourceStatus: "confirmed" }));
    assert.equal(row.status, "reserved");
    assert.equal(row.estimated_micros_usd, 0);
    assert.equal(row.reserved_micros_usd, 10_000); // max(0, minAbsoluteMicrosUsd=10_000)
  });
});

test("tryReserve: taskClass desconhecida -> UnknownTaskClassError, sem linha parcial", () => {
  withTestDb("unknown-task-class", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    assertThrowsCode(() => policy.tryReserve(db, baseTryReserveOpts({ taskClass: "not_a_real_class" })), UnknownTaskClassError);
    assert.equal(countLedgerRows(db), 0);
  });
});

test("tryReserve: reservedMicrosUsd nunca fica abaixo de estimatedMicrosUsd (por construcao, max(estimado, minimo))", () => {
  withTestDb("reserved-never-below-estimate", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    const row = policy.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: 80_000, priceSourceStatus: "unknown" }));
    // priceSourceStatus=unknown -> minimo = teto inteiro da classe (100_000)
    assert.equal(row.reserved_micros_usd, 100_000);
    assert.ok(row.reserved_micros_usd >= row.estimated_micros_usd);
  });
});

// =====================================================================
// 4) tryReserve -- matriz de idempotencia corrigida
// =====================================================================

test("idempotencia: payload identico com CONFIG atual diferente ainda reconhece o retry (retorna a reserva original)", () => {
  withTestDb("idem-config-changed", (db) => {
    const policyA = createAgentRouterBudgetPolicy(testPolicyConfig({ minAbsoluteMicrosUsd: 10_000 }));
    const created = policyA.tryReserve(db, baseTryReserveOpts());

    const policyB = createAgentRouterBudgetPolicy(testPolicyConfig({ minAbsoluteMicrosUsd: 20_000, observedMarginRatio: 0.9 }));
    const retried = policyB.tryReserve(db, baseTryReserveOpts());

    assert.equal(retried.id, created.id);
    assert.equal(countLedgerRows(db), 1);
  });
});

test("idempotencia: payload identico apos a janela orcamentaria virar o dia ainda reconhece o retry (retorna a reserva original, sem recalcular janela)", () => {
  withTestDb("idem-window-rollover", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    const created = policy.tryReserve(db, baseTryReserveOpts({ nowMs: NOW }));

    const nextDayNowMs = NOW + DAY_MS + 3600_000; // bem depois da virada do dia civil
    const retried = policy.tryReserve(db, baseTryReserveOpts({ nowMs: nextDayNowMs }));

    assert.equal(retried.id, created.id);
    assert.equal(retried.budget_window_start_ms, created.budget_window_start_ms); // janela ORIGINAL preservada
    assert.equal(countLedgerRows(db), 1);
  });
});

test("idempotencia: priceSourceStatus diferente -> IdempotencyConflictError", () => {
  withTestDb("idem-price-status-conflict", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    policy.tryReserve(db, baseTryReserveOpts({ priceSourceStatus: "observed" }));
    assertThrowsCode(() => policy.tryReserve(db, baseTryReserveOpts({ priceSourceStatus: "confirmed" })), IdempotencyConflictError);
  });
});

test("idempotencia: estimatedMicrosUsd diferente -> conflito", () => {
  withTestDb("idem-estimate-conflict", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    policy.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: 50_000 }));
    assertThrowsCode(() => policy.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: 60_000 })), IdempotencyConflictError);
  });
});

test("idempotencia: model diferente -> conflito", () => {
  withTestDb("idem-model-conflict", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    policy.tryReserve(db, baseTryReserveOpts({ model: "gpt-5.6-sol" }));
    assertThrowsCode(() => policy.tryReserve(db, baseTryReserveOpts({ model: "other-model" })), IdempotencyConflictError);
  });
});

test("idempotencia: taskClass diferente -> conflito", () => {
  withTestDb("idem-taskclass-conflict", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage" }));
    assertThrowsCode(() => policy.tryReserve(db, baseTryReserveOpts({ taskClass: "normal_analysis" })), IdempotencyConflictError);
  });
});

// =====================================================================
// 5) tryReserve -- tetos global e por categoria
// =====================================================================

test("tryReserve: respeita o teto GLOBAL (operacional) -- exatamente no teto sucede, 1 micro acima falha", () => {
  withTestDb("global-cap-boundary", (db) => {
    const policy = createAgentRouterBudgetPolicy(
      testPolicyConfig({
        operationalCapMicrosUsd: 100_000,
        nominalCapMicrosUsd: 101_000,
        reconciliationMarginMicrosUsd: 1_000,
        categoryCapsMicrosUsd: { triage: 100_000, recurring_analysis: 0, research_innovation: 0, event_review_reserve: 0 },
      })
    );
    const row = policy.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: 100_000, priceSourceStatus: "confirmed" }));
    assert.equal(row.reserved_micros_usd, 100_000);

    assertThrowsCode(
      () => policy.tryReserve(db, baseTryReserveOpts({ idempotencyKey: "policy-key-002", estimatedMicrosUsd: 1, priceSourceStatus: "confirmed" })),
      GlobalBudgetExhaustedError
    );
    assert.equal(countLedgerRows(db), 1); // segunda tentativa nao deixou linha parcial
  });
});

test("tryReserve: respeita o teto por CATEGORIA mesmo com folga no teto global", () => {
  withTestDb("category-cap-boundary", (db) => {
    const policy = createAgentRouterBudgetPolicy(
      testPolicyConfig({
        operationalCapMicrosUsd: 9_000_000,
        categoryCapsMicrosUsd: { triage: 100_000, recurring_analysis: 8_900_000, research_innovation: 0, event_review_reserve: 0 },
      })
    );
    policy.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: 100_000, priceSourceStatus: "confirmed" })); // esgota a categoria "triage" (100_000)

    // ha MUITO orcamento global sobrando (8.9M), mas a categoria "triage" esta zerada
    assertThrowsCode(
      () => policy.tryReserve(db, baseTryReserveOpts({ idempotencyKey: "policy-key-002", taskClass: "triage", estimatedMicrosUsd: 1, priceSourceStatus: "confirmed" })),
      CategoryBudgetExhaustedError
    );
  });
});

test("tryReserve: categorias diferentes nao competem entre si", () => {
  withTestDb("category-independent", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 100_000, priceSourceStatus: "confirmed" }));
    const row = policy.tryReserve(
      db,
      baseTryReserveOpts({ idempotencyKey: "policy-key-002", taskClass: "research_innovation", estimatedMicrosUsd: 500_000, priceSourceStatus: "confirmed" })
    );
    assert.equal(row.status, "reserved");
  });
});

// =====================================================================
// 6) getState
// =====================================================================

test("getState: reflete totais globais e por categoria apos reservas", () => {
  withTestDb("get-state", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 40_000, priceSourceStatus: "confirmed" }));
    policy.tryReserve(db, baseTryReserveOpts({ idempotencyKey: "k2", taskClass: "research_innovation", estimatedMicrosUsd: 300_000, priceSourceStatus: "confirmed" }));

    const state = policy.getState(db, NOW);
    assert.equal(state.globalTotalMicrosUsd, 340_000);
    assert.equal(state.byCategory.triage.totalMicrosUsd, 40_000);
    assert.equal(state.byCategory.research_innovation.totalMicrosUsd, 300_000);
    assert.equal(state.byCategory.recurring_analysis.totalMicrosUsd, 0);
    assert.equal(state.operationalCapMicrosUsd, 9_000_000);
  });
});

// =====================================================================
// 7) Concorrencia real -- dois processos separados, arquivo real
// =====================================================================

const RACE_POLICY_CONFIG_SRC = `{
  nominalCapMicrosUsd: 251000, operationalCapMicrosUsd: 250000, reconciliationMarginMicrosUsd: 1000,
  categoryCapsMicrosUsd: { triage: 250000 },
  perCallLimitsMicrosUsd: { triage: 200000 },
  taskClassToCategory: { triage: "triage" },
  observedMarginRatio: 0, minAbsoluteMicrosUsd: 1,
  timezone: "America/Sao_Paulo", windowStartLocal: "00:00",
}`;

function policyChildScript(idempotencyKey, estimatedMicrosUsd) {
  return `
const Database = require(${JSON.stringify(BETTER_SQLITE3_PATH)});
const policyMod = require(${JSON.stringify(POLICY_MODULE_PATH)});
const dbPath = process.argv[1];
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
const policy = policyMod.createAgentRouterBudgetPolicy(${RACE_POLICY_CONFIG_SRC});
try {
  policy.tryReserve(db, {
    idempotencyKey: ${JSON.stringify(idempotencyKey)}, correlationId: "corr", model: "gpt-5.6-sol", taskClass: "triage",
    estimatedMicrosUsd: ${estimatedMicrosUsd}, priceSource: "confirmed_sample", priceSourceStatus: "confirmed", pricingTableVersion: "v1",
    expiresAtMs: ${NOW + 300000}, nowMs: ${NOW},
  });
  process.stdout.write("OK\\n");
} catch (e) {
  process.stdout.write("ERR:" + e.constructor.name + "\\n");
}
`;
}

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

test("concorrencia real: mesma idempotencyKey de 2 processos via tryReserve -- so 1 reserva resulta (retry-safe)", async () => {
  const { dir, dbPath } = createTempDbFile("policy-concurrency-idem");
  let procA, procB;
  try {
    const setupDb = new Database(dbPath);
    runMigrations(setupDb, MIGRATIONS_DIR);
    setupDb.close();

    const script = policyChildScript("shared-policy-key", 150000);
    procA = spawn(process.execPath, ["-e", script, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    procB = spawn(process.execPath, ["-e", script, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

    const linesA = [];
    const linesB = [];
    const [resA, resB] = await Promise.all([
      waitForLine(procA, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesA),
      waitForLine(procB, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesB),
    ]);

    assert.ok([resA, resB].every((r) => r.startsWith("OK") || r.startsWith("ERR")));

    const finalDb = new Database(dbPath, { readonly: true });
    const count = finalDb.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_ledger WHERE idempotency_key = 'shared-policy-key'").get().c;
    finalDb.close();
    assert.equal(count, 1);
  } finally {
    await cleanupAll(dir, [
      ["procA", procA],
      ["procB", procB],
    ]);
  }
});

test("concorrencia real: 2 chaves diferentes disputando o MESMO teto de categoria -- so 1 sucede, prova de atomicidade check-then-reserve sem corrida", async () => {
  const { dir, dbPath } = createTempDbFile("policy-concurrency-cap");
  let procA, procB;
  try {
    const setupDb = new Database(dbPath);
    runMigrations(setupDb, MIGRATIONS_DIR);
    setupDb.close();

    // categoria/teto global = 250000 micros; cada processo tenta reservar
    // 150000 -- juntos excederiam (300000 > 250000), entao so um pode vencer
    const scriptA = policyChildScript("race-key-A", 150000);
    const scriptB = policyChildScript("race-key-B", 150000);
    procA = spawn(process.execPath, ["-e", scriptA, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    procB = spawn(process.execPath, ["-e", scriptB, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

    const linesA = [];
    const linesB = [];
    const [resA, resB] = await Promise.all([
      waitForLine(procA, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesA),
      waitForLine(procB, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesB),
    ]);

    const results = [resA, resB];
    const okCount = results.filter((r) => r === "OK").length;
    const exhaustedCount = results.filter((r) => r === "ERR:GlobalBudgetExhaustedError" || r === "ERR:CategoryBudgetExhaustedError").length;

    assert.equal(okCount, 1, `esperava exatamente 1 OK, veio: ${JSON.stringify(results)}`);
    assert.equal(exhaustedCount, 1, `esperava exatamente 1 erro de orcamento esgotado, veio: ${JSON.stringify(results)}`);

    const finalDb = new Database(dbPath, { readonly: true });
    const total = finalDb.prepare(`SELECT SUM(${ledger.EFFECTIVE_MICROS_USD_CASE_SQL}) AS t FROM agentrouter_budget_ledger`).get().t;
    finalDb.close();
    assert.equal(total, 150000, "total efetivo nunca pode ter excedido o teto de 250000 mesmo sob corrida -- neste caso exatamente 1 reserva de 150000 vingou");
  } finally {
    await cleanupAll(dir, [
      ["procA", procA],
      ["procB", procB],
    ]);
  }
});

// =====================================================================
// 8) Contrato da API -- reservedMicrosUsd/requestedReserveMicrosUsd NUNCA
// aceitos do chamador (documentado no JSDoc de tryReserve). Campos
// desconhecidos sao REJEITADOS, nunca silenciosamente ignorados.
// =====================================================================

test("tryReserve: campo desconhecido 'requestedReserveMicrosUsd' e REJEITADO -- nunca silenciosamente usado para reduzir a reserva", () => {
  withTestDb("unrecognized-requested-reserve", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    assertThrowsCode(() => policy.tryReserve(db, { ...baseTryReserveOpts(), requestedReserveMicrosUsd: 1 }), UnrecognizedReserveFieldError);
    assert.equal(countLedgerRows(db), 0);
  });
});

test("tryReserve: campo desconhecido 'reservedMicrosUsd' e REJEITADO -- confirma que o valor reservado nunca vem do chamador", () => {
  withTestDb("unrecognized-reserved", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    assertThrowsCode(() => policy.tryReserve(db, { ...baseTryReserveOpts(), reservedMicrosUsd: 1 }), UnrecognizedReserveFieldError);
    assert.equal(countLedgerRows(db), 0);
  });
});

test("tryReserve: qualquer campo fora da lista permitida e rejeitado, nao so os monetarios conhecidos", () => {
  withTestDb("unrecognized-other", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    assertThrowsCode(() => policy.tryReserve(db, { ...baseTryReserveOpts(), someRandomField: 1 }), UnrecognizedReserveFieldError);
  });
});

test("retry da politica devolve reservedMicrosUsd ORIGINALMENTE PERSISTIDO, mesmo que a politica ATUAL (config diferente) calculasse outro valor", () => {
  withTestDb("retry-preserves-original-reserved", (db) => {
    const policyOriginal = createAgentRouterBudgetPolicy(testPolicyConfig({ minAbsoluteMicrosUsd: 10_000 }));
    const created = policyOriginal.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: 1_000, priceSourceStatus: "confirmed" }));
    assert.equal(created.reserved_micros_usd, 10_000); // max(1000, minAbsoluteMicrosUsd=10_000)

    const policyChanged = createAgentRouterBudgetPolicy(testPolicyConfig({ minAbsoluteMicrosUsd: 80_000 })); // calcularia 80_000 agora
    const retried = policyChanged.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: 1_000, priceSourceStatus: "confirmed" }));

    assert.equal(retried.id, created.id);
    assert.equal(retried.reserved_micros_usd, 10_000); // preserva o ORIGINAL, nao recalcula
    assert.equal(countLedgerRows(db), 1);
  });
});

test("reserveBudget() chamado DIRETO continua exigindo/comparando reservedMicrosUsd -- contrato do ledger inalterado (referencia cruzada)", () => {
  withTestDb("direct-reserveBudget-unchanged", (db) => {
    ledger.reserveBudget(db, baseReserveOptsForLedgerDirect());
    assertThrowsCode(() => ledger.reserveBudget(db, baseReserveOptsForLedgerDirect({ reservedMicrosUsd: 999 })), IdempotencyConflictError);
  });
});

function baseReserveOptsForLedgerDirect(overrides = {}) {
  return {
    idempotencyKey: "direct-ledger-key",
    correlationId: "corr-001",
    model: "gpt-5.6-sol",
    taskClass: "triage",
    estimatedMicrosUsd: 50_000,
    reservedMicrosUsd: 100_000,
    priceSource: "observed_sample",
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

// =====================================================================
// 9) Matriz de estados/categorias via politica -- getState() precisa
// refletir corretamente CADA status do ledger, registros fora da janela, e
// classes nao mapeadas (unmappedMicrosUsd)
// =====================================================================

test("getState: status 'reserved' contribui com reserved_micros_usd", () => {
  withTestDb("state-reserved", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 40_000, priceSourceStatus: "confirmed" }));
    const state = policy.getState(db, NOW);
    assert.equal(state.byCategory.triage.totalMicrosUsd, 40_000);
  });
});

test("getState: status 'confirmed' contribui com confirmed_micros_usd (nao mais o valor reservado)", () => {
  withTestDb("state-confirmed", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 40_000, priceSourceStatus: "confirmed" }));
    confirmBudget(db, { idempotencyKey: "policy-key-001", confirmedMicrosUsd: 12_345, nowMs: NOW + 1 });
    const state = policy.getState(db, NOW);
    assert.equal(state.byCategory.triage.totalMicrosUsd, 12_345);
  });
});

test("getState: status 'worst_case_charged' contribui com original_worst_case_micros_usd", () => {
  withTestDb("state-worstcase", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    const row = policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 40_000, priceSourceStatus: "confirmed" }));
    markSendIntent(db, { idempotencyKey: "policy-key-001", requestId: null, nowMs: NOW + 1 });
    markWorstCaseCharged(db, { idempotencyKey: "policy-key-001", nowMs: NOW + 2 });
    const state = policy.getState(db, NOW);
    assert.equal(state.byCategory.triage.totalMicrosUsd, row.reserved_micros_usd);
  });
});

test("getState: status 'expired_worst_case' contribui (crash apos intencao de envio, varredura de vencidas)", () => {
  withTestDb("state-expired-worstcase", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    const row = policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 40_000, priceSourceStatus: "confirmed", expiresAtMs: NOW + 1000 }));
    markSendIntent(db, { idempotencyKey: "policy-key-001", requestId: "r1", nowMs: NOW + 500 });
    sweepExpiredReservations(db, { nowMs: NOW + 2000 });
    const state = policy.getState(db, NOW);
    assert.equal(state.byCategory.triage.totalMicrosUsd, row.reserved_micros_usd);
  });
});

test("getState: 'released' e 'expired_released' contribuem ZERO (nunca contam para o orcamento)", () => {
  withTestDb("state-released-zero", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 40_000, priceSourceStatus: "confirmed" }));
    releaseBudget(db, { idempotencyKey: "policy-key-001", nowMs: NOW + 1 });

    policy.tryReserve(db, baseTryReserveOpts({ idempotencyKey: "k2", taskClass: "triage", estimatedMicrosUsd: 1_000, priceSourceStatus: "confirmed", expiresAtMs: NOW + 1000 }));
    sweepExpiredReservations(db, { nowMs: NOW + 2000 }); // sem send_intent -> expired_released

    const state = policy.getState(db, NOW);
    assert.equal(state.byCategory.triage.totalMicrosUsd, 0);
    assert.equal(state.globalTotalMicrosUsd, 0);
  });
});

test("getState: reconciliacao com valor efetivo -- usa o valor RECONCILIADO, nao o original pos worst_case_charged", () => {
  withTestDb("state-reconciled", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 90_000, priceSourceStatus: "confirmed" }));
    markSendIntent(db, { idempotencyKey: "policy-key-001", requestId: null, nowMs: NOW + 1 });
    markWorstCaseCharged(db, { idempotencyKey: "policy-key-001", nowMs: NOW + 2 });
    reconcileDown(db, { idempotencyKey: "policy-key-001", reconciledEffectiveMicrosUsd: 30_000, evidenceType: "agentrouter_panel", actorType: "operator", nowMs: NOW + 3 });
    const state = policy.getState(db, NOW);
    assert.equal(state.byCategory.triage.totalMicrosUsd, 30_000);
  });
});

test("getState: registros FORA da janela consultada nao sao somados", () => {
  withTestDb("state-outside-window", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    ledger.reserveBudget(db, {
      idempotencyKey: "outside-window-key",
      correlationId: "c",
      model: "m",
      taskClass: "triage",
      estimatedMicrosUsd: 5000,
      reservedMicrosUsd: 5000,
      priceSource: "s",
      priceSourceStatus: "confirmed",
      pricingTableVersion: "v1",
      budgetWindowStartMs: NOW + 10 * DAY_MS,
      budgetWindowEndMs: NOW + 11 * DAY_MS,
      budgetWindowTimezone: "America/Sao_Paulo",
      expiresAtMs: null,
      nowMs: NOW,
    });
    const state = policy.getState(db, NOW);
    assert.equal(state.globalTotalMicrosUsd, 0);
    assert.equal(state.byCategory.triage.totalMicrosUsd, 0);
  });
});

test("getState: classe historica NAO mapeada em taskClassToCategory conta em unmappedMicrosUsd, nao em nenhuma categoria", () => {
  withTestDb("state-unmapped", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    const { windowStartMs, windowEndMs } = policy.computeWindow(NOW);
    ledger.reserveBudget(db, {
      idempotencyKey: "legacy-key",
      correlationId: "c",
      model: "m",
      taskClass: "legacy_unmapped_class",
      estimatedMicrosUsd: 7000,
      reservedMicrosUsd: 7000,
      priceSource: "s",
      priceSourceStatus: "confirmed",
      pricingTableVersion: "v1",
      budgetWindowStartMs: windowStartMs,
      budgetWindowEndMs: windowEndMs,
      budgetWindowTimezone: "America/Sao_Paulo",
      expiresAtMs: null,
      nowMs: NOW,
    });
    // minAbsoluteMicrosUsd (10_000) > estimatedMicrosUsd (3000) -> reservedMicrosUsd vira 10_000
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 3000, priceSourceStatus: "confirmed" }));

    const state = policy.getState(db, NOW);
    assert.equal(state.unmappedMicrosUsd, 7000);
    assert.equal(state.byCategory.triage.totalMicrosUsd, 10_000);
    assert.equal(state.globalTotalMicrosUsd, 17_000);
  });
});

test("getState: invariante soma(categorias) + unmappedMicrosUsd === globalTotalMicrosUsd, com estados mistos", () => {
  withTestDb("state-invariant", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    const { windowStartMs, windowEndMs } = policy.computeWindow(NOW);
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 40_000, priceSourceStatus: "confirmed" }));
    policy.tryReserve(db, baseTryReserveOpts({ idempotencyKey: "k2", taskClass: "research_innovation", estimatedMicrosUsd: 300_000, priceSourceStatus: "confirmed" }));
    confirmBudget(db, { idempotencyKey: "k2", confirmedMicrosUsd: 250_000, nowMs: NOW + 1 });
    ledger.reserveBudget(db, {
      idempotencyKey: "legacy-key",
      correlationId: "c",
      model: "m",
      taskClass: "legacy_unmapped_class",
      estimatedMicrosUsd: 9000,
      reservedMicrosUsd: 9000,
      priceSource: "s",
      priceSourceStatus: "confirmed",
      pricingTableVersion: "v1",
      budgetWindowStartMs: windowStartMs,
      budgetWindowEndMs: windowEndMs,
      budgetWindowTimezone: "America/Sao_Paulo",
      expiresAtMs: null,
      nowMs: NOW,
    });

    const state = policy.getState(db, NOW);
    const categorySum = Object.values(state.byCategory).reduce((acc, c) => acc + c.totalMicrosUsd, 0);
    assert.equal(categorySum + state.unmappedMicrosUsd, state.globalTotalMicrosUsd);
    assert.equal(state.globalTotalMicrosUsd, 40_000 + 250_000 + 9_000);
  });
});

test("seguranca SQL: task_class e usado como parametro VINCULADO, nunca interpolado -- linha com sintaxe de injecao classica nao quebra nem vaza para outras categorias", () => {
  withTestDb("state-sql-injection-safe", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    const { windowStartMs, windowEndMs } = policy.computeWindow(NOW);
    // Insercao via SQL bruto: task_class NAO tem restricao de charset no
    // CHECK do banco (so length/CR/LF/NUL) -- so o JS (assertRestrictedString,
    // usado por reserveBudget/resolvePolicyIdempotentReservation) restringe o
    // charset. Isso prova que, MESMO que um valor "perigoso" chegue na tabela
    // por outro caminho, a soma por categoria da politica nao quebra nem
    // classifica errado.
    db.prepare(
      `INSERT INTO agentrouter_budget_ledger
        (idempotency_key, correlation_id, model, task_class, status, estimated_micros_usd, reserved_micros_usd,
         price_source_status, pricing_table_version, budget_window_start_ms, budget_window_end_ms, budget_window_timezone,
         created_at, created_at_ms)
       VALUES ('inj-key', 'c', 'm', @taskClass, 'reserved', 1234, 1234, 'confirmed', 'v1', @s, @e, 'America/Sao_Paulo', @iso, @nowMs)`
    ).run({ taskClass: "x' OR '1'='1", s: windowStartMs, e: windowEndMs, iso: new Date(NOW).toISOString(), nowMs: NOW });

    assert.doesNotThrow(() => policy.getState(db, NOW));
    const state = policy.getState(db, NOW);
    assert.equal(state.byCategory.triage.totalMicrosUsd, 0);
    assert.equal(state.byCategory.recurring_analysis.totalMicrosUsd, 0);
    assert.equal(state.byCategory.research_innovation.totalMicrosUsd, 0);
    assert.equal(state.byCategory.event_review_reserve.totalMicrosUsd, 0);
    assert.equal(state.unmappedMicrosUsd, 1234);
  });
});

// =====================================================================
// 10) Limites e configuracao -- tetos nominais/operacionais, margem,
// distribuicao por categoria, formulas de minimo por priceSourceStatus,
// imutabilidade profunda (nao so do objeto externo)
// =====================================================================

test("config: DEFAULT_POLICY_CONFIG tem teto operacional de exatamente US$9 (9_000_000 micros)", () => {
  assert.equal(policyMod.DEFAULT_POLICY_CONFIG.operationalCapMicrosUsd, 9_000_000);
});

test("config: DEFAULT_POLICY_CONFIG tem margem de reconciliacao de exatamente US$1 (nominal - operacional)", () => {
  const cfg = policyMod.DEFAULT_POLICY_CONFIG;
  assert.equal(cfg.reconciliationMarginMicrosUsd, 1_000_000);
  assert.equal(cfg.nominalCapMicrosUsd - cfg.operationalCapMicrosUsd, 1_000_000);
});

test("config: DEFAULT_POLICY_CONFIG -- soma das 4 categorias e exatamente US$9 (9_000_000 micros)", () => {
  const caps = policyMod.DEFAULT_POLICY_CONFIG.categoryCapsMicrosUsd;
  const sum = Object.values(caps).reduce((a, b) => a + b, 0);
  assert.equal(sum, 9_000_000);
  assert.equal(sum, policyMod.DEFAULT_POLICY_CONFIG.operationalCapMicrosUsd);
});

test("margem de reconciliacao (US$1) nunca e consumida por tryReserve -- teto sempre verificado contra o operacional, nunca o nominal", () => {
  withTestDb("margin-never-consumed", (db) => {
    const policy = createAgentRouterBudgetPolicy(
      testPolicyConfig({
        operationalCapMicrosUsd: 9_000_000,
        nominalCapMicrosUsd: 10_000_000,
        reconciliationMarginMicrosUsd: 1_000_000,
        categoryCapsMicrosUsd: { triage: 9_000_000, recurring_analysis: 0, research_innovation: 0, event_review_reserve: 0 },
        perCallLimitsMicrosUsd: { ...testPolicyConfig().perCallLimitsMicrosUsd, triage: 9_000_000 },
      })
    );
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 9_000_000, priceSourceStatus: "confirmed" }));
    // qualquer coisa a mais tentaria consumir dentro da faixa de margem (9M-10M) -- deve falhar
    assertThrowsCode(
      () => policy.tryReserve(db, baseTryReserveOpts({ idempotencyKey: "k2", taskClass: "triage", estimatedMicrosUsd: 1, priceSourceStatus: "confirmed" })),
      GlobalBudgetExhaustedError
    );
    const state = policy.getState(db, NOW);
    assert.equal(state.globalTotalMicrosUsd, 9_000_000); // nunca ultrapassa o operacional -- a margem fica intocada
  });
});

test("categorias: SEM emprestimo -- categoria zerada rejeita mesmo com outra categoria totalmente livre e folga global", () => {
  withTestDb("no-cross-category-borrow", (db) => {
    const policy = createAgentRouterBudgetPolicy(
      testPolicyConfig({ categoryCapsMicrosUsd: { triage: 100_000, recurring_analysis: 8_900_000, research_innovation: 0, event_review_reserve: 0 } })
    );
    policy.tryReserve(db, baseTryReserveOpts({ estimatedMicrosUsd: 100_000, priceSourceStatus: "confirmed" })); // esgota triage
    assertThrowsCode(
      () => policy.tryReserve(db, baseTryReserveOpts({ idempotencyKey: "k2", taskClass: "triage", estimatedMicrosUsd: 1, priceSourceStatus: "confirmed" })),
      CategoryBudgetExhaustedError
    );
    // recurring_analysis continua livre -- prova que nao existe mecanismo de "emprestimo" implicito de triage
    const row = policy.tryReserve(db, baseTryReserveOpts({ idempotencyKey: "k3", taskClass: "normal_analysis", estimatedMicrosUsd: 100_000, priceSourceStatus: "confirmed" }));
    assert.equal(row.status, "reserved");
  });
});

test("priceSourceStatus='unknown' reserva o teto COMPLETO da classe (pior caso absoluto)", () => {
  withTestDb("unknown-full-limit", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    const row = policy.tryReserve(db, baseTryReserveOpts({ taskClass: "deep_analysis", estimatedMicrosUsd: 1, priceSourceStatus: "unknown" }));
    assert.equal(row.reserved_micros_usd, 500_000); // teto de deep_analysis
  });
});

test("priceSourceStatus='observed' aplica a margem conservadora (ceil(teto * observedMarginRatio))", () => {
  withTestDb("observed-margin-math", (db) => {
    // teto de triage=100_000, observedMarginRatio=0.5 -> margem=50_000;
    // estimativa (1_000) e minAbsolute (10_000) sao ambos menores -> minimo = 50_000
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    const row = policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 1_000, priceSourceStatus: "observed" }));
    assert.equal(row.reserved_micros_usd, 50_000);
  });
});

test("priceSourceStatus='confirmed' continua submetido ao teto operacional/por categoria -- nao e isento de checagem de orcamento", () => {
  withTestDb("confirmed-still-capped", (db) => {
    const policy = createAgentRouterBudgetPolicy(
      testPolicyConfig({ categoryCapsMicrosUsd: { triage: 50_000, recurring_analysis: 8_950_000, research_innovation: 0, event_review_reserve: 0 } })
    );
    policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 50_000, priceSourceStatus: "confirmed" })); // esgota
    assertThrowsCode(
      () => policy.tryReserve(db, baseTryReserveOpts({ idempotencyKey: "k2", taskClass: "triage", estimatedMicrosUsd: 1, priceSourceStatus: "confirmed" })),
      CategoryBudgetExhaustedError
    );
  });
});

test("config: objeto TOP-LEVEL mutado apos a criacao nao afeta a politica ja criada", () => {
  withTestDb("config-toplevel-immutable", (db) => {
    const cfg = testPolicyConfig();
    const policy = createAgentRouterBudgetPolicy(cfg);
    cfg.operationalCapMicrosUsd = 1; // reatribuicao no nivel externo
    const row = policy.tryReserve(db, baseTryReserveOpts());
    assert.equal(row.status, "reserved"); // nao foi afetado pela mutacao externa
  });
});

test("config: objetos ANINHADOS (categoryCapsMicrosUsd/perCallLimitsMicrosUsd/taskClassToCategory) mutados DIRETAMENTE apos a criacao NAO afetam a politica -- imutabilidade nao e so do objeto externo", () => {
  withTestDb("config-nested-immutable", (db) => {
    const cfg = testPolicyConfig();
    const policy = createAgentRouterBudgetPolicy(cfg);
    cfg.categoryCapsMicrosUsd.triage = 1;
    cfg.perCallLimitsMicrosUsd.triage = 1;
    cfg.taskClassToCategory.triage = "recurring_analysis";
    const row = policy.tryReserve(db, baseTryReserveOpts({ taskClass: "triage", estimatedMicrosUsd: 50_000, priceSourceStatus: "confirmed" }));
    assert.equal(row.status, "reserved");
    assert.equal(row.reserved_micros_usd, 50_000); // teto ORIGINAL de triage (100_000) continua valendo
    const state = policy.getState(db, NOW);
    assert.equal(state.byCategory.triage.totalMicrosUsd, 50_000); // continua na categoria original, nao "recurring_analysis"
  });
});

// =====================================================================
// 11) Cobertura de janelas civis -- duracoes variaveis por DST (23h/24h/25h),
// fronteiras inclusiva/exclusiva, windowStartLocal != meia-noite, inicio
// inexistente/ambiguo em transicoes NA MEIA-NOITE, UTC, offsets fracionarios,
// ausencia de Date.now() oculto
// =====================================================================

function mkPolicyForTz(timezone, windowStartLocal = "00:00") {
  return createAgentRouterBudgetPolicy(testPolicyConfig({ timezone, windowStartLocal }));
}

test("computeWindow: janela de 23h no dia de 'spring forward' (America/New_York, 2026-03-08)", () => {
  const policy = mkPolicyForTz("America/New_York");
  const { windowStartMs, windowEndMs } = policy.computeWindow(Date.UTC(2026, 2, 8, 12, 0));
  assert.equal((windowEndMs - windowStartMs) / 3600000, 23);
});

test("computeWindow: janela de 24h em dia normal, sem DST envolvido", () => {
  const policy = mkPolicyForTz("America/New_York");
  const { windowStartMs, windowEndMs } = policy.computeWindow(Date.UTC(2026, 5, 15, 12, 0));
  assert.equal((windowEndMs - windowStartMs) / 3600000, 24);
});

test("computeWindow: janela de 25h no dia de 'fall back' (America/New_York, 2026-11-01)", () => {
  const policy = mkPolicyForTz("America/New_York");
  const { windowStartMs, windowEndMs } = policy.computeWindow(Date.UTC(2026, 10, 1, 12, 0));
  assert.equal((windowEndMs - windowStartMs) / 3600000, 25);
});

test("computeWindow: inicio INCLUSIVO -- nowMs exatamente igual a windowStartMs pertence a essa mesma janela", () => {
  const policy = mkPolicyForTz("America/Sao_Paulo");
  const w1 = policy.computeWindow(Date.UTC(2026, 7, 25, 3, 0, 0));
  const w1Again = policy.computeWindow(w1.windowStartMs);
  assert.equal(w1Again.windowStartMs, w1.windowStartMs);
  assert.equal(w1Again.windowEndMs, w1.windowEndMs);
});

test("computeWindow: fim EXCLUSIVO -- nowMs exatamente igual a windowEndMs pertence a PROXIMA janela, nao a atual", () => {
  const policy = mkPolicyForTz("America/Sao_Paulo");
  const w1 = policy.computeWindow(Date.UTC(2026, 7, 25, 3, 0, 0));
  const wAtEnd = policy.computeWindow(w1.windowEndMs);
  assert.equal(wAtEnd.windowStartMs, w1.windowEndMs);
  assert.notEqual(wAtEnd.windowStartMs, w1.windowStartMs);
});

test("computeWindow: instante 1ms ANTES da virada ainda pertence a janela atual", () => {
  const policy = mkPolicyForTz("America/Sao_Paulo");
  const w1 = policy.computeWindow(Date.UTC(2026, 7, 25, 3, 0, 0));
  const wJustBefore = policy.computeWindow(w1.windowEndMs - 1);
  assert.equal(wJustBefore.windowStartMs, w1.windowStartMs);
});

test("computeWindow: windowStartLocal != meia-noite (09:00), caso trivial sem DST -- ja coberto em detalhe nos testes de DST acima", () => {
  const policy = mkPolicyForTz("America/Sao_Paulo", "09:00");
  const w = policy.computeWindow(Date.UTC(2026, 7, 25, 13, 0, 0)); // 10:00 local
  assert.equal(new Date(w.windowStartMs).toISOString(), "2026-08-25T12:00:00.000Z");
});

test("computeWindow: inicio INEXISTENTE por transicao civil EXATAMENTE a meia-noite (America/Santiago, gap de 2026-09-06 00:00)", () => {
  const policy = mkPolicyForTz("America/Santiago", "00:00");
  // nowMs cai no dia civil 2026-09-06 em Santiago (spring-forward, offset -4->-3, meia-noite nao existe)
  assertThrowsCode(() => policy.computeWindow(Date.UTC(2026, 8, 6, 12, 0)), InvalidWindowStartError);
});

test("computeWindow: inicio AMBIGUO por transicao civil (America/Santiago, windowStartLocal=23:30, fall-back de 2026-04-04)", () => {
  const policy = mkPolicyForTz("America/Santiago", "23:30");
  // nowMs cai no dia civil 2026-04-04 em Santiago, bem antes das 23:30 ambiguas desse mesmo dia
  assertThrowsCode(() => policy.computeWindow(Date.UTC(2026, 3, 4, 12, 0)), InvalidWindowStartError);
});

test("computeWindow: meia-noite ADJACENTE a uma transicao de fall-back mas ela mesma NAO-ambigua resolve normalmente (America/Santiago, 2026-04-05 00:00)", () => {
  const policy = mkPolicyForTz("America/Santiago", "00:00");
  const w = policy.computeWindow(Date.UTC(2026, 3, 5, 12, 0));
  assert.equal(new Date(w.windowStartMs).toISOString(), "2026-04-05T04:00:00.000Z");
});

test("computeWindow: timezone UTC -- sempre 24h, offset zero, nenhuma transicao possivel", () => {
  const policy = mkPolicyForTz("UTC");
  const w = policy.computeWindow(Date.UTC(2026, 7, 25, 15, 0, 0));
  assert.equal(w.windowStartMs, Date.UTC(2026, 7, 25, 0, 0, 0));
  assert.equal(w.windowEndMs, Date.UTC(2026, 7, 26, 0, 0, 0));
  assert.equal((w.windowEndMs - w.windowStartMs) / 3600000, 24);
});

test("computeWindow: offset fracionario de 30min (Asia/Kolkata, UTC+5:30, sem DST)", () => {
  const policy = mkPolicyForTz("Asia/Kolkata");
  const w = policy.computeWindow(Date.UTC(2026, 5, 15, 10, 0, 0));
  assert.equal(new Date(w.windowStartMs).toISOString(), "2026-06-14T18:30:00.000Z");
  assert.equal((w.windowEndMs - w.windowStartMs) / 3600000, 24);
});

test("computeWindow: offset fracionario de 45min (Asia/Kathmandu, UTC+5:45, sem DST)", () => {
  const policy = mkPolicyForTz("Asia/Kathmandu");
  const w = policy.computeWindow(Date.UTC(2026, 5, 15, 10, 0, 0));
  assert.equal(new Date(w.windowStartMs).toISOString(), "2026-06-14T18:15:00.000Z");
  assert.equal((w.windowEndMs - w.windowStartMs) / 3600000, 24);
});

test("modulo: nenhum USO REAL de Date.now() no codigo (fora de comentarios) -- relogio 100% injetavel via nowMs", () => {
  const source = fs.readFileSync(require.resolve("../../lib/aiGateway/agentRouterBudgetPolicy"), "utf8");
  // remove comentarios de bloco e de linha antes de checar -- o proprio
  // modulo MENCIONA "Date.now()" em prosa dentro de um comentario para
  // documentar que ele NAO e usado, o que faria uma checagem ingenua falhar
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!codeOnly.includes("Date.now("), "Date.now() nao deveria aparecer como codigo real no modulo de politica -- relogio deve ser 100% injetavel via nowMs");
});

// =====================================================================
// 12) Falha ENTRE a soma/checagem de orcamento e a insercao final -- rollback
// completo, sem linha nem evento (mesma transacao unica, sem passo isolado)
// =====================================================================

test("tryReserve: falha no INSERT final (CHECK do banco, expiresAtMs < nowMs) DEPOIS dos checks de orcamento passarem -> rollback completo, sem linha nem evento", () => {
  withTestDb("insert-fails-after-checks", (db) => {
    const policy = createAgentRouterBudgetPolicy(testPolicyConfig());
    // tryReserve nao valida expiresAtMs contra nowMs (so ledger.reserveBudget
    // faz isso via CHECK do banco) -- os checks de orcamento (idempotencia,
    // classe, teto por chamada, teto global, teto por categoria) TODOS
    // passam normalmente, e so o INSERT final falha.
    assert.throws(() => policy.tryReserve(db, baseTryReserveOpts({ nowMs: NOW, expiresAtMs: NOW - 1000 })));
    assert.equal(countLedgerRows(db), 0);
    const eventCount = db.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_events").get().c;
    assert.equal(eventCount, 0);
    const state = policy.getState(db, NOW);
    assert.equal(state.globalTotalMicrosUsd, 0);
  });
});

// =====================================================================
// 13) Concorrencia real expandida -- o gate atomico da POLITICA e
// exercitado diretamente (nao apenas reaproveitando testes do ledger)
// =====================================================================

const POLICY_HOLDER_SCRIPT = `
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

function policyBusyWaiterScript(busyTimeoutMs, idempotencyKey) {
  return `
const Database = require(${JSON.stringify(BETTER_SQLITE3_PATH)});
const policyMod = require(${JSON.stringify(POLICY_MODULE_PATH)});
const dbPath = process.argv[1];
const db = new Database(dbPath);
db.pragma("busy_timeout = ${busyTimeoutMs}");
const policy = policyMod.createAgentRouterBudgetPolicy(${RACE_POLICY_CONFIG_SRC});
process.stdout.write("ATTEMPT_START\\n");
try {
  policy.tryReserve(db, {
    idempotencyKey: ${JSON.stringify(idempotencyKey)}, correlationId: "corr", model: "gpt-5.6-sol", taskClass: "triage",
    estimatedMicrosUsd: 100000, priceSource: "confirmed_sample", priceSourceStatus: "confirmed", pricingTableVersion: "v1",
    expiresAtMs: ${NOW + 300000}, nowMs: ${NOW},
  });
  process.stdout.write("OK\\n");
} catch (e) {
  process.stdout.write("ERR:" + e.constructor.name + ":" + (e.cause ? e.cause.code : "none") + "\\n");
}
`;
}

test("concorrencia real: retry IDENTICO concorrente (mesma idempotencyKey, mesmo payload) -- exatamente 1 linha e exatamente 1 evento RESERVED", async () => {
  const { dir, dbPath } = createTempDbFile("policy-concurrency-retry-event");
  let procA, procB;
  try {
    const setupDb = new Database(dbPath);
    runMigrations(setupDb, MIGRATIONS_DIR);
    setupDb.close();

    const script = policyChildScript("retry-event-key", 150000);
    procA = spawn(process.execPath, ["-e", script, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    procB = spawn(process.execPath, ["-e", script, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

    const linesA = [];
    const linesB = [];
    const [resA, resB] = await Promise.all([
      waitForLine(procA, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesA),
      waitForLine(procB, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesB),
    ]);
    assert.ok([resA, resB].every((r) => r === "OK"), `payload identico -- ambos deveriam suceder (retry reconhecido), veio: ${JSON.stringify([resA, resB])}`);

    const finalDb = new Database(dbPath, { readonly: true });
    const rowCount = finalDb.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_ledger WHERE idempotency_key = 'retry-event-key'").get().c;
    const ledgerId = finalDb.prepare("SELECT id FROM agentrouter_budget_ledger WHERE idempotency_key = 'retry-event-key'").get().id;
    const eventCount = finalDb.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_events WHERE ledger_id = ? AND event_type = 'RESERVED'").get(ledgerId).c;
    finalDb.close();
    assert.equal(rowCount, 1, "so 1 linha, mesmo com 2 processos tentando a mesma reserva simultaneamente");
    assert.equal(eventCount, 1, "so 1 evento RESERVED, sem duplicacao na trilha append-only");
  } finally {
    await cleanupAll(dir, [
      ["procA", procA],
      ["procB", procB],
    ]);
  }
});

test("concorrencia real: payload CONFLITANTE concorrente (mesma idempotencyKey, estimativas diferentes) -- 1 reserva e 1 IdempotencyConflictError, sem segunda linha/evento", async () => {
  const { dir, dbPath } = createTempDbFile("policy-concurrency-conflict-event");
  let procA, procB;
  try {
    const setupDb = new Database(dbPath);
    runMigrations(setupDb, MIGRATIONS_DIR);
    setupDb.close();

    procA = spawn(process.execPath, ["-e", policyChildScript("conflict-event-key", 150000), "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    procB = spawn(process.execPath, ["-e", policyChildScript("conflict-event-key", 160000), "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

    const linesA = [];
    const linesB = [];
    const [resA, resB] = await Promise.all([
      waitForLine(procA, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesA),
      waitForLine(procB, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesB),
    ]);
    const results = [resA, resB];
    assert.equal(results.filter((r) => r === "OK").length, 1, `esperava exatamente 1 OK, veio: ${JSON.stringify(results)}`);
    assert.equal(results.filter((r) => r === "ERR:IdempotencyConflictError").length, 1, `esperava exatamente 1 IdempotencyConflictError, veio: ${JSON.stringify(results)}`);

    const finalDb = new Database(dbPath, { readonly: true });
    const rowCount = finalDb.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_ledger WHERE idempotency_key = 'conflict-event-key'").get().c;
    const ledgerId = finalDb.prepare("SELECT id FROM agentrouter_budget_ledger WHERE idempotency_key = 'conflict-event-key'").get().id;
    const eventCount = finalDb.prepare("SELECT COUNT(*) AS c FROM agentrouter_budget_events WHERE ledger_id = ?").get(ledgerId).c;
    finalDb.close();
    assert.equal(rowCount, 1, "so a reserva vencedora persiste");
    assert.equal(eventCount, 1, "so o evento RESERVED original -- a tentativa conflitante nao gera evento nem linha");
  } finally {
    await cleanupAll(dir, [
      ["procA", procA],
      ["procB", procB],
    ]);
  }
});

test("concorrencia real: 2 categorias diferentes com saldo PROPRIO suficiente, mas juntas excederiam o teto GLOBAL (reduzido por consumo previo de classe nao mapeada) -- vencedor recebe erro orcamentario NOMEADO, nunca SQLITE_BUSY", async () => {
  const { dir, dbPath } = createTempDbFile("policy-concurrency-global-vs-category");
  let procA, procB;
  try {
    const setupDb = new Database(dbPath);
    runMigrations(setupDb, MIGRATIONS_DIR);

    const twoCatConfig = {
      nominalCapMicrosUsd: 251000,
      operationalCapMicrosUsd: 250000,
      reconciliationMarginMicrosUsd: 1000,
      categoryCapsMicrosUsd: { triage: 150000, research_innovation: 100000 },
      perCallLimitsMicrosUsd: { triage: 150000, research_innovation: 100000 },
      taskClassToCategory: { triage: "triage", research_innovation: "research_innovation" },
      observedMarginRatio: 0,
      minAbsoluteMicrosUsd: 1,
      timezone: "America/Sao_Paulo",
      windowStartLocal: "00:00",
    };
    const setupPolicy = createAgentRouterBudgetPolicy(twoCatConfig);
    const { windowStartMs, windowEndMs } = setupPolicy.computeWindow(NOW);
    // Consumo PREVIO de classe NAO mapeada: conta no teto GLOBAL mas em
    // NENHUMA categoria -- e o unico jeito de "duas categorias com saldo
    // proprio" poderem, juntas, exceder o global, ja que
    // soma(categoryCaps)===operationalCap por construcao (categorias sozinhas
    // NUNCA excedem o global quando as caps somam exatamente a ele).
    ledger.reserveBudget(setupDb, {
      idempotencyKey: "legacy-preexisting",
      correlationId: "c",
      model: "m",
      taskClass: "legacy_unmapped_class",
      estimatedMicrosUsd: 100000,
      reservedMicrosUsd: 100000,
      priceSource: "s",
      priceSourceStatus: "confirmed",
      pricingTableVersion: "v1",
      budgetWindowStartMs: windowStartMs,
      budgetWindowEndMs: windowEndMs,
      budgetWindowTimezone: "America/Sao_Paulo",
      expiresAtMs: null,
      nowMs: NOW,
    });
    setupDb.close();
    // headroom global restante = 250000-100000=150000; triage pede 100000
    // (dentro do proprio teto de 150000), research_innovation pede 100000
    // (dentro do proprio teto de 100000) -- juntos 200000 > 150000 de headroom global

    const configSrc = JSON.stringify(twoCatConfig);
    function twoCatChildScript(idempotencyKey, taskClass, estimatedMicrosUsd) {
      return `
const Database = require(${JSON.stringify(BETTER_SQLITE3_PATH)});
const policyMod = require(${JSON.stringify(POLICY_MODULE_PATH)});
const db = new Database(process.argv[1]);
db.pragma("busy_timeout = 5000");
const policy = policyMod.createAgentRouterBudgetPolicy(${configSrc});
try {
  policy.tryReserve(db, {
    idempotencyKey: ${JSON.stringify(idempotencyKey)}, correlationId: "corr", model: "gpt-5.6-sol", taskClass: ${JSON.stringify(taskClass)},
    estimatedMicrosUsd: ${estimatedMicrosUsd}, priceSource: "confirmed_sample", priceSourceStatus: "confirmed", pricingTableVersion: "v1",
    expiresAtMs: ${NOW + 300000}, nowMs: ${NOW},
  });
  process.stdout.write("OK\\n");
} catch (e) {
  process.stdout.write("ERR:" + e.constructor.name + "\\n");
}
`;
    }

    procA = spawn(process.execPath, ["-e", twoCatChildScript("global-race-A", "triage", 100000), "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    procB = spawn(process.execPath, ["-e", twoCatChildScript("global-race-B", "research_innovation", 100000), "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

    const linesA = [];
    const linesB = [];
    const [resA, resB] = await Promise.all([
      waitForLine(procA, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesA),
      waitForLine(procB, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, linesB),
    ]);
    const results = [resA, resB];
    assert.equal(results.filter((r) => r === "OK").length, 1, `esperava exatamente 1 OK, veio: ${JSON.stringify(results)}`);
    assert.equal(
      results.filter((r) => r === "ERR:GlobalBudgetExhaustedError").length,
      1,
      `perdedor deveria receber GlobalBudgetExhaustedError (nao CategoryBudgetExhaustedError nem SQLITE_BUSY) -- veio: ${JSON.stringify(results)}`
    );

    const finalDb = new Database(dbPath, { readonly: true });
    const globalTotal = finalDb.prepare(`SELECT SUM(${ledger.EFFECTIVE_MICROS_USD_CASE_SQL}) AS t FROM agentrouter_budget_ledger`).get().t;
    finalDb.close();
    assert.ok(globalTotal <= 250000, `soma global (${globalTotal}) nunca pode exceder o teto operacional (250000)`);
  } finally {
    await cleanupAll(dir, [
      ["procA", procA],
      ["procB", procB],
    ]);
  }
});

test("concorrencia real: lock mantido ALEM do busy_timeout gera AtomicReservationUnavailableError com a causa original (SQLITE_BUSY) preservada em .cause", async () => {
  const { dir, dbPath } = createTempDbFile("policy-busy-wrapped");
  let holder, waiter;
  try {
    const setupDb = new Database(dbPath);
    runMigrations(setupDb, MIGRATIONS_DIR);
    setupDb.close();

    holder = spawn(process.execPath, ["-e", POLICY_HOLDER_SCRIPT, "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    const holderLines = [];
    await waitForLine(holder, (l) => l === "LOCKED", 10000, holderLines);

    const waiterLines = [];
    waiter = spawn(process.execPath, ["-e", policyBusyWaiterScript(300, "busy-key"), "--", dbPath], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    await waitForLine(waiter, (l) => l === "ATTEMPT_START", 10000, waiterLines);

    const resultLine = await waitForLine(waiter, (l) => l.startsWith("OK") || l.startsWith("ERR"), 10000, waiterLines);

    // so libera A DEPOIS de ja termos o resultado de B, pra provar que B
    // falhou ANTES da liberacao (nao por coincidencia de timing)
    holder.stdin.write("COMMIT\n");
    await waitForLine(holder, (l) => l === "COMMITTED", 10000, holderLines);

    assert.equal(resultLine, "ERR:AtomicReservationUnavailableError:SQLITE_BUSY", `esperava erro atomico com causa SQLITE_BUSY, veio: ${resultLine}`);
  } finally {
    await cleanupAll(dir, [
      ["holder", holder],
      ["waiter", waiter],
    ]);
  }
});
