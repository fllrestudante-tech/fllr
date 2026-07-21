const crypto = require("crypto");

// Conhece o schema de telegram_messages_raw (migração 0009) -- usa a conexão
// compartilhada de lib/infra/db.js (market.db único), não abre banco próprio.
// Só dado bruto aqui: sem ticker/sentiment/confidence/keywords -- isso é
// responsabilidade de telegram_signals, escrita por um classificador futuro
// que lê esta tabela (ver migração 0009 pro raciocínio completo). A
// ingestão nunca decide relevância nem sobrescreve nada.

function getRecentHashes(db, windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  return db
    .prepare(
      "SELECT DISTINCT normalized_hash as hash, MAX(time_ms) as time FROM telegram_messages_raw WHERE time_ms >= ? GROUP BY normalized_hash"
    )
    .all(cutoff);
}

function insertRawMessage(db, { timeMs, channel, text, hash, messageId = null, replyToMessageId = null, author = null, mediaType = null, links = null }) {
  db.prepare(
    `INSERT INTO telegram_messages_raw
       (uuid, time_ms, time, channel, message_id, reply_to_message_id, author, text, media_type, links, normalized_hash)
     VALUES
       (@uuid, @timeMs, @time, @channel, @messageId, @replyToMessageId, @author, @text, @mediaType, @links, @hash)`
  ).run({
    uuid: crypto.randomUUID(),
    timeMs,
    time: new Date(timeMs).toISOString(),
    channel,
    messageId,
    replyToMessageId,
    author,
    text,
    mediaType,
    links: links && links.length > 0 ? JSON.stringify(links) : null,
    hash,
  });
}

module.exports = { getRecentHashes, insertRawMessage };
