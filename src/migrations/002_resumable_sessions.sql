ALTER TABLE sessions ADD COLUMN source_path TEXT;
ALTER TABLE sessions ADD COLUMN source_exists INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN source_mtime_ms REAL;
ALTER TABLE sessions ADD COLUMN source_size_bytes INTEGER;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN name TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_path TEXT;
ALTER TABLE sessions ADD COLUMN first_message TEXT;

CREATE INDEX idx_sessions_resumable
ON sessions(source_exists, last_timestamp DESC);
