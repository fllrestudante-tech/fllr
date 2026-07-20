CREATE TABLE system_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  automatic_recovery INTEGER,
  resync_status TEXT,
  resync_details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_system_incidents_started ON system_incidents(started_at);
CREATE UNIQUE INDEX idx_system_incidents_open ON system_incidents(type) WHERE ended_at IS NULL;
