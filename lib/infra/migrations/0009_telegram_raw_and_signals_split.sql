-- Separa ingestão bruta de classificação, de vez: telegram_messages_raw é
-- SÓ dado capturado (imutável na origem -- a ingestão nunca decide relevância
-- nem sobrescreve nada). telegram_signals é a camada de classificação, ainda
-- vazia (nenhum classificador escreve nela hoje -- criada agora porque é
-- decisão de arquitetura explícita do usuário, não porque o código que a usa
-- já existe). Um classificador futuro (Narrative Engine/Signal Extractor)
-- lê telegram_messages_raw e grava 1+ linhas em telegram_signals por
-- mensagem, uma por versão de algoritmo -- reprocessar com um algoritmo novo
-- soma linhas novas, nunca sobrescreve as antigas, preservando o histórico
-- completo de cada tentativa de classificação.

ALTER TABLE telegram_messages RENAME TO telegram_messages_v1_old;

CREATE TABLE telegram_messages_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  message_id INTEGER,
  reply_to_message_id INTEGER,
  author TEXT,
  text TEXT NOT NULL,
  media_type TEXT,
  links TEXT,
  normalized_hash TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  time TEXT NOT NULL
);
CREATE INDEX idx_telegram_raw_message_id ON telegram_messages_raw(channel, message_id);
CREATE INDEX idx_telegram_raw_hash_time ON telegram_messages_raw(normalized_hash, time_ms);

-- ticker/sentiment/confidence/keywords da tabela antiga não são migrados --
-- eram só sentinelas "unclassified"/0/[] do curto período entre a captura
-- ampla (migração 0008) e esta migração, nunca uma classificação real feita
-- por um classificador de verdade. Nenhum dado genuíno se perde.
INSERT INTO telegram_messages_raw
  (uuid, channel, message_id, reply_to_message_id, author, text, media_type, links, normalized_hash, time_ms, time)
SELECT
  uuid, channel, message_id, reply_to_message_id, author, text, media_type, links, normalized_hash, time_ms, time
FROM telegram_messages_v1_old;

DROP TABLE telegram_messages_v1_old;

CREATE TABLE telegram_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  raw_message_id INTEGER NOT NULL REFERENCES telegram_messages_raw(id),
  classifier_name TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  is_relevant INTEGER,
  is_call INTEGER,
  ticker TEXT,
  direction TEXT,
  sentiment TEXT,
  confidence REAL,
  keywords TEXT,
  processed_at TEXT NOT NULL
);
CREATE INDEX idx_telegram_signals_raw_message ON telegram_signals(raw_message_id);
CREATE INDEX idx_telegram_signals_ticker_time ON telegram_signals(ticker, processed_at);
-- Reprocessar com a MESMA versão de um classificador não duplica; uma
-- versão NOVA gera linha nova, preservando o histórico de reprocessamentos.
CREATE UNIQUE INDEX idx_telegram_signals_unique_run ON telegram_signals(raw_message_id, classifier_name, classifier_version);
