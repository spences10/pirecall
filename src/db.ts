import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { StatementSync } from 'node:sqlite';

const DEFAULT_DB_PATH = join(process.env.HOME!, '.pi', 'pirecall.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  cwd TEXT,
  first_timestamp INTEGER,
  last_timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
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

CREATE TABLE IF NOT EXISTS sync_state (
  file_path TEXT PRIMARY KEY,
  last_modified INTEGER NOT NULL,
  last_byte_offset INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS tool_results (
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

CREATE TABLE IF NOT EXISTS model_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  provider TEXT,
  model_id TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_results(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_results_call ON tool_results(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_model_changes_session ON model_changes(session_id);

-- FTS5 full-text search index for messages (content_text + thinking)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content_text,
  thinking,
  content='messages',
  content_rowid='rowid'
);

-- Triggers to keep FTS index in sync with messages table
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content_text, thinking) VALUES (new.rowid, new.content_text, new.thinking);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text, thinking) VALUES('delete', old.rowid, old.content_text, old.thinking);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text, thinking) VALUES('delete', old.rowid, old.content_text, old.thinking);
  INSERT INTO messages_fts(rowid, content_text, thinking) VALUES (new.rowid, new.content_text, new.thinking);
END;
`;

/**
 * Escape a search term for FTS5 MATCH queries.
 */
function escape_fts5_query(term: string): string {
	if (term.startsWith('"') && term.endsWith('"')) {
		return term;
	}

	const is_prefix = term.endsWith('*');
	const base_term = is_prefix ? term.slice(0, -1) : term;

	const has_special = /[./\-:()^+']/.test(base_term);

	if (!has_special && !base_term.includes('"')) {
		return term;
	}

	const escaped = `"${base_term.replace(/"/g, '""')}"`;
	return is_prefix ? escaped + '*' : escaped;
}

export interface CompactResult {
	dry_run: boolean;
	older_than_days: number;
	cutoff_date: string;
	tool_results_compacted: {
		read: number;
		bash: number;
		grep_glob: number;
		write: number;
	};
	bytes_before: number;
	bytes_after: number;
}

export class Database {
	private db: DatabaseSync;
	private db_path: string;
	private stmt_upsert_session: StatementSync;
	private stmt_insert_message: StatementSync;
	private stmt_insert_tool_call: StatementSync;
	private stmt_insert_tool_result: StatementSync;
	private stmt_insert_model_change: StatementSync;
	private stmt_get_sync_state: StatementSync;
	private stmt_set_sync_state: StatementSync;

