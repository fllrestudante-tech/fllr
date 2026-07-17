// Runtime Metrics Engine -- processo próprio (6º filho do supervisor) que lê
// o estado de todo mundo (heartbeats dos 4 coletores, runtime/processes/
// state.json, market.db, trades.jsonl) e escreve snapshots agregados por
// domínio em runtime/metrics/*.json, além de um histórico append-only em
// runtime/metrics/history/*.jsonl (curva de estabilidade ao longo do tempo).
// Nenhum coletor individual deveria virar consciente dos irmãos -- por isso
// esses 5 domínios (todos cross-cutting) nascem centralizados aqui.
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { openDb, insertEvent } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const healthChecks = require("../lib/healthChecks");
const { computeFreshnessForDomains } = require("../lib/freshnessScore");
const { computeThroughput } = require("../lib/throughput");
const { computeApiHealthScore, aggregateProviderHealth } = require("../lib/apiHealth");
const { startHeartbeat, writeJsonSnapshot } = require("../lib/heartbeatWriter");
const { createCollectorMetrics } = require("../lib/collectors/collectorMetrics");
const { deriveOperationalState } = require("../lib/operationalState");
const { sampleDatabaseHealth } = require("../lib/databaseHealth");
const { computeTradingHealth } = require("../lib/tradingHealth");
const { sampleProcessResources } = require("../lib/processResourceUsage");
const { createAlertManager } = require("../lib/alertManager");

const SLOW_SAMPLE_INTERVAL_MS = 15 * 60 * 1000; // database.json: integrity_check é O(n), não roda no ritmo rápido dos outros domínios

// O próprio sampler usa o mesmo createCollectorMetrics() que qualquer
// coletor -- domínio "collectors_sample" registra sucesso/falha de cada
// rodada, reaproveitando checkCollectorHeartbeat (lib/healthChecks.js) pro
// checkMetricsSampler da Fase B em vez de fabricar um payload fixo.
const samplerMetrics = createCollectorMetrics();

const METRICS_DIR = path.join(__dirname, "..", "runtime", "metrics");
const HISTORY_DIR = path.join(METRICS_DIR, "history");
const SAMPLER_HEALTH_FILE = path.join(__dirname, "..", "runtime", "heartbeats", "metrics-sampler.json");
const SAMPLE_INTERVAL_MS = 60000;

const HEARTBEAT_FILES = {
  bybit_collector: healthChecks.DEFAULT_COLLECTOR_HEALTH_FILE,
  fear_greed_collector: healthChecks.DEFAULT_FEAR_GREED_HEALTH_FILE,
  btc_dominance_collector: healthChecks.DEFAULT_BTC_DOMINANCE_HEALTH_FILE,
  knowledge_collector: healthChecks.DEFAULT_KNOWLEDGE_HEALTH_FILE,
};

// "bot" não tem check dedicado (checkBybit mede a API, não o processo) --
// fica de fora deste mapa e o operationalState() cai no fallback baseado só
// no status do supervisor (sem healthStatus), que já cobre esse caso.
const CHILD_HEALTH_CHECKS = {
  bybit_collector: healthChecks.checkCollector,
  fear_greed_collector: healthChecks.checkFearGreed,
  btc_dominance_collector: healthChecks.checkBtcDominance,
  knowledge_collector: healthChecks.checkKnowledgeCollector,
  metrics_sampler: healthChecks.checkMetricsSampler,
};

const db = openDb();
const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });
const alertManager = createAlertManager({ db });

