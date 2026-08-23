// CLI de backfill sob demanda -- expõe lib/backfill.js (hoje só invocado
// internamente por scripts/supervisor.js na recuperação de uma queda de
// conectividade) pra uso manual quando um símbolo novo entra no Universe
// (Fase A, expansão multi-asset). Sem isso, cada símbolo novo levaria dias
// pra acumular histórico só de polling ao vivo.
//
// Uso: npm run backfill -- BTCUSDT --days=7
const config = require("../config");
const { openDb, insertEvent, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const bybitClient = require("../lib/bybit");
const { backfillCandles, backfillFunding, backfillOpenInterest } = require("../lib/backfill");

function parseArgs(argv) {
  const symbol = argv.find((a) => !a.startsWith("--"));
  const daysArg = argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? Number(daysArg.split("=")[1]) : 7;
  return { symbol, days };
}

async function main() {
  const { symbol, days } = parseArgs(process.argv.slice(2));
  if (!symbol || !Number.isFinite(days) || days <= 0) {
    console.error("Uso: npm run backfill -- <SYMBOL> [--days=N]  (ex: npm run backfill -- ETHUSDT --days=7)");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });
  const untilMs = Date.now();
  const sinceMs = untilMs - days * 24 * 60 * 60 * 1000;

  console.log(`⏪ Backfill de ${symbol} — últimos ${days} dia(s), gravando em ${DEFAULT_DB_PATH}`);

  const candles = await backfillCandles(db, eventBus, bybitClient, { symbol, interval: config.interval, sinceMs, untilMs });
  console.log(`🕯️  candles: ${candles.inserted} inseridos`);

  const funding = await backfillFunding(db, eventBus, bybitClient, { symbol, sinceMs, untilMs });
  console.log(`💰 funding: ${funding.inserted} inseridos`);

  const openInterest = await backfillOpenInterest(db, eventBus, bybitClient, { symbol, sinceMs, untilMs });
  console.log(`📊 open interest: ${openInterest.inserted} inseridos`);

  db.close();
}

main().catch((err) => {
  console.error("⚠️  Backfill falhou:", err.message);
  process.exitCode = 1;
});