	constructor(db_path = DEFAULT_DB_PATH) {
		this.db_path = db_path;
		this.db = new DatabaseSync(db_path, {
			enableForeignKeyConstraints: true,
		});
		this.db.exec(SCHEMA);

		this.stmt_upsert_session = this.db.prepare(`
			INSERT INTO sessions (id, project_path, cwd, first_timestamp, last_timestamp)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				last_timestamp = MAX(last_timestamp, excluded.last_timestamp)
		`);

		this.stmt_insert_message = this.db.prepare(`
			INSERT OR IGNORE INTO messages (
				id, session_id, parent_id, type, provider, model,
				content_text, content_json, thinking, timestamp,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
				cost_total
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.stmt_insert_tool_call = this.db.prepare(`
			INSERT OR IGNORE INTO tool_calls (id, message_id, session_id, tool_name, tool_input, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		this.stmt_insert_tool_result = this.db.prepare(`
			INSERT OR IGNORE INTO tool_results (tool_call_id, message_id, session_id, content, is_error, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		this.stmt_insert_model_change = this.db.prepare(`
			INSERT OR IGNORE INTO model_changes (id, session_id, parent_id, provider, model_id, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		this.stmt_get_sync_state = this.db.prepare(
			'SELECT last_modified, last_byte_offset FROM sync_state WHERE file_path = ?',
		);

		this.stmt_set_sync_state = this.db.prepare(`
			INSERT INTO sync_state (file_path, last_modified, last_byte_offset)
			VALUES (?, ?, ?)
			ON CONFLICT(file_path) DO UPDATE SET
				last_modified = excluded.last_modified,
				last_byte_offset = excluded.last_byte_offset
		`);
	}

	begin() {
		this.db.exec('BEGIN TRANSACTION');
	}

	commit() {
		this.db.exec('COMMIT');
	}

	disable_foreign_keys() {
		this.db.exec('PRAGMA foreign_keys = OFF');
	}

	enable_foreign_keys() {
		this.db.exec('PRAGMA foreign_keys = ON');
	}

	upsert_session(session: {
		id: string;
		project_path: string;
		cwd?: string;
		timestamp: number;
	}) {
		this.stmt_upsert_session.run(
			session.id,
			session.project_path,
			session.cwd ?? null,
			session.timestamp,
			session.timestamp,
		);
	}

	insert_message(msg: {
		id: string;
		session_id: string;
		parent_id?: string;
		type: string;
		provider?: string;
		model?: string;
		content_text?: string;
		content_json?: string;
		thinking?: string;
		timestamp: number;
		input_tokens?: number;
		output_tokens?: number;
		cache_read_tokens?: number;
		cache_write_tokens?: number;
		cost_total?: number;
	}) {
		this.stmt_insert_message.run(
			msg.id,
			msg.session_id,
			msg.parent_id ?? null,
			msg.type,
			msg.provider ?? null,
			msg.model ?? null,
			msg.content_text ?? null,
			msg.content_json ?? null,
			msg.thinking ?? null,
			msg.timestamp,
			msg.input_tokens ?? 0,
			msg.output_tokens ?? 0,
			msg.cache_read_tokens ?? 0,
			msg.cache_write_tokens ?? 0,
			msg.cost_total ?? 0,
		);
	}

	insert_tool_call(call: {
		id: string;
		message_id: string;
		session_id: string;
		tool_name: string;
		tool_input: string;
		timestamp: number;
	}) {
		this.stmt_insert_tool_call.run(
			call.id,
			call.message_id,
			call.session_id,
			call.tool_name,
			call.tool_input,
			call.timestamp,
		);
	}

	insert_tool_result(result: {
		tool_call_id: string;
		message_id: string;
		session_id: string;
		content: string;
		is_error: boolean;
		timestamp: number;
	}) {
		this.stmt_insert_tool_result.run(
			result.tool_call_id,
			result.message_id,
			result.session_id,
			result.content,
			result.is_error ? 1 : 0,
			result.timestamp,
		);
	}

	insert_model_change(change: {
		id: string;
		session_id: string;
		parent_id?: string;
		provider: string;
		model_id: string;
		timestamp: number;
	}) {
		this.stmt_insert_model_change.run(
			change.id,
			change.session_id,
			change.parent_id ?? null,
			change.provider,
			change.model_id,
			change.timestamp,
		);
	}

	get_sync_state(
		file_path: string,
	): { last_modified: number; last_byte_offset: number } | undefined {
		return this.stmt_get_sync_state.get(file_path) as
			| { last_modified: number; last_byte_offset: number }
			| undefined;
	}

	set_sync_state(
		file_path: string,
		last_modified: number,
		last_byte_offset: number,
	) {
		this.stmt_set_sync_state.run(
			file_path,
			last_modified,
			last_byte_offset,
		);
	}

	get_stats() {
		const sessions = this.db
			.prepare('SELECT COUNT(*) as count FROM sessions')
			.get() as { count: number };
		const messages = this.db
			.prepare('SELECT COUNT(*) as count FROM messages')
			.get() as { count: number };
		const tool_calls = this.db
			.prepare('SELECT COUNT(*) as count FROM tool_calls')
			.get() as { count: number };
		const tool_results = this.db
			.prepare('SELECT COUNT(*) as count FROM tool_results')
			.get() as { count: number };
		const model_changes = this.db
			.prepare('SELECT COUNT(*) as count FROM model_changes')
			.get() as { count: number };
		const tokens = this.db
			.prepare(
				`
			SELECT
				SUM(input_tokens) as input,
				SUM(output_tokens) as output,
				SUM(cache_read_tokens) as cache_read,
				SUM(cache_write_tokens) as cache_write,
				SUM(cost_total) as total_cost
			FROM messages
		`,
			)
			.get() as {
			input: number;
			output: number;
			cache_read: number;
			cache_write: number;
			total_cost: number;
		};

		return {
			sessions: sessions.count,
			messages: messages.count,
			tool_calls: tool_calls.count,
			tool_results: tool_results.count,
			model_changes: model_changes.count,
			tokens,
		};
	}

	reset_sync_state() {
		this.db.exec('DELETE FROM sync_state');
	}

	search(
		term: string,
		options: {
			limit?: number;
			project?: string;
			session?: string;
			after?: number;
			sort?: 'relevance' | 'time' | 'time-asc';
		} = {},
	): Array<{
		id: string;
		session_id: string;
		project_path: string;
		content_text: string;
		timestamp: number;
		snippet: string;
		relevance: number;
	}> {
		const limit = options.limit ?? 20;
		const sort = options.sort ?? 'relevance';
		let query = `
			SELECT
				m.id,
				m.session_id,
				s.project_path,
				m.content_text,
				m.timestamp,
				COALESCE(
					snippet(messages_fts, 0, '>>>', '<<<', '...', 32),
					snippet(messages_fts, 1, '>>>', '<<<', '...', 32)
				) as snippet,
				bm25(messages_fts, 10.0, 1.0) as relevance
			FROM messages_fts
			JOIN messages m ON m.rowid = messages_fts.rowid
			JOIN sessions s ON s.id = m.session_id
			WHERE messages_fts MATCH ?
		`;
		const params: (string | number)[] = [escape_fts5_query(term)];

		if (options.project) {
			query += ` AND s.project_path LIKE ?`;
			params.push(`%${options.project}%`);
		}

		if (options.session) {
			query += ` AND m.session_id LIKE ?`;
			params.push(`${options.session}%`);
		}

		if (options.after) {
			query += ` AND m.timestamp >= ?`;
			params.push(options.after);
		}

		if (sort === 'time') {
			query += ` ORDER BY m.timestamp DESC`;
		} else if (sort === 'time-asc') {
			query += ` ORDER BY m.timestamp ASC`;
		} else {
			query += ` ORDER BY relevance`;
		}

		query += ` LIMIT ?`;
		params.push(limit);

		return this.db.prepare(query).all(...params) as Array<{
			id: string;
			session_id: string;
			project_path: string;
			content_text: string;
			timestamp: number;
			snippet: string;
			relevance: number;
		}>;
	}

	get_messages_around(
		session_id: string,
		timestamp: number,
		count: number,
	): {
		before: Array<{
			id: string;
			type: string;
			content_text: string;
			timestamp: number;
		}>;
		after: Array<{
			id: string;
			type: string;
			content_text: string;
			timestamp: number;
		}>;
	} {
		const before = this.db
			.prepare(
				`SELECT id, type, content_text, timestamp
				FROM messages
				WHERE session_id = ? AND timestamp < ?
				ORDER BY timestamp DESC
				LIMIT ?`,
			)
			.all(session_id, timestamp, count) as Array<{
			id: string;
			type: string;
			content_text: string;
			timestamp: number;
		}>;

		const after = this.db
			.prepare(
				`SELECT id, type, content_text, timestamp
				FROM messages
				WHERE session_id = ? AND timestamp > ?
				ORDER BY timestamp ASC
				LIMIT ?`,
			)
			.all(session_id, timestamp, count) as Array<{
			id: string;
			type: string;
			content_text: string;
			timestamp: number;
		}>;

		return { before: before.reverse(), after };
	}

	get_context_around(
		session_id: string,
		timestamp: number,
		count: number,
	): {
		before: Array<{
			type: string;
			content_text: string;
			tool_names?: string[];
			timestamp: number;
		}>;
		after: Array<{
			type: string;
			content_text: string;
			tool_names?: string[];
			timestamp: number;
		}>;
	} {
		const fetch_limit = count * 4;

		const raw_before = this.db
			.prepare(
				`SELECT m.id, m.type, m.content_text, m.timestamp,
					(SELECT GROUP_CONCAT(tc.tool_name, ', ')
					 FROM tool_calls tc WHERE tc.message_id = m.id) as tool_names
				FROM messages m
				WHERE m.session_id = ? AND m.timestamp < ?
				ORDER BY m.timestamp DESC
				LIMIT ?`,
			)
			.all(session_id, timestamp, fetch_limit) as Array<{
			id: string;
			type: string;
			content_text: string | null;
			timestamp: number;
			tool_names: string | null;
		}>;

		const raw_after = this.db
			.prepare(
				`SELECT m.id, m.type, m.content_text, m.timestamp,
					(SELECT GROUP_CONCAT(tc.tool_name, ', ')
					 FROM tool_calls tc WHERE tc.message_id = m.id) as tool_names
				FROM messages m
				WHERE m.session_id = ? AND m.timestamp > ?
				ORDER BY m.timestamp ASC
				LIMIT ?`,
			)
			.all(session_id, timestamp, fetch_limit) as Array<{
			id: string;
			type: string;
			content_text: string | null;
			timestamp: number;
			tool_names: string | null;
		}>;

		const enrich = (
			row: (typeof raw_before)[number],
		): {
			type: string;
			content_text: string;
			tool_names?: string[];
			timestamp: number;
		} | null => {
			const tools = row.tool_names
				? row.tool_names.split(', ')
				: undefined;
			if (row.content_text) {
				return {
					type: row.type,
					content_text: row.content_text,
					tool_names: tools,
					timestamp: row.timestamp,
				};
			}
			if (tools) {
				return {
					type: row.type,
					content_text: `[used tools: ${tools.join(', ')}]`,
					tool_names: tools,
					timestamp: row.timestamp,
				};
			}
			return null;
		};

		const before = raw_before
			.map(enrich)
			.filter((m) => m !== null)
			.slice(0, count)
			.reverse();

		const after = raw_after
			.map(enrich)
			.filter((m) => m !== null)
			.slice(0, count);

		return { before, after };
	}

	rebuild_fts() {
		this.db.exec(
			`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`,
		);
	}

	get_sessions(
		options: { limit?: number; project?: string } = {},
	): Array<{
		id: string;
		project_path: string;
		first_timestamp: number;
		last_timestamp: number;
		message_count: number;
		total_tokens: number;
		total_cost: number;
		duration_mins: number;
	}> {
		const limit = options.limit ?? 10;
		let query = `
			SELECT
				s.id,
				s.project_path,
				s.first_timestamp,
				s.last_timestamp,
				COUNT(m.id) as message_count,
				COALESCE(SUM(m.input_tokens + m.output_tokens), 0) as total_tokens,
				COALESCE(SUM(m.cost_total), 0) as total_cost,
				CAST((s.last_timestamp - s.first_timestamp) / 60000.0 AS INTEGER) as duration_mins
			FROM sessions s
			LEFT JOIN messages m ON m.session_id = s.id
		`;
		const params: (string | number)[] = [];

		if (options.project) {
			query += ` WHERE s.project_path LIKE ?`;
			params.push(`%${options.project}%`);
		}

		query += ` GROUP BY s.id ORDER BY s.last_timestamp DESC LIMIT ?`;
		params.push(limit);

		return this.db.prepare(query).all(...params) as Array<{
			id: string;
			project_path: string;
			first_timestamp: number;
			last_timestamp: number;
			message_count: number;
			total_tokens: number;
			total_cost: number;
			duration_mins: number;
		}>;
	}

	get_tool_stats(
		options: { limit?: number; project?: string } = {},
	): Array<{
		tool_name: string;
		count: number;
		percentage: number;
	}> {
		const limit = options.limit ?? 10;
		let query = `
			SELECT
				tc.tool_name,
				COUNT(*) as count
			FROM tool_calls tc
		`;
		const params: (string | number)[] = [];

		if (options.project) {
			query += `
				JOIN sessions s ON s.id = tc.session_id
				WHERE s.project_path LIKE ?
			`;
			params.push(`%${options.project}%`);
		}

		query += `
			GROUP BY tc.tool_name
			ORDER BY count DESC
			LIMIT ?
		`;
		params.push(limit);

		const rows = this.db.prepare(query).all(...params) as Array<{
			tool_name: string;
			count: number;
		}>;

		let total_query = 'SELECT COUNT(*) as total FROM tool_calls tc';
		const total_params: (string | number)[] = [];
		if (options.project) {
			total_query +=
				' JOIN sessions s ON s.id = tc.session_id WHERE s.project_path LIKE ?';
			total_params.push(`%${options.project}%`);
		}
		const total = (
			this.db.prepare(total_query).get(...total_params) as {
				total: number;
			}
		).total;

		return rows.map((r) => ({
			tool_name: r.tool_name,
			count: r.count,
			percentage: total > 0 ? (r.count / total) * 100 : 0,
		}));
	}

	get_schema(table_name?: string): {
		tables: Array<{
			name: string;
			type: string;
			row_count: number;
			columns: Array<{
				name: string;
				type: string;
				notnull: boolean;
				default_value: unknown;
				pk: boolean;
			}>;
			indexes: Array<{ name: string; sql: string }>;
			foreign_keys: Array<{
				from: string;
				table: string;
				to: string;
			}>;
		}>;
	} {
		const table_rows = this.db
			.prepare(
				`SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
			)
			.all() as Array<{ name: string; type: string }>;

		const tables = table_rows
			.filter((t) => !table_name || t.name === table_name)
			.map((t) => {
				const row_count = (
					this.db
						.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`)
						.get() as { count: number }
				).count;

				const columns = this.db
					.prepare(`PRAGMA table_info("${t.name}")`)
					.all() as Array<{
					name: string;
					type: string;
					notnull: number;
					dflt_value: unknown;
					pk: number;
				}>;

				const indexes = (
					this.db
						.prepare(`PRAGMA index_list("${t.name}")`)
						.all() as Array<{ name: string }>
				)
					.map((idx) => {
						const sql_row = this.db
							.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`)
							.get(idx.name) as { sql: string } | undefined;
						return {
							name: idx.name,
							sql: sql_row?.sql ?? '',
						};
					})
					.filter((idx) => idx.sql);

				const foreign_keys = this.db
					.prepare(`PRAGMA foreign_key_list("${t.name}")`)
					.all() as Array<{
					from: string;
					table: string;
					to: string;
				}>;

				return {
					name: t.name,
					type: t.type,
					row_count,
					columns: columns.map((c) => ({
						name: c.name,
						type: c.type,
						notnull: c.notnull === 1,
						default_value: c.dflt_value,
						pk: c.pk > 0,
					})),
					indexes,
					foreign_keys: foreign_keys.map((fk) => ({
						from: fk.from,
						table: fk.table,
						to: fk.to,
					})),
				};
			});

		return { tables };
	}

	compact(options: {
		older_than_days: number;
		dry_run: boolean;
	}): CompactResult {
		const cutoff_ts =
			Date.now() - options.older_than_days * 24 * 60 * 60 * 1000;
		const cutoff_date = new Date(cutoff_ts)
			.toISOString()
			.split('T')[0];

		const bytes_before = existsSync(this.db_path)
			? statSync(this.db_path).size
			: 0;

		if (options.dry_run) {
			const count_tool = (names: string[], min: number) =>
				(
					this.db
						.prepare(
							`SELECT COUNT(*) as n FROM tool_results tr
							 JOIN tool_calls tc ON tr.tool_call_id = tc.id
							 WHERE tc.tool_name IN (${names.map(() => '?').join(',')})
							   AND tr.timestamp < ?
							   AND tr.content IS NOT NULL
							   AND tr.content NOT LIKE '[compacted:%'
							   AND LENGTH(tr.content) > ?`,
						)
						.get(...names, cutoff_ts, min) as {
						n: number;
					}
				).n;

			return {
				dry_run: true,
				older_than_days: options.older_than_days,
				cutoff_date,
				tool_results_compacted: {
					read: count_tool(['read'], 200),
					bash: count_tool(['bash'], 200),
					grep_glob: count_tool(['grep', 'glob'], 100),
					write: count_tool(['write'], 100),
				},
				bytes_before,
				bytes_after: bytes_before,
			};
		}

		let read_count = 0;
		let bash_count = 0;
		let grep_glob_count = 0;
		let write_count = 0;

		const changes = () =>
			(
				this.db.prepare('SELECT changes() as n').get() as {
					n: number;
				}
			).n;

		this.disable_foreign_keys();
		this.begin();

		try {
			// Compact read tool results
			this.db
				.prepare(
					`UPDATE tool_results
					 SET content = '[compacted: ' || LENGTH(content) || 'B — file: ' ||
						COALESCE(JSON_EXTRACT(tc.tool_input, '$.file_path'), 'unknown') ||
						' recoverable from git]'
					 FROM tool_calls tc
					 WHERE tool_results.tool_call_id = tc.id
					   AND tc.tool_name = 'read'
					   AND tool_results.timestamp < ?
					   AND tool_results.content IS NOT NULL
					   AND tool_results.content NOT LIKE '[compacted:%'
					   AND LENGTH(tool_results.content) > 200`,
				)
				.run(cutoff_ts);
			read_count = changes();

			// Compact bash tool results (keep first 200 chars)
			this.db
				.prepare(
					`UPDATE tool_results
					 SET content = SUBSTR(content, 1, 200) || CHAR(10) ||
						'[compacted: truncated from ' || LENGTH(content) || 'B]'
					 FROM tool_calls tc
					 WHERE tool_results.tool_call_id = tc.id
					   AND tc.tool_name = 'bash'
					   AND tool_results.timestamp < ?
					   AND tool_results.content IS NOT NULL
					   AND tool_results.content NOT LIKE '[compacted:%'
					   AND LENGTH(tool_results.content) > 200`,
				)
				.run(cutoff_ts);
			bash_count = changes();

			// Compact grep/glob tool results
			this.db
				.prepare(
					`UPDATE tool_results
					 SET content = '[compacted: ' || LENGTH(content) || 'B]'
					 FROM tool_calls tc
					 WHERE tool_results.tool_call_id = tc.id
					   AND tc.tool_name IN ('grep', 'glob')
					   AND tool_results.timestamp < ?
					   AND tool_results.content IS NOT NULL
					   AND tool_results.content NOT LIKE '[compacted:%'
					   AND LENGTH(tool_results.content) > 100`,
				)
				.run(cutoff_ts);
			grep_glob_count = changes();

			// Compact write tool results
			this.db
				.prepare(
					`UPDATE tool_results
					 SET content = '[compacted: ' || LENGTH(content) || 'B]'
					 FROM tool_calls tc
					 WHERE tool_results.tool_call_id = tc.id
					   AND tc.tool_name = 'write'
					   AND tool_results.timestamp < ?
					   AND tool_results.content IS NOT NULL
					   AND tool_results.content NOT LIKE '[compacted:%'
					   AND LENGTH(tool_results.content) > 100`,
				)
				.run(cutoff_ts);
			write_count = changes();

			this.commit();
		} catch (err) {
			this.db.exec('ROLLBACK');
			throw err;
		} finally {
			this.enable_foreign_keys();
		}

		this.rebuild_fts();
		this.db.exec('VACUUM');

		const bytes_after = existsSync(this.db_path)
			? statSync(this.db_path).size
			: 0;

		return {
			dry_run: false,
			older_than_days: options.older_than_days,
			cutoff_date,
			tool_results_compacted: {
				read: read_count,
				bash: bash_count,
				grep_glob: grep_glob_count,
				write: write_count,
			},
			bytes_before,
			bytes_after,
		};
	}

	close() {
		this.db.close();
	}
}
