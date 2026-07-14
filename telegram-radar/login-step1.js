// Passo 1/3 do login: envia o código de verificação pro Telegram.
// Uso: node telegram-radar/login-step1.js +5511999999999
require("dotenv").config({ path: __dirname + "/../.env" });
const fs = require("fs");
const path = require("path");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const phone = process.argv[2];
const STATE_FILE = path.join(__dirname, ".login-state.json");

if (!apiId || !apiHash) {
  console.error("⚠️  Preencha TELEGRAM_API_ID e TELEGRAM_API_HASH no .env.");
  process.exit(1);
}
if (!phone) {
  console.error("Uso: node telegram-radar/login-step1.js +5511999999999 (com código do país)");
  process.exit(1);
}

(async () => {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const result = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber: phone,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({}),
    })
  );

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ session: client.session.save(), phone, phoneCodeHash: result.phoneCodeHash }, null, 2)
  );

  console.log("✅ Código enviado pro seu Telegram (confira o app). Rode:");
  console.log("   node telegram-radar/login-step2.js <código>");

  await client.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("❌", err.message || err);
  process.exit(1);
});
