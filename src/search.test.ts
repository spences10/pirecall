import { runCommand } from 'citty';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from 'vitest';
import { main } from './cli.ts';
import { Database } from './db.ts';

interface MatchedMessage {
	id: string;
	type: string;
}

interface MatchContext {
	before: Array<{ type: string }>;
	after: Array<{ type: string }>;
}

interface SearchResult extends MatchedMessage {
	context?: MatchContext;
}

interface RecallMatch extends MatchContext {
	match: MatchedMessage;
}

describe('search message filtering', () => {
	let directory: string;
	let db_path: string;
	let db: Database;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'pirecall-search-'));
		db_path = join(directory, 'fixture.db');
		db = new Database(db_path);
		db.upsert_session({
			id: 'type-session',
			project_path: '/test/types',
			timestamp: 1,
		});
		for (let i = 0; i < 64; i++) {
			const type =
				i < 40 ? 'toolResult' : i % 2 ? 'assistant' : 'user';
			db.insert_message({
				id: `type-${i}`,
				session_id: 'type-session',
				type,
				content_text:
					type === 'toolResult'
						? 'the toolonly output'
						: 'We discussed the authentication issue and decided to fix the login flow next.',
				timestamp: i + 1,
			});
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});

	test.each(['relevance', 'time', 'time-asc'] as const)(
		'default %s search filters before limiting results',
		(sort) => {
			const results = db.search('the', { sort });
			expect(results).toHaveLength(20);
			expect(
				results.every((r) => ['user', 'assistant'].includes(r.type)),
			).toBe(true);
		},
	);

	test.each(['user', 'assistant', 'toolResult'] as const)(
		'can explicitly search %s messages',
		(type) => {
			const results = db.search('the', { type, limit: 100 });
			expect(results).toHaveLength(type === 'toolResult' ? 40 : 12);
			expect(results.every((r) => r.type === type)).toBe(true);
		},
	);

	test('all preserves unfiltered BM25 ranking and tool-only search', () => {
		const results = db.search('the', { type: 'all' });
		expect(results).toHaveLength(20);
		expect(results.every((r) => r.type === 'toolResult')).toBe(true);
		expect(
			db.search('the', { type: 'all', limit: 100 }),
		).toHaveLength(64);
		expect(db.search('toolonly')).toEqual([]);
		expect(
			db.search('toolonly', { type: 'toolResult' }),
		).toHaveLength(20);
		expect(db.search('toolonly', { type: 'all' })).toHaveLength(20);
	});

	test('combines message filtering with project, session, date, sort, and limit', () => {
		const options = {
			type: 'toolResult' as const,
			project: '/test/types',
			session: 'type-',
			after: 35,
			sort: 'time-asc' as const,
			limit: 3,
		};
		expect(db.search('the', options).map((r) => r.timestamp)).toEqual(
			[35, 36, 37],
		);
		for (const filter of [
			{ project: 'missing' },
			{ session: 'missing' },
			{ after: 100 },
		]) {
			expect(db.search('the', { ...options, ...filter })).toEqual([]);
		}
	});

	for (const name of ['search', 'recall'] as const) {
		describe(`${name} CLI`, () => {
			async function run_json(
				term: string,
				extra: string[] = [],
			): Promise<RecallMatch[]> {
				const output = vi
					.spyOn(console, 'log')
					.mockImplementation(() => {});
				await runCommand(main, {
					rawArgs: [name, term, '--db', db_path, '--json', ...extra],
				});
				const json = output.mock.calls.at(-1)![0] as string;
				output.mockRestore();
				if (name === 'search') {
					return (JSON.parse(json) as SearchResult[]).map((r) => ({
						match: r,
						before: r.context?.before ?? [],
						after: r.context?.after ?? [],
					}));
				}
				return (JSON.parse(json) as { matches: RecallMatch[] })
					.matches;
			}

			test('defaults to conversation and exposes matched types', async () => {
				const matches = await run_json('the');
				expect(matches).toHaveLength(name === 'search' ? 20 : 5);
				expect(
					matches.every((r) =>
						['user', 'assistant'].includes(r.match.type),
					),
				).toBe(true);
			});

			test.each(['user', 'assistant', 'toolResult', 'all'] as const)(
				'accepts --type %s',
				async (type) => {
					const matches = await run_json('the', [
						'--type',
						type,
						'--limit',
						'100',
					]);
					const expected = db.search('the', { type, limit: 100 });
					expect(
						matches.map((r) => ({
							id: r.match.id,
							type: r.match.type,
						})),
					).toEqual(
						expected.map((r) => ({ id: r.id, type: r.type })),
					);
				},
			);

			test('tool-only matches require opt-in', async () => {
				expect(await run_json('toolonly')).toEqual([]);
				const matches = await run_json('toolonly', [
					'--type',
					'toolResult',
				]);
				expect(matches.length).toBeGreaterThan(0);
				expect(
					matches.every((r) => r.match.type === 'toolResult'),
				).toBe(true);
			});

			test('returns no matches for absent terms', async () => {
				expect(await run_json('nonexistentterm12345')).toEqual([]);
			});

			test('keeps bounded tool evidence around conversational matches', async () => {
				const matches = await run_json('the', [
					'--type',
					'user',
					'--limit',
					'100',
					'--context',
					'1',
				]);
				const entry = matches.find((r) => r.match.id === 'type-40')!;
				expect(entry.before).toHaveLength(1);
				expect(entry.before[0].type).toBe('toolResult');
				expect(entry.after).toHaveLength(1);
				expect(entry.after[0].type).toBe('assistant');
			});

			test('can disable surrounding context', async () => {
				const matches = await run_json('the', ['--context', '0']);
				expect(matches.length).toBeGreaterThan(0);
				for (const entry of matches) {
					expect(entry.before).toEqual([]);
					expect(entry.after).toEqual([]);
				}
			});

			test('rejects invalid filter values', async () => {
				await expect(
					runCommand(main, {
						rawArgs: [
							name,
							'the',
							'--db',
							db_path,
							'--type',
							'invalid',
						],
					}),
				).rejects.toThrow(/type/);
			});
		});
	}
});
