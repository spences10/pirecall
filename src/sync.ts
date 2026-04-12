import { existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { glob } from 'tinyglobby';
import { Database } from './db.ts';
import { parse_file } from './parser.ts';

const SESSIONS_DIR = join(
	process.env.HOME!,
	'.pi',
	'agent',
	'sessions',
);

export interface SyncResult {
	files_scanned: number;
	files_processed: number;
	messages_added: number;
	sessions_added: number;
	tool_calls_added: number;
	tool_results_added: number;
	model_changes_added: number;
}

export async function sync(
	db: Database,
	verbose = false,
): Promise<SyncResult> {
	const result: SyncResult = {
		files_scanned: 0,
		files_processed: 0,
		messages_added: 0,
		sessions_added: 0,
		tool_calls_added: 0,
		tool_results_added: 0,
		model_changes_added: 0,
	};

	if (!existsSync(SESSIONS_DIR)) {
		console.log(`Sessions directory not found: ${SESSIONS_DIR}`);
		return result;
	}

	const files = await glob('**/*.jsonl', {
		cwd: SESSIONS_DIR,
		absolute: true,
	});

	result.files_scanned = files.length;
	console.log(`Found ${files.length} session files`);

	const seen_sessions = new Set<string>();
	let file_idx = 0;

	db.disable_foreign_keys();
	db.begin();

	for (const file_path of files) {
		file_idx++;
		if (file_idx % 100 === 0) {
			process.stdout.write(
				`\r  Progress: ${file_idx}/${files.length}`,
			);
		}
		const last_modified = statSync(file_path).mtimeMs;

		const sync_state = db.get_sync_state(file_path);

		if (sync_state && sync_state.last_modified >= last_modified) {
			continue;
		}

		const start_offset = sync_state?.last_byte_offset ?? 0;
		const project_path = extract_project_path(file_path);

		if (verbose) {
			console.log(`Processing: ${file_path}`);
		}

		let last_byte_offset = start_offset;
		let file_messages_added = 0;

		for (const { result: parsed, byte_offset } of parse_file(
			file_path,
			start_offset,
		)) {
			last_byte_offset = byte_offset;

			// Handle session header
			if (parsed.session) {
				const session = parsed.session;
				// Prefer cwd from session header over decoded dir name
				const real_path = session.cwd || project_path;
				if (!seen_sessions.has(session.id)) {
					db.upsert_session({
						id: session.id,
						project_path: real_path,
						cwd: session.cwd,
						timestamp: session.timestamp,
					});
					seen_sessions.add(session.id);
					result.sessions_added++;
				}
			}

			// Handle model changes
			if (parsed.model_change) {
				db.insert_model_change(parsed.model_change);
				result.model_changes_added++;
			}

			// Handle messages
			if (parsed.message) {
				const msg = parsed.message;

				// Ensure session exists (for resume where header was already processed)
				if (
					msg.session_id &&
					!seen_sessions.has(msg.session_id)
				) {
					db.upsert_session({
						id: msg.session_id,
						project_path,
						timestamp: msg.timestamp,
					});
					seen_sessions.add(msg.session_id);
				}

				db.insert_message(msg);
				file_messages_added++;

				// Insert tool calls
				for (const tool_call of msg.tool_calls) {
					db.insert_tool_call({
						id: tool_call.id,
						message_id: msg.id,
						session_id: msg.session_id,
						tool_name: tool_call.tool_name,
						tool_input: tool_call.tool_input,
						timestamp: msg.timestamp,
					});
					result.tool_calls_added++;
				}

				// Insert tool results
				for (const tool_result of msg.tool_results) {
					db.insert_tool_result({
						tool_call_id: tool_result.tool_call_id,
						message_id: msg.id,
						session_id: msg.session_id,
						content: tool_result.content,
						is_error: tool_result.is_error,
						timestamp: msg.timestamp,
					});
					result.tool_results_added++;
				}
			}
		}

		if (file_messages_added > 0) {
			result.files_processed++;
			result.messages_added += file_messages_added;
		}

		db.set_sync_state(file_path, last_modified, last_byte_offset);
	}

	db.commit();
	db.enable_foreign_keys();

	if (files.length >= 100) {
		console.log(); // newline after progress
	}

	return result;
}

function extract_project_path(file_path: string): string {
	const rel = relative(SESSIONS_DIR, file_path);
	const project_dir = rel.split('/')[0];

	// Pi encodes paths as --home-scott-repos-foo--
	if (project_dir.startsWith('--') && project_dir.endsWith('--')) {
		const inner = project_dir.slice(2, -2);
		return (
			'/' +
			inner.replace(/-/g, '/').replace(/\/\/+/g, '/')
		);
	}

	// Fallback: strip leading/trailing dashes
	if (project_dir.startsWith('-')) {
		return (
			'/' +
			project_dir
				.slice(1)
				.replace(/-/g, '/')
				.replace(/\/\/+/g, '/')
		);
	}

	return project_dir;
}
