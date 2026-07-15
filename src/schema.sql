CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  cwd TEXT,
  first_timestamp INTEGER,
  last_timestamp INTEGER
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  content_text TEXT,
  content_json TEXT,
  thinking TEXT,
  timestamp INTEGER NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cost_total REAL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE sync_state (
  file_path TEXT PRIMARY KEY,
  last_modified INTEGER NOT NULL,
  last_byte_offset INTEGER NOT NULL
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_call_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  content TEXT,
  is_error INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id),
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE model_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  provider TEXT,
  model_id TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_sessions_project ON sessions(project_path);
CREATE INDEX idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX idx_tool_calls_name ON tool_calls(tool_name);
CREATE INDEX idx_tool_results_session ON tool_results(session_id);
CREATE INDEX idx_tool_results_call ON tool_results(tool_call_id);
CREATE INDEX idx_model_changes_session ON model_changes(session_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_text,
  thinking,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content_text, thinking)
  VALUES (new.rowid, new.content_text, new.thinking);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text, thinking)
  VALUES ('delete', old.rowid, old.content_text, old.thinking);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text, thinking)
  VALUES ('delete', old.rowid, old.content_text, old.thinking);
  INSERT INTO messages_fts(rowid, content_text, thinking)
  VALUES (new.rowid, new.content_text, new.thinking);
END;
