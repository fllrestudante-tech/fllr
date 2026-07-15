const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../config");
const bybit = require("./bybit");
const { DEFAULT_DB_PATH: DEFAULT_MARKET_DB_PATH } = require("./infra/db");

const DEGRADED_LATENCY_MS = 3000;

/**
 * Faz uma chamada leve e real contra a Bybit (não depende de estado
 * acumulado de outras partes do bot) — funciona igual dentro do loop
 * principal ou rodando `npm run health` isolado.
 */
async function checkBybit(bybitClient = bybit, opts = {}) {
  const now = opts.now || Date.now;
  const degradedLatencyMs = opts.degradedLatencyMs ?? DEGRADED_LATENCY_MS;
  const startedAt = now();
  try {
    await bybitClient.getKlines(config.symbol, config.interval, 1);
    const latencyMs = now() - startedAt;
    return { status: latencyMs > degradedLatencyMs ? "degraded" : "ok", details: { latencyMs } };
  } catch (err) {
    return { status: "down", details: { error: err.message, latencyMs: now() - startedAt } };
  }
}

/**
 * Lê o histórico do auto-tuning (data/tuning.json) — não roda um backtest
 * novo, só reporta se o último já rodou dentro do intervalo esperado.
 */
function checkBacktest(tuningFilePath = config.paths.tuningFile, now = Date.now()) {
  if (!fs.existsSync(tuningFilePath)) {
    return { status: "not_implemented", details: { reason: "backtest ainda não rodou" } };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(tuningFilePath, "utf8"));
    const lastRun = raw.history && raw.history[0];
    if (!lastRun) {
      return { status: "degraded", details: { reason: "tuning.json sem histórico" } };
    }
    const ageMs = now - new Date(lastRun.ranAt).getTime();
    const maxAgeMs = config.backtestIntervalHours * 60 * 60 * 1000 * 2; // tolera 1 execução perdida
    return {
      status: ageMs > maxAgeMs ? "degraded" : "ok",
      details: { ranAt: lastRun.ranAt, promoted: lastRun.promoted, ageMs },
    };
  } catch (err) {
    return { status: "down", details: { error: err.message } };
  }
}

const TELEGRAM_STALE_MS = 5 * 60 * 1000;
const DEFAULT_TELEGRAM_HEALTH_FILE = path.join(__dirname, "..", "telegram-radar", "data", "health.json");

/**
 * Lê o heartbeat que telegram-radar/watch.js escreve periodicamente — o
 * radar roda como processo separado do loop principal, então a única forma
 * de saber se ele está vivo é essa marca de tempo em disco.
 */
function checkTelegramRadar(healthFilePath = DEFAULT_TELEGRAM_HEALTH_FILE, now = Date.now()) {
  if (!fs.existsSync(healthFilePath)) {
    return { status: "not_implemented", details: { reason: "telegram-radar/watch.js nunca rodou" } };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(healthFilePath, "utf8"));
    const ageMs = now - new Date(raw.lastHeartbeatAt).getTime();
    return { status: ageMs > TELEGRAM_STALE_MS ? "down" : "ok", details: { ...raw, ageMs } };
  } catch (err) {
    return { status: "down", details: { error: err.message } };
  }
}

const COLLECTOR_STALE_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES_DEGRADED = 3;
const RUNTIME_HEARTBEATS_DIR = path.join(__dirname, "..", "runtime", "heartbeats");
const DEFAULT_COLLECTOR_HEALTH_FILE = path.join(RUNTIME_HEARTBEATS_DIR, "bybit-collector.json");
const DEFAULT_FEAR_GREED_HEALTH_FILE = path.join(RUNTIME_HEARTBEATS_DIR, "fear-greed-collector.json");
const DEFAULT_BTC_DOMINANCE_HEALTH_FILE = path.join(RUNTIME_HEARTBEATS_DIR, "btc-dominance-collector.json");
const DEFAULT_KNOWLEDGE_HEALTH_FILE = path.join(RUNTIME_HEARTBEATS_DIR, "knowledge-collector.json");

/**
 * Lê heartbeat + métricas (lib/collectors/collectorMetrics.js) que qualquer
 * coletor escreve periodicamente. degraded quando algum domínio acumula
 * falhas consecutivas -- mesmo com o processo vivo (heartbeat fresco), pode
 * estar falhando silenciosamente contra a fonte. Compartilhado por
 * checkCollector (Bybit) e checkFearGreed -- mesma forma de arquivo, só
 * muda o path default.
 */
