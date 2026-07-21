const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { shouldSkipMessage, extractLinks, detectMediaType, handleIncomingMessage } = require("../../telegram-radar/watch");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-radar-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeTargets() {
  const targets = [{ id: { toString: () => "111" }, title: "Canal Teste" }];
  const targetIds = new Set(["111"]);
  return { targets, targetIds };
}

function makeMessage({ id, text = null, dateSec, chatId = "111", action = null, media = null, sticker = null, gif = null, senderId = null, replyToMsgId = undefined }) {
  return {
    id,
    message: text,
    date: dateSec,
    chatId: { toString: () => chatId },
    action,
    media,
    sticker,
    gif,
    senderId,
    replyToMsgId,
  };
}

test("shouldSkipMessage: descarta mensagem de serviço (action presente)", () => {
  assert.equal(shouldSkipMessage({ action: { className: "MessageActionChatJoinedByLink" } }), true);
});

test("shouldSkipMessage: descarta mensagem totalmente vazia (sem texto e sem mídia)", () => {
  assert.equal(shouldSkipMessage({ message: "", media: null }), true);
});

test("shouldSkipMessage: descarta sticker sem legenda, mas mantém sticker com legenda", () => {
  assert.equal(shouldSkipMessage({ message: "", media: {}, sticker: {} }), true);
  assert.equal(shouldSkipMessage({ message: "olha esse gráfico", media: {}, sticker: {} }), false);
});

test("shouldSkipMessage: descarta GIF sem legenda", () => {
  assert.equal(shouldSkipMessage({ message: "", media: {}, gif: {} }), true);
});

test("shouldSkipMessage: mantém foto sem legenda (não está na lista de exclusão explícita)", () => {
  assert.equal(shouldSkipMessage({ message: "", media: {}, photo: {} }), false);
});

test("shouldSkipMessage: mantém mensagem de texto normal", () => {
  assert.equal(shouldSkipMessage({ message: "UNIUSDT rompendo resistência", media: null }), false);
});

test("extractLinks: extrai URLs únicas do texto", () => {
  const links = extractLinks("olha esse video https://youtu.be/abc e de novo https://youtu.be/abc, outro https://x.com/y");
  assert.deepEqual(links, ["https://youtu.be/abc", "https://x.com/y"]);
});

test("extractLinks: texto sem link retorna array vazio", () => {
  assert.deepEqual(extractLinks("BTC rompendo agora"), []);
});

test("detectMediaType: identifica sticker/gif/photo/document/nenhum", () => {
  assert.equal(detectMediaType({ sticker: {}, media: {} }), "sticker");
  assert.equal(detectMediaType({ gif: {}, media: {} }), "gif");
  assert.equal(detectMediaType({ photo: {}, media: {} }), "photo");
  assert.equal(detectMediaType({ document: {}, media: {} }), "document");
  assert.equal(detectMediaType({ media: null }), null);
});

test("handleIncomingMessage: captura mensagem de texto puro sem exigir ticker/keyword -- coletor não classifica na entrada", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const { targets, targetIds } = makeTargets();
  const eventBus = { emit: () => {} };

  const result = await handleIncomingMessage(
    { db, eventBus, alertManager: null, targets, targetIds },
    makeMessage({ id: 1, text: "Bom dia pessoal, cenário de hoje é de cautela", dateSec: Math.floor(Date.now() / 1000) })
  );

  const row = db.prepare("SELECT * FROM telegram_messages_raw").get();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(result.handled, true);
  assert.equal(row.text, "Bom dia pessoal, cenário de hoje é de cautela");
  // telegram_messages_raw não tem coluna de classificação -- isso vive em
  // telegram_signals, escrita depois por um classificador futuro.
  assert.equal("ticker" in row, false);
  assert.equal("sentiment" in row, false);
});

test("handleIncomingMessage: grava message_id, author, reply_to e links quando presentes", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const { targets, targetIds } = makeTargets();
  const eventBus = { emit: () => {} };

  await handleIncomingMessage(
    { db, eventBus, alertManager: null, targets, targetIds },
    makeMessage({
      id: 42,
      text: "confira essa análise https://youtu.be/xyz",
      dateSec: Math.floor(Date.now() / 1000),
      senderId: { toString: () => "999" },
      replyToMsgId: 41,
    })
  );

  const row = db.prepare("SELECT * FROM telegram_messages_raw").get();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(row.message_id, 42);
  assert.equal(row.reply_to_message_id, 41);
  assert.equal(row.author, "999");
  assert.deepEqual(JSON.parse(row.links), ["https://youtu.be/xyz"]);
});

