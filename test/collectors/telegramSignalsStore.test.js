const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { insertRawMessage } = require("../../lib/collectors/telegramStore");
const { getUnclassifiedRawMessages, insertSignal } = require("../../lib/collectors/telegramSignalsStore");
const { classify } = require("../../lib/narrativeEngine/classify");
const { hashText } = require("../../telegram-radar/lib/dedupe");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-signals-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

test("getUnclassifiedRawMessages: retorna só mensagens ainda sem sinal para esta versão do classificador", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  insertRawMessage(db, { timeMs: Date.now(), channel: "A", text: "UNIUSDT rompendo", hash: hashText("UNIUSDT rompendo") });
  const raw = db.prepare("SELECT * FROM telegram_messages_raw").get();

  const pendingBefore = getUnclassifiedRawMessages(db, { classifierName: "narrative_engine", classifierVersion: "0" });
  assert.equal(pendingBefore.length, 1);

  insertSignal(db, raw.id, classify(raw.text));

  const pendingAfter = getUnclassifiedRawMessages(db, { classifierName: "narrative_engine", classifierVersion: "0" });
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(pendingAfter.length, 0);
});

test("insertSignal: reprocessar a MESMA versão não duplica (idempotente)", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  insertRawMessage(db, { timeMs: Date.now(), channel: "A", text: "UNIUSDT rompendo", hash: hashText("UNIUSDT rompendo") });
  const raw = db.prepare("SELECT * FROM telegram_messages_raw").get();
  const signal = classify(raw.text);

  const first = insertSignal(db, raw.id, signal);
  const second = insertSignal(db, raw.id, signal);

  const rows = db.prepare("SELECT * FROM telegram_signals WHERE raw_message_id = ?").all(raw.id);
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(rows.length, 1);
});

test("insertSignal: uma versão NOVA do classificador soma linha nova, preservando a anterior", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  insertRawMessage(db, { timeMs: Date.now(), channel: "A", text: "UNIUSDT rompendo", hash: hashText("UNIUSDT rompendo") });
  const raw = db.prepare("SELECT * FROM telegram_messages_raw").get();
  const signalV0 = classify(raw.text);
  const signalV1 = { ...signalV0, classifierVersion: "1" };

  insertSignal(db, raw.id, signalV0);
  insertSignal(db, raw.id, signalV1);

  const rows = db.prepare("SELECT classifier_version FROM telegram_signals WHERE raw_message_id = ? ORDER BY classifier_version").all(raw.id);
  db.close();
  fs.unlinkSync(dbPath);

  assert.deepEqual(rows.map((r) => r.classifier_version), ["0", "1"]);
});

test("insertSignal: grava features e confidence_breakdown como JSON reconstituível", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  insertRawMessage(db, { timeMs: Date.now(), channel: "A", text: "UNIUSDT rompendo a resistência no 4H", hash: hashText("x") });
  const raw = db.prepare("SELECT * FROM telegram_messages_raw").get();
  insertSignal(db, raw.id, classify(raw.text));

  const row = db.prepare("SELECT * FROM telegram_signals WHERE raw_message_id = ?").get(raw.id);
  db.close();
  fs.unlinkSync(dbPath);

  const features = JSON.parse(row.features);
  const breakdown = JSON.parse(row.confidence_breakdown);
  assert.equal(features.hasTicker, true);
  assert.ok("ticker" in breakdown);
  assert.equal(row.ticker, "UNI");
  assert.equal(row.pair, "UNIUSDT");
  assert.equal(row.timeframe, "4H");
});
