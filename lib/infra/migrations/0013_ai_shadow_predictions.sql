CREATE TABLE ai_shadow_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  context_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,

  t0 TEXT NOT NULL,
  t0_ms INTEGER NOT NULL,
  price_t0 REAL NOT NULL,

  is_valid_prediction INTEGER NOT NULL, -- 1 = a IA respondeu de fato (bullish/bearish/neutral); 0 = tentativa falhou (AI_UNAVAILABLE: sem key, erro de rede, timeout) -- nunca inferir isso de bias/state em query futura
  provider TEXT,
  model TEXT,
  bias TEXT,
  state TEXT NOT NULL,
  score INTEGER NOT NULL,
  confidence INTEGER NOT NULL,
  risk_flags TEXT NOT NULL DEFAULT '[]',
  rationale TEXT,

  price_t15 REAL, return_pct_t15 REAL, reconciled_t15 INTEGER NOT NULL DEFAULT 0, reconciled_at_t15 TEXT,
  price_t30 REAL, return_pct_t30 REAL, reconciled_t30 INTEGER NOT NULL DEFAULT 0, reconciled_at_t30 TEXT,
  price_t60 REAL, return_pct_t60 REAL, reconciled_t60 INTEGER NOT NULL DEFAULT 0, reconciled_at_t60 TEXT,
  price_t240 REAL, return_pct_t240 REAL, reconciled_t240 INTEGER NOT NULL DEFAULT 0, reconciled_at_t240 TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_ai_shadow_predictions_symbol_interval_t0
  ON ai_shadow_predictions(symbol, interval, t0_ms DESC);
