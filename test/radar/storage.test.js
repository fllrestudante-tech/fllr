const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { getRecentHashes, insertRawMessage } = require("../../lib/collectors/telegramStore");
const { hashText } = require("../../telegram-radar/lib/dedupe");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-market-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

test("openDb + insertRawMessage: grava e lê de volta uma mensagem bruta em telegram_messages_raw", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = Date.now();

  insertRawMessage(db, {
    timeMs: now,
    channel: "Canal Teste",
    text: "BTC vai romper",
    hash: hashText("BTC vai romper"),
    messageId: 10,
    replyToMessageId: 9,
    author: "555",
    mediaType: "photo",
    links: ["https://exemplo.com/x"],
  });

  const rows = db.prepare("SELECT * FROM telegram_messages_raw").all();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(rows.length, 1);
  assert.ok(rows[0].uuid);
  assert.equal(rows[0].channel, "Canal Teste");
  assert.equal(rows[0].text, "BTC vai romper");
  assert.equal(rows[0].message_id, 10);
  assert.equal(rows[0].reply_to_message_id, 9);
  assert.equal(rows[0].author, "555");
  assert.equal(rows[0].media_type, "photo");
  assert.deepEqual(JSON.parse(rows[0].links), ["https://exemplo.com/x"]);
});

test("insertRawMessage: campos opcionais (messageId/author/mediaType/links) aceitam ausência sem quebrar", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  insertRawMessage(db, {
    timeMs: Date.now(),
    channel: "Canal Teste",
    text: "pump generalizado no mercado",
    hash: hashText("pump generalizado no mercado"),
  });

  const rows = db.prepare("SELECT * FROM telegram_messages_raw").all();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_id, null);
  assert.equal(rows[0].author, null);
  assert.equal(rows[0].media_type, null);
  assert.equal(rows[0].links, null);
});

test("getRecentHashes: só retorna hashes dentro da janela pedida", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = Date.now();

  insertRawMessage(db, {
    timeMs: now - 60000, // dentro de 10min
    channel: "A",
    text: "recente",
    hash: hashText("recente"),
  });
  insertRawMessage(db, {
    timeMs: now - 20 * 60 * 1000, // fora de 10min
    channel: "A",
    text: "antiga",
    hash: hashText("antiga"),
  });

  const recent = getRecentHashes(db, 10 * 60 * 1000, now);
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(recent.length, 1);
  assert.equal(recent[0].hash, hashText("recente"));
});

test("telegram_signals: existe vazia, pronta pra um classificador futuro gravar (raw_message_id referencia telegram_messages_raw)", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  const countBefore = db.prepare("SELECT COUNT(*) as c FROM telegram_signals").get();
  assert.equal(countBefore.c, 0);

  insertRawMessage(db, {
    timeMs: Date.now(),
    channel: "Canal Teste",
    text: "UNIUSDT rompendo resistência",
    hash: hashText("UNIUSDT rompendo resistência"),
    messageId: 1,
  });
  const raw = db.prepare("SELECT * FROM telegram_messages_raw").get();

  const crypto = require("crypto");
  db.prepare(
    `INSERT INTO telegram_signals (uuid, raw_message_id, classifier_name, classifier_version, ticker, sentiment, confidence, processed_at)
     VALUES (@uuid, @rawId, @name, @version, @ticker, @sentiment, @confidence, @processedAt)`
  ).run({
    uuid: crypto.randomUUID(),
    rawId: raw.id,
    name: "narrative_engine_v0",
    version: "1",
    ticker: "UNI",
    sentiment: "bullish",
    confidence: 0.6,
    processedAt: new Date().toISOString(),
  });

  const signals = db.prepare("SELECT * FROM telegram_signals WHERE raw_message_id = ?").all(raw.id);
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(signals.length, 1);
  assert.equal(signals[0].ticker, "UNI");
  assert.equal(signals[0].classifier_version, "1");
});
