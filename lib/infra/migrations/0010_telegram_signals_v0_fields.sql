-- Campos do Narrative Engine v0 (lib/narrativeEngine/classify.js) que não
-- couberam no desenho inicial de telegram_signals (migração 0009): pair,
-- timeframe, preço mencionado, tipo de mensagem/sinal, idioma, feature
-- vector e confidence breakdown completos (JSON), e a confiança específica
-- do sentimento (distinta de "confidence", que é do sinal como um todo).
ALTER TABLE telegram_signals ADD COLUMN pair TEXT;
ALTER TABLE telegram_signals ADD COLUMN timeframe TEXT;
ALTER TABLE telegram_signals ADD COLUMN price_mentioned TEXT;
ALTER TABLE telegram_signals ADD COLUMN message_type TEXT;
ALTER TABLE telegram_signals ADD COLUMN signal_type TEXT;
ALTER TABLE telegram_signals ADD COLUMN language TEXT;
ALTER TABLE telegram_signals ADD COLUMN sentiment_confidence REAL;
ALTER TABLE telegram_signals ADD COLUMN features TEXT;
ALTER TABLE telegram_signals ADD COLUMN confidence_breakdown TEXT;

CREATE INDEX idx_telegram_signals_message_type ON telegram_signals(message_type);
