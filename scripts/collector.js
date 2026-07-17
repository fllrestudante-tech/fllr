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

const HEALTH_FILE = DEFAULT_COLLECTOR_HEALTH_FILE;

const db = openDb();
const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });

eventBus.on("candle.closed", (e) => console.log(`🕯️  candle fechado: ${e.payload.symbol} ${e.payload.interval}m @ ${e.payload.openTime}`));
eventBus.on("funding.updated", (e) => console.log(`💰 funding atualizado: ${e.payload.symbol}`));
eventBus.on("oi.updated", (e) => console.log(`📊 open interest atualizado: ${e.payload.symbol}`));
eventBus.on("ticker.updated", () => {}); // alta frequência, sem log pra não poluir o console
eventBus.on("long_short_ratio.updated", (e) => console.log(`⚖️  long/short atualizado: ${e.payload.symbol}`));

console.log(`📡 Bybit Collector iniciando — símbolo ${config.symbol}, gravando em ${DEFAULT_DB_PATH}`);
const collector = runCollector(db, eventBus, bybitClient, config);

// lib/healthChecks.js (checkCollector) lê esse arquivo -- o collector roda
// como processo separado do loop principal e do npm run health, então essa
// marca de tempo + métricas em disco é a única forma de checar de fora.
const heartbeat = startHeartbeat(HEALTH_FILE, () => ({ metrics: collector.getMetrics() }));

process.on("SIGINT", () => {
  console.log("📡 Collector encerrado (SIGINT).");
  heartbeat.stop();
  collector.stop();
  process.exit(0);
});
