// Processo standalone de coleta -- não opera, só grava no Market Database
// (data/market.db). Fonte pública sem chave (CoinGecko /global).
const fs = require("fs");
const path = require("path");
const { openDb, insertEvent, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const coingeckoClient = require("../lib/coingecko");
const { runCollector } = require("../lib/collectors/btcDominanceCollector");

const HEALTH_FILE = path.join(__dirname, "..", "data", "btc-dominance-collector-health.json");
const HEARTBEAT_INTERVAL_MS = 60000;

const db = openDb();
const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });

eventBus.on("btc_dominance.updated", (e) => console.log(`🌐 BTC Dominance atualizada: ${e.payload.btcDominancePct.toFixed(2)}%`));

console.log(`📡 BTC Dominance Collector iniciando — gravando em ${DEFAULT_DB_PATH}`);
const collector = runCollector(db, eventBus, coingeckoClient);

function writeHeartbeat() {
  fs.writeFileSync(
    HEALTH_FILE,
    JSON.stringify({ lastHeartbeatAt: new Date().toISOString(), metrics: collector.getMetrics() }, null, 2)
  );
}

setTimeout(writeHeartbeat, 3000);
setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);

process.on("SIGINT", () => {
  console.log("📡 BTC Dominance Collector encerrado (SIGINT).");
  collector.stop();
  process.exit(0);
});
