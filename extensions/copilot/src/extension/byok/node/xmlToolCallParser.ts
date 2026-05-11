/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICopilotBeginToolCall, ICopilotToolCall } from '../../../platform/networking/common/fetch';
import { generateUuid } from '../../../util/vs/base/common/uuid';

/**
 * Parses XML-format tool calls emitted in the assistant content channel by BYOK
 * models that fail to use proper JSON `tool_calls` (e.g., some Fireworks-served
 * models when their server-side "shape" fails to convert XML into structured
 * tool calls).
 *
 * Expected format produced by these models (whitespace-tolerant):
 *
 *   <function=NAME>
 *   <parameter=KEY>
 *   VALUE
 *   </parameter>
 *   <parameter=KEY2>
 *   VALUE2
 *   </parameter>
 *   </function>
 *
 * The parser is stateful and streaming: feed it text chunks as they arrive,
 * and it yields the text that should still be shown to the user (everything
 * outside `<function=...>` blocks) and any tool calls that have been fully
 * assembled.
 */

export interface IXmlToolCallParserOutput {
	/** Text outside any `<function=...>` block, safe to forward to the user. */
	passThrough: string;
	/** Tool call begin events, emitted as soon as the function name is known. */
	beginToolCalls: ICopilotBeginToolCall[];
	/** Fully-assembled tool calls (name + JSON arguments string + id). */
	toolCalls: ICopilotToolCall[];
}

const FUNCTION_OPEN_PREFIX = '<function=';

export class XmlToolCallParser {
	/**
	 * Buffer of unconsumed input. May contain a partial open tag, an in-progress
	 * function block, or trailing characters we haven't decided about yet.
	 */
	private _buffer = '';

	/**
	 * When set, the parser is currently collecting characters inside a
	 * `<function=NAME>...</function>` block. The function name and a synthesized
	 * id are captured at the moment the opening tag closes, so we can emit a
	 * `beginToolCall` immediately.
	 */
	private _currentCall: { name: string; id: string; beginEmitted: boolean } | undefined;

	/**
	 * If true, the parser has been disabled (e.g., because a native JSON
	 * tool_call arrived) and all subsequent input is passed through verbatim.
	 */
	private _disabled = false;

	disable(): void {
		this._disabled = true;
	}

	isDisabled(): boolean {
		return this._disabled;
	}

	/**
	 * Feed a chunk of streamed text into the parser. Returns the portion of
	 * input that should be forwarded as user-visible text, plus any tool-call
	 * events that completed during this chunk.
	 */
	feed(chunk: string): IXmlToolCallParserOutput {
		const result: IXmlToolCallParserOutput = { passThrough: '', beginToolCalls: [], toolCalls: [] };
		if (this._disabled) {
			result.passThrough = chunk;
			return result;
		}
		this._buffer += chunk;
		this._drain(result);
		return result;
	}

	/**
	 * Flush any unconsumed buffer at end of stream. If the buffer contains an
	 * incomplete `<function=...>` block, we give up trying to parse it and emit
	 * the raw text as pass-through so the user still sees what the model
	 * produced.
	 */
	flush(): IXmlToolCallParserOutput {
		const result: IXmlToolCallParserOutput = { passThrough: '', beginToolCalls: [], toolCalls: [] };
		if (this._disabled) {
			result.passThrough = this._buffer;
			this._buffer = '';
			return result;
		}
		if (this._currentCall) {
			// Incomplete tool call at end of stream — reconstruct the original text
			// so the user can at least see what was emitted.
			result.passThrough = `${FUNCTION_OPEN_PREFIX}${this._currentCall.name}>${this._buffer}`;
			this._buffer = '';
			this._currentCall = undefined;
			return result;
		}
		// Buffer holds trailing characters that may have been a partial `<function=`
		// prefix; nothing matched, so flush as-is.
		result.passThrough = this._buffer;
		this._buffer = '';
		return result;
	}

