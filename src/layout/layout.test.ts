import { describe, expect, it } from 'vitest';
import { createDemoScore } from '../demo-score.js';
import { buildScore } from '../model/score.js';
import { layoutScore, relayoutMeasure } from './layout.js';
import type { LaidOutScore } from './types.js';

const overlaps = (a: { x: number; width: number }, b: { x: number; width: number }) =>
	a.x < b.x + b.width && b.x < a.x + a.width;

describe('layoutScore', () => {
	it('lays every note out and keeps ids addressable', () => {
		const layout = layoutScore(createDemoScore());
		const ids = layout.measures.flatMap((m) => m.notes.map((n) => n.id));
		expect(ids).toHaveLength(13);
		expect(new Set(ids).size).toBe(13);
	});

	it('gives measures disjoint horizontal bands', () => {
		// This is the precondition that makes region-scoped redraw safe at all:
		// if two measures shared pixels, repainting one would erase part of the
		// other. Asserted here rather than in the renderer because it is a
		// property of layout, and the renderer would only notice it visually.
		const layout = layoutScore(createDemoScore());
		for (let i = 1; i < layout.measures.length; i++) {
			expect(overlaps(layout.measures[i - 1]!.region, layout.measures[i]!.region)).toBe(false);
		}
	});

	it('keeps every drawn pixel inside its own measure region', () => {
		const layout = layoutScore(createDemoScore());
		for (const measure of layout.measures) {
			for (const op of measure.ops) {
				expect(op.x).toBeGreaterThanOrEqual(measure.region.x - 0.001);
				expect(op.y).toBeGreaterThanOrEqual(measure.region.y - 0.001);
				expect(op.y).toBeLessThanOrEqual(measure.region.y + measure.region.height + 0.001);
			}
			for (const note of measure.notes) {
				expect(note.bounds.x).toBeGreaterThanOrEqual(measure.region.x - 0.001);
				expect(note.bounds.x + note.bounds.width).toBeLessThanOrEqual(
					measure.region.x + measure.region.width + 0.001
				);
			}
		}
	});

	it('puts the clef, key signature and time signature in the first measure', () => {
		// They have to belong to a measure, not to a header nobody redraws:
		// clearing measure 0's region wipes them, so measure 0's ops must be able
		// to put them back.
		const layout = layoutScore(createDemoScore());
		const first = layout.measures[0]!;
		const glyphs = first.ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
		expect(glyphs).toContain('gClef');
		expect(glyphs).toContain('accidentalSharp');
		expect(glyphs).toContain('timeSig4');
		expect(layout.measures[1]!.ops.some((op) => op.kind === 'glyph' && op.glyph === 'gClef')).toBe(
			false
		);
	});

	it('gives every measure its own staff lines', () => {
		const layout = layoutScore(createDemoScore());
		for (const measure of layout.measures) {
			const fullWidthRects = measure.ops.filter(
				(op) => op.kind === 'rect' && Math.abs(op.width - measure.region.width) < 0.001
			);
			expect(fullWidthRects).toHaveLength(5);
		}
	});

	it('omits an accidental the key signature already implies', () => {
		// F sharp in G major draws no sharp; F natural in G major draws a natural.
		const sharpCount = (layout: LaidOutScore) =>
			layout.measures.flatMap((m) =>
				m.ops.filter((op) => op.kind === 'glyph' && op.glyph === 'accidentalSharp')
			).length;
		const inKey = layoutScore(buildScore([[['F#5', 'quarter']]], { keyFifths: 1 }));
		// One sharp for the key signature itself, none on the note.
		expect(sharpCount(inKey)).toBe(1);

		const naturals = layoutScore(buildScore([[['F5', 'quarter']]], { keyFifths: 1 }));
		expect(
			naturals.measures.flatMap((m) =>
				m.ops.filter((op) => op.kind === 'glyph' && op.glyph === 'accidentalNatural')
			)
		).toHaveLength(1);
	});

	it('draws ledger lines only for notes off the staff', () => {
		const onStaff = layoutScore(buildScore([[['B4', 'quarter']]]));
		const offStaff = layoutScore(buildScore([[['C4', 'quarter']]]));
		const ledgerCount = (layout: LaidOutScore) =>
			layout.measures[0]!.ops.filter(
				(op) => op.kind === 'rect' && op.width < layout.measures[0]!.region.width / 2
			).length;
		// A C4 needs one ledger line; a B4 sits on the middle line and needs none.
		// Both scores also contain a stem, hence the difference rather than a count.
		expect(ledgerCount(offStaff) - ledgerCount(onStaff)).toBe(1);
	});
});

describe('relayoutMeasure', () => {
	it('rebuilds one measure and leaves the others byte-identical', () => {
		const score = createDemoScore();
		const layout = layoutScore(score);
		score.transposeNote(score.measures[1]!.notes[0]!.id, 1);
		const updated = relayoutMeasure(score, layout, 1);
		expect(updated).not.toBeNull();
		for (const index of [0, 2, 3]) {
			// Same object, not merely an equal one: untouched measures are not
			// recomputed at all, which is what keeps edit cost independent of
			// score length.
			expect(updated!.measures[index]).toBe(layout.measures[index]);
		}
		expect(updated!.measures[1]).not.toBe(layout.measures[1]);
		// The rebuilt measure occupies the same band, to within the float noise of
		// having been computed by translation the first time and directly the
		// second. If it did not, `relayoutMeasure` would have refused.
		const before = layout.measures[1]!.region;
		const after = updated!.measures[1]!.region;
		expect(after.x).toBeCloseTo(before.x, 6);
		expect(after.width).toBeCloseTo(before.width, 6);
		expect(after.y).toBeCloseTo(before.y, 6);
		expect(after.height).toBeCloseTo(before.height, 6);
	});

	it('refuses when the edit would move the rest of the system', () => {
		// A transpose never changes a measure's width, but a duration change
		// would, and then "redraw one measure" is a lie. The layout says so
		// rather than silently producing a wrong picture.
		const score = createDemoScore();
		const layout = layoutScore(score);
		score.measures[1]!.notes[0]!.value = 'whole';
		expect(relayoutMeasure(score, layout, 1)).toBeNull();
	});

	it('refuses when the edit would overflow the canvas vertically', () => {
		const score = createDemoScore();
		const layout = layoutScore(score);
		// Far above the staff: the ledger lines would run off the top.
		for (let i = 0; i < 24; i++) score.transposeNote(score.measures[1]!.notes[0]!.id, 1);
		expect(relayoutMeasure(score, layout, 1)).toBeNull();
	});
});