function checkCollectorHeartbeat(healthFilePath, now = Date.now()) {
  if (!fs.existsSync(healthFilePath)) {
    return { status: "not_implemented", details: { reason: "coletor nunca rodou" } };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(healthFilePath, "utf8"));
    const ageMs = now - new Date(raw.lastHeartbeatAt).getTime();
    if (ageMs > COLLECTOR_STALE_MS) {
      return { status: "down", details: { reason: "heartbeat velho", ageMs } };
    }

    const domains = raw.metrics || {};
    const failingDomains = Object.entries(domains)
      .filter(([, m]) => m.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES_DEGRADED)
      .map(([name]) => name);

    return { status: failingDomains.length > 0 ? "degraded" : "ok", details: { ageMs, failingDomains, domains } };
  } catch (err) {
    return { status: "down", details: { error: err.message } };
  }
}

function checkCollector(healthFilePath = DEFAULT_COLLECTOR_HEALTH_FILE, now = Date.now()) {
  return checkCollectorHeartbeat(healthFilePath, now);
}

function checkFearGreed(healthFilePath = DEFAULT_FEAR_GREED_HEALTH_FILE, now = Date.now()) {
  return checkCollectorHeartbeat(healthFilePath, now);
}

function checkBtcDominance(healthFilePath = DEFAULT_BTC_DOMINANCE_HEALTH_FILE, now = Date.now()) {
  return checkCollectorHeartbeat(healthFilePath, now);
}

function checkKnowledgeCollector(healthFilePath = DEFAULT_KNOWLEDGE_HEALTH_FILE, now = Date.now()) {
  return checkCollectorHeartbeat(healthFilePath, now);
}

const SUPERVISOR_STALE_MS = 90000; // 3x o tick de 30s do scripts/supervisor.js
const DEFAULT_SUPERVISOR_STATE_FILE = path.join(__dirname, "..", "runtime", "processes", "state.json");

/**
 * Lê runtime/processes/state.json, escrito por scripts/supervisor.js a cada
 * tick. down se o supervisor parou de bater (processo morreu/travou) --
 * diferente dos checks de coletor, aqui "ageMs" mede o próprio supervisor,
 * não um coletor individual. `details.children` dá um resumo rápido de
 * status por processo sem duplicar a tabela completa (isso é a Fase B).
 */
function checkSupervisor(statePath = DEFAULT_SUPERVISOR_STATE_FILE, now = Date.now()) {
  if (!fs.existsSync(statePath)) {
    return { status: "not_implemented", details: { reason: "supervisor nunca rodou" } };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const lastTickAt = raw._meta && raw._meta.lastTickAt;
    if (!lastTickAt) {
      return { status: "degraded", details: { reason: "state.json sem _meta.lastTickAt" } };
    }
    const ageMs = now - new Date(lastTickAt).getTime();
    const children = Object.fromEntries(
      Object.entries(raw)
        .filter(([name]) => name !== "_meta")
        .map(([name, c]) => [name, c.status])
    );
    return { status: ageMs > SUPERVISOR_STALE_MS ? "down" : "ok", details: { ageMs, children } };
  } catch (err) {
    return { status: "down", details: { error: err.message } };
  }
}

// Banco de Dados (market.db único, lib/infra/db.js) — SELECT 1 real, não só
// checa se o arquivo existe, pra pegar corrupção/lock também.
function checkDatabase(dbPath = DEFAULT_MARKET_DB_PATH) {
  if (!fs.existsSync(dbPath)) {
    return { status: "not_implemented", details: { reason: "market.db ainda não existe (nenhum coletor rodou ainda)" } };
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.prepare("SELECT 1").get();
    return { status: "ok", details: {} };
  } catch (err) {
    return { status: "down", details: { error: err.message } };
  } finally {
    if (db) db.close();
  }
}

// Módulos ainda não construídos (Scanner, IA, Workers) reportam isso
// honestamente em vez de fingir um status.
function notImplemented() {
  return { status: "not_implemented", details: {} };
}

module.exports = {
  checkBybit,
  checkBacktest,
  checkTelegramRadar,
  checkDatabase,
  checkCollector,
  checkFearGreed,
  checkBtcDominance,
  checkKnowledgeCollector,
  checkSupervisor,
  notImplemented,
  DEFAULT_TELEGRAM_HEALTH_FILE,
  DEFAULT_MARKET_DB_PATH,
  RUNTIME_HEARTBEATS_DIR,
  DEFAULT_COLLECTOR_HEALTH_FILE,
  DEFAULT_FEAR_GREED_HEALTH_FILE,
  DEFAULT_BTC_DOMINANCE_HEALTH_FILE,
  DEFAULT_KNOWLEDGE_HEALTH_FILE,
  DEFAULT_SUPERVISOR_STATE_FILE,
};
