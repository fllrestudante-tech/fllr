const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DEFAULT_DB_PATH = path.join(__dirname, "..", "..", "data", "market.db");
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function ensureMigrationsTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
}

function appliedVersions(db) {
  return new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version)
  );
}

function parseVersion(filename) {
  const match = filename.match(/^(\d+)_/);
  if (!match) throw new Error(`Nome de migração inválido (esperado NNNN_descricao.sql): ${filename}`);
  return parseInt(match[1], 10);
}

/**
 * Aplica migrações .sql pendentes de migrationsDir, em ordem, cada uma numa
 * transação própria (db.transaction do better-sqlite3 já faz rollback
 * automático se a função lançar). Idempotente: versão já registrada em
 * schema_migrations é pulada. Só pra frente -- sem down-migration, uma
 * migração errada se corrige com uma migração nova, não reescrevendo esta.
 */
function runMigrations(db, migrationsDir = MIGRATIONS_DIR) {
  ensureMigrationsTable(db);
  const applied = appliedVersions(db);
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = parseVersion(file);
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
    });

    try {
      applyMigration();
    } catch (err) {
      throw new Error(`Migração ${file} falhou, revertida: ${err.message}`);
    }
  }
}

function openDb(dbPath = DEFAULT_DB_PATH, migrationsDir = MIGRATIONS_DIR) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db, migrationsDir);
  return db;
}

// Grava um evento do event bus em events_log -- é o que dá ao Replay Engine
// futuro uma trilha completa e ordenada do que aconteceu, não só o estado
// final nas tabelas de domínio.
function insertEvent(db, event) {
  db.prepare("INSERT INTO events_log (uuid, event_name, payload, occurred_at) VALUES (@uuid, @eventName, @payload, @occurredAt)").run({
    uuid: event.uuid,
    eventName: event.eventName,
    payload: JSON.stringify(event.payload),
    occurredAt: event.occurredAt,
  });
}

module.exports = { openDb, runMigrations, insertEvent, DEFAULT_DB_PATH, MIGRATIONS_DIR };
