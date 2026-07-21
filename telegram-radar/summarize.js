// Consulta o SQLite e ranqueia tickers por score de frequência com
// decaimento. Lê de telegram_signals (join com telegram_messages_raw pro
// canal/timestamp) -- essa tabela só existe vazia até um classificador
// futuro (Narrative Engine/Signal Extractor) processar telegram_messages_raw
// e gravar linhas nela (migração 0009). Rodar sob demanda
// (node telegram-radar/summarize.js).
const fs = require("fs");
const { openDb, DEFAULT_DB_PATH } = require("../lib/infra/db");
const { scoreByTicker } = require("./lib/score");

if (!fs.existsSync(DEFAULT_DB_PATH)) {
  console.log("Nenhuma menção coletada ainda. Rode watch.js primeiro.");
  process.exit(0);
}

const db = openDb();
const rows = db
  .prepare(
    `SELECT s.ticker as ticker, r.time_ms as time, r.channel as channel
     FROM telegram_signals s
     JOIN telegram_messages_raw r ON r.id = s.raw_message_id
     WHERE s.ticker IS NOT NULL`
  )
  .all();

if (rows.length === 0) {
  console.log(
    "Nenhum ticker classificado ainda -- watch.js só captura texto bruto (telegram_messages_raw); a extração de ticker é responsabilidade de um classificador futuro (Narrative Engine/Signal Extractor) que ainda não existe."
  );
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
