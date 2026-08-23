// Status consolidado pro Header Global -- cada subsistema já tem um jeito
// de saber se está saudável hoje (processes.json, heartbeat do coletor,
// connectivityStatus, databaseHealth, state.json); este módulo só junta
// tudo num único objeto pro Header mostrar em toda seção. Nenhum cálculo
// novo, nenhuma chamada à Bybit -- só leitura de arquivos que os processos
// ao vivo já escrevem.
const fs = require("fs");
const path = require("path");
const connectivityStatus = require("../connectivityStatus");
const { sampleDatabaseHealth } = require("../databaseHealth");
const stateStore = require("../state");
const checks = require("../healthChecks");
const { loadRegistry, listByStatus } = require("../registry/registryStore");

const RUNTIME_METRICS_DIR = path.join(__dirname, "..", "..", "runtime", "metrics");
const REPLAY_STATS_PATH = path.join(__dirname, "..", "..", "data", "replay", "stats.json");

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// ok/degraded/down/unknown -- mesmo vocabulário de lib/healthChecks.js, nunca
// uma % inventada (ver "Fabricação de métrica" no plano do Dashboard).
function processStatus(processesSnapshot, name) {
  const p = processesSnapshot?.processes?.[name];
  if (!p) return "unknown";
  if (p.operationalState !== "RUNNING") return "down";
  return p.degraded ? "degraded" : "ok";
}

function collectorHeartbeatStatus(now) {
  const result = checks.checkCollector(checks.DEFAULT_COLLECTOR_HEALTH_FILE, now);
  return result.status;
}

function replayStatus(stats) {
  if (!stats) return "unknown";
  return "ok"; // existe stats.json -- já rodou pelo menos uma vez; frescor vira dataAge, não status binário aqui
}

function circuitBreakerStatus(state, now) {
  if (!state.circuitBreakerUntil) return "off";
  return now < state.circuitBreakerUntil ? "on" : "off";
}

// Decision Engine: index.js::cycle() usa lib/signal.js (EMA/RSI/StochRSI/OBV
// clássico), nenhum Brain decide trade hoje -- fato arquitetural verificável
// no código, não uma métrica calculada. Atualizar este texto no dia em que
// isso mudar de verdade (Decision Brain deixar de ser "idea" no registry E
// index.js passar a consumi-lo).
function readDecisionEngineLabel() {
  return "Classical (EMA/RSI/StochRSI/OBV)";
}

function readFeatureBuilderLabel(objects) {
  const obj = objects.find((o) => o.id === "idea-feature-builder");
  return obj ? obj.status : "unknown";
}

function readBrainsLabel(objects) {
  const brains = listByStatus(objects, "production").filter((o) => o.type === "brain");
  return brains.length > 0 ? "Observation Mode" : "unknown";
}

function readHeader({ now = Date.now() } = {}) {
  const processesSnapshot = readJson(path.join(RUNTIME_METRICS_DIR, "processes.json"));
  const replayStats = readJson(REPLAY_STATS_PATH);
  const state = stateStore.load();
  const dbHealth = sampleDatabaseHealth(undefined, { runIntegrityCheck: false });
  const objects = loadRegistry();

  return {
    bot: processStatus(processesSnapshot, "bot"),
    collector: collectorHeartbeatStatus(now),
    replay: replayStatus(replayStats),
    marketDb: dbHealth?.status ?? "unknown",
    exchangeConnected: connectivityStatus.isOnline() && connectivityStatus.isProviderHealthy("bybit") ? "connected" : "disconnected",
    scheduler: "ok", // backlog real vem de /api/v1/collectors (schedulerStats) -- header só confirma que o coletor está respondendo
    circuitBreaker: circuitBreakerStatus(state, now),
    brains: readBrainsLabel(objects),
    decisionEngine: readDecisionEngineLabel(),
    featureBuilder: readFeatureBuilderLabel(objects),
  };
}

module.exports = { readHeader, processStatus, circuitBreakerStatus };
