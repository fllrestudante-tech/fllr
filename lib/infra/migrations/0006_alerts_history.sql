CREATE TABLE alerts_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_alerts_history_source_time ON alerts_history(source, occurred_at);
CREATE INDEX idx_alerts_history_severity_time ON alerts_history(severity, occurred_at);
