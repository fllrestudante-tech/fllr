// Processo standalone de coleta -- não opera, só grava no Market Database
// (data/market.db). Roda em paralelo ao bot de trading (index.js), que por
// enquanto continua lendo direto da Bybit sem depender deste coletor.
const config = require("../config");
const { openDb, insertEvent, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const bybitClient = require("../lib/bybit");
const { runCollector } = require("../lib/collectors/bybitCollector");
const { DEFAULT_COLLECTOR_HEALTH_FILE } = require("../lib/healthChecks");
const { startHeartbeat } = require("../lib/heartbeatWriter");
const connectivityStatus = require("../lib/connectivityStatus");
const { getUniverse } = require("../lib/universe");
const { getRetryStats } = require("../lib/httpRetry");

const HEALTH_FILE = DEFAULT_COLLECTOR_HEALTH_FILE;

const db = openDb();
const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });

eventBus.on("candle.closed", (e) => console.log(`🕯️  candle fechado: ${e.payload.symbol} ${e.payload.interval}m @ ${e.payload.openTime}`));
eventBus.on("funding.updated", (e) => console.log(`💰 funding atualizado: ${e.payload.symbol}`));
eventBus.on("oi.updated", (e) => console.log(`📊 open interest atualizado: ${e.payload.symbol}`));
eventBus.on("ticker.updated", () => {}); // alta frequência, sem log pra não poluir o console
eventBus.on("long_short_ratio.updated", (e) => console.log(`⚖️  long/short atualizado: ${e.payload.symbol}`));

// Fase A (expansão multi-asset) -- o Universe (lib/universe.js, MARKET_SYMBOLS
// no .env) substitui o único config.symbol de antes; sem MARKET_SYMBOLS
// configurado, getUniverse já cai pra [config.symbol] sozinho.
const { symbols } = getUniverse({ fallbackSymbol: config.symbol });
console.log(`📡 Bybit Collector iniciando — ${symbols.length} símbolo(s) [${symbols.join(", ")}], gravando em ${DEFAULT_DB_PATH}`);
const shouldPause = () => !connectivityStatus.isOnline() || !connectivityStatus.isProviderHealthy("bybit");
const collector = runCollector(db, eventBus, bybitClient, config, {}, shouldPause);

// lib/healthChecks.js (checkCollector) lê esse arquivo -- o collector roda
// como processo separado do loop principal e do npm run health, então essa
// marca de tempo + métricas em disco é a única forma de checar de fora.
// schedulerStats/rateLimitStats entram na Fase A pra dar visibilidade de
// saturação/throttling durante o rollout progressivo (getRetryStats é
// acumulado desde o boot deste processo, cobre todas as chamadas à Bybit
// feitas por ele, não só o coletor).
const heartbeat = startHeartbeat(HEALTH_FILE, () => ({
  metrics: collector.getMetrics(),
  schedulerStats: collector.getSchedulerStats(),
  rateLimitStats: getRetryStats(),
}));

process.on("SIGINT", () => {
  console.log("📡 Collector encerrado (SIGINT).");
  heartbeat.stop();
  collector.stop();
  process.exit(0);
});
