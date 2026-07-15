// Processo standalone de coleta -- não opera, só grava no Market Database
// (data/market.db). Fonte pública sem chave (CoinGecko /global).
const fs = require("fs");
const path = require("path");
const { openDb, insertEvent, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const coingeckoClient = require("../lib/coingecko");
const { runCollector } = require("../lib/collectors/btcDominanceCollector");
const { DEFAULT_BTC_DOMINANCE_HEALTH_FILE } = require("../lib/healthChecks");

const HEALTH_FILE = DEFAULT_BTC_DOMINANCE_HEALTH_FILE;
const HEARTBEAT_INTERVAL_MS = 60000;

const db = openDb();
const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });

eventBus.on("btc_dominance.updated", (e) => console.log(`🌐 BTC Dominance atualizada: ${e.payload.btcDominancePct.toFixed(2)}%`));

console.log(`📡 BTC Dominance Collector iniciando — gravando em ${DEFAULT_DB_PATH}`);
const collector = runCollector(db, eventBus, coingeckoClient);

function writeHeartbeat() {
  fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
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
