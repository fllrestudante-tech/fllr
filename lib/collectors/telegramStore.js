const crypto = require("crypto");

// Conhece o schema de telegram_messages (migração 0001) -- usa a conexão
// compartilhada de lib/infra/db.js (market.db único), não abre banco próprio.

function getRecentHashes(db, windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  return db
    .prepare(
      "SELECT DISTINCT normalized_hash as hash, MAX(time_ms) as time FROM telegram_messages WHERE time_ms >= ? GROUP BY normalized_hash"
    )
    .all(cutoff);
}

function insertMention(db, { timeMs, channel, ticker, text, hash, sentiment, confidence, keywords }) {
  db.prepare(
    `INSERT INTO telegram_messages (uuid, time_ms, time, channel, ticker, text, normalized_hash, sentiment, confidence, keywords)
     VALUES (@uuid, @timeMs, @time, @channel, @ticker, @text, @hash, @sentiment, @confidence, @keywords)`
  ).run({
    uuid: crypto.randomUUID(),
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

module.exports = { getRecentHashes, insertMention };
