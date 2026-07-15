// Checa a saúde de todos os módulos sob demanda, sem depender de dashboard
// externo pago. Uso: npm run health
const { createHealthRegistry } = require("../lib/health");
const checks = require("../lib/healthChecks");

const STATUS_ICON = { ok: "✅", degraded: "⚠️", down: "🔴", not_implemented: "⬜" };

async function main() {
  const registry = createHealthRegistry();
  registry.registerCheck("bybit", checks.checkBybit);
  registry.registerCheck("bybit_collector", checks.checkCollector);
  registry.registerCheck("backtest", checks.checkBacktest);
  registry.registerCheck("telegram_radar", checks.checkTelegramRadar);
  registry.registerCheck("scanner", checks.notImplemented);
  registry.registerCheck("banco_de_dados", checks.checkDatabase);
  registry.registerCheck("ia", checks.notImplemented);
  registry.registerCheck("workers", checks.notImplemented);

  const results = await registry.runChecks();

  console.log("Status de saúde dos módulos:\n");
  for (const [name, result] of Object.entries(results)) {
    const icon = STATUS_ICON[result.status] || "❔";
    console.log(`${icon} ${name}: ${result.status}`);
    if (result.details && Object.keys(result.details).length > 0) {
      console.log(`   ${JSON.stringify(result.details)}`);
    }
  }
}

main().catch((err) => {
  console.error("⚠️  Falha ao checar saúde:", err.message);
  process.exit(1);
});
