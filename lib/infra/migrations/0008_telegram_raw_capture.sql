-- O Telegram Collector deixa de ser um classificador na entrada: passa a
-- capturar praticamente toda mensagem útil do canal (texto, mídia, replies,
-- links), deixando ticker/sentimento/direção pra uma etapa futura separada
-- de classificação (Narrative Engine/Signal Extractor) que lê o texto bruto
-- depois. Colunas novas nullable -- linhas antigas (capturadas antes desta
-- migração) genuinamente não têm esse dado, NULL é honesto aqui.
ALTER TABLE telegram_messages ADD COLUMN message_id INTEGER;
ALTER TABLE telegram_messages ADD COLUMN reply_to_message_id INTEGER;
ALTER TABLE telegram_messages ADD COLUMN author TEXT;
ALTER TABLE telegram_messages ADD COLUMN media_type TEXT;
ALTER TABLE telegram_messages ADD COLUMN links TEXT;

CREATE INDEX idx_telegram_message_id ON telegram_messages(channel, message_id);
