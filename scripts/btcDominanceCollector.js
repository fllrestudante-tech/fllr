// Processo standalone de coleta -- não opera, só grava no Market Database
// (data/market.db). Fonte pública sem chave (CoinGecko /global).
const { openDb, insertEvent, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const coingeckoClient = require("../lib/coingecko");
const { runCollector } = require("../lib/collectors/btcDominanceCollector");
const { DEFAULT_BTC_DOMINANCE_HEALTH_FILE } = require("../lib/healthChecks");
const { startHeartbeat } = require("../lib/heartbeatWriter");
const connectivityStatus = require("../lib/connectivityStatus");

const HEALTH_FILE = DEFAULT_BTC_DOMINANCE_HEALTH_FILE;

const db = openDb();
const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });

eventBus.on("btc_dominance.updated", (e) => console.log(`🌐 BTC Dominance atualizada: ${e.payload.btcDominancePct.toFixed(2)}%`));

console.log(`📡 BTC Dominance Collector iniciando — gravando em ${DEFAULT_DB_PATH}`);
const shouldPause = () => !connectivityStatus.isOnline() || !connectivityStatus.isProviderHealthy("coingecko");
const collector = runCollector(db, eventBus, coingeckoClient, {}, shouldPause);

const heartbeat = startHeartbeat(HEALTH_FILE, () => ({ metrics: collector.getMetrics() }), { initialDelayMs: 3000 });

process.on("SIGINT", () => {
  console.log("📡 BTC Dominance Collector encerrado (SIGINT).");
  heartbeat.stop();
  collector.stop();
  process.exit(0);
});
