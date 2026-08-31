// Prova ATIVA de que a integração de ALERTAS do Telegram (lib/alerts.js +
// lib/connectivityManager.js -- os únicos dois arquivos deste round que
// falam com a Bot API do Telegram) é outbound-only: nenhum getUpdates,
// nenhum webhook, nenhum handler de comando, nenhuma capacidade de alterar
// estado a partir de uma mensagem recebida. Os ÚNICOS métodos da Bot API
// chamados em todo o projeto (fora do repositório manual telegram-radar/,
// ver nota de escopo abaixo) são sendMessage (lib/alerts.js) e getMe
// (lib/connectivityManager.js, health check puro).
//
// NOTA DE ESCOPO IMPORTANTE: o repositório TEM uma segunda integração
// Telegram, telegram-radar/ (login-step1/2/3.js + watch.js), que usa o
// pacote MTProto `telegram` (cliente de CONTA DE USUÁRIO, não Bot API) pra
// LER mensagens de canais de sinal -- isso é INTENCIONAL (radar de sinal de
// mercado, feature separada) e FICA FORA do escopo deste teste/desta rodada
// (a instrução do usuário nomeou explicitamente index.js/lib/aiGateway/*/
// lib/alerts.js/lib/connectivityManager.js). A prova abaixo NUNCA afirma
// "zero entrada Telegram no repositório inteiro" -- só que a integração de
// ALERTA (a única tocada nesta rodada) é outbound-only, e que telegram-radar
// não está registrado no pipeline automático supervisionado (ALL_CHILDREN).
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

function readSourceWithoutComments(relPath) {
  const src = fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
  // Remove comentários de bloco e de linha -- suficiente pra este arquivo
  // (nenhum literal de string neste projeto contém "//" seguido de um dos
  // termos proibidos abaixo de forma que isso mude o resultado do teste).
  // Lookbehind negativo evita tratar o "//" de "https://..." dentro de um
  // template literal como início de comentário (bug real encontrado ao
  // escrever este teste -- sem isso, a URL inteira da Bot API sumia junto
  // com o "comentário").
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
}

// Métodos da Bot API do Telegram que implicariam capacidade de ENTRADA
// (long polling, webhook, edição/callback) -- nenhum destes deveria
// aparecer em lib/alerts.js ou lib/connectivityManager.js.
const FORBIDDEN_INBOUND_PATTERNS = [
  /getUpdates/i,
  /setWebhook/i,
  /deleteWebhook/i,
  /answerCallbackQuery/i,
  /editMessageText/i,
  /editMessageReplyMarkup/i,
  /\bonText\b/i,
  /\bbot\.on\(/i,
  /node-telegram-bot-api/i,
  /telegraf/i,
  /grammy/i,
  /TelegramClient/i, // API MTProto de conta de usuário (telegram-radar) -- nunca em alerts.js/connectivityManager.js
  /StringSession/i,
];

for (const relPath of ["lib/alerts.js", "lib/connectivityManager.js"]) {
  test(`prova estrutural: ${relPath} nunca referencia nenhum padrão de entrada/comando do Telegram`, () => {
    const src = readSourceWithoutComments(relPath);
    for (const pattern of FORBIDDEN_INBOUND_PATTERNS) {
      assert.ok(!pattern.test(src), `${relPath} não deveria conter o padrão proibido ${pattern}`);
    }
  });
}

test("prova estrutural: os ÚNICOS métodos da Bot API do Telegram referenciados em lib/alerts.js são sendMessage; em lib/connectivityManager.js só getMe", () => {
  const alertsSrc = readSourceWithoutComments("lib/alerts.js");
  const alertsMethods = [...alertsSrc.matchAll(/api\.telegram\.org\/bot\$?\{?[^/]*\}?\/(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(new Set(alertsMethods), new Set(["sendMessage"]));

  const connSrc = readSourceWithoutComments("lib/connectivityManager.js");
  const connMethods = [...connSrc.matchAll(/api\.telegram\.org\/bot\$?\{?[^/]*\}?\/(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(new Set(connMethods), new Set(["getMe"]));
});

test("prova estrutural: sendTelegramAlert/alertOnTransitions exportados de lib/alerts.js não incluem nenhuma função de leitura/handler (grep de module.exports)", () => {
  const alertsSrc = readSourceWithoutComments("lib/alerts.js");
  const exportsMatch = alertsSrc.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(exportsMatch, "module.exports não encontrado em lib/alerts.js");
  const exportedNames = exportsMatch[1]
    .split(",")
    .map((s) => s.trim().split(":")[0].trim())
    .filter(Boolean);
  const forbiddenExportNames = ["onMessage", "onCommand", "registerHandler", "startPolling", "listen", "webhook"];
  for (const name of exportedNames) {
    assert.ok(!forbiddenExportNames.includes(name), `export inesperado de entrada: ${name}`);
  }
});

test("prova comportamental: sendTelegramAlert nunca registra listener nenhum -- axios.get É chamado SÓ por checkTelegramHealth (getMe), nunca por sendTelegramAlert", async (t) => {
  const axios = require("axios");
  const logger = require("../lib/logger");
  const { sendTelegramAlert, __resetAlertsRuntimeStateForTests } = require("../lib/alerts");
  __resetAlertsRuntimeStateForTests();
  t.mock.method(logger, "logAlert", () => {}); // nunca grava em data/alerts.jsonl real durante o teste

  let getCalls = 0;
  t.mock.method(axios, "get", async () => {
    getCalls++;
    throw new Error("axios.get não deveria ser chamado por sendTelegramAlert");
  });

  const result = await sendTelegramAlert("mensagem de teste isolamento", { botToken: "T", chatId: "1", post: async () => {} });

  assert.equal(result.sent, true);
  assert.equal(getCalls, 0);
});

test("prova de escopo: telegram-radar (integração MTProto de conta de usuário, capaz de LER mensagens) NÃO está registrado em ALL_CHILDREN -- não faz parte do pipeline automático supervisionado (Safe/Demo Observe)", () => {
  const { ALL_CHILDREN } = require("../lib/supervisorProfile");
  const scripts = ALL_CHILDREN.map((c) => c.script);
  for (const s of scripts) {
    assert.ok(!s.includes("telegram-radar"), `ALL_CHILDREN não deveria incluir nada de telegram-radar/, encontrou: ${s}`);
  }
});
