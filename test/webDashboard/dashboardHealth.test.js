const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { SERVICE_NAME, REQUIRED_TABLES, computeDashboardHealth } = require("../../lib/webDashboard/dashboardHealth");

function makeFixtureDb(label, { withTables = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-dashboardhealth-${label}-`));
  const dbPath = path.join(dir, "fixture.db");
  const db = new Database(dbPath);
  if (withTables) {
    for (const table of REQUIRED_TABLES) {
      db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    }
  }
  db.close();
  return { dir, dbPath };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Todos os testes deste arquivo que não mockam readSupervisorState
// explicitamente recebem esta fixture: todo processo "safe" (os únicos
// elegíveis fora do perfil demo) reportado como "running" -- sem isso,
// requiredProcessesAlive/systemReady dariam false por causa da MOCK
// (arquivo ausente), não do que o teste realmente quer provar.
const { ALL_CHILDREN } = require("../../lib/supervisorProfile");
function fakeAllRunning() {
  const state = {};
  for (const child of ALL_CHILDREN) {
    if (child.category === "safe") state[child.name] = { pid: 1, status: "running" };
  }
  return () => state;
}
function fakeNoProcesses() {
  return () => null;
}
function fakeKillSwitchBlocking() {
  return () => ({ state: "BLOCK_NEW_EXPOSURE", reason: null });
}
function fakeSnapshotAlwaysFresh() {
  return () => ({ capturedAtMs: Date.now() });
}
function fakeSnapshotAlwaysMissing() {
  return () => {
    const err = new Error("ausente");
    err.code = "SNAPSHOT_MISSING";
    throw err;
  };
}

function baseDeps(overrides = {}) {
  return {
    readSupervisorState: fakeAllRunning(),
    readEffectiveKillSwitchState: fakeKillSwitchBlocking(),
    readSnapshot: fakeSnapshotAlwaysMissing(),
    ...overrides,
  };
}

test("computeDashboardHealth: perfil safe + gate desligado + banco com a estrutura mínima + processos vivos -> ready, 200, status ok", () => {
  const { dir, dbPath } = makeFixtureDb("ready");
  try {
    const result = computeDashboardHealth({ env: {}, dbPath, ...baseDeps() });
    assert.equal(result.ready, true);
    assert.equal(result.httpStatus, 200);
    assert.deepEqual(result.body, {
      status: "ok",
      service: SERVICE_NAME,
      mode: "safe",
      executionMode: null,
      tradingExecutionEnabled: false,
      database: "ok",
      systemReady: true,
      newExposureAllowed: false,
      privateReadReady: false,
      snapshotFresh: false,
      blockReason: "profile_safe",
    });
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: perfil safe + processo obrigatório fora do ar -> systemReady=false, ready=false (200 exige TODOS os processos elegíveis rodando)", () => {
  const { dir, dbPath } = makeFixtureDb("safe-process-down");
  try {
    const result = computeDashboardHealth({ env: {}, dbPath, ...baseDeps({ readSupervisorState: fakeNoProcesses() }) });
    assert.equal(result.body.systemReady, false);
    assert.equal(result.ready, false);
    assert.equal(result.httpStatus, 503);
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: banco ausente -> não pronto, 503, database 'unavailable' (nunca lança)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-dashboardhealth-missing-"));
  const missingPath = path.join(dir, "nao-existe.db");
  try {
    const result = computeDashboardHealth({ env: {}, dbPath: missingPath, ...baseDeps() });
    assert.equal(result.ready, false);
    assert.equal(result.httpStatus, 503);
    assert.equal(result.body.database, "unavailable");
    assert.equal(result.body.status, "degraded");
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: banco existe mas SEM a estrutura mínima (tabelas ausentes) -> 'unavailable'", () => {
  const { dir, dbPath } = makeFixtureDb("no-tables", { withTables: false });
  try {
    const result = computeDashboardHealth({ env: {}, dbPath, ...baseDeps() });
    assert.equal(result.ready, false);
    assert.equal(result.httpStatus, 503);
    assert.equal(result.body.database, "unavailable");
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: arquivo corrompido (não é um SQLite válido) -> 'unavailable', nunca lança, nunca tenta reparo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-dashboardhealth-corrupt-"));
  const corruptPath = path.join(dir, "corrupt.db");
  fs.writeFileSync(corruptPath, "isto nao e um banco sqlite valido, so texto qualquer\0\0\0");
  try {
    assert.doesNotThrow(() => computeDashboardHealth({ env: {}, dbPath: corruptPath, ...baseDeps() }));
    const result = computeDashboardHealth({ env: {}, dbPath: corruptPath, ...baseDeps() });
    assert.equal(result.ready, false);
    assert.equal(result.httpStatus, 503);
    assert.equal(result.body.database, "unavailable");
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: gate financeiro LIGADO derruba a prontidão mesmo com banco/perfil perfeitos -- fail-closed, nunca mostra o valor bruto", () => {
  const { dir, dbPath } = makeFixtureDb("gate-on");
  try {
    const result = computeDashboardHealth({ env: { TRADING_EXECUTION_ENABLED: "true" }, dbPath, ...baseDeps() });
    assert.equal(result.ready, false);
    assert.equal(result.httpStatus, 503);
    assert.equal(result.body.status, "degraded");
    assert.equal(result.body.tradingExecutionEnabled, true); // boolean, nunca a string bruta
    assert.equal(typeof result.body.tradingExecutionEnabled, "boolean");
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: perfil não reconhecido -> mode 'invalid' (nunca o valor bruto recebido), não pronto", () => {
  const { dir, dbPath } = makeFixtureDb("invalid-profile");
  try {
    const result = computeDashboardHealth({ env: { SUPERVISOR_PROFILE: "producao-tudo-ligado-fake" }, dbPath, ...baseDeps() });
    assert.equal(result.body.mode, "invalid");
    assert.ok(!JSON.stringify(result.body).includes("producao-tudo-ligado-fake"));
    assert.equal(result.ready, false);
    assert.equal(result.httpStatus, 503);
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: a resposta pública nunca contém o caminho absoluto do banco, nem stack, nem chaves internas", () => {
  const { dir, dbPath } = makeFixtureDb("no-path-leak");
  try {
    const result = computeDashboardHealth({ env: {}, dbPath, ...baseDeps() });
    const serialized = JSON.stringify(result.body);
    assert.ok(!serialized.includes(dbPath));
    assert.ok(!serialized.includes(dir));
    assert.deepEqual(
      Object.keys(result.body).sort(),
      ["blockReason", "database", "executionMode", "mode", "newExposureAllowed", "privateReadReady", "service", "snapshotFresh", "status", "systemReady", "tradingExecutionEnabled"].sort()
    );
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: determinístico -- mesma entrada sempre produz a mesma saída", () => {
  const { dir, dbPath } = makeFixtureDb("deterministic");
  try {
    const r1 = computeDashboardHealth({ env: {}, dbPath, now: 1_756_000_000_000, ...baseDeps() });
    const r2 = computeDashboardHealth({ env: {}, dbPath, now: 1_756_000_000_000, ...baseDeps() });
    assert.deepEqual(r1, r2);
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: com os parâmetros default (sem env/dbPath explícitos) nunca lança", () => {
  assert.doesNotThrow(() => computeDashboardHealth());
});

// =====================================================================
// perfil demo + DEMO_EXECUTION_MODE=observe -- item 3 da fase
// "observação": saudável PRA OBSERVAÇÃO (200) nunca significa pronto pra
// negociar (newExposureAllowed continua false, kill switch continua
// bloqueando).
// =====================================================================

const VALID_DEMO_ENV = { SUPERVISOR_PROFILE: "demo", BYBIT_DEMO: "true", BYBIT_TESTNET: "false", BYBIT_API_KEY: "fake-key-not-a-real-secret", BYBIT_API_SECRET: "fake-secret-not-real", DEMO_PRIVATE_READ_ENABLED: "true", DEMO_EXECUTION_MODE: "observe" };

function fakeAllRunningIncludingBot() {
  const state = {};
  for (const child of ALL_CHILDREN) state[child.name] = { pid: 1, status: "running" };
  return () => state;
}

test("computeDashboardHealth: demo + observe, tudo saudável -> ready=200, mas newExposureAllowed continua false (saudável pra OBSERVAÇÃO, não pra negociar)", () => {
  const { dir, dbPath } = makeFixtureDb("demo-observe-ready");
  try {
    const result = computeDashboardHealth({
      env: VALID_DEMO_ENV,
      dbPath,
      readSupervisorState: fakeAllRunningIncludingBot(),
      readEffectiveKillSwitchState: fakeKillSwitchBlocking(),
      readSnapshot: fakeSnapshotAlwaysFresh(),
    });
    assert.equal(result.ready, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.mode, "demo");
    assert.equal(result.body.executionMode, "observe");
    assert.equal(result.body.systemReady, true);
    assert.equal(result.body.newExposureAllowed, false, "healthy != pronto pra negociar -- essa é exatamente a separação exigida");
    assert.equal(result.body.privateReadReady, true);
    assert.equal(result.body.snapshotFresh, true);
    assert.equal(result.body.blockReason, "execution_mode_observe");
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: demo + observe, snapshot stale -> não pronto (503), blockReason permanece sobre execution_mode, sistema ainda pode estar systemReady", () => {
  const { dir, dbPath } = makeFixtureDb("demo-observe-stale-snapshot");
  try {
    const result = computeDashboardHealth({
      env: VALID_DEMO_ENV,
      dbPath,
      readSupervisorState: fakeAllRunningIncludingBot(),
      readEffectiveKillSwitchState: fakeKillSwitchBlocking(),
      readSnapshot: fakeSnapshotAlwaysMissing(),
    });
    assert.equal(result.ready, false);
    assert.equal(result.httpStatus, 503);
    assert.equal(result.body.snapshotFresh, false);
    assert.equal(result.body.systemReady, true, "systemReady é independente de snapshot -- processo/banco continuam saudáveis mesmo com snapshot velho");
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: demo + observe, DEMO_PRIVATE_READ_ENABLED ausente -> privateReadReady=false, não pronto", () => {
  const { dir, dbPath } = makeFixtureDb("demo-observe-no-read");
  try {
    const result = computeDashboardHealth({
      env: { ...VALID_DEMO_ENV, DEMO_PRIVATE_READ_ENABLED: undefined },
      dbPath,
      readSupervisorState: fakeAllRunningIncludingBot(),
      readEffectiveKillSwitchState: fakeKillSwitchBlocking(),
      readSnapshot: fakeSnapshotAlwaysFresh(),
    });
    assert.equal(result.body.privateReadReady, false);
    assert.equal(result.ready, false);
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: demo + TRADING_EXECUTION_ENABLED=true (nunca deveria estar ligado em observe) -> não pronto, mesmo com o resto saudável", () => {
  const { dir, dbPath } = makeFixtureDb("demo-observe-trading-on");
  try {
    const result = computeDashboardHealth({
      env: { ...VALID_DEMO_ENV, TRADING_EXECUTION_ENABLED: "true" },
      dbPath,
      readSupervisorState: fakeAllRunningIncludingBot(),
      readEffectiveKillSwitchState: fakeKillSwitchBlocking(),
      readSnapshot: fakeSnapshotAlwaysFresh(),
    });
    assert.equal(result.ready, false);
    assert.equal(result.httpStatus, 503);
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: demo + modo 'execution' -> este endpoint nunca reconhece como pronto nesta fase (fail-closed, caminho ainda não coberto)", () => {
  const { dir, dbPath } = makeFixtureDb("demo-execution-mode");
  try {
    const result = computeDashboardHealth({
      env: { ...VALID_DEMO_ENV, DEMO_EXECUTION_MODE: "execution" },
      dbPath,
      readSupervisorState: fakeAllRunningIncludingBot(),
      readEffectiveKillSwitchState: fakeKillSwitchBlocking(),
      readSnapshot: fakeSnapshotAlwaysFresh(),
    });
    assert.equal(result.ready, false);
    assert.equal(result.body.executionMode, "execution");
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: demo + DEMO_EXECUTION_MODE ausente/inválido -> executionMode=null/valor, nunca pronto", () => {
  const { dir, dbPath } = makeFixtureDb("demo-mode-missing");
  try {
    const result = computeDashboardHealth({
      env: { ...VALID_DEMO_ENV, DEMO_EXECUTION_MODE: undefined },
      dbPath,
      readSupervisorState: fakeAllRunningIncludingBot(),
      readEffectiveKillSwitchState: fakeKillSwitchBlocking(),
      readSnapshot: fakeSnapshotAlwaysFresh(),
    });
    assert.equal(result.body.executionMode, null);
    assert.equal(result.ready, false);
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: kill switch ARMED_DEMO de verdade + TRADING_EXECUTION_ENABLED=true -> newExposureAllowed=true refletido honestamente (nunca escondido), mas ready ainda false em observe (TRADING_EXECUTION_ENABLED nunca deveria estar true aqui)", () => {
  const { dir, dbPath } = makeFixtureDb("armed-honest");
  try {
    const result = computeDashboardHealth({
      env: { ...VALID_DEMO_ENV, TRADING_EXECUTION_ENABLED: "true" },
      dbPath,
      readSupervisorState: fakeAllRunningIncludingBot(),
      readEffectiveKillSwitchState: () => ({ state: "ARMED_DEMO", reason: "manual" }),
      readSnapshot: fakeSnapshotAlwaysFresh(),
    });
    assert.equal(result.body.newExposureAllowed, true);
    assert.equal(result.body.blockReason, null);
    assert.equal(result.ready, false); // TRADING_EXECUTION_ENABLED=true nunca é "pronto" nesta fase, mesmo com exposição autorizada
  } finally {
    cleanup(dir);
  }
});