test("handleIncomingMessage: mensagem de serviço/sticker sem legenda é ignorada sem tocar o banco", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const { targets, targetIds } = makeTargets();
  const eventBus = { emit: () => {} };

  const result = await handleIncomingMessage(
    { db, eventBus, alertManager: null, targets, targetIds },
    makeMessage({ id: 1, text: "", dateSec: Math.floor(Date.now() / 1000), media: {}, sticker: {} })
  );

  const rows = db.prepare("SELECT * FROM telegram_messages_raw").all();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(result.handled, false);
  assert.equal(result.skipped, true);
  assert.equal(rows.length, 0);
});

test("handleIncomingMessage: grava usando message.date (timestamp real), não a hora de recebimento", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const { targets, targetIds } = makeTargets();
  const eventBus = { emit: () => {} };
  const pastDateSec = Math.floor((Date.now() - 3600_000) / 1000); // 1h atrás

  const result = await handleIncomingMessage(
    { db, eventBus, alertManager: null, targets, targetIds },
    makeMessage({ id: 1, text: "SOL rompendo agora", dateSec: pastDateSec })
  );

  const row = db.prepare("SELECT * FROM telegram_messages_raw").get();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(result.handled, true);
  assert.equal(row.time_ms, pastDateSec * 1000);
  assert.notEqual(row.time_ms, Date.now());
});

test("handleIncomingMessage: dedupe entre mensagens com o mesmo texto normalizado dentro da janela", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const { targets, targetIds } = makeTargets();
  const eventBus = { emit: () => {} };
  const nowSec = Math.floor(Date.now() / 1000);

  const first = await handleIncomingMessage(
    { db, eventBus, alertManager: null, targets, targetIds },
    makeMessage({ id: 1, text: "$BTC vai romper agora!", dateSec: nowSec })
  );
  const second = await handleIncomingMessage(
    { db, eventBus, alertManager: null, targets, targetIds },
    makeMessage({ id: 2, text: "$BTC vai romper agora", dateSec: nowSec + 5 })
  );

  const rows = db.prepare("SELECT * FROM telegram_messages_raw").all();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(first.handled, true);
  assert.equal(second.duplicate, true);
  assert.equal(rows.length, 1);
});

test("handleIncomingMessage: erro isolado -- falha na mensagem 1 dispara alerta ERROR mas não impede a mensagem 2 de ser processada", async () => {
  const dbPath = tmpDbPath();
  const realDb = openDb(dbPath);
  const { targets, targetIds } = makeTargets();
  const eventBus = { emit: () => {} };
  const alerts = [];
  const alertManager = {
    fire: async (key, severity, message) => {
      alerts.push({ key, severity, message });
    },
  };

  let failNext = true;
  const poisonedDb = {
    prepare(sql) {
      if (failNext) {
        failNext = false;
        throw new Error("falha simulada de banco (conexão indisponível)");
      }
      return realDb.prepare(sql);
    },
  };

  const loggedContexts = [];
  const logAlertFake = (context) => loggedContexts.push(context);

  const nowSec = Math.floor(Date.now() / 1000);
  const result1 = await handleIncomingMessage(
    { db: poisonedDb, eventBus, alertManager, targets, targetIds, logAlert: logAlertFake },
    makeMessage({ id: 1, text: "BTC breakout iminente", dateSec: nowSec })
  );
  const result2 = await handleIncomingMessage(
    { db: poisonedDb, eventBus, alertManager, targets, targetIds, logAlert: logAlertFake },
    makeMessage({ id: 2, text: "ETH pump forte", dateSec: nowSec + 1 })
  );

  const rows = realDb.prepare("SELECT * FROM telegram_messages_raw").all();
  realDb.close();
  fs.unlinkSync(dbPath);

  assert.equal(result1.handled, false);
  assert.ok(result1.error);
  assert.equal(result2.handled, true); // mensagem seguinte processada normalmente
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "ETH pump forte");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "ERROR");
  assert.equal(alerts[0].key, "telegram_radar_insert_error");
  assert.equal(loggedContexts.length, 1); // log estruturado usado (não o real, injetado por teste)
  assert.equal(loggedContexts[0].event, "radar_insert_error");
  assert.equal(loggedContexts[0].channel, "Canal Teste");
});

test("handleIncomingMessage: falha ao enviar o alerta (ex: Telegram fora do ar) não derruba o handler", async () => {
  const dbPath = tmpDbPath();
  const realDb = openDb(dbPath);
  const { targets, targetIds } = makeTargets();
  const eventBus = { emit: () => {} };
  const alertManager = {
    fire: async () => {
      throw new Error("Telegram API indisponível");
    },
  };
  const poisonedDb = {
    prepare() {
      throw new Error("falha simulada de banco");
    },
  };

  const result = await handleIncomingMessage(
    { db: poisonedDb, eventBus, alertManager, targets, targetIds, logAlert: () => {} },
    makeMessage({ id: 1, text: "BTC breakout", dateSec: Math.floor(Date.now() / 1000) })
  );

  realDb.close();
  fs.unlinkSync(dbPath);

  assert.equal(result.handled, false);
  assert.ok(result.error);
});
