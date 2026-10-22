// Files produced by a tsconfig `contentMappers` entry (e.g. `.vue`) carry
// the transformed TypeScript in `file.text` and the user's file in
// `file.originalText`; `file.spanMap` relates the two. Rules see and
// report in transformed coordinates; everything the user sees or that
// touches disk goes through here.

import type { TextChange } from '@tsslint/types';
import { type SourceFile, SpanMap } from 'typescript/ast';

export function getOriginalText(file: SourceFile): string {
	return file.spanMap ? file.originalText : file.text;
}

// Undefined when the range only covers generated code with no counterpart
// in the original file — there is nothing for the user to look at.
export function toOriginalRange(
	file: SourceFile,
	start: number,
	end: number,
): { start: number; end: number } | undefined {
	if (!file.spanMap) {
		return { start, end };
	}
	const { range, fidelity } = file.spanMap.virtualToOriginalSpan({ pos: start, end });
	if (SpanMap.isNone(fidelity)) {
		return undefined;
	}
	return { start: range.pos, end: range.end };
}

// Undefined unless every edit maps exactly onto original text; an
// approximate edit could corrupt the user's file.
export function toOriginalTextChanges(
	file: SourceFile,
	textChanges: readonly TextChange[],
): TextChange[] | undefined {
	if (!file.spanMap) {
		return [...textChanges];
	}
	const result: TextChange[] = [];
	for (const { span, newText } of textChanges) {
		const { range, fidelity } = file.spanMap.virtualToOriginalSpan({ pos: span.start, end: span.start + span.length });
		if (!SpanMap.isExact(fidelity)) {
			return undefined;
		}
		result.push({ span: { start: range.pos, length: range.end - range.pos }, newText });
	}
	return result;
}
