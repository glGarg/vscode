/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { XmlToolCallParser } from '../xmlToolCallParser';

describe('XmlToolCallParser', () => {

	it('passes through plain text unchanged', () => {
		const parser = new XmlToolCallParser();
		const r1 = parser.feed('hello world');
		const r2 = parser.flush();
		expect(r1.passThrough + r2.passThrough).toBe('hello world');
		expect(r1.toolCalls).toEqual([]);
		expect(r2.toolCalls).toEqual([]);
	});

	it('parses a single complete tool call in one chunk', () => {
		const parser = new XmlToolCallParser();
		const r = parser.feed('I will read the file.\n<function=read_file>\n<parameter=filePath>\n/tmp/foo\n</parameter>\n</function>\nDone.');
		const flush = parser.flush();
		expect(r.passThrough + flush.passThrough).toBe('I will read the file.\n\nDone.');
		expect(r.beginToolCalls).toHaveLength(1);
		expect(r.beginToolCalls[0].name).toBe('read_file');
		expect(r.toolCalls).toHaveLength(1);
		expect(r.toolCalls[0].name).toBe('read_file');
		expect(JSON.parse(r.toolCalls[0].arguments)).toEqual({ filePath: '/tmp/foo' });
		// begin tool call id matches the completed tool call id
		expect(r.beginToolCalls[0].id).toBe(r.toolCalls[0].id);
	});

	it('handles a tool call split across many chunks', () => {
		const parser = new XmlToolCallParser();
		const chunks = [
			'Reading… ',
			'<func',
			'tion=read',
			'_file>\n<parameter=filePath>\n/a/b/c',
			'.ts\n</parameter>',
			'\n</function>',
			' Done.',
		];
		let passThrough = '';
		let toolCalls: { name: string; arguments: string; id: string }[] = [];
		let beginToolCalls: { name: string; id?: string }[] = [];
		for (const c of chunks) {
			const out = parser.feed(c);
			passThrough += out.passThrough;
			toolCalls = toolCalls.concat(out.toolCalls);
			beginToolCalls = beginToolCalls.concat(out.beginToolCalls);
		}
		const flush = parser.flush();
		passThrough += flush.passThrough;
		expect(passThrough).toBe('Reading…  Done.');
		expect(beginToolCalls).toHaveLength(1);
		expect(beginToolCalls[0].name).toBe('read_file');
		expect(toolCalls).toHaveLength(1);
		expect(JSON.parse(toolCalls[0].arguments)).toEqual({ filePath: '/a/b/c.ts' });
	});

	it('emits beginToolCall on the chunk where the open tag closes, before arguments stream in', () => {
		const parser = new XmlToolCallParser();
		const a = parser.feed('<function=grep_search>\n');
		expect(a.beginToolCalls).toHaveLength(1);
		expect(a.beginToolCalls[0].name).toBe('grep_search');
		expect(a.toolCalls).toEqual([]);
		const b = parser.feed('<parameter=query>\nfoo\n</parameter>\n</function>');
		expect(b.beginToolCalls).toEqual([]);
		expect(b.toolCalls).toHaveLength(1);
		expect(JSON.parse(b.toolCalls[0].arguments)).toEqual({ query: 'foo' });
	});

	it('parses multiple sequential tool calls in one response', () => {
		const parser = new XmlToolCallParser();
		const r = parser.feed(
			'<function=read_file><parameter=filePath>/a</parameter></function>' +
			'<function=read_file><parameter=filePath>/b</parameter></function>'
		);
		expect(r.toolCalls).toHaveLength(2);
		expect(JSON.parse(r.toolCalls[0].arguments)).toEqual({ filePath: '/a' });
		expect(JSON.parse(r.toolCalls[1].arguments)).toEqual({ filePath: '/b' });
		expect(r.toolCalls[0].id).not.toBe(r.toolCalls[1].id);
	});

	it('parses multiple parameters and preserves multi-line values', () => {
		const parser = new XmlToolCallParser();
		const r = parser.feed(
			'<function=create_file>\n' +
			'<parameter=filePath>\n/tmp/foo.py\n</parameter>\n' +
			'<parameter=content>\nline1\nline2\nline3\n</parameter>\n' +
			'</function>'
		);
		expect(r.toolCalls).toHaveLength(1);
		const args = JSON.parse(r.toolCalls[0].arguments);
		expect(args).toEqual({ filePath: '/tmp/foo.py', content: 'line1\nline2\nline3' });
	});

	it('coerces JSON-literal-looking parameter values', () => {
		const parser = new XmlToolCallParser();
		const r = parser.feed(
			'<function=demo>' +
			'<parameter=count>42</parameter>' +
			'<parameter=ratio>3.14</parameter>' +
			'<parameter=enabled>true</parameter>' +
			'<parameter=label>hello</parameter>' +
			'<parameter=tags>["a","b"]</parameter>' +
			'</function>'
		);
		const args = JSON.parse(r.toolCalls[0].arguments);
		expect(args).toEqual({
			count: 42,
			ratio: 3.14,
			enabled: true,
			label: 'hello',
			tags: ['a', 'b'],
		});
	});

	it('flushes incomplete tool call as text at end of stream', () => {
		const parser = new XmlToolCallParser();
		const a = parser.feed('start <function=read_file>\n<parameter=filePath>\n/tmp/foo');
		expect(a.passThrough).toBe('start ');
		expect(a.beginToolCalls).toHaveLength(1);
		const flush = parser.flush();
		// Should reconstruct enough so the user isn't left without context.
		expect(flush.passThrough).toContain('<function=read_file>');
		expect(flush.passThrough).toContain('/tmp/foo');
	});

	it('does not eat a trailing partial open-tag at safe-prefix boundary until disambiguated', () => {
		const parser = new XmlToolCallParser();
		// Trailing "<f" could be the start of "<function=" — must be withheld.
		const a = parser.feed('hello <f');
		expect(a.passThrough).toBe('hello ');
		// Disambiguate as plain text: "foo" follows, not "unction=".
		const b = parser.feed('oo bar');
		expect(b.passThrough).toBe('<foo bar');
	});

	it('passes input through verbatim once disabled', () => {
		const parser = new XmlToolCallParser();
		parser.disable();
		const r = parser.feed('<function=read_file><parameter=k>v</parameter></function>');
		expect(r.passThrough).toBe('<function=read_file><parameter=k>v</parameter></function>');
		expect(r.toolCalls).toEqual([]);
		expect(r.beginToolCalls).toEqual([]);
	});

	it('treats an empty function name as literal text and does not deadlock', () => {
		const parser = new XmlToolCallParser();
		const r = parser.feed('<function=>oops');
		const flush = parser.flush();
		expect((r.passThrough + flush.passThrough)).toContain('oops');
		expect(r.toolCalls).toEqual([]);
	});
});
