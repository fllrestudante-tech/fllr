// Backup Engine -- 3 níveis (daily/weekly/monthly), cada um com verificação
// de integridade real (abre a cópia e roda PRAGMA integrity_check, não só
// confia que o arquivo foi escrito) e um manifesto (backup.json) ao lado.
// Usa db.backup() do better-sqlite3 (seguro com WAL) -- nunca fs.copyFile
// bruto no .db, mesma disciplina já estabelecida no projeto pro
// lib/databaseHealth.js.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3");
const config = require("../config");

const PROJECT_ROOT = path.join(__dirname, "..");
const DEFAULT_BACKUPS_DIR = path.join(PROJECT_ROOT, "backups");
const DEFAULT_RUNTIME_DIR = path.join(PROJECT_ROOT, "runtime");

const LEVELS = ["daily", "weekly", "monthly"];
// monthly nunca é podado -- "snapshot permanente" pedido explicitamente.
const RETENTION_DAYS = { daily: 14, weekly: 60, monthly: null };

function dateStamp(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function computeChecksum(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

// PRAGMA integrity_check contra a CÓPIA (nunca o banco em produção) --
// abrir read-only evita disputar lock com quem ainda escreve no original.
function verifyBackupIntegrity(dbPath) {
  let copyDb;
  try {
    copyDb = new Database(dbPath, { readonly: true });
    const result = copyDb.pragma("integrity_check");
    const detail = result[0]?.integrity_check;
    return { ok: detail === "ok", detail };
  } catch (err) {
    return { ok: false, detail: err.message };
  } finally {
    if (copyDb) copyDb.close();
  }
}

function computeRowsPerTable(dbPath) {
  const copyDb = new Database(dbPath, { readonly: true });
  try {
    const tables = copyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const counts = {};
    for (const { name } of tables) {
      counts[name] = copyDb.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get().c;
    }
    return counts;
  } finally {
    copyDb.close();
  }
}

function getSchemaVersion(dbPath) {
  const copyDb = new Database(dbPath, { readonly: true });
  try {
    const row = copyDb.prepare("SELECT MAX(version) as v FROM schema_migrations").get();
    return row?.v ?? null;
  } catch {
    return null; // banco sem a tabela (não deveria acontecer, mas não fabrica valor)
  } finally {
    copyDb.close();
  }
}

function getSqliteVersion(dbPath) {
  const copyDb = new Database(dbPath, { readonly: true });
  try {
    return copyDb.prepare("SELECT sqlite_version() as v").get().v;
  } finally {
    copyDb.close();
  }
}

// Best-effort -- backup não deve falhar só porque não achou git (ex: rodando
// fora do repo por algum motivo). null é honesto nesse caso.
function getGitInfo(cwd = PROJECT_ROOT) {
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  return { commit: run(["rev-parse", "HEAD"]), tag: run(["describe", "--tags", "--always"]) };
}

function compressFile(filePath) {
  const gzPath = `${filePath}.gz`;
  const compressed = zlib.gzipSync(fs.readFileSync(filePath));
  fs.writeFileSync(gzPath, compressed);
  fs.rmSync(filePath);
  return gzPath;
}

function copyIfExists(srcPath, destPath) {
  if (fs.existsSync(srcPath)) fs.copyFileSync(srcPath, destPath);
}

/**
 * Cria 1 backup pro nível pedido. Idempotente: se já existe um manifesto pra
 * essa data/nível, pula (mesmo padrão "já existe? pula" dos outros
 * coletores) -- permite chamar isso a cada N minutos de um daemon sem se
 * preocupar com duplicar trabalho.
 */
async function runBackup({
  db,
  level,
  backupsDir = DEFAULT_BACKUPS_DIR,
  runtimeDir = DEFAULT_RUNTIME_DIR,
  statePath = config.paths.stateFile,
  tuningPath = config.paths.tuningFile,
  now = new Date(),
  alertManager = null,
}) {
  if (!LEVELS.includes(level)) throw new Error(`Nível de backup inválido: ${level}`);

  const dateStr = dateStamp(now);
  const destDir = path.join(backupsDir, level, dateStr);
  const manifestPath = path.join(destDir, "backup.json");

  if (fs.existsSync(manifestPath)) {
    return { skipped: true, reason: "backup já existe para esta data/nível", destDir };
  }

  fs.mkdirSync(destDir, { recursive: true });
  const dbDestPath = path.join(destDir, "market.db");

  try {
    await db.backup(dbDestPath);
  } catch (err) {
    if (alertManager) {
      await alertManager
        .fire(`backup_${level}`, "CRITICAL", `Backup Engine: falha ao copiar market.db (${level}) -- ${err.message}`)
        .catch(() => {});
    }
    return { skipped: false, valid: false, error: err.message, destDir };
  }

  copyIfExists(statePath, path.join(destDir, "state.json"));
  copyIfExists(tuningPath, path.join(destDir, "tuning.json"));
  if (fs.existsSync(runtimeDir)) {
    fs.cpSync(runtimeDir, path.join(destDir, "runtime"), { recursive: true });
  }

  const integrity = verifyBackupIntegrity(dbDestPath);
  const rowsPerTable = integrity.ok ? computeRowsPerTable(dbDestPath) : null;
  const schemaVersion = integrity.ok ? getSchemaVersion(dbDestPath) : null;
  const sqliteVersion = integrity.ok ? getSqliteVersion(dbDestPath) : null;
  const checksum = computeChecksum(dbDestPath); // checksum é do conteúdo bruto, antes de comprimir

  // Weekly/monthly são "compactados" por pedido explícito -- daily fica em
  // texto puro pra restaurar rápido no dia a dia.
  const compressed = level !== "daily";
  const finalDbFile = compressed ? path.basename(compressFile(dbDestPath)) : path.basename(dbDestPath);

  const gitInfo = getGitInfo();
  const manifest = {
    level,
    createdAt: now.toISOString(),
    version: require("../package.json").version,
    schemaVersion,
    sqliteVersion,
    commit: gitInfo.commit,
    tag: gitInfo.tag,
    compressed,
    dbFile: finalDbFile,
    checksum,
    rowsPerTable,
    valid: integrity.ok,
    integrityDetail: integrity.detail,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (!integrity.ok && alertManager) {
    await alertManager
      .fire(`backup_${level}_invalid`, "CRITICAL", `Backup Engine: backup ${level} de ${dateStr} falhou no integrity_check (${integrity.detail})`)
      .catch(() => {});
  }

  return { skipped: false, valid: integrity.ok, destDir, manifest };
}

/**
 * Decide se HOJE é dia de rodar este nível -- separado de runBackup() de
 * propósito: runBackup só sabe ser idempotente pra uma data exata, quem
 * decide "essa é a data certa pra um backup semanal/mensal" é o chamador
 * (scripts/backupDaemon.js). daily roda sempre (a idempotência por data já
 * evita duplicar no mesmo dia); weekly roda se o último rodou há 7+ dias;
 * monthly roda se o último foi num mês/ano calendário diferente do atual.
 */
function shouldRunLevel(level, latestManifest, now = new Date()) {
  if (level === "daily") return true;
  if (!latestManifest) return true;
  const last = new Date(latestManifest.createdAt);
  if (level === "weekly") return now.getTime() - last.getTime() >= 7 * 24 * 60 * 60 * 1000;
  if (level === "monthly") return now.getUTCFullYear() !== last.getUTCFullYear() || now.getUTCMonth() !== last.getUTCMonth();
  return false;
}

/**
 * Remove backups mais velhos que a retenção do nível. monthly nunca é
 * podado (retentionDays null pra esse nível) -- "snapshot permanente".
 */
function pruneOldBackups({ backupsDir = DEFAULT_BACKUPS_DIR, level, now = new Date() }) {
  const retentionDays = RETENTION_DAYS[level];
  if (retentionDays == null) return { pruned: [] };

  const levelDir = path.join(backupsDir, level);
  if (!fs.existsSync(levelDir)) return { pruned: [] };

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const pruned = [];
  for (const entry of fs.readdirSync(levelDir)) {
    const entryDate = Date.parse(entry);
    if (!Number.isNaN(entryDate) && entryDate < cutoff) {
      fs.rmSync(path.join(levelDir, entry), { recursive: true, force: true });
      pruned.push(entry);
    }
  }
  return { pruned };
}

function readLatestManifest({ backupsDir = DEFAULT_BACKUPS_DIR, level }) {
  const levelDir = path.join(backupsDir, level);
  if (!fs.existsSync(levelDir)) return null;
  const dates = fs.readdirSync(levelDir).filter((d) => fs.existsSync(path.join(levelDir, d, "backup.json"))).sort();
  if (dates.length === 0) return null;
  const latestDate = dates[dates.length - 1];
  const manifest = JSON.parse(fs.readFileSync(path.join(levelDir, latestDate, "backup.json"), "utf8"));
  return { ...manifest, dateDir: latestDate };
}

function computeDiskUsage(backupsDir = DEFAULT_BACKUPS_DIR) {
  if (!fs.existsSync(backupsDir)) return 0;
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(backupsDir);
  return total;
}

// Consumido por lib/healthChecks.js::checkBackup e pelo dashboard -- baseado
// no backup DIÁRIO (é o que tem SLA de "todo dia"; weekly/monthly são
// cadência mais longa e não deveriam disparar "stale" no dia a dia).
function getBackupHealth({ backupsDir = DEFAULT_BACKUPS_DIR, now = Date.now(), staleMs = 36 * 60 * 60 * 1000 } = {}) {
  const latest = readLatestManifest({ backupsDir, level: "daily" });
  if (!latest) {
    return { status: "never_ran", lastBackupAt: null, retentionDays: RETENTION_DAYS.daily, diskUsageBytes: computeDiskUsage(backupsDir) };
  }
  const ageMs = now - new Date(latest.createdAt).getTime();
  const status = !latest.valid ? "invalid" : ageMs > staleMs ? "stale" : "ok";
  return {
    status,
    lastBackupAt: latest.createdAt,
    ageMs,
    integrityOk: latest.valid,
    retentionDays: RETENTION_DAYS.daily,
    diskUsageBytes: computeDiskUsage(backupsDir),
  };
}

module.exports = {
  LEVELS,
  RETENTION_DAYS,
  runBackup,
  shouldRunLevel,
  pruneOldBackups,
  readLatestManifest,
  getBackupHealth,
  computeDiskUsage,
  verifyBackupIntegrity,
  computeChecksum,
  computeRowsPerTable,
  getSchemaVersion,
  getGitInfo,
  DEFAULT_BACKUPS_DIR,
  DEFAULT_RUNTIME_DIR,
};
