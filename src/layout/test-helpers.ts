// Shared fixtures and op finders for the layout test files. Not a test file
// itself; nothing here asserts.

import { parsePitch } from '../model/pitch.js';
import { buildScore, Score, type MeasureBuildSpec, type MeasureSpec } from '../model/score.js';
import type { GlyphName } from '../render/glyph-metrics.js';
import { layoutScore } from './layout.js';
import type { DrawOp, LaidOutMeasure, LaidOutScore } from './types.js';

/** A round staff space, so stem/beam/ledger thicknesses are distinct numbers. */
export const SS = 10;

export type GlyphOp = Extract<DrawOp, { kind: 'glyph' }>;
export type RectOp = Extract<DrawOp, { kind: 'rect' }>;
export type CurveOp = Extract<DrawOp, { kind: 'curve' }>;
export type TextOp = Extract<DrawOp, { kind: 'text' }>;

/** Lays a C-major treble score out at `SS` and returns its first measure too. */
export function layoutOne(measures: readonly (MeasureSpec | MeasureBuildSpec)[]) {
	const score = buildScore(measures, { keyFifths: 0 });
	const layout = layoutScore(score, { staffSpacePx: SS });
	return { score, layout, measure: layout.measures[0]!, ops: layout.measures[0]!.ops };
}

/** Note ids of measure `m` (staff 0), in `measure.notes` order. */
export const ids = (score: Score, m = 0) => score.measures[m]!.notes.map((note) => note.id);

/** The notehead glyph drawn for note `id`. */
export const headOf = (ops: readonly DrawOp[], id: string) =>
	ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.noteId === id && op.glyph.startsWith('notehead'))!;

/** Every glyph op drawing `name`. */
export const glyphOps = (ops: readonly DrawOp[], name: GlyphName) =>
	ops.filter((op): op is GlyphOp => op.kind === 'glyph' && op.glyph === name);

export const measureAt = (layout: LaidOutScore, staffIndex: number, index: number): LaidOutMeasure =>
	layout.measures.find((m) => m.staffIndex === staffIndex && m.index === index)!;

/** Treble over bass, three measures each of C4 D4 E4 F4 quarters, so both
 *  staves have a colliding "measure 1". */
export function twoStaffScore(): Score {
	const score = new Score({ keyFifths: 0 });
	score.appendStaff('bass');
	for (const staffIndex of [0, 1] as const) {
		for (let i = 0; i < 3; i++) {
			const measure = score.appendMeasure(staffIndex);
			for (const pitch of ['C4', 'D4', 'E4', 'F4']) {
				score.appendNote(measure, { pitch: parsePitch(pitch), value: 'quarter' });
			}
		}
	}
	return score;
}
