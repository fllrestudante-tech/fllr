// Processo standalone de coleta -- não opera, só grava eventos normalizados
// no Market Database (data/market.db). Primeiro capítulo do "Knowledge
// Collector": hoje só cobre eventos estruturados (market_events); notícias,
// vídeos, tweets viram providers/tabelas próprias no futuro.
const { openDb, insertEvent, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const { runCollector } = require("../lib/collectors/knowledge/eventsCollector");

const coinMarketCalClient = require("../lib/coinMarketCal");
const coinMarketCalProvider = require("../lib/collectors/knowledge/providers/coinMarketCalProvider");
const fredClient = require("../lib/fred");
const fredProvider = require("../lib/collectors/knowledge/providers/fredProvider");
const fomcCalendarProvider = require("../lib/collectors/knowledge/providers/fomcCalendarProvider");
const { DEFAULT_KNOWLEDGE_HEALTH_FILE } = require("../lib/healthChecks");
const { startHeartbeat } = require("../lib/heartbeatWriter");

const HEALTH_FILE = DEFAULT_KNOWLEDGE_HEALTH_FILE;

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

const heartbeat = startHeartbeat(HEALTH_FILE, () => ({ metrics: collector.getMetrics() }));

process.on("SIGINT", () => {
  console.log("📡 Knowledge Collector encerrado (SIGINT).");
  heartbeat.stop();
  collector.stop();
  process.exit(0);
});
