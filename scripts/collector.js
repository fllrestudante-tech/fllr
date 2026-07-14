// Processo standalone de coleta -- não opera, só grava no Market Database
// (data/market.db). Roda em paralelo ao bot de trading (index.js), que por
// enquanto continua lendo direto da Bybit sem depender deste coletor.
const config = require("../config");
const { openDb, insertEvent, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const bybitClient = require("../lib/bybit");
const { runCollector } = require("../lib/collectors/bybitCollector");

const db = openDb();
const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });

eventBus.on("candle.closed", (e) => console.log(`🕯️  candle fechado: ${e.payload.symbol} ${e.payload.interval}m @ ${e.payload.openTime}`));
eventBus.on("funding.updated", (e) => console.log(`💰 funding atualizado: ${e.payload.symbol}`));
eventBus.on("oi.updated", (e) => console.log(`📊 open interest atualizado: ${e.payload.symbol}`));

console.log(`📡 Bybit Collector iniciando — símbolo ${config.symbol}, gravando em ${DEFAULT_DB_PATH}`);
runCollector(db, eventBus, bybitClient, config);
