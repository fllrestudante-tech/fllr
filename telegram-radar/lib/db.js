const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DEFAULT_DB_PATH = path.join(__dirname, "..", "data", "radar.db");

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time_ms INTEGER NOT NULL,
      time TEXT NOT NULL,
      channel TEXT NOT NULL,
      ticker TEXT,
      text TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      confidence REAL NOT NULL,
      keywords TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_ticker_time ON mentions(ticker, time_ms);
    CREATE INDEX IF NOT EXISTS idx_mentions_hash_time ON mentions(normalized_hash, time_ms);
  `);
}

function openDb(dbPath = DEFAULT_DB_PATH) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

// hashes distintos vistos dentro da janela — usado por lib/dedupe.js (isDuplicate)
// pra saber se um texto normalizado já apareceu recentemente, em qualquer canal.
function getRecentHashes(db, windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  return db
    .prepare("SELECT DISTINCT normalized_hash as hash, MAX(time_ms) as time FROM mentions WHERE time_ms >= ? GROUP BY normalized_hash")
    .all(cutoff);
}

function insertMention(db, { timeMs, channel, ticker, text, hash, sentiment, confidence, keywords }) {
  db.prepare(
    `INSERT INTO mentions (time_ms, time, channel, ticker, text, normalized_hash, sentiment, confidence, keywords)
     VALUES (@timeMs, @time, @channel, @ticker, @text, @hash, @sentiment, @confidence, @keywords)`
  ).run({
    timeMs,
    time: new Date(timeMs).toISOString(),
    channel,
    ticker: ticker || null,
    text,
    hash,
    sentiment,
    confidence,
    keywords: JSON.stringify(keywords || []),
  });
}

module.exports = { openDb, getRecentHashes, insertMention, DEFAULT_DB_PATH };
