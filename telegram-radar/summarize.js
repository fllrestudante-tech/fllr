// Consulta o SQLite (telegram-radar/data/radar.db) e ranqueia tickers por
// score de frequência com decaimento — substitui reprocessar o mentions.jsonl
// inteiro a cada chamada. Rodar sob demanda (node telegram-radar/summarize.js).
const fs = require("fs");
const { openDb, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { scoreByTicker } = require("./lib/score");

if (!fs.existsSync(DEFAULT_DB_PATH)) {
  console.log("Nenhuma menção coletada ainda. Rode watch.js primeiro.");
  process.exit(0);
}

const db = openDb();
const rows = db.prepare("SELECT ticker, time_ms as time, channel FROM telegram_messages WHERE ticker IS NOT NULL").all();

if (rows.length === 0) {
  console.log("Nenhuma menção com ticker coletada ainda.");
  process.exit(0);
}

const channelsByTicker = {};
for (const r of rows) {
  if (!channelsByTicker[r.ticker]) channelsByTicker[r.ticker] = new Set();
  channelsByTicker[r.ticker].add(r.channel);
}

const scores = scoreByTicker(rows);
const ranked = Object.entries(scores)
  .map(([ticker, windows]) => ({ ticker, ...windows, channels: [...channelsByTicker[ticker]] }))
  .sort((a, b) => (b["24h"] || 0) - (a["24h"] || 0));

console.log(`Total de menções (ticker x mensagem): ${rows.length}`);
console.log("Watchlist (score por janela, com decaimento — mais recente pesa mais):\n");
ranked.forEach((r, i) => {
  console.log(
    `${i + 1}. ${r.ticker} — score 1h=${(r["1h"] || 0).toFixed(2)} 24h=${(r["24h"] || 0).toFixed(2)} 7d=${(r["7d"] || 0).toFixed(2)} — canais: ${r.channels.join(", ")}`
  );
});
