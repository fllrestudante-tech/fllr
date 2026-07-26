// Checa a saúde de todos os módulos sob demanda, sem depender de dashboard
// externo pago. Uso: npm run health (ou npm run health -- --watch[=Nseg])
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { createHealthRegistry } = require("../lib/health");
const checks = require("../lib/healthChecks");
const dashboard = require("../lib/dashboard");
const { computeAvailability } = require("../lib/platformAvailability");
const marketBrainData = require("../lib/brains/marketBrainData");
const marketBrain = require("../lib/brains/marketBrain");
const structureBrainData = require("../lib/brains/structureBrainData");
const structureBrain = require("../lib/brains/structureBrain");
const liquidityBrainData = require("../lib/brains/liquidityBrainData");
const liquidityBrain = require("../lib/brains/liquidityBrain");
const { fuseContext } = require("../lib/brains/contextFusion");
const fvgBrainData = require("../lib/brains/fvgBrainData");
const fvgBrain = require("../lib/brains/fvgBrain");
const orderBlockBrainData = require("../lib/brains/orderBlockBrainData");
const orderBlockBrain = require("../lib/brains/orderBlockBrain");
const config = require("../config");
const { DEFAULT_MARKET_DB_PATH } = checks;

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

// Query barata sobre system_incidents (não precisa de sampler contínuo,
// diferente das métricas de throughput -- mesmo raciocínio já aplicado ao
// Backup Health, que também é calculado sob demanda em vez de amostrado).
function readAvailability() {
  if (!fs.existsSync(DEFAULT_MARKET_DB_PATH)) return null;
  let db;
  try {
    db = new Database(DEFAULT_MARKET_DB_PATH, { readonly: true, fileMustExist: true });
    return computeAvailability(db);
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

// Mesmo padrão on-demand de readAvailability() -- não precisa de sampler
// contínuo pra v1, é uma leitura barata (últimas linhas de 5 tabelas +
// getBacktestCandles já cacheável pelo próprio SO entre chamadas).
function readMarketBrainSnapshot() {
  if (!fs.existsSync(DEFAULT_MARKET_DB_PATH)) return null;
  let db;
  try {
    db = new Database(DEFAULT_MARKET_DB_PATH, { readonly: true, fileMustExist: true });
    const inputs = marketBrainData.gatherMarketBrainInputs(db, { symbol: config.symbol, interval: config.interval });
    return marketBrain.analyzeMarket(inputs);
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

function readStructureBrainSnapshot() {
  if (!fs.existsSync(DEFAULT_MARKET_DB_PATH)) return null;
  let db;
  try {
    db = new Database(DEFAULT_MARKET_DB_PATH, { readonly: true, fileMustExist: true });
    const inputs = structureBrainData.gatherStructureBrainInputs(db, { symbol: config.symbol, interval: config.interval });
    return structureBrain.analyzeStructure(inputs);
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

function readLiquidityBrainSnapshot() {
  if (!fs.existsSync(DEFAULT_MARKET_DB_PATH)) return null;
  let db;
  try {
    db = new Database(DEFAULT_MARKET_DB_PATH, { readonly: true, fileMustExist: true });
    const inputs = liquidityBrainData.gatherLiquidityBrainInputs(db, { symbol: config.symbol, interval: config.interval });
    return liquidityBrain.analyzeLiquidity(inputs);
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

// fvgBrainData já orquestra Market/Structure/Liquidity/Context Fusion
// internamente (o FVG Brain precisa deles como contexto) -- recomputa os
// outros 3 Brains de novo aqui em vez de reaproveitar os já calculados
// acima; redundante, mas é uma ferramenta de CLI sob demanda (não um
// hot path), simplicidade > microotimização.
function readFVGBrainSnapshot() {
  if (!fs.existsSync(DEFAULT_MARKET_DB_PATH)) return null;
  let db;
  try {
    db = new Database(DEFAULT_MARKET_DB_PATH, { readonly: true, fileMustExist: true });
    const inputs = fvgBrainData.gatherFVGBrainInputs(db, { symbol: config.symbol, interval: config.interval });
    return fvgBrain.analyzeFVG(inputs);
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

// orderBlockBrainData orquestra Market/Structure/Liquidity/Context Fusion
// do mesmo jeito que o fvgBrainData (Order Block Brain também precisa
// deles como contexto) -- mesma redundância aceita acima.
function readOrderBlockBrainSnapshot() {
  if (!fs.existsSync(DEFAULT_MARKET_DB_PATH)) return null;
  let db;
  try {
    db = new Database(DEFAULT_MARKET_DB_PATH, { readonly: true, fileMustExist: true });
    const inputs = orderBlockBrainData.gatherOrderBlockBrainInputs(db, { symbol: config.symbol, interval: config.interval });
    return orderBlockBrain.analyzeOrderBlocks(inputs);
  } catch {
    return null;
  } finally {
    if (db) db.close();
  }
}

async function main() {
  const registry = createHealthRegistry();
  registry.registerCheck("bybit", checks.checkBybit);
  registry.registerCheck("bybit_collector", checks.checkCollector);
  registry.registerCheck("fear_greed_collector", checks.checkFearGreed);
  registry.registerCheck("btc_dominance_collector", checks.checkBtcDominance);
  registry.registerCheck("knowledge_collector", checks.checkKnowledgeCollector);
  registry.registerCheck("metrics_sampler", checks.checkMetricsSampler);
  registry.registerCheck("backup_daemon", checks.checkBackupDaemon);
  registry.registerCheck("backup", checks.checkBackup);
  registry.registerCheck("supervisor", checks.checkSupervisor);
  registry.registerCheck("connectivity", checks.checkConnectivity);
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

  console.log("\nBackup Health:\n");
  dashboard.formatBackupSection(results.backup?.details).forEach((l) => console.log(l));

  console.log("\nPlatform Availability:\n");
  dashboard.formatPlatformAvailabilitySection(readAvailability()).forEach((l) => console.log(l));

  const marketSnapshot = readMarketBrainSnapshot();
  const structureSnapshot = readStructureBrainSnapshot();
  const liquiditySnapshot = readLiquidityBrainSnapshot();

  console.log("\nMarket Brain:\n");
  dashboard.formatMarketBrainSection(marketSnapshot).forEach((l) => console.log(l));

  console.log("\nStructure Brain:\n");
  dashboard.formatStructureBrainSection(structureSnapshot).forEach((l) => console.log(l));

  console.log("\nLiquidity Brain:\n");
  dashboard.formatLiquidityBrainSection(liquiditySnapshot).forEach((l) => console.log(l));

  console.log("\nContext Fusion:\n");
  const context = marketSnapshot && structureSnapshot && liquiditySnapshot ? fuseContext({ market: marketSnapshot, structure: structureSnapshot, liquidity: liquiditySnapshot }) : null;
  dashboard.formatContextFusionSection(context).forEach((l) => console.log(l));

  console.log("\nFVG Brain:\n");
  dashboard.formatFVGBrainSection(readFVGBrainSnapshot()).forEach((l) => console.log(l));

  console.log("\nOrder Block Brain:\n");
  dashboard.formatOrderBlockBrainSection(readOrderBlockBrainSnapshot()).forEach((l) => console.log(l));

  console.log("\nTrading Health (Demo):\n");
  dashboard.formatTradingSection(tradingSnapshot).forEach((l) => console.log(l));

  console.log("\nExit Analytics (de onde vem o lucro, por motivo de saída):\n");
  dashboard.formatExitAnalyticsTable(tradingSnapshot).forEach((l) => console.log(l));

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
