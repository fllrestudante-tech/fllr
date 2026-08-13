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
const { DOMAIN_TABLES, sampleCoverage } = require("../lib/dataCoverage");
const { sampleGaps } = require("../lib/temporalGaps");
const { sampleSanityChecks } = require("../lib/sanityChecks");
const { computeDataConfidenceScore } = require("../lib/dataConfidenceScore");
const { compareProviders } = require("../lib/crossSourceValidation");
const { buildSourceReliabilityRegistry } = require("../lib/sourceReliability");
const marketBrainData = require("../lib/brains/marketBrainData");
const marketBrain = require("../lib/brains/marketBrain");
const structureBrainData = require("../lib/brains/structureBrainData");
const structureBrain = require("../lib/brains/structureBrain");
const liquidityBrainData = require("../lib/brains/liquidityBrainData");
const liquidityBrain = require("../lib/brains/liquidityBrain");
const { fuseContext } = require("../lib/brains/contextFusion");
const { loadRegistry, countByStatus } = require("../lib/registry/registryStore");
const { buildAllFeatures, summarizeFeatures } = require("../lib/featureBuilder");
const { summarizeDecisionBrainReadiness } = require("../lib/brainAnalytics");
const { computeAiCostMetrics } = require("../lib/aiGateway/costMetrics");

// Domínios de mercado que teriam um equivalente em outra exchange (Binance,
// quando existir) -- só esses fazem sentido pra Cross-Source Validation.
// Fear&Greed/BTC Dominance/Knowledge não têm "segunda fonte" no roadmap.
const CROSS_SOURCE_DOMAINS = ["candles", "funding", "open_interest"];

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
// scripts/replayEngine.js roda sob demanda (npm run replay), não é filho do
// supervisor -- lido aqui só como consumidor, nunca recomputado (evita
// duplicar a leitura de snapshots.jsonl, que pode ter dezenas de milhares
// de linhas, dentro do ritmo do sampler).
const REPLAY_STATS_FILE = path.join(__dirname, "..", "data", "replay", "stats.json");

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

/**
 * Market Quality Engine (Fase B.5): "os dados são confiáveis e
 * consistentes?" -- diferente do Freshness Score, que só responde "é
 * recente?". Cobertura, gaps temporais e sanity checks por domínio viram um
 * Data Confidence Score; junto com API Health e Freshness (já calculados em
 * runCollectorsSample), viram o registro de Source Reliability (Operational
 * Reliability agora, Predictive Reliability reservado pra fase futura).
 * Cross-Source Validation fica em N/A honesto pros 3 domínios de mercado até
 * o Binance Collector existir -- a lógica de comparação já está pronta e
 * testada com dado fake, só falta um segundo provider real.
 */
