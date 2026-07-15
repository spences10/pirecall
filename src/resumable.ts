import { resolve } from 'node:path';
import { Database } from './db.ts';

export const RESUMABLE_API_SCHEMA_VERSION = 1 as const;
export const RESUMABLE_API_CAPABILITIES = [
	'archive-preserving-source-liveness',
	'cwd-scope',
	'server-side-search',
	'pagination',
] as const;

export interface ResumableSession {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	parent_session_path?: string;
	created_at: string;
	modified_at: string;
	message_count: number;
	first_message: string;
	source_exists: true;
	source_mtime_ms?: number;
	source_size_bytes?: number;
	last_seen_at?: string;
}

export interface ListResumableSessionsOptions {
	db_path?: string;
	cwd?: string;
	scope?: 'project' | 'all';
	query?: string;
	limit?: number;
	offset?: number;
	signal?: AbortSignal;
}

export interface ResumableSessionsResult {
	schema_version: typeof RESUMABLE_API_SCHEMA_VERSION;
	capabilities: typeof RESUMABLE_API_CAPABILITIES;
	sessions: ResumableSession[];
}

interface ResumableRow {
	id: string;
	path: string;
	cwd: string | null;
	name: string | null;
	parent_session_path: string | null;
	first_timestamp: number;
	modified_timestamp: number;
	message_count: number;
	first_message: string | null;
	source_mtime_ms: number | null;
	source_size_bytes: number | null;
	last_seen_at: number | null;
}

export async function list_resumable_sessions(
	options: ListResumableSessionsOptions = {},
): Promise<ResumableSessionsResult> {
	if (options.signal?.aborted) {
		throw (
			options.signal.reason ??
			new DOMException('Aborted', 'AbortError')
		);
	}
	const scope = options.scope ?? (options.cwd ? 'project' : 'all');
	if (scope === 'project' && !options.cwd) {
		throw new Error('cwd is required when scope is "project"');
	}
	const db = new Database(options.db_path);
	try {
		const rows = db.list_resumable_sessions({
			cwd:
				scope === 'project' && options.cwd
					? resolve(options.cwd)
					: undefined,
			query: options.query?.trim() || undefined,
			limit: options.limit,
			offset: options.offset,
		}) as unknown as ResumableRow[];
		return {
			schema_version: RESUMABLE_API_SCHEMA_VERSION,
			capabilities: RESUMABLE_API_CAPABILITIES,
			sessions: rows.map((row) => ({
				id: row.id,
				path: row.path,
				cwd: row.cwd ?? '',
				name: row.name ?? undefined,
				parent_session_path: row.parent_session_path ?? undefined,
				created_at: new Date(row.first_timestamp).toISOString(),
				modified_at: new Date(row.modified_timestamp).toISOString(),
				message_count: row.message_count,
				first_message: row.first_message ?? '(no messages)',
				source_exists: true,
				source_mtime_ms: row.source_mtime_ms ?? undefined,
				source_size_bytes: row.source_size_bytes ?? undefined,
				last_seen_at:
					row.last_seen_at === null
						? undefined
						: new Date(row.last_seen_at).toISOString(),
			})),
		};
	} finally {
		db.close();
	}
}
