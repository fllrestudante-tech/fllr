const test = require("node:test");
const assert = require("node:assert/strict");
const { sendTelegramAlert, alertOnTransitions } = require("../lib/alerts");

test("sendTelegramAlert: sem token/chatId, não envia e não lança erro", async () => {
  const result = await sendTelegramAlert("teste", { botToken: "", chatId: "", post: async () => assert.fail("não deveria chamar post") });
  assert.equal(result.sent, false);
});

test("sendTelegramAlert: com token/chatId, chama o post injetado com a URL e payload corretos", async () => {
  const calls = [];
  const result = await sendTelegramAlert("🔴 [bybit] ok → down", {
    botToken: "TOKEN123",
    chatId: "999",
    post: async (url, body) => calls.push({ url, body }),
  });
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/botTOKEN123/sendMessage");
  assert.deepEqual(calls[0].body, { chat_id: "999", text: "🔴 [bybit] ok → down" });
});

test("alertOnTransitions: dispara um alerta por transição, na ordem recebida", async () => {
  const sent = [];
  await alertOnTransitions(
    [
      { name: "bybit", from: "ok", to: "down" },
      { name: "telegram_radar", from: "down", to: "ok" },
    ],
    async (text) => sent.push(text)
  );
  assert.equal(sent.length, 2);
  assert.match(sent[0], /bybit.*ok → down/);
  assert.match(sent[1], /telegram_radar.*down → ok/);
});

test("alertOnTransitions: lista vazia não dispara nada", async () => {
  let called = false;
  await alertOnTransitions([], async () => {
    called = true;
  });
  assert.equal(called, false);
});
