const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");

function tmpDir(name) {
  const dir = path.join(os.tmpdir(), `bot-cripto10-migrations-${Date.now()}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("runMigrations: aplica migrações em ordem e registra em schema_migrations", () => {
  const dir = tmpDir("ordem");
  fs.writeFileSync(path.join(dir, "0001_criar_a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");
  fs.writeFileSync(path.join(dir, "0002_criar_b.sql"), "CREATE TABLE b (id INTEGER PRIMARY KEY);");

  const db = new Database(":memory:");
  runMigrations(db, dir);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes("a"));
  assert.ok(tables.includes("b"));

  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
  assert.deepEqual(versions, [1, 2]);

  fs.rmSync(dir, { recursive: true, force: true });
  db.close();
});

test("runMigrations: idempotente -- rodar de novo não reaplica nem duplica", () => {
  const dir = tmpDir("idempotente");
  fs.writeFileSync(path.join(dir, "0001_criar_a.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");

  const db = new Database(":memory:");
  runMigrations(db, dir);
  assert.doesNotThrow(() => runMigrations(db, dir));

  const versions = db.prepare("SELECT version FROM schema_migrations").all();
  assert.equal(versions.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
  db.close();
});

test("runMigrations: migração inválida falha e faz rollback -- não fica registrada nem meio aplicada", () => {
  const dir = tmpDir("rollback");
  fs.writeFileSync(path.join(dir, "0001_ok.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");
  fs.writeFileSync(path.join(dir, "0002_quebrada.sql"), "CREATE TABLE b (id INTEGER PRIMARY KEY); SQL INVALIDO AQUI;");

  const db = new Database(":memory:");
  assert.throws(() => runMigrations(db, dir), /0002_quebrada\.sql falhou/);

  // migração 1 continua aplicada (rodou antes da quebrada)
  const versions = db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version);
  assert.deepEqual(versions, [1]);

  // migração 2 não deixou rastro nenhum -- nem a tabela b, que estava no mesmo arquivo antes do erro
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(!tables.includes("b"));

  fs.rmSync(dir, { recursive: true, force: true });
  db.close();
});
