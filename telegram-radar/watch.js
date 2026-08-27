// Escuta canais do Telegram (contas que você já segue) e captura
// praticamente toda mensagem útil pra base local (SQLite, tabela
// telegram_messages_raw) -- o Telegram Collector é um COLETOR, não um
// classificador: grava texto/mídia/replies bruto e nunca toma decisão
// irreversível na ingestão. A decisão de relevância (é call? é ticker? é
// ruído?) vira responsabilidade de uma camada separada (telegram_signals,
// migração 0009), escrita depois por um classificador futuro (Narrative
// Engine/Signal Extractor) que lê o histórico bruto completo -- permitindo
// reprocessar do zero sempre que o algoritmo evoluir, sem perder nem
// recapturar nada. Só descarta o que é claramente irrelevante na origem
// (serviço do Telegram, sticker/GIF sem legenda, mensagem vazia) -- ver
// shouldSkipMessage(). Rodar depois de gerar a sessão com login.js.
require("dotenv").config({ path: __dirname + "/../.env" });
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { openDb, insertEvent } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const { getRecentHashes, insertRawMessage } = require("../lib/collectors/telegramStore");
const { hashText, isDuplicate } = require("./lib/dedupe");
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
const URL_REGEX = /https?:\/\/\S+/g;

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

// Filtro mínimo na origem -- só descarta o que não carrega conteúdo nenhum
// pra capturar: mensagens de serviço (entrou/saiu, mudou foto/título, pin --
// identificadas por message.action), mensagem totalmente vazia (sem texto e
// sem mídia), e sticker/GIF isolado sem legenda. Reações não passam por
// aqui -- chegam via um tipo de update diferente (UpdateMessageReactions),
// não via NewMessage, então já ficam fora naturalmente. Tudo o mais
// (inclusive mídia com legenda, ou mídia sem legenda que não seja
// sticker/gif, ex: um print de gráfico) é capturado.
function shouldSkipMessage(message) {
  if (message.action) return true;
  const hasText = Boolean(message.message && message.message.trim().length > 0);
  const hasMedia = Boolean(message.media);
  if (!hasText && !hasMedia) return true;
  if (!hasText && (message.sticker || message.gif)) return true;
  return false;
}

