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

// ticker/sentiment/confidence/keywords são opcionais -- o Telegram Collector
// (telegram-radar/watch.js) captura a mensagem bruta e não classifica mais na
// entrada; "unclassified"/confidence 0/keywords vazio é o estado honesto até
// um classificador futuro (Narrative Engine/Signal Extractor) processar o
// texto e atualizar a linha.
function insertMention(
  db,
  {
    timeMs,
    channel,
    text,
    hash,
    messageId = null,
    replyToMessageId = null,
    author = null,
    mediaType = null,
    links = null,
    ticker = null,
    sentiment = "unclassified",
    confidence = 0,
    keywords = [],
  }
) {
  db.prepare(
    `INSERT INTO telegram_messages
       (uuid, time_ms, time, channel, message_id, reply_to_message_id, author, ticker, text, media_type, links, normalized_hash, sentiment, confidence, keywords)
     VALUES
       (@uuid, @timeMs, @time, @channel, @messageId, @replyToMessageId, @author, @ticker, @text, @mediaType, @links, @hash, @sentiment, @confidence, @keywords)`
  ).run({
    uuid: crypto.randomUUID(),
    timeMs,
    time: new Date(timeMs).toISOString(),
    channel,
    messageId,
    replyToMessageId,
    author,
    ticker: ticker || null,
    text,
    mediaType,
    links: links && links.length > 0 ? JSON.stringify(links) : null,
    hash,
    sentiment,
    confidence,
    keywords: JSON.stringify(keywords || []),
  });
}

module.exports = { getRecentHashes, insertMention };
