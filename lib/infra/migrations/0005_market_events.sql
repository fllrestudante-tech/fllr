-- Primeiro provider do futuro "Knowledge Collector" (eventos estruturados
-- com data/hora e janela de impacto). Outros tipos de conhecimento
-- (noticias, videos, tweets) terao schema proprio quando forem construidos
-- -- nao cabem nessa mesma tabela (formato bem diferente de um evento datado).
CREATE TABLE market_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,                 -- 'coinmarketcal' | 'fred' | 'fomc_calendar'
  source_event_id TEXT NOT NULL,          -- id/chave natural na fonte -- dedup e re-sync
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,                 -- 'fomc','cpi','payroll','gdp','etf','unlock','hard_fork','listing','governance','partnership','ama', ...
  severity INTEGER NOT NULL,              -- 1 (fomc/cpi/etf) / 2 (unlock/hard_fork/listing) / 3 (ama/partnership/governance)
  market_scope TEXT NOT NULL,             -- 'GLOBAL','BTC','ETH','SOL','MEME','DEFI','RWA','AI', ...
  expected_volatility TEXT,               -- 'LOW','MEDIUM','HIGH','EXTREME'
  event_time INTEGER NOT NULL,            -- ms epoch
  impact_window_before_ms INTEGER,
  impact_window_after_ms INTEGER,
  confirmed INTEGER NOT NULL DEFAULT 1,   -- 0 = especulativo/rumor, 1 = confirmado pela fonte
  source_url TEXT,
  source_reliability_score REAL,          -- NULL ate o Source Reliability Engine existir -- nao fabricar valor agora
  recorded_at TEXT NOT NULL,              -- primeira coleta
  updated_at TEXT NOT NULL                -- ultima vez que os dados do evento mudaram na fonte
);
CREATE UNIQUE INDEX idx_market_events_provider_unique ON market_events(provider, source_event_id);
CREATE INDEX idx_market_events_time ON market_events(event_time);
CREATE INDEX idx_market_events_category_time ON market_events(category, event_time);

-- Junction table -- "assets" como array JSON numa coluna nao e consultavel
-- (WHERE asset='BTC' precisa de tabela de verdade), e e exatamente o tipo
-- de consulta que o Validation Engine/Replay Engine vao fazer.
CREATE TABLE market_event_assets (
  event_id INTEGER NOT NULL REFERENCES market_events(id),
  asset TEXT NOT NULL,
  PRIMARY KEY (event_id, asset)
);
CREATE INDEX idx_market_event_assets_asset ON market_event_assets(asset);