	private _drain(result: IXmlToolCallParserOutput): void {
		while (this._buffer.length > 0) {
			if (this._currentCall) {
				if (!this._currentCall.beginEmitted) {
					result.beginToolCalls.push({ name: this._currentCall.name, id: this._currentCall.id });
					this._currentCall.beginEmitted = true;
				}
				const closeIdx = this._buffer.indexOf('</function>');
				if (closeIdx === -1) {
					// Whole buffer is the (still incomplete) function body — wait for more.
					return;
				}
				const body = this._buffer.slice(0, closeIdx);
				this._buffer = this._buffer.slice(closeIdx + '</function>'.length);
				const args = parseParameterArguments(body);
				result.toolCalls.push({
					name: this._currentCall.name,
					id: this._currentCall.id,
					arguments: JSON.stringify(args),
				});
				this._currentCall = undefined;
				continue;
			}

			const openIdx = this._buffer.indexOf(FUNCTION_OPEN_PREFIX);
			if (openIdx === -1) {
				// No open tag — emit everything except a trailing window that might
				// be the start of a future `<function=`.
				const safe = safePrefixEnd(this._buffer);
				if (safe > 0) {
					result.passThrough += this._buffer.slice(0, safe);
					this._buffer = this._buffer.slice(safe);
				}
				return;
			}

			// Emit any prose before the opening tag.
			if (openIdx > 0) {
				result.passThrough += this._buffer.slice(0, openIdx);
				this._buffer = this._buffer.slice(openIdx);
			}

			// Read the function name: `<function=NAME>`. Wait for the closing `>`.
			const nameStart = FUNCTION_OPEN_PREFIX.length;
			const nameEnd = this._buffer.indexOf('>', nameStart);
			if (nameEnd === -1) {
				// Open tag still incomplete — hold buffer until more arrives.
				return;
			}
			const name = this._buffer.slice(nameStart, nameEnd).trim();
			this._buffer = this._buffer.slice(nameEnd + 1);
			if (!name) {
				// Empty function name — treat the opening tag as literal text and
				// continue scanning so we don't get stuck in a loop.
				result.passThrough += `${FUNCTION_OPEN_PREFIX}>`;
				continue;
			}
			this._currentCall = { name, id: `call_xml_${generateUuid()}`, beginEmitted: false };
		}
	}
}

/**
 * Parses the body of a `<function=...>...</function>` block into an arguments
 * object. The body is expected to contain zero or more
 * `<parameter=KEY>VALUE</parameter>` pairs interspersed with whitespace.
 *
 * Values are best-effort coerced to JSON types (number, boolean, null, object,
 * array) so the resulting JSON.stringify produces an arguments string that
 * matches the tool's JSON schema for non-string parameters. Anything that
 * doesn't look like a JSON literal stays a string.
 */
function parseParameterArguments(body: string): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
	let match: RegExpExecArray | null;
	while ((match = paramRegex.exec(body)) !== null) {
		const key = match[1].trim();
		const rawValue = match[2];
		if (!key) {
			continue;
		}
		args[key] = coerceValue(rawValue);
	}
	return args;
}

function coerceValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed === '') {
		return '';
	}
	if (trimmed === 'true') { return true; }
	if (trimmed === 'false') { return false; }
	if (trimmed === 'null') { return null; }
	if (/^-?\d+$/.test(trimmed)) {
		const n = Number(trimmed);
		if (Number.isSafeInteger(n)) {
			return n;
		}
	}
	if (/^-?\d+\.\d+$/.test(trimmed)) {
		const n = Number(trimmed);
		if (Number.isFinite(n)) {
			return n;
		}
	}
	if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			// Not valid JSON — fall through to string.
		}
	}
	return trimmed;
}

/**
 * Given the current buffer with no `<function=` prefix found, return the
 * largest length `n` such that `buffer.slice(0, n)` is safe to emit without
 * risk of straddling a future `<function=` tag. Specifically, any trailing
 * suffix that could be a prefix of `<function=` must be withheld.
 */
function safePrefixEnd(buffer: string): number {
	const maxHold = FUNCTION_OPEN_PREFIX.length - 1;
	const start = Math.max(0, buffer.length - maxHold);
	for (let i = start; i < buffer.length; i++) {
		if (FUNCTION_OPEN_PREFIX.startsWith(buffer.slice(i))) {
			return i;
		}
	}
	return buffer.length;
}
