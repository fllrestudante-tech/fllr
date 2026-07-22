// Dispara o Backup Engine uma vez e sai -- útil pra verificação manual
// (`npm run backup`) sem precisar esperar o daemon supervisionado.
const { openDb } = require("../lib/infra/db");
const { createAlertManager } = require("../lib/alertManager");
const backup = require("../lib/backup");

async function main() {
  const db = openDb();
  const alertManager = createAlertManager({ db });

  for (const level of backup.LEVELS) {
    const latest = backup.readLatestManifest({ level });
    if (!backup.shouldRunLevel(level, latest)) {
      console.log(`⏭️  ${level}: ainda não é hora (último em ${latest?.createdAt ?? "nunca"}).`);
      continue;
    }
    const result = await backup.runBackup({ db, level, alertManager });
    if (result.skipped) {
      console.log(`⏭️  ${level}: ${result.reason}`);
    } else {
      console.log(`${result.valid ? "✅" : "❌"} ${level}: ${result.destDir} (valid=${result.valid})`);
      if (result.manifest) console.log(JSON.stringify(result.manifest, null, 2));
    }
  }

  db.close();
}

main().catch((err) => {
  console.error("❌ Erro no backup:", err.message);
  process.exit(1);
});
