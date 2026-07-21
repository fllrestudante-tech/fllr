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
const { createAlertManager } = require("../lib/alertManager");
const { logAlert } = require("../lib/logger");

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

// Processa 1 mensagem recebida -- isolado num try/catch pra que uma falha
// (ex: banco travado) não derrube o processo inteiro (client.addEventHandler
// roda callbacks async fora de qualquer try do chamador; uma rejeição não
// tratada mataria o radar, que não é supervisionado). Erro vira log
// estruturado (lib/logger.js::logAlert) + alerta ERROR via
// lib/alertManager.js (mesmo caminho já confirmado funcionando pro Telegram),
// mas a mensagem seguinte continua sendo processada normalmente. Extraído
// como função própria (recebe dependências por parâmetro) pra ser testável
// sem precisar de uma conexão real com o Telegram.
async function handleIncomingMessage({ db, eventBus, alertManager, targets, targetIds }, message) {
  const chatId = message.chatId?.toString();
  if (!chatId || !targetIds.has(chatId)) return { handled: false };

  const chat = targets.find((t) => t.id.toString() === chatId);
  const channel = chat?.title || chatId;
  // message.date é o timestamp real de quando a mensagem foi publicada no
  // Telegram (segundos epoch) -- usar isso em vez de Date.now() (hora de
  // recebimento) evita distorcer análise temporal caso o gramJS reentregue
  // backlog após uma reconexão (recebimento tardio ≠ momento da publicação).
  const messageTimeMs = message.date ? message.date * 1000 : Date.now();
  const text = message.message || "";
  const { tickers, keywords } = extractSignals(text);
  if (tickers.length === 0 && keywords.length === 0) return { handled: false };

  try {
    const recentHashes = getRecentHashes(db, DEDUPE_WINDOW_MS, messageTimeMs);
    if (isDuplicate(text, recentHashes, DEDUPE_WINDOW_MS, messageTimeMs)) {
      console.log(`⏭️  [${channel}] mensagem duplicada (repost dentro de ${DEDUPE_WINDOW_MS / 60000}min), ignorada.`);
      return { handled: false, duplicate: true };
    }

    const { sentiment, confidence, matchedKeywords } = classify(text);
    const hash = hashText(text);
    const truncatedText = text.slice(0, 500);
    const tickerList = tickers.length > 0 ? tickers : [null];

    for (const ticker of tickerList) {
      insertMention(db, {
        timeMs: messageTimeMs,
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
    return { handled: true };
  } catch (err) {
    const context = {
      event: "radar_insert_error",
      channel,
      messageId: message.id ?? null,
      ticker: tickers[0] ?? null,
      timestampMs: messageTimeMs,
      error: err.message,
      stack: err.stack,
    };
    logAlert(context);
    console.error(`❌ [${channel}] erro ao processar mensagem (isolado -- radar continua vivo): ${err.message}`);
    if (alertManager) {
      await alertManager
        .fire("telegram_radar_insert_error", "ERROR", `telegram-radar: falha ao processar mensagem de [${channel}] -- ${err.message}`)
        .catch((alertErr) => console.error("❌ Falha ao enviar alerta de erro do radar:", alertErr.message));
    }
    return { handled: false, error: err.message };
  }
}

async function main() {
  ensureDataDir();
  const db = openDb(); // market.db único (lib/infra/db.js) -- não abre mais um banco isolado do radar
  const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });
  const alertManager = createAlertManager({ db });
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

  client.addEventHandler((event) => {
    // handleIncomingMessage nunca rejeita (ver comentário na definição) --
    // o .catch aqui é só uma rede de segurança extra caso algo escape disso.
    handleIncomingMessage({ db, eventBus, alertManager, targets, targetIds }, event.message).catch((err) => {
      console.error("❌ Erro inesperado não capturado no handler do radar:", err.message);
    });
  }, new NewMessage({}));
}

// Só roda main() quando o arquivo é executado diretamente (npm run
// telegram:watch) -- permite requerer extractSignals/handleIncomingMessage
// em testes sem conectar no Telegram de verdade.
if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Erro no radar de Telegram:", err.message);
    process.exit(1);
  });
}

module.exports = { extractSignals, handleIncomingMessage };
