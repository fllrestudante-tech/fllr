-- Snapshot de ticker (preço, mark/index price, spread, funding, OI num só
-- call) -- é observação repetida no tempo, não tem chave natural única como
-- candle/funding/OI, então não leva UNIQUE INDEX de idempotência.
CREATE TABLE tickers_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  last_price REAL NOT NULL,
  mark_price REAL NOT NULL,
  index_price REAL NOT NULL,
  bid_price REAL NOT NULL,
  ask_price REAL NOT NULL,
  volume_24h REAL NOT NULL,
  turnover_24h REAL NOT NULL,
  price_change_24h_pct REAL NOT NULL,
  funding_rate REAL NOT NULL,
  open_interest REAL NOT NULL,
  snapshot_time INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_tickers_lookup ON tickers_snapshot(exchange, symbol, snapshot_time);

-- Razão compradores/vendedores (contas) -- tem timestamp próprio da Bybit,
-- então segue o mesmo padrão de idempotência de funding/open_interest.
CREATE TABLE long_short_ratio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  buy_ratio REAL NOT NULL,
  sell_ratio REAL NOT NULL,
  snapshot_time INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_long_short_unique ON long_short_ratio(exchange, symbol, snapshot_time);
