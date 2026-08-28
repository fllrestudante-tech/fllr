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

test("computeDashboardHealth: perfil safe + gate desligado + banco com a estrutura mínima -> ready, 200, status ok", () => {
  const { dir, dbPath } = makeFixtureDb("ready");
  try {
    const result = computeDashboardHealth({ env: {}, dbPath });
    assert.equal(result.ready, true);
    assert.equal(result.httpStatus, 200);
    assert.deepEqual(result.body, {
      status: "ok",
      service: SERVICE_NAME,
      mode: "safe",
      tradingExecutionEnabled: false,
      database: "ok",
    });
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: banco ausente -> não pronto, 503, database 'unavailable' (nunca lança)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-dashboardhealth-missing-"));
  const missingPath = path.join(dir, "nao-existe.db");
  try {
    const result = computeDashboardHealth({ env: {}, dbPath: missingPath });
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
    const result = computeDashboardHealth({ env: {}, dbPath });
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
    assert.doesNotThrow(() => computeDashboardHealth({ env: {}, dbPath: corruptPath }));
    const result = computeDashboardHealth({ env: {}, dbPath: corruptPath });
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
    const result = computeDashboardHealth({ env: { TRADING_EXECUTION_ENABLED: "true" }, dbPath });
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
    const result = computeDashboardHealth({ env: { SUPERVISOR_PROFILE: "producao-tudo-ligado-fake" }, dbPath });
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
    const result = computeDashboardHealth({ env: {}, dbPath });
    const serialized = JSON.stringify(result.body);
    assert.ok(!serialized.includes(dbPath));
    assert.ok(!serialized.includes(dir));
    assert.deepEqual(Object.keys(result.body).sort(), ["database", "mode", "service", "status", "tradingExecutionEnabled"]);
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: determinístico -- mesma entrada sempre produz a mesma saída", () => {
  const { dir, dbPath } = makeFixtureDb("deterministic");
  try {
    const r1 = computeDashboardHealth({ env: {}, dbPath });
    const r2 = computeDashboardHealth({ env: {}, dbPath });
    assert.deepEqual(r1, r2);
  } finally {
    cleanup(dir);
  }
});

test("computeDashboardHealth: com os parâmetros default (sem env/dbPath explícitos) nunca lança", () => {
  assert.doesNotThrow(() => computeDashboardHealth());
});
