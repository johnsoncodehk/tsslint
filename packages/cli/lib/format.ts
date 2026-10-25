// Converts core diagnostics into the shape TS7's diagnostic formatter
// renders, in the coordinates of the file the user actually wrote.

import type { Diagnostic, RelatedInformation } from '@tsslint/types';
import type { SourceFile } from 'typescript/ast';
import {
	type Diagnostic as TSDiagnostic,
	type FormatDiagnosticsHost,
	formatDiagnosticsWithColorAndContext,
} from 'typescript/sync';
import contentMapper = require('./content-mapper.js');

const lineStartsCache = new WeakMap<SourceFile, number[]>();

// Undefined when the diagnostic lies entirely in generated code of a
// content-mapped file.
export function formatDiagnostic(diagnostic: Diagnostic, host: FormatDiagnosticsHost): string | undefined {
	const converted = convert(diagnostic);
	if (!converted) {
		return undefined;
	}
	return formatDiagnosticsWithColorAndContext([converted], host).trimEnd();
}

function convert(diagnostic: Diagnostic | RelatedInformation): TSDiagnostic | undefined {
	// The formatter prints `${source}${code}`; rule ids go in `source`.
	const code = typeof diagnostic.code === 'string'
		? { source: diagnostic.code, code: '' as unknown as number }
		: { code: diagnostic.code };
	const base = {
		...code,
		category: diagnostic.category,
		text: diagnostic.messageText,
	};
	const { file, start, length } = diagnostic;
	if (!file || start === undefined || length === undefined) {
		return { ...base, pos: 0, end: 0 };
	}
	// Compiler diagnostics of a content-mapped file already come back in
	// original coordinates; only rule reports are in transformed ones.
	const range = 'source' in diagnostic && diagnostic.source === 'tsslint'
		? contentMapper.toOriginalRange(file, start, start + length)
		: { start, end: start + length };
	if (!range) {
		return undefined;
	}
	const text = contentMapper.getOriginalText(file);
	const lineStarts = getLineStarts(file, text);
	const startPosition = toLineAndCharacter(lineStarts, range.start);
	const endPosition = toLineAndCharacter(lineStarts, range.end);
	const relatedInformation = 'relatedInformation' in diagnostic
		? diagnostic.relatedInformation?.map(convert).filter(info => !!info)
		: undefined;
	return {
		...base,
		fileName: file.fileName,
		pos: range.start,
		end: range.end,
		startPosition,
		endPosition,
		sourceLines: getSourceLines(text, lineStarts, startPosition.line, endPosition.line),
		reportsUnnecessary: 'reportsUnnecessary' in diagnostic ? diagnostic.reportsUnnecessary : undefined,
		reportsDeprecated: 'reportsDeprecated' in diagnostic ? diagnostic.reportsDeprecated : undefined,
		relatedInformation,
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
