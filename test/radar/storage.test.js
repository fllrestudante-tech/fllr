const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../../lib/infra/db");
const { getRecentHashes, insertMention } = require("../../lib/collectors/telegramStore");
const { hashText } = require("../../telegram-radar/lib/dedupe");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-market-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

test("openDb + insertMention: grava e lê de volta uma menção em telegram_messages", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = Date.now();

  insertMention(db, {
    timeMs: now,
    channel: "Canal Teste",
    ticker: "BTC",
    text: "BTC vai romper",
    hash: hashText("BTC vai romper"),
    sentiment: "bullish",
    confidence: 0.5,
    keywords: ["breakout"],
  });

  const rows = db.prepare("SELECT * FROM telegram_messages").all();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(rows.length, 1);
  assert.ok(rows[0].uuid);
  assert.equal(rows[0].ticker, "BTC");
  assert.equal(rows[0].channel, "Canal Teste");
  assert.equal(rows[0].sentiment, "bullish");
  assert.deepEqual(JSON.parse(rows[0].keywords), ["breakout"]);
});

test("insertMention: ticker null é aceito (menção só por keyword, sem cashtag)", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  insertMention(db, {
    timeMs: Date.now(),
    channel: "Canal Teste",
    ticker: null,
    text: "pump generalizado no mercado",
    hash: hashText("pump generalizado no mercado"),
    sentiment: "bullish",
    confidence: 0.33,
    keywords: ["pump"],
  });

  const rows = db.prepare("SELECT * FROM telegram_messages").all();
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, null);
});

test("getRecentHashes: só retorna hashes dentro da janela pedida", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = Date.now();

  insertMention(db, {
    timeMs: now - 60000, // dentro de 10min
    channel: "A",
    ticker: "BTC",
    text: "recente",
    hash: hashText("recente"),
    sentiment: "neutral",
    confidence: 0,
    keywords: [],
  });
  insertMention(db, {
    timeMs: now - 20 * 60 * 1000, // fora de 10min
    channel: "A",
    ticker: "BTC",
    text: "antiga",
    hash: hashText("antiga"),
    sentiment: "neutral",
    confidence: 0,
    keywords: [],
  });

  const recent = getRecentHashes(db, 10 * 60 * 1000, now);
  db.close();
  fs.unlinkSync(dbPath);

  assert.equal(recent.length, 1);
  assert.equal(recent[0].hash, hashText("recente"));
});
