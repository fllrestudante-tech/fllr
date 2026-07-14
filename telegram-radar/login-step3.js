// Passo 3/3 do login (só necessário se a conta tiver verificação em duas etapas).
// Uso: node telegram-radar/login-step3.js <senha>
require("dotenv").config({ path: __dirname + "/../.env" });
const fs = require("fs");
const path = require("path");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { computeCheck } = require("telegram/Password");

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const password = process.argv[2];
const STATE_FILE = path.join(__dirname, ".login-state.json");

if (!password || !fs.existsSync(STATE_FILE)) {
  console.error("Uso: node telegram-radar/login-step3.js <senha de verificação em duas etapas> (rode login-step2.js antes)");
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

(async () => {
  const client = new TelegramClient(new StringSession(state.session), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const passwordInfo = await client.invoke(new Api.account.GetPassword({}));
  const passwordCheck = await computeCheck(passwordInfo, password);
  await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));

  console.log("\n✅ Login concluído. Session salva:\n");
  console.log(client.session.save());
  fs.unlinkSync(STATE_FILE);
  await client.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("❌", err.message || err);
  process.exit(1);
});
