// Renders diagnostics with TS7's diagnostic formatter, in the coordinates
// of the file the user actually wrote.

import type { Diagnostic } from '@tsslint/types';
import path = require('path');
import type { SourceFile } from 'typescript/ast';
import {
	type Diagnostic as TSDiagnostic,
	type FormatDiagnosticsHost,
	formatDiagnosticsWithColorAndContext,
} from 'typescript/sync';
import { cyan } from './colors.js';
import contentMapper = require('./content-mapper.js');

const lineStartsCache = new WeakMap<SourceFile, number[]>();

// Undefined when the diagnostic lies entirely in generated code of a
// content-mapped file.
export function formatDiagnostic(
	diagnostic: Diagnostic,
	file: SourceFile,
	host: FormatDiagnosticsHost,
): string | undefined {
	// The formatter prints `${source}${code}`, so `source` is only kept to
	// carry a rule id.
	const converted = diagnostic.ruleId === undefined
		? { ...diagnostic, source: undefined, fileName: file.fileName }
		: convertRuleReport(diagnostic, diagnostic.ruleId, file);
	if (!converted) {
		return undefined;
	}
	const output = formatDiagnosticsWithColorAndContext([converted], host).trimEnd();
	if (converted.fileName === undefined) {
		// The formatter only names the file together with a position.
		return cyan(path.relative(host.getCurrentDirectory(), file.fileName)) + ' - ' + output;
	}
	return output;
}

// Rule reports are in transformed coordinates and carry no line
// information; compiler diagnostics already come back with both in the
// original file.
function convertRuleReport(diagnostic: Diagnostic, ruleId: string, file: SourceFile): TSDiagnostic | undefined {
	// There are no string codes.
	const code = { source: ruleId, code: '' as unknown as number };
	if (diagnostic.fileName === undefined) {
		return { ...diagnostic, ...code };
	}
	const range = contentMapper.toOriginalRange(file, diagnostic);
	if (!range) {
		return undefined;
	}
	const text = contentMapper.getOriginalText(file);
	const lineStarts = getLineStarts(file, text);
	const startPosition = toLineAndCharacter(lineStarts, range.pos);
	const endPosition = toLineAndCharacter(lineStarts, range.end);
	return {
		...diagnostic,
		...code,
		fileName: file.fileName,
		pos: range.pos,
		end: range.end,
		startPosition,
		endPosition,
		sourceLines: getSourceLines(text, lineStarts, startPosition.line, endPosition.line),
	};
}

function getLineStarts(file: SourceFile, text: string): number[] {
	let lineStarts = lineStartsCache.get(file);
	if (!lineStarts) {
		lineStarts = [0];
		for (let i = 0; i < text.length; i++) {
			const ch = text.charCodeAt(i);
			if (ch === 13 /* \r */) {
				if (text.charCodeAt(i + 1) === 10 /* \n */) {
					i++;
				}
				lineStarts.push(i + 1);
			}
			else if (ch === 10 /* \n */ || ch === 0x2028 || ch === 0x2029) {
				lineStarts.push(i + 1);
			}
		}
		lineStartsCache.set(file, lineStarts);
	}
	return lineStarts;
}

function toLineAndCharacter(lineStarts: number[], position: number) {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (lineStarts[mid] <= position) {
			low = mid;
		}
		else {
			high = mid - 1;
		}
	}
	return { line: low, character: position - lineStarts[low] };
}

// Same context window as `tsc`: every line for short spans, otherwise the
// first two and last two (the formatter prints an ellipsis for the gap).
function getSourceLines(text: string, lineStarts: number[], startLine: number, endLine: number) {
	const lines = endLine - startLine >= 4
		? [startLine, startLine + 1, endLine - 1, endLine]
		: Array.from({ length: endLine - startLine + 1 }, (_, i) => startLine + i);
	return lines.map(line => {
		const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] : text.length;
		return { line, text: text.slice(lineStarts[line], lineEnd).replace(/(?:\r\n|[\r\n\u2028\u2029])$/, '') };
	});
}
