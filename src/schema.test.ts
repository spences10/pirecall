import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { apply_schema } from './schema.ts';

const base_schema = readFileSync(
	new URL('./schema.sql', import.meta.url),
	'utf8',
);
const resumable_migration = readFileSync(
	new URL('./migrations/002_resumable_sessions.sql', import.meta.url),
	'utf8',
);

function user_version(db: DatabaseSync): number {
	return (
		db.prepare('PRAGMA user_version').get() as {
			user_version: number;
		}
	).user_version;
}

describe('pirecall schema', () => {
	test('creates a fresh database and applies migrations', () => {
		const db = new DatabaseSync(':memory:');
		apply_schema(db);
		expect(user_version(db)).toBe(2);
		const columns = (
			db.prepare('PRAGMA table_info(sessions)').all() as Array<{
				name: string;
			}>
		).map((column) => column.name);
		expect(columns).toContain('source_path');
		db.close();
	});

	test('upgrades an unversioned original database without data loss', () => {
		const db = new DatabaseSync(':memory:');
		db.exec(base_schema);
		db.prepare(
			'INSERT INTO sessions (id, project_path) VALUES (?, ?)',
		).run('legacy', '/tmp/legacy');
		apply_schema(db);
		expect(user_version(db)).toBe(2);
		expect(db.prepare('SELECT id FROM sessions').get()).toEqual({
			id: 'legacy',
		});
		db.close();
	});

	test('adopts an unversioned resumable database', () => {
		const db = new DatabaseSync(':memory:');
		db.exec(base_schema);
		db.exec(resumable_migration);
		db.prepare(
			'INSERT INTO sessions (id, project_path, source_path) VALUES (?, ?, ?)',
		).run('resumable', '/tmp/project', '/tmp/session.jsonl');
		apply_schema(db);
		expect(user_version(db)).toBe(2);
		expect(
			db.prepare('SELECT source_path FROM sessions').get(),
		).toEqual({ source_path: '/tmp/session.jsonl' });
		db.close();
	});

	test('rejects schemas newer than this package', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('PRAGMA user_version = 3');
		expect(() => apply_schema(db)).toThrow('newer than supported');
		db.close();
	});
});
