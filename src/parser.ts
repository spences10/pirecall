import { readFileSync } from 'node:fs';

// Pi session JSONL entry types
interface SessionEntry {
	type: 'session';
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

interface ModelChangeEntry {
	type: 'model_change';
	id: string;
	parentId: string | null;
	timestamp: string;
	provider: string;
	modelId: string;
}

interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	thinkingSignature?: string;
	// toolCall fields
	id?: string;
	name?: string;
	arguments?: unknown;
}

interface MessageEntry {
	type: 'message';
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: 'user' | 'assistant' | 'toolResult';
		content?: ContentBlock[];
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
		api?: string;
		provider?: string;
		model?: string;
		usage?: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost?: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				total: number;
			};
		};
		stopReason?: string;
		timestamp?: number;
		responseId?: string;
	};
}

type PiEntry =
	| SessionEntry
	| ModelChangeEntry
	| MessageEntry
	| { type: string; [key: string]: unknown };

export interface ParsedSession {
	id: string;
	cwd: string;
	timestamp: number;
}

export interface ParsedMessage {
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
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cost_total: number;
	tool_calls: ToolCall[];
	tool_results: ToolResult[];
}

export interface ToolCall {
	id: string;
	tool_name: string;
	tool_input: string;
}

export interface ToolResult {
	tool_call_id: string;
	content: string;
	is_error: boolean;
}

export interface ParsedModelChange {
	id: string;
	session_id: string;
	parent_id?: string;
	provider: string;
	model_id: string;
	timestamp: number;
}

function extract_text(
	content: ContentBlock[] | undefined,
): string | undefined {
	if (!content) return undefined;

	const text_parts = content
		.filter(
			(b): b is ContentBlock & { text: string } =>
				b.type === 'text' &&
				typeof b.text === 'string' &&
				b.text.length > 0,
		)
		.map((b) => b.text);

	return text_parts.length > 0 ? text_parts.join('\n') : undefined;
}

function extract_thinking(
	content: ContentBlock[] | undefined,
): string | undefined {
	if (!content) return undefined;

	const thinking = content.find(
		(b) => b.type === 'thinking' && b.thinking,
	);
	return thinking?.thinking;
}

function extract_tool_calls(
	content: ContentBlock[] | undefined,
): ToolCall[] {
	if (!content) return [];

	return content
		.filter((b) => b.type === 'toolCall' && b.id && b.name)
		.map((b) => ({
			id: b.id!,
			tool_name: b.name!,
			tool_input: b.arguments ? JSON.stringify(b.arguments) : '{}',
		}));
}

export interface ParseResult {
	session?: ParsedSession;
	message?: ParsedMessage;
	model_change?: ParsedModelChange;
}

export function parse_entry(
	line: string,
	session_id: string,
): ParseResult | null {
	try {
		const data = JSON.parse(line) as PiEntry;

		if (data.type === 'session') {
			const entry = data as SessionEntry;
			const timestamp = new Date(entry.timestamp).getTime();
			if (isNaN(timestamp)) return null;
			return {
				session: {
					id: entry.id,
					cwd: entry.cwd,
					timestamp,
				},
			};
		}

		if (data.type === 'model_change') {
			const entry = data as ModelChangeEntry;
			const timestamp = new Date(entry.timestamp).getTime();
			if (isNaN(timestamp)) return null;
			return {
				model_change: {
					id: entry.id,
					session_id,
					parent_id: entry.parentId ?? undefined,
					provider: entry.provider,
					model_id: entry.modelId,
					timestamp,
				},
			};
		}

		if (data.type === 'message') {
			const entry = data as MessageEntry;
			const msg = entry.message;
			const timestamp = new Date(entry.timestamp).getTime();
			if (isNaN(timestamp)) return null;

			const usage = msg.usage;

			// Handle toolResult messages
			if (msg.role === 'toolResult') {
				const result_content = msg.content
					? msg.content
							.filter((c) => c.type === 'text' && c.text)
							.map((c) => c.text)
							.join('\n')
					: '';

				const tool_results: ToolResult[] = msg.toolCallId
					? [
							{
								tool_call_id: msg.toolCallId,
								content: result_content,
								is_error: msg.isError ?? false,
							},
						]
					: [];

				return {
					message: {
						id: entry.id,
						session_id,
						parent_id: entry.parentId ?? undefined,
						type: 'toolResult',
						provider: undefined,
						model: undefined,
						content_text: result_content || undefined,
						content_json: msg.content
							? JSON.stringify(msg.content)
							: undefined,
						thinking: undefined,
						timestamp,
						input_tokens: 0,
						output_tokens: 0,
						cache_read_tokens: 0,
						cache_write_tokens: 0,
						cost_total: 0,
						tool_calls: [],
						tool_results,
					},
				};
			}

			// User or assistant message
			return {
				message: {
					id: entry.id,
					session_id,
					parent_id: entry.parentId ?? undefined,
					type: msg.role,
					provider: msg.provider,
					model: msg.model,
					content_text: extract_text(msg.content),
					content_json: msg.content
						? JSON.stringify(msg.content)
						: undefined,
					thinking: extract_thinking(msg.content),
					timestamp,
					input_tokens: usage?.input ?? 0,
					output_tokens: usage?.output ?? 0,
					cache_read_tokens: usage?.cacheRead ?? 0,
					cache_write_tokens: usage?.cacheWrite ?? 0,
					cost_total: usage?.cost?.total ?? 0,
					tool_calls: extract_tool_calls(msg.content),
					tool_results: [],
				},
			};
		}

		// Skip thinking_level_change, compaction, branch_summary, etc.
		return null;
	} catch {
		return null;
	}
}

export function* parse_file(
	file_path: string,
	start_offset = 0,
): Generator<{
	result: ParseResult;
	byte_offset: number;
}> {
	const text = readFileSync(file_path, 'utf-8');

	const content =
		start_offset > 0
			? new TextDecoder().decode(
					new TextEncoder().encode(text).slice(start_offset),
				)
			: text;

	const lines = content.split('\n');
	let byte_offset = start_offset;

	// We need session_id from the header.
	// If starting from offset 0, first line is the session header.
	// If resuming, we need to read the first line to get session_id.
	let session_id = '';
	if (start_offset === 0) {
		// Will be set from the session entry
	} else {
		// Read first line of file to get session ID
		const first_line = readFileSync(file_path, 'utf-8').split(
			'\n',
		)[0];
		try {
			const header = JSON.parse(first_line) as PiEntry;
			if (header.type === 'session') {
				session_id = (header as SessionEntry).id;
			}
		} catch {
			// Can't determine session ID
		}
	}

	for (const line of lines) {
		const line_bytes = new TextEncoder().encode(line).length + 1; // +1 for newline

		if (line.trim()) {
			const result = parse_entry(line, session_id);
			if (result) {
				// Capture session_id from header
				if (result.session) {
					session_id = result.session.id;
				}
				yield {
					result,
					byte_offset: byte_offset + line_bytes,
				};
			}
		}

		byte_offset += line_bytes;
	}
}
