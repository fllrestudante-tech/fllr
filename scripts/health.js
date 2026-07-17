// Checa a saúde de todos os módulos sob demanda, sem depender de dashboard
// externo pago. Uso: npm run health (ou npm run health -- --watch[=Nseg])
const fs = require("fs");
const path = require("path");
const { createHealthRegistry } = require("../lib/health");
const checks = require("../lib/healthChecks");
const dashboard = require("../lib/dashboard");

const METRICS_DIR = path.join(__dirname, "..", "runtime", "metrics");

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

const STATUS_ICON = {
  ok: "✅",
  degraded: "⚠️",
  down: "🔴",
  stopped: "⏹️",
  disabled: "⬜",
  not_implemented: "⬜",
  // Modelo de 7 estados (lib/operationalState.js) -- vocabulário em
  // maiúsculas de propósito, pra não se confundir com os status minúsculos
  // acima (que continuam existindo, checkTelegramRadar agora é o único a
  // já retornar um estado do modelo novo direto).
  RUNNING: "✅",
  STOPPED: "⏹️",
  DISABLED: "⬜",
  MANUAL: "🧑",
  ERROR: "🔴",
  STARTING: "🟡",
  UNKNOWN: "❔",
};

async function main() {
  const registry = createHealthRegistry();
  registry.registerCheck("bybit", checks.checkBybit);
  registry.registerCheck("bybit_collector", checks.checkCollector);
  registry.registerCheck("fear_greed_collector", checks.checkFearGreed);
  registry.registerCheck("btc_dominance_collector", checks.checkBtcDominance);
  registry.registerCheck("knowledge_collector", checks.checkKnowledgeCollector);
  registry.registerCheck("metrics_sampler", checks.checkMetricsSampler);
  registry.registerCheck("supervisor", checks.checkSupervisor);
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

  // Runtime Metrics Engine (Fase B) -- lê os snapshots já calculados pelo
  // scripts/metricsSampler.js, não recalcula nada aqui.
  const collectorsSnapshot = readJsonIfExists(path.join(METRICS_DIR, "collectors.json"));
  const processesSnapshot = readJsonIfExists(path.join(METRICS_DIR, "processes.json"));
  const databaseSnapshot = readJsonIfExists(path.join(METRICS_DIR, "database.json"));
  const tradingSnapshot = readJsonIfExists(path.join(METRICS_DIR, "trading.json"));
  const qualitySnapshot = readJsonIfExists(path.join(METRICS_DIR, "quality.json"));

  console.log("\nDomínios (freshness / SLA / throughput / API health):\n");
  dashboard.formatDomainsTable(collectorsSnapshot).forEach((l) => console.log(l));

  console.log("\nProcessos supervisionados (uptime / restarts / CPU / RAM / estado):\n");
  dashboard.formatProcessesTable(processesSnapshot).forEach((l) => console.log(l));

  console.log("\nDatabase Health:\n");
  dashboard.formatDatabaseSection(databaseSnapshot).forEach((l) => console.log(l));

  console.log("\nTrading Health (Demo):\n");
  dashboard.formatTradingSection(tradingSnapshot).forEach((l) => console.log(l));

  console.log("\nMarket Quality (Coverage / Gaps / Sanity / Data Confidence Score):\n");
  dashboard.formatQualityTable(qualitySnapshot).forEach((l) => console.log(l));

  console.log("\nCross-Source Validation:\n");
  dashboard.formatCrossSourceSection(qualitySnapshot).forEach((l) => console.log(l));

  console.log("\nSource Reliability:\n");
  dashboard.formatSourceReliabilitySection(qualitySnapshot).forEach((l) => console.log(l));
}

const watchArg = process.argv.find((a) => a.startsWith("--watch"));

async function runOnce() {
  if (watchArg) console.clear();
  await main();
}

if (watchArg) {
  const seconds = Number(watchArg.split("=")[1]) || 10;
  runOnce().catch((err) => console.error("⚠️  Falha ao checar saúde:", err.message));
  setInterval(() => {
    runOnce().catch((err) => console.error("⚠️  Falha ao checar saúde:", err.message));
  }, seconds * 1000);
} else {
  main().catch((err) => {
    console.error("⚠️  Falha ao checar saúde:", err.message);
    process.exit(1);
  });
}
