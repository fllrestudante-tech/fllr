const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { handleIncomingMessage } = require("../../telegram-radar/watch");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-radar-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeTargets() {
  const targets = [{ id: { toString: () => "111" }, title: "Canal Teste" }];
  const targetIds = new Set(["111"]);
  return { targets, targetIds };
}

function makeMessage({ id, text, dateSec, chatId = "111" }) {
  return { id, message: text, date: dateSec, chatId: { toString: () => chatId } };
}

test("handleIncomingMessage: grava usando message.date (timestamp real), não a hora de recebimento", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const { targets, targetIds } = makeTargets();
  const eventBus = { emit: () => {} };
  const pastDateSec = Math.floor((Date.now() - 3600_000) / 1000); // 1h atrás

  const result = await handleIncomingMessage(
    { db, eventBus, alertManager: null, targets, targetIds },
    makeMessage({ id: 1, text: "SOL breakout confirmado", dateSec: pastDateSec })
  );

  const row = db.prepare("SELECT * FROM telegram_messages").get();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(result.handled, true);
  assert.equal(row.time_ms, pastDateSec * 1000);
  assert.notEqual(row.time_ms, Date.now()); // não usou a hora de recebimento
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

  const rows = db.prepare("SELECT * FROM telegram_messages").all();
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

  const rows = realDb.prepare("SELECT * FROM telegram_messages").all();
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

test("handleIncomingMessage: mensagem sem ticker nem keyword é ignorada (handled=false) sem tocar o banco", async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const { targets, targetIds } = makeTargets();
  const eventBus = { emit: () => {} };

  const result = await handleIncomingMessage(
    { db, eventBus, alertManager: null, targets, targetIds },
    makeMessage({ id: 1, text: "bom dia pessoal", dateSec: Math.floor(Date.now() / 1000) })
  );

  const rows = db.prepare("SELECT * FROM telegram_messages").all();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(result.handled, false);
  assert.equal(rows.length, 0);
});
