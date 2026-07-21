const crypto = require("crypto");

// Camada de acesso a telegram_signals (migrações 0009/0010) -- escrita feita
// pelo classificador (lib/narrativeEngine/classify.js), nunca pela ingestão
// (telegram-radar/watch.js). Índice único (raw_message_id, classifier_name,
// classifier_version) faz do INSERT OR IGNORE um reprocessamento idempotente:
// rodar a MESMA versão de novo não duplica; uma versão NOVA sempre soma
// linha nova, preservando o histórico completo de cada tentativa.

function getUnclassifiedRawMessages(db, { classifierName, classifierVersion, limit = 500 }) {
  return db
    .prepare(
      `SELECT r.* FROM telegram_messages_raw r
       LEFT JOIN telegram_signals s
         ON s.raw_message_id = r.id AND s.classifier_name = @classifierName AND s.classifier_version = @classifierVersion
       WHERE s.id IS NULL
       ORDER BY r.time_ms ASC
       LIMIT @limit`
    )
    .all({ classifierName, classifierVersion, limit });
}

function insertSignal(db, rawMessageId, signal) {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO telegram_signals
         (uuid, raw_message_id, classifier_name, classifier_version, is_relevant, is_call, ticker, pair, direction,
          timeframe, price_mentioned, message_type, signal_type, sentiment, sentiment_confidence, confidence,
          keywords, language, features, confidence_breakdown, processed_at)
       VALUES
         (@uuid, @rawMessageId, @classifierName, @classifierVersion, @isRelevant, @isCall, @ticker, @pair, @direction,
          @timeframe, @priceMentioned, @messageType, @signalType, @sentiment, @sentimentConfidence, @confidence,
          @keywords, @language, @features, @confidenceBreakdown, @processedAt)`
    )
    .run({
      uuid: crypto.randomUUID(),
      rawMessageId,
      classifierName: signal.classifierName,
      classifierVersion: signal.classifierVersion,
      isRelevant: signal.isRelevant ? 1 : 0,
      isCall: signal.isCall ? 1 : 0,
      ticker: signal.ticker || null,
      pair: signal.pair || null,
      direction: signal.direction || null,
      timeframe: signal.timeframe || null,
      priceMentioned: signal.priceMentioned || null,
      messageType: signal.messageType || null,
      signalType: signal.signalType || null,
      sentiment: signal.sentiment || null,
      sentimentConfidence: signal.sentimentConfidence ?? null,
      confidence: signal.confidence ?? null,
      keywords: JSON.stringify(signal.keywords || []),
      language: signal.language || null,
      features: JSON.stringify(signal.features || {}),
      confidenceBreakdown: JSON.stringify(signal.confidenceBreakdown || {}),
      processedAt: new Date().toISOString(),
    });
  return { inserted: result.changes > 0 };
}

module.exports = { getUnclassifiedRawMessages, insertSignal };
