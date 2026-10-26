// Files produced by a tsconfig `contentMappers` entry (e.g. `.vue`) carry
// the transformed TypeScript in `file.text` and the user's file in
// `file.originalText`; `file.spanMap` relates the two. Rules see and
// report in transformed coordinates; everything the user sees or that
// touches disk goes through here.

import { type ReadonlyTextRange, type SourceFile, SpanMap } from 'typescript/ast';
import type { TextEdit } from 'typescript/sync';

export function getOriginalText(file: SourceFile): string {
	return file.spanMap ? file.originalText : file.text;
}

// Undefined when the range only covers generated code with no counterpart
// in the original file — there is nothing for the user to look at.
export function toOriginalRange(file: SourceFile, range: ReadonlyTextRange): ReadonlyTextRange | undefined {
	if (!file.spanMap) {
		return range;
	}
	const mapped = file.spanMap.virtualToOriginalSpan(range);
	if (SpanMap.isNone(mapped.fidelity)) {
		return undefined;
	}
	return mapped.range;
}

// Undefined unless every edit maps exactly onto original text; an
// approximate edit could corrupt the user's file.
export function toOriginalTextEdits(file: SourceFile, edits: readonly TextEdit[]): TextEdit[] | undefined {
	if (!file.spanMap) {
		return [...edits];
	}
	const result: TextEdit[] = [];
	for (const edit of edits) {
		const { range, fidelity } = file.spanMap.virtualToOriginalSpan(edit);
		if (!SpanMap.isExact(fidelity)) {
			return undefined;
		}
		result.push({ pos: range.pos, end: range.end, newText: edit.newText });
	}
	return result;
}
