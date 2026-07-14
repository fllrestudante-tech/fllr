const fs = require("fs");
const path = require("path");
const config = require("../config");
const bybit = require("./bybit");

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

// Módulos ainda não construídos (Scanner, Banco de Dados até a Fase 4, IA,
// Workers) reportam isso honestamente em vez de fingir um status.
function notImplemented() {
  return { status: "not_implemented", details: {} };
}

module.exports = { checkBybit, checkBacktest, checkTelegramRadar, notImplemented, DEFAULT_TELEGRAM_HEALTH_FILE };
