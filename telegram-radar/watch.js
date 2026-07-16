// Escuta canais do Telegram (contas que você já segue) e extrai menções de
// tickers/palavras-chave pra uma base local (SQLite) — 100% determinístico,
// sem chamada a nenhuma IA/LLM: só regex, dedup, classificação por
// palavra-chave e score por frequência. Rodar depois de gerar a sessão com
// login.js.
require("dotenv").config({ path: __dirname + "/../.env" });
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { openDb, insertEvent } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const { getRecentHashes, insertMention } = require("../lib/collectors/telegramStore");
const { hashText, isDuplicate } = require("./lib/dedupe");
const { classify } = require("./lib/classify");

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION || "";
const targetChannelNames = (process.env.TELEGRAM_CHANNELS || "Velatrader Squad Oficial")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const DATA_DIR = path.join(__dirname, "data");
const HEALTH_FILE = path.join(DATA_DIR, "health.json");
const HEARTBEAT_INTERVAL_MS = 60000;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000; // mesmo "call" repostado em canais diferentes dentro de 10min conta uma vez só

// lib/healthChecks.js (checkTelegramRadar) lê esse arquivo pra saber se o
// radar está vivo — watch.js roda como processo separado do loop principal,
// então essa marca de tempo em disco é a única forma de checar de fora.
function writeHeartbeat(extra = {}) {
  fs.writeFileSync(HEALTH_FILE, JSON.stringify({ lastHeartbeatAt: new Date().toISOString(), ...extra }));
}

if (!apiId || !apiHash || !sessionString) {
  console.error("⚠️  Preencha TELEGRAM_API_ID, TELEGRAM_API_HASH e TELEGRAM_SESSION no .env (rode login.js primeiro).");
  process.exit(1);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Cashtags/hashtags tipo $BTC, #SOL, $1000PEPE — e algumas palavras-chave de calls.
const TICKER_REGEX = /[$#]([A-Z][A-Z0-9]{1,9})\b/g;
const KEYWORDS = ["breakout", "listing", "airdrop", "buy zone", "pump", "moon", "gem", "presale"];

function extractSignals(text) {
  if (!text) return { tickers: [], keywords: [] };
  const tickers = [...new Set([...text.matchAll(TICKER_REGEX)].map((m) => m[1]))];
  const lower = text.toLowerCase();
  const keywords = KEYWORDS.filter((k) => lower.includes(k));
  return { tickers, keywords };
}

async function main() {
  ensureDataDir();
  const db = openDb(); // market.db único (lib/infra/db.js) -- não abre mais um banco isolado do radar
  const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  console.log("✅ Conectado ao Telegram.");
  writeHeartbeat({ status: "connected" });
  setInterval(() => writeHeartbeat({ status: "connected" }), HEARTBEAT_INTERVAL_MS);

  const dialogs = await client.getDialogs({});
  const targets = dialogs.filter((d) => {
    const title = (d.title || "").trim().toLowerCase();
    return targetChannelNames.some((name) => title.includes(name));
  });

  if (targets.length === 0) {
    console.error(`⚠️  Nenhum canal encontrado com o nome: ${targetChannelNames.join(", ")}. Canais disponíveis:`);
    dialogs.filter((d) => d.isChannel || d.isGroup).forEach((d) => console.error(`  - ${d.title}`));
    process.exit(1);
  }

  // Casamento é por substring contra os dialogs que a conta já segue -- não
  // entra em canal novo sozinho. Se algum nome pedido não bateu com nada,
  // avisa qual (senão fica silenciosamente incompleto quando pelo menos 1
  // dos N nomes bate e os outros não).
  const unmatched = targetChannelNames.filter(
    (name) => !targets.some((t) => (t.title || "").trim().toLowerCase().includes(name))
  );
  if (unmatched.length > 0) {
    console.warn(
      `⚠️  ${unmatched.length} canal(is) pedido(s) no TELEGRAM_CHANNELS não foram encontrados nos diálogos da conta (provavelmente ainda não seguidos/entrou no grupo): ${unmatched.join(", ")}`
    );
  }

  console.log(`📡 Escutando (${targets.length}/${targetChannelNames.length} pedidos): ${targets.map((t) => t.title).join(", ")}`);
  const targetIds = new Set(targets.map((t) => t.id.toString()));

  client.addEventHandler(async (event) => {
    const message = event.message;
    const chatId = message.chatId?.toString();
    if (!chatId || !targetIds.has(chatId)) return;

    const text = message.message || "";
    const { tickers, keywords } = extractSignals(text);
    if (tickers.length === 0 && keywords.length === 0) return;

    const chat = targets.find((t) => t.id.toString() === chatId);
    const channel = chat?.title || chatId;
    const now = Date.now();

    const recentHashes = getRecentHashes(db, DEDUPE_WINDOW_MS, now);
    if (isDuplicate(text, recentHashes, DEDUPE_WINDOW_MS, now)) {
      console.log(`⏭️  [${channel}] mensagem duplicada (repost dentro de ${DEDUPE_WINDOW_MS / 60000}min), ignorada.`);
      return;
    }

    const { sentiment, confidence, matchedKeywords } = classify(text);
    const hash = hashText(text);
    const truncatedText = text.slice(0, 500);
    const tickerList = tickers.length > 0 ? tickers : [null];

    for (const ticker of tickerList) {
      insertMention(db, {
        timeMs: now,
        channel,
        ticker,
        text: truncatedText,
        hash,
        sentiment,
        confidence,
        keywords: matchedKeywords.length ? matchedKeywords : keywords,
      });
    }

    eventBus.emit("telegram.message.received", { channel, tickers, sentiment, confidence });
    console.log(`📥 [${channel}] tickers=${tickers.join(",")} sentiment=${sentiment}(${confidence.toFixed(2)}) keywords=${keywords.join(",")}`);
  }, new NewMessage({}));
}

main().catch((err) => {
  console.error("❌ Erro no radar de Telegram:", err.message);
  process.exit(1);
});
