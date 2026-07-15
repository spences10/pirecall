import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Database } from './db.ts';
import { sync } from './sync.ts';

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('session metadata backfill', () => {
	test('indexes the latest name from an unchanged legacy session', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pirecall-sync-'));
		dirs.push(dir);
		const project_dir = join(dir, '--tmp-project--');
		const file_path = join(project_dir, 'named.jsonl');
		mkdirSync(project_dir, { recursive: true });
		const entries = [
			{
				type: 'session',
				version: 3,
				id: 'legacy-named',
				timestamp: '2026-07-15T00:00:00.000Z',
				cwd: '/tmp/project',
			},
			{
				type: 'session_info',
				id: 'info-1',
				parentId: null,
				timestamp: '2026-07-15T00:00:01.000Z',
				name: 'Old name',
			},
			{
				type: 'message',
				id: 'message-1',
				parentId: 'info-1',
				timestamp: '2026-07-15T00:00:02.000Z',
				message: {
					role: 'user',
					content: [{ type: 'text', text: 'first prompt' }],
				},
			},
			{
				type: 'session_info',
				id: 'info-2',
				parentId: 'message-1',
				timestamp: '2026-07-15T00:00:03.000Z',
				name: 'Current name',
			},
		];
		writeFileSync(
			file_path,
			`${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
		);
		const stats = statSync(file_path);
		const db = new Database(join(dir, 'pirecall.db'));
		db.upsert_session({
			id: 'legacy-named',
			project_path: '/tmp/project',
			cwd: '/tmp/project',
			timestamp: Date.parse('2026-07-15T00:00:00.000Z'),
		});
		db.insert_message({
			id: 'message-1',
			session_id: 'legacy-named',
			type: 'user',
			content_text: 'first prompt',
			timestamp: Date.parse('2026-07-15T00:00:02.000Z'),
		});
		db.update_session_source({
			id: 'legacy-named',
			path: file_path,
			mtime_ms: stats.mtimeMs,
			size_bytes: stats.size,
			last_seen_at: Date.now(),
			first_message: 'first prompt',
		});
		db.set_sync_state(file_path, stats.mtimeMs, stats.size, false);

		const result = await sync(db, false, dir);
		const sessions = db.list_resumable_sessions();
		expect(result.files_processed).toBe(0);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.name).toBe('Current name');
		expect(db.get_sync_state(file_path)?.metadata_indexed).toBe(1);
		expect(db.get_stats().messages).toBe(1);
		db.close();
	});
});
