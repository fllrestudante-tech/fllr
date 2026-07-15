// Processo standalone de coleta -- não opera, só grava eventos normalizados
// no Market Database (data/market.db). Primeiro capítulo do "Knowledge
// Collector": hoje só cobre eventos estruturados (market_events); notícias,
// vídeos, tweets viram providers/tabelas próprias no futuro.
const fs = require("fs");
const path = require("path");
const { openDb, insertEvent, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const { runCollector } = require("../lib/collectors/knowledge/eventsCollector");

const coinMarketCalClient = require("../lib/coinMarketCal");
const coinMarketCalProvider = require("../lib/collectors/knowledge/providers/coinMarketCalProvider");
const fredClient = require("../lib/fred");
const fredProvider = require("../lib/collectors/knowledge/providers/fredProvider");
const fomcCalendarProvider = require("../lib/collectors/knowledge/providers/fomcCalendarProvider");

const HEALTH_FILE = path.join(__dirname, "..", "data", "knowledge-collector-health.json");
const HEARTBEAT_INTERVAL_MS = 60000;

const db = openDb();
const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });

eventBus.on("market_event.created", (e) => console.log(`🗓️  novo evento [${e.payload.provider}/${e.payload.category}]`));
eventBus.on("market_event.updated", (e) => console.log(`🔄 evento atualizado [${e.payload.provider}/${e.payload.category}]`));

console.log(`📡 Knowledge Collector (eventos) iniciando — gravando em ${DEFAULT_DB_PATH}`);
const collector = runCollector(db, eventBus, [
  { provider: coinMarketCalProvider, client: coinMarketCalClient },
  { provider: fredProvider, client: fredClient },
  { provider: fomcCalendarProvider, client: null, intervalMs: 24 * 60 * 60 * 1000 }, // dado estático, checar 1x/dia basta
]);

function writeHeartbeat() {
  fs.writeFileSync(
    HEALTH_FILE,
    JSON.stringify({ lastHeartbeatAt: new Date().toISOString(), metrics: collector.getMetrics() }, null, 2)
  );
}

setTimeout(writeHeartbeat, 5000);
setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);

process.on("SIGINT", () => {
  console.log("📡 Knowledge Collector encerrado (SIGINT).");
  collector.stop();
  process.exit(0);
});
