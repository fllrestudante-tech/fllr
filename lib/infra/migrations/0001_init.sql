CREATE TABLE events_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_events_log_name_time ON events_log(event_name, occurred_at);

CREATE TABLE candles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_candles_unique ON candles(exchange, symbol, interval, open_time);

CREATE TABLE funding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  funding_rate REAL NOT NULL,
  funding_time INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_funding_unique ON funding(exchange, symbol, funding_time);

CREATE TABLE open_interest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  oi_value REAL NOT NULL,
  snapshot_time INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_oi_unique ON open_interest(exchange, symbol, snapshot_time);

CREATE TABLE telegram_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  ticker TEXT,
  text TEXT NOT NULL,
  normalized_hash TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  confidence REAL NOT NULL,
  keywords TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  time TEXT NOT NULL
);
CREATE INDEX idx_telegram_ticker_time ON telegram_messages(ticker, time_ms);
CREATE INDEX idx_telegram_hash_time ON telegram_messages(normalized_hash, time_ms);