function runQualitySample() {
  const { collectors, apiHealthByDomain } = sampleCollectors();

  const freshnessByDomain = {};
  for (const c of Object.values(collectors)) {
    for (const [domain, d] of Object.entries(c.domains)) {
      freshnessByDomain[domain] = d.freshness;
    }
  }

  const quality = {};
  const dataConfidenceByDomain = {};
  for (const domain of Object.keys(DOMAIN_TABLES)) {
    const sla = config.sla.domains[domain] || { expectedIntervalMs: config.sla.defaultExpectedIntervalMs };
    const windowMs = Math.max(sla.expectedIntervalMs * 20, 60 * 60 * 1000);

    const coverage = sampleCoverage(domain, db);
    const gaps = sampleGaps(domain, db, { windowMs, expectedIntervalMs: sla.expectedIntervalMs });
    const sanity = sampleSanityChecks(domain, db, { windowMs });
    const confidence = computeDataConfidenceScore({
      coveragePct: coverage.coveragePct,
      gapsCount: gaps.gapsCount,
      sanityPassRate: sanity.passRate,
    });
    dataConfidenceByDomain[domain] = confidence;
    quality[domain] = { coverage, gaps, sanity, dataConfidence: confidence };

    if (typeof confidence.score === "number" && confidence.score < 70) {
      alertManager.fire(`quality_${domain}`, "WARNING", `${domain}: Data Confidence Score baixo (${confidence.score})`).catch((err) => console.error("⚠️  Falha ao disparar alerta:", err.message));
    }
    if (sanity.checks?.ohlc && !sanity.checks.ohlc.pass) {
      alertManager.fire(`quality_${domain}_ohlc`, "ERROR", `${domain}: ${sanity.checks.ohlc.violations} vela(s) com OHLC inválido`).catch((err) => console.error("⚠️  Falha ao disparar alerta:", err.message));
    }
  }

  // Cross-Source Validation: só Bybit existe hoje (providersAvailable=1) --
  // sempre N/A, nunca vira erro/warning por causa disso (regra explícita).
  const crossSourceValidation = {};
  for (const domain of CROSS_SOURCE_DOMAINS) {
    crossSourceValidation[domain] = compareProviders([], [], { providersAvailable: 1, providersOperational: 1 });
  }

  const sourceReliability = buildSourceReliabilityRegistry({ apiHealthByDomain, freshnessByDomain, dataConfidenceByDomain });

  const sampledAt = new Date().toISOString();
  writeJsonSnapshot(path.join(METRICS_DIR, "quality.json"), { quality, crossSourceValidation, sourceReliability, sampledAt });
  appendHistory("quality", {
    dataConfidenceByDomain: Object.fromEntries(Object.entries(dataConfidenceByDomain).map(([d, c]) => [d, c.score])),
    sourceReliabilitySummary: Object.fromEntries(Object.entries(sourceReliability).map(([p, s]) => [p, s.operationalReliability.score])),
  });
  eventBus.emit("runtime_metrics.quality.updated", { sampledAt });
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

/**
 * Context Fusion -- combina Market/Structure/Liquidity Brain (só leitura,
 * ver lib/brains/contextFusion.js) e persiste o resultado no mesmo padrão
 * de snapshot+histórico JSONL já usado pelos outros 4 domínios -- é
 * literalmente o "guardar ao longo do tempo" que motivou entrar aqui em
 * vez de criar tabela/migração nova. Cadência lenta (junto de
 * database/trading/quality): computar os 3 Brains sobre ~2500+ candles
 * não é leve o bastante pra rodar no ritmo rápido de 60s.
 */
function runContextSample() {
  const market = marketBrain.analyzeMarket(marketBrainData.gatherMarketBrainInputs(db, { symbol: config.symbol, interval: config.interval }));
  const structure = structureBrain.analyzeStructure(structureBrainData.gatherStructureBrainInputs(db, { symbol: config.symbol, interval: config.interval }));
  const liquidity = liquidityBrain.analyzeLiquidity(liquidityBrainData.gatherLiquidityBrainInputs(db, { symbol: config.symbol, interval: config.interval }));
  const context = fuseContext({ market, structure, liquidity });

  const sampledAt = new Date().toISOString();
  writeJsonSnapshot(path.join(METRICS_DIR, "context.json"), { ...context, sampledAt });
  appendHistory("context", {
    state: context.state,
    confidence: context.confidence,
    score: context.score,
    conflicts: context.conflicts,
  });
  eventBus.emit("runtime_metrics.context.updated", { sampledAt });
}

/**
 * Nível 2 (Knowledge Growth) do Plano de Evolução -- Fase 1: só persistência
 * do que registry/research-objects.json já tem hoje (status é vocabulário
 * aberto, ver countByStatus). Nenhuma análise/tendência calculada aqui.
 */
function runKnowledgeSample() {
  const objects = loadRegistry();
  const summary = countByStatus(objects);
  const sampledAt = new Date().toISOString();
  writeJsonSnapshot(path.join(METRICS_DIR, "knowledge.json"), { ...summary, sampledAt });
  appendHistory("knowledge", summary);
  eventBus.emit("runtime_metrics.knowledge.updated", { sampledAt });
}

/**
 * Nível 3 (Market Intelligence) -- Fase 1: persiste o que lib/featureBuilder
 * já calcula pro símbolo único que a plataforma roda hoje (config.symbol).
 * Quebra por ativo (BTC/ETH/SOL) fica fora até a plataforma virar
 * multi-asset -- não fabricado aqui.
 */
function runFeatureSample() {
  const featuresByDomain = buildAllFeatures(db, config.symbol);
  const features = summarizeFeatures(featuresByDomain);
  const sampledAt = new Date().toISOString();
  writeJsonSnapshot(path.join(METRICS_DIR, "features.json"), { symbol: config.symbol, features, sampledAt });
  appendHistory("features", { symbol: config.symbol, features });
  eventBus.emit("runtime_metrics.features.updated", { sampledAt });
}

/**
 * Nível 4 (Brain Evolution) -- Fase 1: lê data/replay/stats.json (gravado só
 * quando alguém roda `npm run replay` manualmente) em vez de recomputar
 * evaluateDecisionBrainReadiness aqui dentro. Se replay nunca rodou, não há
 * nada pra persistir ainda -- sem valor inventado.
 */
function runBrainSample() {
  const stats = readHeartbeat(REPLAY_STATS_FILE);
  const summary = summarizeDecisionBrainReadiness(stats?.decisionBrainReadiness);
  if (!summary) return;

  const sampledAt = new Date().toISOString();
  writeJsonSnapshot(path.join(METRICS_DIR, "brain.json"), { ...summary, sampledAt });
  appendHistory("brain", summary);
  eventBus.emit("runtime_metrics.brain.updated", { sampledAt });
}

/**
 * AI Gateway Cost (2026-08-11) -- lê data/ai-assessments.jsonl (o próprio
 * lib/aiGateway/aiGateway.js já grava lá, uma linha por assessment) e
 * calcula AI_ASSESSMENTS_24H/AI_PROVIDER_ATTEMPTS_24H/
 * AI_INPUT_TOKENS_24H/AI_OUTPUT_TOKENS_24H/AI_COST_ESTIMATE_24H/
 * AI_COST_ESTIMATE_30D (ver lib/aiGateway/costMetrics.js pra a distinção
 * assessment-vs-tentativa e a regra de quando o custo é parcial). Cadência
 * lenta (15min, junto de quality/context) é mais que suficiente -- o AI
 * Decision Cycle nunca chama a IA mais de 1x a cada
 * config.ai.minCallIntervalMs (5min por padrão), então recalcular isso no
 * ritmo rápido (60s) não traria dado mais novo.
 */
function runAiCostSample() {
  const metrics = computeAiCostMetrics();
  const sampledAt = new Date().toISOString();
  writeJsonSnapshot(path.join(METRICS_DIR, "ai-cost.json"), { ...metrics, sampledAt });
  appendHistory("ai-cost", {
    AI_ASSESSMENTS_24H: metrics.AI_ASSESSMENTS_24H,
    AI_PROVIDER_ATTEMPTS_24H: metrics.AI_PROVIDER_ATTEMPTS_24H,
    AI_INPUT_TOKENS_24H: metrics.AI_INPUT_TOKENS_24H,
    AI_OUTPUT_TOKENS_24H: metrics.AI_OUTPUT_TOKENS_24H,
    AI_COST_ESTIMATE_24H: metrics.AI_COST_ESTIMATE_24H,
    AI_COST_ESTIMATE_30D: metrics.AI_COST_ESTIMATE_30D,
    AI_COST_ESTIMATE_INCOMPLETE: metrics.AI_COST_ESTIMATE_INCOMPLETE,
    AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H: metrics.AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H,
  });
  eventBus.emit("runtime_metrics.ai_cost.updated", { sampledAt });
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

  const qualityStartedAt = Date.now();
  try {
    runQualitySample();
    samplerMetrics.recordSuccess("quality_sample", { inserted: true, latencyMs: Date.now() - qualityStartedAt });
  } catch (err) {
    samplerMetrics.recordFailure("quality_sample", err, { latencyMs: Date.now() - qualityStartedAt });
    console.error("⚠️  metricsSampler: falha ao amostrar quality:", err.message);
  }

  const contextStartedAt = Date.now();
  try {
    runContextSample();
    samplerMetrics.recordSuccess("context_sample", { inserted: true, latencyMs: Date.now() - contextStartedAt });
  } catch (err) {
    samplerMetrics.recordFailure("context_sample", err, { latencyMs: Date.now() - contextStartedAt });
    console.error("⚠️  metricsSampler: falha ao amostrar context (Context Fusion):", err.message);
  }

  const knowledgeStartedAt = Date.now();
  try {
    runKnowledgeSample();
    samplerMetrics.recordSuccess("knowledge_sample", { inserted: true, latencyMs: Date.now() - knowledgeStartedAt });
  } catch (err) {
    samplerMetrics.recordFailure("knowledge_sample", err, { latencyMs: Date.now() - knowledgeStartedAt });
    console.error("⚠️  metricsSampler: falha ao amostrar knowledge (Research Objects):", err.message);
  }

  const featureStartedAt = Date.now();
  try {
    runFeatureSample();
    samplerMetrics.recordSuccess("feature_sample", { inserted: true, latencyMs: Date.now() - featureStartedAt });
  } catch (err) {
    samplerMetrics.recordFailure("feature_sample", err, { latencyMs: Date.now() - featureStartedAt });
    console.error("⚠️  metricsSampler: falha ao amostrar features (Feature Builder):", err.message);
  }

  const brainStartedAt = Date.now();
  try {
    runBrainSample();
    samplerMetrics.recordSuccess("brain_sample", { inserted: true, latencyMs: Date.now() - brainStartedAt });
  } catch (err) {
    samplerMetrics.recordFailure("brain_sample", err, { latencyMs: Date.now() - brainStartedAt });
    console.error("⚠️  metricsSampler: falha ao amostrar brain (Decision Brain Readiness):", err.message);
  }

  const aiCostStartedAt = Date.now();
  try {
    runAiCostSample();
    samplerMetrics.recordSuccess("ai_cost_sample", { inserted: true, latencyMs: Date.now() - aiCostStartedAt });
  } catch (err) {
    samplerMetrics.recordFailure("ai_cost_sample", err, { latencyMs: Date.now() - aiCostStartedAt });
    console.error("⚠️  metricsSampler: falha ao amostrar ai-cost (AI Gateway):", err.message);
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
