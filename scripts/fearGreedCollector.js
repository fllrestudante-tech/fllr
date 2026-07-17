// Processo standalone de coleta -- não opera, só grava no Market Database
// (data/market.db). Fonte pública sem chave (alternative.me), atualiza ~1x/dia.
const { openDb, insertEvent, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const fearGreedClient = require("../lib/fearGreed");
const { runCollector } = require("../lib/collectors/fearGreedCollector");
const { DEFAULT_FEAR_GREED_HEALTH_FILE } = require("../lib/healthChecks");
const { startHeartbeat } = require("../lib/heartbeatWriter");

const HEALTH_FILE = DEFAULT_FEAR_GREED_HEALTH_FILE;

const db = openDb();
const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });

eventBus.on("fear_greed.updated", (e) => console.log(`😱 Fear & Greed atualizado: ${e.payload.value}`));

console.log(`📡 Fear & Greed Collector iniciando — gravando em ${DEFAULT_DB_PATH}`);
const collector = runCollector(db, eventBus, fearGreedClient);

// fonte única, resposta rápida -- 3s é suficiente (Bybit usa 5s por ter 5 domínios em paralelo)
const heartbeat = startHeartbeat(HEALTH_FILE, () => ({ metrics: collector.getMetrics() }), { initialDelayMs: 3000 });

process.on("SIGINT", () => {
  console.log("📡 Fear & Greed Collector encerrado (SIGINT).");
  heartbeat.stop();
  collector.stop();
  process.exit(0);
});
