const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../lib/infra/db");
const backup = require("../lib/backup");

function tmpDir(name) {
  const dir = path.join(os.tmpdir(), `bot-cripto10-backup-test-${Date.now()}-${name}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSourceDb() {
  const dir = tmpDir("source");
  const dbPath = path.join(dir, "market.db");
  const db = openDb(dbPath);
  db.prepare("INSERT INTO events_log (uuid, event_name, payload, occurred_at) VALUES (?, ?, ?, ?)").run(
    "11111111-1111-1111-1111-111111111111",
    "test.event",
    "{}",
    new Date().toISOString()
  );
  return { dir, dbPath, db };
}

test("runBackup: cria market.db + manifesto válido (daily, sem compressão)", async () => {
  const { dir, db } = makeSourceDb();
  const backupsDir = path.join(dir, "backups");

  const result = await backup.runBackup({ db, level: "daily", backupsDir, now: new Date("2026-07-21T12:00:00.000Z") });

  db.close();

  assert.equal(result.skipped, false);
  assert.equal(result.valid, true);
  assert.ok(fs.existsSync(path.join(result.destDir, "market.db"))); // daily não comprime
  assert.equal(result.manifest.compressed, false);
  assert.equal(result.manifest.level, "daily");
  assert.ok(result.manifest.rowsPerTable.events_log >= 1);
  assert.ok(result.manifest.checksum);
  assert.equal(typeof result.manifest.schemaVersion, "number");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runBackup: nível weekly/monthly comprime o banco (.db.gz)", async () => {
  const { dir, db } = makeSourceDb();
  const backupsDir = path.join(dir, "backups");

  const result = await backup.runBackup({ db, level: "weekly", backupsDir, now: new Date("2026-07-21T12:00:00.000Z") });

  db.close();

  assert.equal(result.manifest.compressed, true);
  assert.ok(result.manifest.dbFile.endsWith(".gz"));
  assert.ok(fs.existsSync(path.join(result.destDir, result.manifest.dbFile)));
  assert.ok(!fs.existsSync(path.join(result.destDir, "market.db"))); // versão não comprimida foi removida

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runBackup: idempotente -- rodar de novo no mesmo dia/nível pula em vez de duplicar", async () => {
  const { dir, db } = makeSourceDb();
  const backupsDir = path.join(dir, "backups");
  const now = new Date("2026-07-21T12:00:00.000Z");

  const first = await backup.runBackup({ db, level: "daily", backupsDir, now });
  const second = await backup.runBackup({ db, level: "daily", backupsDir, now });

  db.close();

  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runBackup: copia state.json e tuning.json quando existem", async () => {
  const { dir, db } = makeSourceDb();
  const backupsDir = path.join(dir, "backups");
  const statePath = path.join(dir, "state.json");
  const tuningPath = path.join(dir, "tuning.json");
  fs.writeFileSync(statePath, JSON.stringify({ foo: "bar" }));
  fs.writeFileSync(tuningPath, JSON.stringify({ current: {} }));

  const result = await backup.runBackup({ db, level: "daily", backupsDir, statePath, tuningPath, now: new Date("2026-07-21T12:00:00.000Z") });

  db.close();

  assert.ok(fs.existsSync(path.join(result.destDir, "state.json")));
  assert.ok(fs.existsSync(path.join(result.destDir, "tuning.json")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runBackup: marca valid=false e não derruba o processo quando integrity_check falha", async () => {
  const { dir, db } = makeSourceDb();
  const backupsDir = path.join(dir, "backups");
  const now = new Date("2026-07-21T12:00:00.000Z");

  // Corrompe a cópia DEPOIS que o db.backup() já rodou, mas antes da
  // verificação -- trunca o arquivo pela metade, simulando um backup
  // fisicamente corrompido em disco (garante falha real no
  // integrity_check, diferente de só anexar bytes no fim do arquivo).
  const originalBackup = db.backup.bind(db);
  db.backup = async (destPath) => {
    await originalBackup(destPath);
    const fullSize = fs.statSync(destPath).size;
    fs.truncateSync(destPath, Math.floor(fullSize / 2));
  };

  const alerts = [];
  const alertManager = { fire: async (key, severity, message) => alerts.push({ key, severity, message }) };

  const result = await backup.runBackup({ db, level: "daily", backupsDir, now, alertManager });

  db.close();

  assert.equal(result.valid, false);
  assert.ok(fs.existsSync(path.join(result.destDir, "backup.json"))); // manifesto gravado mesmo inválido, pra investigação
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "CRITICAL");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("shouldRunLevel: daily sempre roda; weekly só após 7 dias; monthly só em mês/ano diferente", () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  assert.equal(backup.shouldRunLevel("daily", { createdAt: now.toISOString() }, now), true);
  assert.equal(backup.shouldRunLevel("weekly", null, now), true);
  assert.equal(backup.shouldRunLevel("weekly", { createdAt: "2026-07-20T12:00:00.000Z" }, now), false);
  assert.equal(backup.shouldRunLevel("weekly", { createdAt: "2026-07-13T12:00:00.000Z" }, now), true);
  assert.equal(backup.shouldRunLevel("monthly", { createdAt: "2026-07-01T00:00:00.000Z" }, now), false);
  assert.equal(backup.shouldRunLevel("monthly", { createdAt: "2026-06-30T00:00:00.000Z" }, now), true);
});

test("pruneOldBackups: remove backups mais velhos que a retenção, mas NUNCA poda monthly", () => {
  const dir = tmpDir("prune");
  const backupsDir = path.join(dir, "backups");
  const now = new Date("2026-07-21T00:00:00.000Z");

  for (const level of ["daily", "weekly", "monthly"]) {
    fs.mkdirSync(path.join(backupsDir, level, "2026-01-01"), { recursive: true }); // bem antigo
    fs.mkdirSync(path.join(backupsDir, level, "2026-07-20"), { recursive: true }); // recente
  }

  const dailyResult = backup.pruneOldBackups({ backupsDir, level: "daily", now });
  const monthlyResult = backup.pruneOldBackups({ backupsDir, level: "monthly", now });

  assert.deepEqual(dailyResult.pruned, ["2026-01-01"]);
  assert.deepEqual(monthlyResult.pruned, []); // monthly nunca é podado
  assert.ok(fs.existsSync(path.join(backupsDir, "monthly", "2026-01-01"))); // ainda existe

  fs.rmSync(dir, { recursive: true, force: true });
});

test("getBackupHealth: never_ran quando não existe nenhum backup diário", () => {
  const dir = tmpDir("health-never-ran");
  const health = backup.getBackupHealth({ backupsDir: path.join(dir, "backups") });
  assert.equal(health.status, "never_ran");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("getBackupHealth: ok quando o backup diário mais recente é fresco e válido", async () => {
  const { dir, db } = makeSourceDb();
  const backupsDir = path.join(dir, "backups");
  const now = new Date("2026-07-21T12:00:00.000Z");

  await backup.runBackup({ db, level: "daily", backupsDir, now });
  db.close();

  const health = backup.getBackupHealth({ backupsDir, now: now.getTime() + 60 * 1000 });
  assert.equal(health.status, "ok");
  assert.equal(health.integrityOk, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("getBackupHealth: stale quando o último backup diário é mais velho que o limite", async () => {
  const { dir, db } = makeSourceDb();
  const backupsDir = path.join(dir, "backups");
  const backupTime = new Date("2026-07-19T12:00:00.000Z");

  await backup.runBackup({ db, level: "daily", backupsDir, now: backupTime });
  db.close();

  const health = backup.getBackupHealth({ backupsDir, now: new Date("2026-07-21T12:00:00.000Z").getTime() });
  assert.equal(health.status, "stale");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("computeDiskUsage: soma o tamanho de todos os arquivos sob backups/", async () => {
  const { dir, db } = makeSourceDb();
  const backupsDir = path.join(dir, "backups");
  await backup.runBackup({ db, level: "daily", backupsDir, now: new Date("2026-07-21T12:00:00.000Z") });
  db.close();

  const usage = backup.computeDiskUsage(backupsDir);
  assert.ok(usage > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("computeDiskUsage: pasta inexistente retorna 0 (não quebra)", () => {
  assert.equal(backup.computeDiskUsage("/caminho/que/nao/existe/backups"), 0);
});
