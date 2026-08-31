const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { runMigrations, MIGRATIONS_DIR } = require("../../lib/infra/db");
const { createAgentRouterBudgetPolicy } = require("../../lib/aiGateway/agentRouterBudgetPolicy");
const {
  MissingEnvBudgetError,
  InvalidEnvBudgetValueError,
  IncoherentEnvBudgetError,
  MonthlyBudgetExhaustedError,
  resolveEnvBudgetMicrosUsd,
  buildDailyPolicyOptionsFromMicros,
  computeUtcMonthWindow,
  assertMonthlyBudgetAvailable,
} = require("../../lib/aiGateway/agentRouterEnvBudget");

const NOW = 1_756_000_000_000;

function createTempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-envbudget-${label}-`));
  const db = new Database(path.join(dir, "test.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db, MIGRATIONS_DIR);
  return { db, dir };
}

function insertLedgerRow(db, { createdAtMs, status, reservedMicrosUsd = 0, confirmedMicrosUsd = null }) {
  const key = `key-${createdAtMs}-${Math.random()}`;
  db.prepare(
    `INSERT INTO agentrouter_budget_ledger
      (idempotency_key, correlation_id, model, task_class, status,
       estimated_micros_usd, reserved_micros_usd, confirmed_micros_usd,
       price_source_status, pricing_table_version,
       budget_window_start_ms, budget_window_end_ms, budget_window_timezone,
       created_at, created_at_ms, expires_at_ms)
     VALUES (?, ?, 'gpt-5.6-sol', 'triage', ?,
       ?, ?, ?,
       'observed', 'v1',
       ?, ?, 'America/Sao_Paulo',
       ?, ?, ?)`
  ).run(
    key,
    `corr-${key}`,
    status,
    reservedMicrosUsd,
    reservedMicrosUsd,
    confirmedMicrosUsd,
    createdAtMs,
    createdAtMs + 24 * 60 * 60 * 1000,
    new Date(createdAtMs).toISOString(),
    createdAtMs,
    createdAtMs + 300_000
  );
}

function assertThrowsCode(fn, ErrorClass, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ErrorClass, `esperado ${ErrorClass.name}, veio ${err.constructor.name}: ${err.message}`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

// =====================================================================
// resolveEnvBudgetMicrosUsd -- fail-closed sobre AGENTROUTER_DAILY_BUDGET_USD
// / AGENTROUTER_MONTHLY_BUDGET_USD.
// =====================================================================

test("resolveEnvBudgetMicrosUsd: AGENTROUTER_DAILY_BUDGET_USD ausente -> MissingEnvBudgetError, zero orcamento resolvido", () => {
  assertThrowsCode(() => resolveEnvBudgetMicrosUsd({ AGENTROUTER_MONTHLY_BUDGET_USD: "50" }), MissingEnvBudgetError, "MISSING_ENV_BUDGET");
});

test("resolveEnvBudgetMicrosUsd: AGENTROUTER_MONTHLY_BUDGET_USD ausente -> MissingEnvBudgetError", () => {
  assertThrowsCode(() => resolveEnvBudgetMicrosUsd({ AGENTROUTER_DAILY_BUDGET_USD: "5" }), MissingEnvBudgetError, "MISSING_ENV_BUDGET");
});

test("resolveEnvBudgetMicrosUsd: AGENTROUTER_DAILY_BUDGET_USD vazio ('') -> MissingEnvBudgetError (tratado como ausente)", () => {
  assertThrowsCode(
    () => resolveEnvBudgetMicrosUsd({ AGENTROUTER_DAILY_BUDGET_USD: "", AGENTROUTER_MONTHLY_BUDGET_USD: "50" }),
    MissingEnvBudgetError,
    "MISSING_ENV_BUDGET"
  );
});

for (const bad of ["abc", "-5", "0", "1e10", "5,00", "NaN", "Infinity", " "]) {
  test(`resolveEnvBudgetMicrosUsd: AGENTROUTER_DAILY_BUDGET_USD=${JSON.stringify(bad)} -> InvalidEnvBudgetValueError`, () => {
    assertThrowsCode(
      () => resolveEnvBudgetMicrosUsd({ AGENTROUTER_DAILY_BUDGET_USD: bad, AGENTROUTER_MONTHLY_BUDGET_USD: "50" }),
      InvalidEnvBudgetValueError,
      "INVALID_ENV_BUDGET_VALUE"
    );
  });
}

test("resolveEnvBudgetMicrosUsd: mensal < diario -> IncoherentEnvBudgetError", () => {
  assertThrowsCode(
    () => resolveEnvBudgetMicrosUsd({ AGENTROUTER_DAILY_BUDGET_USD: "10", AGENTROUTER_MONTHLY_BUDGET_USD: "5" }),
    IncoherentEnvBudgetError,
    "INCOHERENT_ENV_BUDGET"
  );
});

test("resolveEnvBudgetMicrosUsd: diario=5, mensal=100 validos e coerentes -> micros corretos (BigInt-exato, sem ponto flutuante)", () => {
  const { dailyMicrosUsd, monthlyMicrosUsd } = resolveEnvBudgetMicrosUsd({ AGENTROUTER_DAILY_BUDGET_USD: "5", AGENTROUTER_MONTHLY_BUDGET_USD: "100" });
  assert.equal(dailyMicrosUsd, 5_000_000);
  assert.equal(monthlyMicrosUsd, 100_000_000);
});

test("resolveEnvBudgetMicrosUsd: mensal === diario (limite, nao estritamente maior) -> aceito, nao lanca", () => {
  const { dailyMicrosUsd, monthlyMicrosUsd } = resolveEnvBudgetMicrosUsd({ AGENTROUTER_DAILY_BUDGET_USD: "10", AGENTROUTER_MONTHLY_BUDGET_USD: "10" });
  assert.equal(dailyMicrosUsd, monthlyMicrosUsd);
});

// =====================================================================
// buildDailyPolicyOptionsFromMicros -- escala proporcional, alimenta
// createAgentRouterBudgetPolicy sem quebrar as invariantes existentes.
// =====================================================================

test("buildDailyPolicyOptionsFromMicros: teto diario igual ao default (10 USD) -> opcoes IDENTICAS ao DEFAULT_POLICY_CONFIG", () => {
  const { DEFAULT_POLICY_CONFIG } = require("../../lib/aiGateway/agentRouterBudgetPolicy");
  const opts = buildDailyPolicyOptionsFromMicros(10_000_000);
  assert.equal(opts.nominalCapMicrosUsd, DEFAULT_POLICY_CONFIG.nominalCapMicrosUsd);
  assert.equal(opts.operationalCapMicrosUsd, DEFAULT_POLICY_CONFIG.operationalCapMicrosUsd);
  assert.equal(opts.reconciliationMarginMicrosUsd, DEFAULT_POLICY_CONFIG.reconciliationMarginMicrosUsd);
  assert.deepEqual(opts.categoryCapsMicrosUsd, DEFAULT_POLICY_CONFIG.categoryCapsMicrosUsd);
});

test("buildDailyPolicyOptionsFromMicros: soma das categorias SEMPRE bate exatamente com operationalCapMicrosUsd, para vários tetos diarios (inclui valores que geram arredondamento feio)", () => {
  for (const dailyUsd of [1_000_000, 3_333_333, 7, 12_345_679, 1, 999_999_999]) {
    const opts = buildDailyPolicyOptionsFromMicros(dailyUsd);
    const sum = Object.values(opts.categoryCapsMicrosUsd).reduce((a, b) => a + b, 0);
    assert.equal(sum, opts.operationalCapMicrosUsd, `teto diario=${dailyUsd}: soma das categorias (${sum}) != operationalCap (${opts.operationalCapMicrosUsd})`);
  }
});

test("buildDailyPolicyOptionsFromMicros: opcoes resultantes SEMPRE constroem uma policy valida via createAgentRouterBudgetPolicy (fail-closed em dobro -- a propria validacao exaustiva da policy tambem passa)", () => {
  for (const dailyUsd of [10_000_000, 1_000_000, 100_000_000, 50_000, 3_333_333]) {
    const opts = buildDailyPolicyOptionsFromMicros(dailyUsd);
    assert.doesNotThrow(() => createAgentRouterBudgetPolicy(opts), `teto diario=${dailyUsd} deveria produzir uma policy valida`);
  }
});

test("buildDailyPolicyOptionsFromMicros: nenhum limite por-chamada excede o teto da propria categoria", () => {
  const opts = buildDailyPolicyOptionsFromMicros(3_333_333);
  const { DEFAULT_POLICY_CONFIG } = require("../../lib/aiGateway/agentRouterBudgetPolicy");
  for (const tc of Object.keys(opts.perCallLimitsMicrosUsd)) {
    const category = DEFAULT_POLICY_CONFIG.taskClassToCategory[tc];
    assert.ok(
      opts.perCallLimitsMicrosUsd[tc] <= opts.categoryCapsMicrosUsd[category],
      `perCallLimitsMicrosUsd.${tc} (${opts.perCallLimitsMicrosUsd[tc]}) excede categoryCapsMicrosUsd.${category} (${opts.categoryCapsMicrosUsd[category]})`
    );
  }
});

test("buildDailyPolicyOptionsFromMicros: teto diario invalido (<=0 ou nao-inteiro-seguro) -> InvalidEnvBudgetValueError", () => {
  assertThrowsCode(() => buildDailyPolicyOptionsFromMicros(0), InvalidEnvBudgetValueError, "INVALID_ENV_BUDGET_VALUE");
  assertThrowsCode(() => buildDailyPolicyOptionsFromMicros(-1), InvalidEnvBudgetValueError, "INVALID_ENV_BUDGET_VALUE");
});

// =====================================================================
// computeUtcMonthWindow -- mes calendario UTC puro.
// =====================================================================

test("computeUtcMonthWindow: instante no meio do mes -> janela do 1o dia 00:00 UTC ao 1o dia do mes seguinte 00:00 UTC", () => {
  const midMonth = Date.UTC(2026, 7, 15, 12, 30, 0); // 2026-08-15T12:30:00Z
  const { monthStartMs, monthEndMs } = computeUtcMonthWindow(midMonth);
  assert.equal(monthStartMs, Date.UTC(2026, 7, 1, 0, 0, 0, 0));
  assert.equal(monthEndMs, Date.UTC(2026, 8, 1, 0, 0, 0, 0));
});

test("computeUtcMonthWindow: dezembro -> mes seguinte vira janeiro do ano seguinte (overflow de mes tratado por Date.UTC)", () => {
  const inDecember = Date.UTC(2026, 11, 31, 23, 59, 59);
  const { monthStartMs, monthEndMs } = computeUtcMonthWindow(inDecember);
  assert.equal(monthStartMs, Date.UTC(2026, 11, 1, 0, 0, 0, 0));
  assert.equal(monthEndMs, Date.UTC(2027, 0, 1, 0, 0, 0, 0));
});

// =====================================================================
// assertMonthlyBudgetAvailable -- checagem independente contra o ledger
// real (SQLite temporario, mesmo padrao de agentRouterBudgetPolicy.test.js).
// =====================================================================

test("assertMonthlyBudgetAvailable: ledger vazio -> nao lanca (gasto=0 < qualquer teto positivo)", () => {
  const { db, dir } = createTempDb("empty");
  try {
    assert.doesNotThrow(() => assertMonthlyBudgetAvailable(db, { nowMs: NOW, monthlyCapMicrosUsd: 100_000_000 }));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assertMonthlyBudgetAvailable: gasto confirmado do mes corrente >= teto -> MonthlyBudgetExhaustedError (fail-closed)", () => {
  const { db, dir } = createTempDb("exhausted");
  try {
    const monthStart = computeUtcMonthWindow(NOW).monthStartMs;
    insertLedgerRow(db, { createdAtMs: monthStart + 1000, status: "confirmed", confirmedMicrosUsd: 60_000_000 });
    insertLedgerRow(db, { createdAtMs: monthStart + 2000, status: "confirmed", confirmedMicrosUsd: 40_000_000 });
    assertThrowsCode(() => assertMonthlyBudgetAvailable(db, { nowMs: NOW, monthlyCapMicrosUsd: 100_000_000 }), MonthlyBudgetExhaustedError, "MONTHLY_BUDGET_EXHAUSTED");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assertMonthlyBudgetAvailable: gasto abaixo do teto -> nao lanca", () => {
  const { db, dir } = createTempDb("below");
  try {
    const monthStart = computeUtcMonthWindow(NOW).monthStartMs;
    insertLedgerRow(db, { createdAtMs: monthStart + 1000, status: "confirmed", confirmedMicrosUsd: 10_000_000 });
    assert.doesNotThrow(() => assertMonthlyBudgetAvailable(db, { nowMs: NOW, monthlyCapMicrosUsd: 100_000_000 }));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assertMonthlyBudgetAvailable: gasto de um MES ANTERIOR nao conta pro mes corrente (janela calendario estrita)", () => {
  const { db, dir } = createTempDb("prevmonth");
  try {
    const prevMonthTs = computeUtcMonthWindow(NOW).monthStartMs - 60_000; // ultimo instante do mes anterior
    insertLedgerRow(db, { createdAtMs: prevMonthTs, status: "confirmed", confirmedMicrosUsd: 999_000_000 });
    assert.doesNotThrow(() => assertMonthlyBudgetAvailable(db, { nowMs: NOW, monthlyCapMicrosUsd: 100_000_000 }));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assertMonthlyBudgetAvailable: reservas ainda 'reserved' (nao confirmadas) TAMBEM contam pro teto mensal (conservador -- nunca subestima exposicao)", () => {
  const { db, dir } = createTempDb("reserved");
  try {
    const monthStart = computeUtcMonthWindow(NOW).monthStartMs;
    insertLedgerRow(db, { createdAtMs: monthStart + 1000, status: "reserved", reservedMicrosUsd: 100_000_000 });
    assertThrowsCode(() => assertMonthlyBudgetAvailable(db, { nowMs: NOW, monthlyCapMicrosUsd: 100_000_000 }), MonthlyBudgetExhaustedError, "MONTHLY_BUDGET_EXHAUSTED");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assertMonthlyBudgetAvailable: monthlyCapMicrosUsd invalido (<=0) -> InvalidEnvBudgetValueError, nunca deixa passar", () => {
  const { db, dir } = createTempDb("invalidcap");
  try {
    assertThrowsCode(() => assertMonthlyBudgetAvailable(db, { nowMs: NOW, monthlyCapMicrosUsd: 0 }), InvalidEnvBudgetValueError, "INVALID_ENV_BUDGET_VALUE");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
