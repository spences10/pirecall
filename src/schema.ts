import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

const SCHEMA = readFileSync(
	new URL('./schema.sql', import.meta.url),
	'utf8',
);
const LATEST_SCHEMA_VERSION = 2;
const MIGRATIONS: Record<number, string> = {
	2: readFileSync(
		new URL(
			'./migrations/002_resumable_sessions.sql',
			import.meta.url,
		),
		'utf8',
	),
};
const LEGACY_TABLES = [
	'messages',
	'model_changes',
	'sessions',
	'sync_state',
	'tool_calls',
	'tool_results',
] as const;
const RESUMABLE_COLUMNS = [
	'first_message',
	'last_seen_at',
	'name',
	'parent_session_path',
	'source_exists',
	'source_mtime_ms',
	'source_path',
	'source_size_bytes',
] as const;

function get_user_version(db: DatabaseSync): number {
	return (
		db.prepare('PRAGMA user_version').get() as {
			user_version: number;
		}
	).user_version;
}

function has_sessions_table(db: DatabaseSync): boolean {
	return Boolean(
		db
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
			)
			.get(),
	);
}

function detect_legacy_version(db: DatabaseSync): number {
	const tables = new Set(
		(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table'",
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name),
	);
	const missing_tables = LEGACY_TABLES.filter(
		(table_name) => !tables.has(table_name),
	);
	if (missing_tables.length > 0) {
		throw new Error(
			`Unversioned pirecall database has an unrecognized schema; missing tables: ${missing_tables.join(', ')}`,
		);
	}
	const columns = new Set(
		(
			db.prepare('PRAGMA table_info(sessions)').all() as Array<{
				name: string;
			}>
		).map((column) => column.name),
	);
	const resumable_count = RESUMABLE_COLUMNS.filter((column) =>
		columns.has(column),
	).length;
	if (resumable_count === 0) return 1;
	if (resumable_count === RESUMABLE_COLUMNS.length) return 2;
	throw new Error(
		'Unversioned pirecall database has a partially applied resumable-session migration',
	);
}

function run_migration(
	db: DatabaseSync,
	version: number,
	sql: string,
): void {
	db.exec('BEGIN IMMEDIATE');
	try {
		db.exec(sql);
		db.exec(`PRAGMA user_version = ${version}`);
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function apply_schema(db: DatabaseSync): void {
	let current_version = get_user_version(db);
	if (current_version === 0) {
		if (has_sessions_table(db)) {
			current_version = detect_legacy_version(db);
			db.exec(`PRAGMA user_version = ${current_version}`);
		} else {
			run_migration(db, 1, SCHEMA);
			current_version = 1;
		}
	}
	if (current_version > LATEST_SCHEMA_VERSION) {
		throw new Error(
			`Pirecall database schema version ${current_version} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
		);
	}
	for (
		let next_version = current_version + 1;
		next_version <= LATEST_SCHEMA_VERSION;
		next_version++
	) {
		const migration = MIGRATIONS[next_version];
		if (!migration) {
			throw new Error(
				`Missing pirecall migration for schema version ${next_version}`,
			);
		}
		run_migration(db, next_version, migration);
	}
}
