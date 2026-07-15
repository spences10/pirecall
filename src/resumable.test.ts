import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from 'vitest';
import { Database } from './db.ts';
import {
	RESUMABLE_API_CAPABILITIES,
	list_resumable_sessions,
} from './resumable.ts';

const db_path = join(import.meta.dirname, 'resumable-test.db');

describe('resumable session API', () => {
	let db: Database;

	beforeEach(() => {
		if (existsSync(db_path)) unlinkSync(db_path);
		db = new Database(db_path);
		for (const [id, cwd, timestamp] of [
			['live', '/tmp/project', 2000],
			['archived', '/tmp/project', 1000],
		] as const) {
			db.upsert_session({ id, project_path: cwd, cwd, timestamp });
		}
		db.insert_message({
			id: 'message-live',
			session_id: 'live',
			type: 'user',
			content_text: 'fix authentication',
			timestamp: 2000,
		});
		db.update_session_source({
			id: 'live',
			path: '/tmp/live.jsonl',
			mtime_ms: 20,
			size_bytes: 100,
			last_seen_at: 3000,
			name: 'Auth work',
			first_message: 'fix authentication',
		});
		db.close();
	});

	afterEach(() => {
		if (existsSync(db_path)) unlinkSync(db_path);
	});

	test('migrates an existing archive database additively', () => {
		const legacy_path = join(import.meta.dirname, 'legacy-test.db');
		if (existsSync(legacy_path)) unlinkSync(legacy_path);
		const legacy_db = new DatabaseSync(legacy_path);
		legacy_db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				project_path TEXT NOT NULL,
				cwd TEXT,
				first_timestamp INTEGER,
				last_timestamp INTEGER
			);
		`);
		legacy_db.close();

		const migrated_db = new Database(legacy_path);
		const columns = migrated_db
			.get_schema('sessions')
			.tables[0].columns.map((column) => column.name);
		expect(columns).toContain('source_path');
		expect(columns).toContain('source_exists');
		migrated_db.close();
		unlinkSync(legacy_path);
	});

	test('returns only live sources with versioned capabilities', async () => {
		const result = await list_resumable_sessions({ db_path });
		expect(result.schema_version).toBe(1);
		expect(result.capabilities).toEqual(RESUMABLE_API_CAPABILITIES);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]).toMatchObject({
			id: 'live',
			path: '/tmp/live.jsonl',
			name: 'Auth work',
			source_exists: true,
			message_count: 1,
		});
	});

	test('uses source mtime for modified time and ordering', async () => {
		db = new Database(db_path);
		db.upsert_session({
			id: 'newer-source',
			project_path: '/tmp/project',
			cwd: '/tmp/project',
			timestamp: 500,
		});
		db.update_session_source({
			id: 'newer-source',
			path: '/tmp/newer-source.jsonl',
			mtime_ms: 40,
			size_bytes: 50,
			last_seen_at: 3000,
		});
		db.close();

		const result = await list_resumable_sessions({ db_path });
		expect(result.sessions.map((session) => session.id)).toEqual([
			'newer-source',
			'live',
		]);
		expect(result.sessions[0].modified_at).toBe(
			new Date(40).toISOString(),
		);
	});

	test('supports project scope and server-side search', async () => {
		const matching = await list_resumable_sessions({
			db_path,
			cwd: '/tmp/project',
			scope: 'project',
			query: 'authentication',
		});
		expect(matching.sessions.map((session) => session.id)).toEqual([
			'live',
		]);

		const missing = await list_resumable_sessions({
			db_path,
			query: 'unrelated',
		});
		expect(missing.sessions).toEqual([]);
	});

	test('preserves archive rows when a source disappears', async () => {
		db = new Database(db_path);
		db.mark_unseen_sources_missing(4000);
		db.close();

		const result = await list_resumable_sessions({ db_path });
		expect(result.sessions).toEqual([]);

		db = new Database(db_path);
		expect(db.get_stats().sessions).toBe(2);
		db.close();
	});
});