function readHeartbeat(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function appendHistory(domain, entry) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.appendFileSync(path.join(HISTORY_DIR, `${domain}.jsonl`), JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
}

/**
 * Um objeto por coletor supervisionado, cada um com seus domínios
 * (candles/funding/... pro Bybit, um só pros coletores de fonte única) já
 * enriquecidos com freshness/throughput/apiHealth. `apiHealthByDomain` sai
 * à parte pra alimentar a agregação por provider em sla.json.
 */
function sampleCollectors() {
  const collectors = {};
  const apiHealthByDomain = {};

  for (const [collectorName, heartbeatFile] of Object.entries(HEARTBEAT_FILES)) {
    const heartbeat = readHeartbeat(heartbeatFile);
    const domainsMetrics = heartbeat?.metrics || {};
    const freshnessByDomain = computeFreshnessForDomains(domainsMetrics);

    const domains = {};
    for (const [domain, m] of Object.entries(domainsMetrics)) {
      const apiHealth = computeApiHealthScore(m);
      apiHealthByDomain[domain] = apiHealth;
      domains[domain] = {
        ...computeThroughput(m.lastWindow),
        freshness: freshnessByDomain[domain],
        apiHealth,
        totalRuns: m.totalRuns,
        totalInserted: m.totalInserted,
        totalErrors: m.totalErrors,
        consecutiveFailures: m.consecutiveFailures,
        lastSuccessAt: m.lastSuccessAt,
      };
    }

    collectors[collectorName] = {
      heartbeatPresent: !!heartbeat,
      lastHeartbeatAt: heartbeat?.lastHeartbeatAt || null,
      domains,
    };
  }

  return { collectors, apiHealthByDomain };
}

/**
 * Itera runtime/processes/state.json de forma genérica (não hardcoda os
 * nomes dos 5 filhos atuais) -- um 6º/7º filho futuro já aparece sozinho.
 * telegram_radar é acrescentado à parte, sempre MANUAL, já que não está na
 * lista de filhos do supervisor.
 */
function sampleProcesses() {
  const stateRaw = readHeartbeat(healthChecks.DEFAULT_SUPERVISOR_STATE_FILE);
  const processes = {};

  if (stateRaw) {
    const pids = Object.entries(stateRaw)
      .filter(([name]) => name !== "_meta")
      .map(([, child]) => child.pid)
      .filter(Boolean);
    const resourcesByPid = sampleProcessResources(pids);

    for (const [name, child] of Object.entries(stateRaw)) {
      if (name === "_meta") continue;
      const checkFn = CHILD_HEALTH_CHECKS[name];
      const healthResult = checkFn ? checkFn() : null;
      const derived = deriveOperationalState({
        isSupervised: true,
        supervisorStatus: child.status,
        healthStatus: healthResult?.status ?? null,
        startedAt: child.startedAt,
      });
      const resources = child.pid ? resourcesByPid[child.pid] : null;
      processes[name] = {
        pid: child.pid,
        supervisorStatus: child.status,
        healthStatus: healthResult?.status ?? null,
        operationalState: derived.state,
        degraded: derived.degraded,
        startedAt: child.startedAt,
        consecutiveRestarts: child.consecutiveRestarts,
        totalRestarts: child.totalRestarts,
        lastExit: child.lastExit,
        cpuPercent: resources?.cpuPercent ?? null,
        ramBytes: resources?.ramBytes ?? null,
      };
    }
  }

  const telegramHealth = healthChecks.checkTelegramRadar();
  const telegramDerived = deriveOperationalState({ isSupervised: false });
  processes.telegram_radar = {
    pid: null,
    supervisorStatus: null,
    healthStatus: telegramHealth.status,
    operationalState: telegramDerived.state,
    degraded: false,
    details: telegramHealth.details,
  };

  return processes;
}

function runProcessesSample() {
  const processes = sampleProcesses();
  const sampledAt = new Date().toISOString();
  writeJsonSnapshot(path.join(METRICS_DIR, "processes.json"), { processes, sampledAt });
  appendHistory("processes", {
    summary: Object.fromEntries(Object.entries(processes).map(([name, p]) => [name, { operationalState: p.operationalState, degraded: p.degraded }])),
  });
  eventBus.emit("runtime_metrics.processes.updated", { sampledAt });
}

/**
 * Freshness "late" vira WARNING (ex: "Funding atrasado"), "stale" vira ERROR
 * (coletor parou de coletar de verdade -- score 0, bem além da tolerância).
 * "fresh"/"never_succeeded" (esse último já é not_implemented/normal antes
 * do primeiro sucesso) não geram alerta.
 */
function alertOnFreshness(collectors) {
  for (const c of Object.values(collectors)) {
    for (const [domain, d] of Object.entries(c.domains)) {
      if (!d.freshness) continue;
      if (d.freshness.state === "late") {
        alertManager.fire(domain, "WARNING", `${domain} atrasado (freshness ${d.freshness.score}%)`).catch((err) => console.error("⚠️  Falha ao disparar alerta:", err.message));
      } else if (d.freshness.state === "stale") {
        alertManager.fire(domain, "ERROR", `${domain} parou de coletar (freshness 0%, idade ${Math.round(d.freshness.ageMs / 60000)}min)`).catch((err) => console.error("⚠️  Falha ao disparar alerta:", err.message));
      }
    }
  }
}

function runCollectorsSample() {
  const { collectors, apiHealthByDomain } = sampleCollectors();
  const providerHealth = aggregateProviderHealth(apiHealthByDomain);
  const sampledAt = new Date().toISOString();
  alertOnFreshness(collectors);

  writeJsonSnapshot(path.join(METRICS_DIR, "collectors.json"), { collectors, sampledAt });
  writeJsonSnapshot(path.join(METRICS_DIR, "sla.json"), { registry: config.sla, apiHealthByProvider: providerHealth, sampledAt });

  appendHistory("collectors", {
    // linha compacta -- só o essencial pra reconstruir a curva de estabilidade, não o objeto inteiro
    apiHealthByProvider: providerHealth,
    domainsSummary: Object.fromEntries(
      Object.entries(collectors).flatMap(([, c]) => Object.entries(c.domains)).map(([domain, d]) => [domain, { freshnessScore: d.freshness.score, insertedPerMin: d.insertedPerMin }])
    ),
  });

  eventBus.emit("runtime_metrics.collectors.updated", { sampledAt });
  eventBus.emit("runtime_metrics.sla.updated", { sampledAt });
}

/**
 * INSERT/s derivado somando o insertedPerMin já calculado por domínio (zero
 * instrumentação nova nos 13 pontos de db.prepare()). SELECT/s reportado
 * honestamente como não rastreado -- workload é majoritariamente escrita, o
 * único ponto de leitura de verdade fora de health-check/dashboard fica
 * dentro do telegram-radar manual (baixo retorno pra instrumentar agora).
 */
function runDatabaseSample() {
  const dbHealth = sampleDatabaseHealth(undefined, { runIntegrityCheck: true });
  const { collectors } = sampleCollectors();

  if (dbHealth.integrity && !dbHealth.integrity.ok) {
    alertManager.fire("market_db", "CRITICAL", `market.db corrompido: ${dbHealth.integrity.detail}`).catch((err) => console.error("⚠️  Falha ao disparar alerta:", err.message));
  }
  if (dbHealth.vacuumNeeded) {
    alertManager.fire("market_db_vacuum", "WARNING", `market.db precisa de VACUUM (fragmentação ${(dbHealth.fragmentationRatio * 100).toFixed(1)}%)`).catch((err) => console.error("⚠️  Falha ao disparar alerta:", err.message));
  }

  let insertedPerMinTotal = 0;
  for (const c of Object.values(collectors)) {
    for (const d of Object.values(c.domains)) {
      if (typeof d.insertedPerMin === "number") insertedPerMinTotal += d.insertedPerMin;
    }
  }

  const sampledAt = new Date().toISOString();
  writeJsonSnapshot(path.join(METRICS_DIR, "database.json"), {
    ...dbHealth,
    insertedPerMin: insertedPerMinTotal,
    insertedPerSec: insertedPerMinTotal / 60,
    selectPerSec: {
      tracked: false,
      reason: "workload é majoritariamente escrita; único ponto de leitura real fora de health-check/dashboard é telegramStore.js::getRecentHashes, dentro do telegram-radar manual -- baixo retorno pra instrumentar agora",
    },
    sampledAt,
  });
  appendHistory("database", {
    sizeBytes: dbHealth.sizeBytes,
    fragmentationRatio: dbHealth.fragmentationRatio,
    vacuumNeeded: dbHealth.vacuumNeeded,
    insertedPerMin: insertedPerMinTotal,
    integrityOk: dbHealth.integrity?.ok ?? null,
  });
  eventBus.emit("runtime_metrics.database.updated", { sampledAt });
}

function runTradingSample() {
  const tradingHealth = computeTradingHealth();
  const sampledAt = new Date().toISOString();
  writeJsonSnapshot(path.join(METRICS_DIR, "trading.json"), tradingHealth);
  appendHistory("trading", {
    totalTrades: tradingHealth.totalTrades,
    winRate: tradingHealth.winRate,
    profitFactor: tradingHealth.profitFactor,
    expectancy: tradingHealth.expectancy,
    maxDrawdown: tradingHealth.maxDrawdown,
  });
  eventBus.emit("runtime_metrics.trading.updated", { sampledAt });
}

function run() {
  const startedAt = Date.now();
  try {
    runCollectorsSample();
    samplerMetrics.recordSuccess("collectors_sample", { inserted: true, latencyMs: Date.now() - startedAt });
  } catch (err) {
    samplerMetrics.recordFailure("collectors_sample", err, { latencyMs: Date.now() - startedAt });
    console.error("⚠️  metricsSampler: falha ao amostrar collectors/sla:", err.message);
  }

  const processesStartedAt = Date.now();
  try {
    runProcessesSample();
    samplerMetrics.recordSuccess("processes_sample", { inserted: true, latencyMs: Date.now() - processesStartedAt });
  } catch (err) {
    samplerMetrics.recordFailure("processes_sample", err, { latencyMs: Date.now() - processesStartedAt });
    console.error("⚠️  metricsSampler: falha ao amostrar processes:", err.message);
  }

  alertManager.flush().catch((err) => console.error("⚠️  Falha ao consolidar alertas:", err.message));
}

function runSlow() {
  const dbStartedAt = Date.now();
  try {
    runDatabaseSample();
    samplerMetrics.recordSuccess("database_sample", { inserted: true, latencyMs: Date.now() - dbStartedAt });
  } catch (err) {
    samplerMetrics.recordFailure("database_sample", err, { latencyMs: Date.now() - dbStartedAt });
    console.error("⚠️  metricsSampler: falha ao amostrar database:", err.message);
  }

  const tradingStartedAt = Date.now();
  try {
    runTradingSample();
    samplerMetrics.recordSuccess("trading_sample", { inserted: true, latencyMs: Date.now() - tradingStartedAt });
  } catch (err) {
    samplerMetrics.recordFailure("trading_sample", err, { latencyMs: Date.now() - tradingStartedAt });
    console.error("⚠️  metricsSampler: falha ao amostrar trading:", err.message);
  }
}

console.log("📊 Metrics Sampler iniciando...");
run();
setTimeout(runSlow, 10000); // dá tempo dos coletores rodarem ao menos 1 ciclo antes da primeira leitura de database.json
const sampleTimer = setInterval(run, SAMPLE_INTERVAL_MS);
const slowSampleTimer = setInterval(runSlow, SLOW_SAMPLE_INTERVAL_MS);

const heartbeat = startHeartbeat(SAMPLER_HEALTH_FILE, () => ({ metrics: samplerMetrics.getMetrics() }));

process.on("SIGINT", () => {
  console.log("📊 Metrics Sampler encerrado (SIGINT).");
  clearInterval(sampleTimer);
  clearInterval(slowSampleTimer);
  heartbeat.stop();
  db.close();
  process.exit(0);
});
