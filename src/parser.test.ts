import { describe, expect, test } from 'vitest';
import { parse_entry } from './parser.ts';

describe('Parser', () => {
	test('parses session header', () => {
		const line = JSON.stringify({
			type: 'session',
			version: 3,
			id: 'd804bba1-0440-4ad7-8e9c-4d4b242c969d',
			timestamp: '2026-04-11T21:20:35.617Z',
			cwd: '/home/scott/repos/my-pi',
		});

		const result = parse_entry(line, '');
		expect(result?.session).toBeDefined();
		expect(result?.session?.id).toBe(
			'd804bba1-0440-4ad7-8e9c-4d4b242c969d',
		);
		expect(result?.session?.cwd).toBe('/home/scott/repos/my-pi');
		expect(result?.session?.timestamp).toBe(
			new Date('2026-04-11T21:20:35.617Z').getTime(),
		);
	});

	test('parses model_change', () => {
		const line = JSON.stringify({
			type: 'model_change',
			id: 'a0ae66e6',
			parentId: null,
			timestamp: '2026-04-11T21:20:35.626Z',
			provider: 'mistral',
			modelId: 'mistral-large-latest',
		});

		const result = parse_entry(line, 'session-1');
		expect(result?.model_change).toBeDefined();
		expect(result?.model_change?.provider).toBe('mistral');
		expect(result?.model_change?.model_id).toBe(
			'mistral-large-latest',
		);
		expect(result?.model_change?.session_id).toBe('session-1');
	});

	test('parses user message', () => {
		const line = JSON.stringify({
			type: 'message',
			id: '815a77ba',
			parentId: 'e19a6d67',
			timestamp: '2026-04-11T21:20:35.628Z',
			message: {
				role: 'user',
				content: [
					{
						type: 'text',
						text: 'What is 2+2? One word.',
					},
				],
				timestamp: 1775942435628,
			},
		});

		const result = parse_entry(line, 'session-1');
		expect(result?.message).toBeDefined();
		expect(result?.message?.type).toBe('user');
		expect(result?.message?.content_text).toBe(
			'What is 2+2? One word.',
		);
		expect(result?.message?.id).toBe('815a77ba');
		expect(result?.message?.parent_id).toBe('e19a6d67');
		expect(result?.message?.session_id).toBe('session-1');
	});

	test('parses assistant message with usage', () => {
		const line = JSON.stringify({
			type: 'message',
			id: '17f1a0a4',
			parentId: '815a77ba',
			timestamp: '2026-04-11T21:20:36.410Z',
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: 'Four.' }],
				api: 'mistral-conversations',
				provider: 'mistral',
				model: 'mistral-large-latest',
				usage: {
					input: 1536,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1539,
					cost: {
						input: 0.000768,
						output: 0.0000045,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0.0007725,
					},
				},
				stopReason: 'stop',
				timestamp: 1775942435735,
			},
		});

		const result = parse_entry(line, 'session-1');
		const msg = result?.message;
		expect(msg).toBeDefined();
		expect(msg?.type).toBe('assistant');
		expect(msg?.provider).toBe('mistral');
		expect(msg?.model).toBe('mistral-large-latest');
		expect(msg?.input_tokens).toBe(1536);
		expect(msg?.output_tokens).toBe(3);
		expect(msg?.cache_read_tokens).toBe(0);
		expect(msg?.cache_write_tokens).toBe(0);
		expect(msg?.cost_total).toBeCloseTo(0.0007725);
		expect(msg?.content_text).toBe('Four.');
	});

	test('parses assistant message with tool call', () => {
		const line = JSON.stringify({
			type: 'message',
			id: '8e6e0862',
			parentId: 'e1c7c2cc',
			timestamp: '2026-04-11T21:01:04.945Z',
			message: {
				role: 'assistant',
				content: [
					{ type: 'text', text: '' },
					{
						type: 'toolCall',
						id: 'xEsURTr3Z',
						name: 'bash',
						arguments: { command: 'pnpx nopeek load' },
					},
				],
				provider: 'mistral',
				model: 'mistral-large-latest',
				usage: {
					input: 1465,
					output: 14,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1479,
					cost: { total: 0.00075 },
				},
				stopReason: 'toolUse',
			},
		});

		const result = parse_entry(line, 'session-1');
		const msg = result?.message;
		expect(msg?.tool_calls.length).toBe(1);
		expect(msg?.tool_calls[0].id).toBe('xEsURTr3Z');
		expect(msg?.tool_calls[0].tool_name).toBe('bash');
		expect(JSON.parse(msg!.tool_calls[0].tool_input)).toEqual({
			command: 'pnpx nopeek load',
		});
	});

	test('parses toolResult message', () => {
		const line = JSON.stringify({
			type: 'message',
			id: '049b5b38',
			parentId: '8e6e0862',
			timestamp: '2026-04-11T21:01:06.754Z',
			message: {
				role: 'toolResult',
				toolCallId: 'xEsURTr3Z',
				toolName: 'bash',
				content: [
					{
						type: 'text',
						text: 'command output here',
					},
				],
				isError: true,
				timestamp: 1775941266754,
			},
		});

		const result = parse_entry(line, 'session-1');
		const msg = result?.message;
		expect(msg?.type).toBe('toolResult');
		expect(msg?.tool_results.length).toBe(1);
		expect(msg?.tool_results[0].tool_call_id).toBe('xEsURTr3Z');
		expect(msg?.tool_results[0].content).toBe('command output here');
		expect(msg?.tool_results[0].is_error).toBe(true);
	});

	test('parses thinking content', () => {
		const line = JSON.stringify({
			type: 'message',
			id: 'abc12345',
			parentId: 'def67890',
			timestamp: '2026-04-12T10:00:00.000Z',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'thinking',
						thinking: 'Let me think about this...',
					},
					{
						type: 'text',
						text: 'Here is my answer.',
					},
				],
				provider: 'anthropic',
				model: 'claude-opus-4-6',
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
				},
			},
		});

		const result = parse_entry(line, 'session-1');
		const msg = result?.message;
		expect(msg?.thinking).toBe('Let me think about this...');
		expect(msg?.content_text).toBe('Here is my answer.');
	});

	test('skips thinking_level_change', () => {
		const line = JSON.stringify({
			type: 'thinking_level_change',
			id: 'e19a6d67',
			parentId: 'a0ae66e6',
			timestamp: '2026-04-11T21:20:35.626Z',
			thinkingLevel: 'off',
		});

		const result = parse_entry(line, 'session-1');
		expect(result).toBeNull();
	});

	test('returns null for invalid JSON', () => {
		const result = parse_entry('not valid json', 'session-1');
		expect(result).toBeNull();
	});

	test('returns null for invalid timestamp', () => {
		const line = JSON.stringify({
			type: 'session',
			version: 3,
			id: 'test-id',
			timestamp: 'not-a-date',
			cwd: '/test',
		});

		const result = parse_entry(line, '');
		expect(result).toBeNull();
	});

	test('handles empty text in content blocks', () => {
		const line = JSON.stringify({
			type: 'message',
			id: 'msg-1',
			parentId: null,
			timestamp: '2026-04-12T10:00:00.000Z',
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: '' }],
				provider: 'mistral',
				model: 'mistral-large-latest',
			},
		});

		const result = parse_entry(line, 'session-1');
		expect(result?.message?.content_text).toBeUndefined();
	});

	test('handles multiple text blocks', () => {
		const line = JSON.stringify({
			type: 'message',
			id: 'msg-1',
			parentId: null,
			timestamp: '2026-04-12T10:00:00.000Z',
			message: {
				role: 'user',
				content: [
					{ type: 'text', text: 'First part.' },
					{ type: 'text', text: 'Second part.' },
				],
			},
		});

		const result = parse_entry(line, 'session-1');
		expect(result?.message?.content_text).toBe(
			'First part.\nSecond part.',
		);
	});
});
