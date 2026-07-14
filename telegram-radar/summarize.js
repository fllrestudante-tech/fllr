// Agrega telegram-radar/data/mentions.jsonl numa watchlist ranqueada por
// frequência de menção. Rodar sob demanda (node telegram-radar/summarize.js).
const fs = require("fs");
const path = require("path");

const MENTIONS_FILE = path.join(__dirname, "data", "mentions.jsonl");

if (!fs.existsSync(MENTIONS_FILE)) {
  console.log("Nenhuma menção coletada ainda. Rode watch.js primeiro.");
  process.exit(0);
}

const lines = fs.readFileSync(MENTIONS_FILE, "utf8").trim().split("\n").filter(Boolean);
const entries = lines.map((l) => JSON.parse(l));

const counts = {};
for (const e of entries) {
  for (const ticker of e.tickers) {
    if (!counts[ticker]) counts[ticker] = { mentions: 0, channels: new Set(), lastSeen: e.time };
    counts[ticker].mentions++;
    counts[ticker].channels.add(e.channel);
    if (e.time > counts[ticker].lastSeen) counts[ticker].lastSeen = e.time;
  }
}

const ranked = Object.entries(counts)
  .map(([ticker, v]) => ({ ticker, mentions: v.mentions, channels: [...v.channels], lastSeen: v.lastSeen }))
  .sort((a, b) => b.mentions - a.mentions);

console.log(`Total de mensagens com sinal: ${entries.length}`);
console.log("Watchlist (por número de menções):\n");
ranked.forEach((r, i) => {
  console.log(`${i + 1}. ${r.ticker} — ${r.mentions}x — canais: ${r.channels.join(", ")} — última vez: ${r.lastSeen}`);
});
