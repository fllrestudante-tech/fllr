// Passo 2/3 do login: confirma o código recebido. Se a conta tiver verificação
// em duas etapas, pede pra rodar o login-step3.js com a senha.
// Uso: node telegram-radar/login-step2.js 12345
require("dotenv").config({ path: __dirname + "/../.env" });
const fs = require("fs");
const path = require("path");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const code = process.argv[2];
const STATE_FILE = path.join(__dirname, ".login-state.json");

if (!code || !fs.existsSync(STATE_FILE)) {
  console.error("Uso: node telegram-radar/login-step2.js <código recebido no Telegram> (rode login-step1.js antes)");
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

(async () => {
  const client = new TelegramClient(new StringSession(state.session), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  try {
    await client.invoke(
      new Api.auth.SignIn({ phoneNumber: state.phone, phoneCodeHash: state.phoneCodeHash, phoneCode: code })
    );
  } catch (err) {
    const msg = err.errorMessage || err.message || "";
    if (msg.includes("SESSION_PASSWORD_NEEDED")) {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, session: client.session.save() }, null, 2));
      console.log("🔒 Essa conta tem verificação em duas etapas (senha na nuvem). Rode:");
      console.log("   node telegram-radar/login-step3.js <sua senha>");
      await client.disconnect();
      process.exit(0);
    }
    throw err;
  }

  console.log("\n✅ Login concluído. Session salva:\n");
  console.log(client.session.save());
  fs.unlinkSync(STATE_FILE);
  await client.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("❌", err.message || err);
  process.exit(1);
});
