// Descobre o chat_id via getUpdates (Bot API) e manda uma mensagem de teste
// real -- passo manual único depois de criar o bot no @BotFather. Reusa
// lib/alerts.js::sendTelegramAlert sem alterar esse arquivo.
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { sendTelegramAlert } = require("../lib/alerts");

const ENV_PATH = path.join(__dirname, "..", ".env");

function persistChatId(chatId) {
  const raw = fs.readFileSync(ENV_PATH, "utf8");
  const updated = raw.includes("TELEGRAM_ALERT_CHAT_ID=")
    ? raw.replace(/TELEGRAM_ALERT_CHAT_ID=.*/g, `TELEGRAM_ALERT_CHAT_ID=${chatId}`)
    : raw + `\nTELEGRAM_ALERT_CHAT_ID=${chatId}\n`;
  fs.writeFileSync(ENV_PATH, updated);
}

async function main() {
  const token = config.alerts.telegramBotToken;
  if (!token) {
    console.error("❌ TELEGRAM_ALERT_BOT_TOKEN ausente no .env.");
    process.exit(1);
  }

  if (config.alerts.telegramChatId) {
    console.log(`ℹ️  chat_id já configurado (${config.alerts.telegramChatId}) -- enviando mensagem de teste.`);
    const result = await sendTelegramAlert("✅ Teste de alerta do bot-cripto10 -- integração confirmada.");
    console.log(result);
    return;
  }

  console.log("🔍 Buscando chat_id via getUpdates...");
  const { data } = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`);
  if (!data.ok) {
    console.error("❌ Bot API retornou erro:", JSON.stringify(data));
    process.exit(1);
  }
  if (data.result.length === 0) {
    console.error("⚠️  Nenhuma mensagem encontrada ainda. Mande qualquer mensagem pro bot no Telegram e rode este script de novo.");
    process.exit(1);
  }

  const last = data.result[data.result.length - 1];
  const chatId = last.message?.chat?.id;
  const chatType = last.message?.chat?.type;
  const fromName = last.message?.from?.first_name;

  if (!chatId) {
    console.error("❌ Não encontrei chat.id na última atualização:", JSON.stringify(last));
    process.exit(1);
  }

  console.log(`✅ chat_id encontrado: ${chatId} (tipo=${chatType}, de=${fromName})`);
  persistChatId(chatId);
  console.log("✅ TELEGRAM_ALERT_CHAT_ID gravado no .env.");

  const result = await sendTelegramAlert("✅ Teste de alerta do bot-cripto10 -- integração confirmada.", { chatId });
  console.log("Envio de teste:", result);
}

main().catch((err) => {
  console.error("❌ Erro:", err.message);
  process.exit(1);
});
