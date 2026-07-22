// Processo standalone -- roda o Backup Engine (lib/backup.js) em ciclo,
// decidindo por cadência (não a cada tick) quando cada nível
// (daily/weekly/monthly) deve rodar, e poda backups antigos (exceto
// monthly, que é snapshot permanente). Sem isso, perder o market.db (SSD
// corrompido, exclusão acidental, CHKDSK, atualização do Windows) apaga
// meses de candles/funding/OI/telegram/eventos que alimentam o Replay
// Engine/Learning Engine futuros -- e nenhum outro processo do projeto
// protege contra isso hoje.
const path = require("path");
const { openDb } = require("../lib/infra/db");
const { createAlertManager } = require("../lib/alertManager");
const backup = require("../lib/backup");
const { startHeartbeat } = require("../lib/heartbeatWriter");
const { DEFAULT_BACKUP_DAEMON_HEALTH_FILE } = require("../lib/healthChecks");

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // cadência real é diária/semanal/mensal -- não precisa ser fino

const db = openDb();
const alertManager = createAlertManager({ db });
const lastRun = { daily: null, weekly: null, monthly: null };
const lastResult = { daily: null, weekly: null, monthly: null };

async function tick() {
  for (const level of backup.LEVELS) {
    const latest = backup.readLatestManifest({ level });
    if (!backup.shouldRunLevel(level, latest)) continue;

    const result = await backup.runBackup({ db, level, alertManager });
    lastRun[level] = new Date().toISOString();
    lastResult[level] = result.skipped ? "skipped" : result.valid ? "ok" : "invalid";

    if (!result.skipped) {
      console.log(`💾 Backup ${level}: ${result.valid ? "✅ concluído" : "❌ FALHOU integrity_check"} -> ${result.destDir}`);
      const pruned = backup.pruneOldBackups({ level });
      if (pruned.pruned.length > 0) console.log(`🧹 Backup ${level}: ${pruned.pruned.length} backup(s) antigo(s) removido(s).`);
    }
  }
}

console.log("💾 Backup Daemon iniciando...");
tick().catch((err) => console.error("💾 Falha no ciclo de backup:", err.message));
const tickTimer = setInterval(() => {
  tick().catch((err) => console.error("💾 Falha no ciclo de backup:", err.message));
}, CHECK_INTERVAL_MS);

const heartbeat = startHeartbeat(DEFAULT_BACKUP_DAEMON_HEALTH_FILE, () => ({ lastRun, lastResult }), { initialDelayMs: 3000 });

process.on("SIGINT", () => {
  console.log("💾 Backup Daemon encerrado (SIGINT).");
  clearInterval(tickTimer);
  heartbeat.stop();
  db.close();
  process.exit(0);
});
