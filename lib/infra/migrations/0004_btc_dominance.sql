CREATE TABLE btc_dominance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  btc_dominance_pct REAL NOT NULL,
  eth_dominance_pct REAL,
  total_market_cap_usd REAL NOT NULL,
  total_volume_24h_usd REAL NOT NULL,
  market_cap_change_24h_pct REAL,
  snapshot_time INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_btc_dominance_unique ON btc_dominance(source, snapshot_time);
