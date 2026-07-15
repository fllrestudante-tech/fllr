CREATE TABLE fear_greed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  value INTEGER NOT NULL,
  classification TEXT NOT NULL,
  snapshot_time INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_fear_greed_unique ON fear_greed(source, snapshot_time);
