const axios = require("axios");
const config = require("../config");

/**
 * Envia alerta via Telegram Bot API usando HTTP puro (axios já é dependência
 * do projeto) — sem biblioteca nova só pra mandar mensagem de texto.
 */
async function sendTelegramAlert(text, opts = {}) {
  const botToken = opts.botToken ?? config.alerts.telegramBotToken;
  const chatId = opts.chatId ?? config.alerts.telegramChatId;
  const post = opts.post ?? axios.post;

  if (!botToken || !chatId) {
    console.warn("⚠️  Alerta não enviado (TELEGRAM_ALERT_BOT_TOKEN/TELEGRAM_ALERT_CHAT_ID ausentes):", text);
    return { sent: false };
  }

  await post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text });
  return { sent: true };
}

const STATUS_EMOJI = { ok: "✅", degraded: "⚠️", down: "🔴", not_implemented: "⬜" };

/**
 * Só dispara em transições de status (ok->down, down->ok, etc.) — nunca a
 * cada ciclo, senão vira spam enquanto o problema persiste.
 */
async function alertOnTransitions(transitions, sender = sendTelegramAlert) {
  for (const t of transitions) {
    const emoji = STATUS_EMOJI[t.to] || "❔";
    await sender(`${emoji} [${t.name}] ${t.from} → ${t.to}`);
  }
}

module.exports = { sendTelegramAlert, alertOnTransitions };