function extractLinks(text) {
  if (!text) return [];
  const matches = text.match(URL_REGEX) || [];
  // \S+ pega pontuação de frase colada no fim da URL (ex: "...abc," ou
  // "...abc)."); remove esses caracteres do final antes de deduplicar.
  const cleaned = matches.map((url) => url.replace(/[.,!?;:'")\]]+$/, ""));
  return [...new Set(cleaned)];
}

function detectMediaType(message) {
  if (message.sticker) return "sticker";
  if (message.gif) return "gif";
  if (message.videoNote) return "video_note";
  if (message.video) return "video";
  if (message.photo) return "photo";
  if (message.document) return "document";
  if (message.contact) return "contact";
  return message.media ? "other" : null;
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
async function handleIncomingMessage({ db, eventBus, alertManager, targets, targetIds, logAlert: logAlertFn = logAlert }, message) {
  const chatId = message.chatId?.toString();
  if (!chatId || !targetIds.has(chatId)) return { handled: false };
  if (shouldSkipMessage(message)) return { handled: false, skipped: true };

  const chat = targets.find((t) => t.id.toString() === chatId);
  const channel = chat?.title || chatId;
  // message.date é o timestamp real de quando a mensagem foi publicada no
  // Telegram (segundos epoch) -- usar isso em vez de Date.now() (hora de
  // recebimento) evita distorcer análise temporal caso o gramJS reentregue
  // backlog após uma reconexão (recebimento tardio ≠ momento da publicação).
  const messageTimeMs = message.date ? message.date * 1000 : Date.now();
  const text = message.message || "";

  try {
    const recentHashes = getRecentHashes(db, DEDUPE_WINDOW_MS, messageTimeMs);
    if (isDuplicate(text, recentHashes, DEDUPE_WINDOW_MS, messageTimeMs)) {
      console.log(`⏭️  [${channel}] mensagem duplicada (repost dentro de ${DEDUPE_WINDOW_MS / 60000}min), ignorada.`);
      return { handled: false, duplicate: true };
    }

    const hash = hashText(text);
    const links = extractLinks(text);
    const mediaType = detectMediaType(message);
    const author = message.senderId ? message.senderId.toString() : null;
    const replyToMessageId = message.replyToMsgId ?? null;

    insertRawMessage(db, {
      timeMs: messageTimeMs,
      channel,
      messageId: message.id ?? null,
      replyToMessageId,
      author,
      text,
      hash,
      mediaType,
      links,
    });

    eventBus.emit("telegram.message.received", { channel, mediaType, hasLinks: links.length > 0 });
    console.log(`📥 [${channel}] msg#${message.id ?? "?"} media=${mediaType ?? "-"} len=${text.length}${links.length ? ` links=${links.length}` : ""}`);
    return { handled: true };
  } catch (err) {
    const context = {
      event: "radar_insert_error",
      channel,
      messageId: message.id ?? null,
      timestampMs: messageTimeMs,
      error: err.message,
      stack: err.stack,
    };
    logAlertFn(context);
    console.error(`❌ [${channel}] erro ao processar mensagem (isolado -- radar continua vivo): ${err.message}`);
    if (alertManager) {
      await alertManager
        .fire("telegram_radar_insert_error", "ERROR", `telegram-radar: falha ao processar mensagem de [${channel}] -- ${err.message}`)
        .catch((alertErr) => console.error("❌ Falha ao enviar alerta de erro do radar:", alertErr.message));
    }
    return { handled: false, error: err.message };
  }
}

// Resolve os canais autorizados a partir dos diálogos que a conta já segue
// (client.getDialogs) -- nunca entra em canal novo sozinho. Casamento por
// substring (title.toLowerCase().includes(name)) tolera variação visual
// mínima do título pedido (ex: emoji no fim, "Velatrader Squad Oficial 🦈"
// batendo com o nome pedido "velatrader squad oficial"), mas a resolução
// INTEIRA falha (fail-closed) se qualquer nome pedido bater em ZERO ou em
// MAIS DE UM diálogo -- nunca escolhe silenciosamente entre candidatos
// ambíguos, e nunca segue parcialmente com só alguns dos nomes pedidos
// resolvidos (diferente do comportamento antigo, que tolerava nomes sem
// match e só avisava). Restrita a d.isChannel||d.isGroup (nunca um DM
// individual, mesmo que o título bata por acaso). Extraída de main() pra
// ser testável sem conexão real com o Telegram -- dialogs é só um array de
// objetos {id, title, isChannel, isGroup} aqui, nunca uma sessão real.
function resolveTargetChannels({ dialogs, targetChannelNames: names }) {
  const candidates = dialogs.filter((d) => d.isChannel || d.isGroup);
  const byName = names.map((name) => ({
    name,
    matches: candidates.filter((d) => (d.title || "").trim().toLowerCase().includes(name)),
  }));
  const zeroMatches = byName.filter((m) => m.matches.length === 0).map((m) => m.name);
  const ambiguousMatches = byName
    .filter((m) => m.matches.length > 1)
    .map((m) => ({ name: m.name, titles: m.matches.map((d) => d.title) }));

  if (zeroMatches.length > 0 || ambiguousMatches.length > 0) {
    return { ok: false, zeroMatches, ambiguousMatches, availableTitles: candidates.map((d) => d.title) };
  }

  return { ok: true, targets: byName.map((m) => m.matches[0]) };
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
  const resolution = resolveTargetChannels({ dialogs, targetChannelNames });

  if (!resolution.ok) {
    if (resolution.zeroMatches.length > 0) {
      console.error(`⚠️  Nenhum canal encontrado com o nome: ${resolution.zeroMatches.join(", ")}. Canais disponíveis:`);
      resolution.availableTitles.forEach((title) => console.error(`  - ${title}`));
    }
    if (resolution.ambiguousMatches.length > 0) {
      for (const amb of resolution.ambiguousMatches) {
        console.error(`⚠️  Nome "${amb.name}" corresponde a mais de um canal -- ambíguo, nenhum será escolhido automaticamente. Candidatos:`);
        amb.titles.forEach((title) => console.error(`  - ${title}`));
      }
      console.error('⚠️  Ajuste TELEGRAM_CHANNELS para um nome mais específico e confirme manualmente antes de rodar de novo.');
    }
    process.exit(1);
  }

  const targets = resolution.targets;
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
// telegram:watch) -- permite requerer handleIncomingMessage em testes sem
// conectar no Telegram de verdade.
if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Erro no radar de Telegram:", err.message);
    process.exit(1);
  });
}

module.exports = { shouldSkipMessage, extractLinks, detectMediaType, handleIncomingMessage, resolveTargetChannels };
