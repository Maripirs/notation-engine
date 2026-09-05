import { describe, expect, it } from 'vitest';
import { createDemoScore, createDurationShowcaseScore } from '../demo-score.js';
import { buildScore, TRIPLET, validateMeasure, type NoteValue } from '../model/score.js';
import { layoutScore, relayoutMeasure } from './layout.js';
import type { DrawOp, LaidOutScore } from './types.js';

const NOTE_VALUES: readonly NoteValue[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];

/** Glyph names an ops list draws, in order, dropping the plain rects. */
const glyphsOf = (ops: readonly DrawOp[]) =>
	ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));

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

	it('redraws just one measure in a later system, keeping its clef and key signature', () => {
		// Measure 2 opens system 2 of the demo score at this width (see the
		// `layoutScore` multi-system tests below), so it carries a clef and key
		// signature that a naive re-layout could accidentally drop.
		const score = createDemoScore();
		const options = { staffSpacePx: 11, systemWidthPx: 600 };
		const layout = layoutScore(score, options);
		expect(layout.systems[1]!.measureIndices).toEqual([2, 3]);

		score.transposeNote(score.measures[2]!.notes[0]!.id, 1);
		const updated = relayoutMeasure(score, layout, 2, options);
		expect(updated).not.toBeNull();
		for (const index of [0, 1, 3]) {
			expect(updated!.measures[index]).toBe(layout.measures[index]);
		}
		const glyphs = updated!.measures[2]!.ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
		expect(glyphs).toContain('gClef');
		expect(glyphs).toContain('accidentalSharp');
	});
});

describe('layoutScore with systemWidthPx (multi-system)', () => {
	const options = { staffSpacePx: 11, systemWidthPx: 600 };

	it('casts measures off onto a new system once they would overflow the width', () => {
		const layout = layoutScore(createDemoScore(), options);
		expect(layout.systems).toEqual([
			{ measureIndices: [0, 1], topY: layout.systems[0]!.topY },
			{ measureIndices: [2, 3], topY: layout.systems[1]!.topY }
		]);
		// Every measure still appears exactly once, in score order, across systems.
		expect(layout.systems.flatMap((s) => s.measureIndices)).toEqual([0, 1, 2, 3]);
	});

	it('starts each system at the same left margin and stacks systems vertically', () => {
		const layout = layoutScore(createDemoScore(), options);
		const systemTwoStart = layout.measures[2]!;
		expect(systemTwoStart.region.x).toBeCloseTo(layout.measures[0]!.region.x, 6);
		// The second system's staff sits strictly below the first system's.
		expect(layout.systems[1]!.topY).toBeGreaterThan(layout.systems[0]!.topY);
	});

	it('never lets a measure exceed the system width budget', () => {
		const layout = layoutScore(createDemoScore(), options);
		for (const measure of layout.measures) {
			expect(measure.region.width).toBeLessThanOrEqual(options.systemWidthPx);
		}
	});

	it('draws a clef and key signature, but not a time signature, on a later system-starting measure', () => {
		const layout = layoutScore(createDemoScore(), options);
		const systemStart = layout.measures[2]!;
		const glyphs = systemStart.ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
		expect(glyphs).toContain('gClef');
		expect(glyphs).toContain('accidentalSharp');
		expect(glyphs).not.toContain('timeSig4');

		// Only the score's true first measure states the time signature.
		const scoreStart = layout.measures[0]!.ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
		expect(scoreStart).toContain('timeSig4');

		// A mid-system measure gets neither.
		const midSystem = layout.measures[1]!.ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
		expect(midSystem).not.toContain('gClef');
	});

	it('lays out the same as a single system when the score fits within the width', () => {
		const roomy = layoutScore(createDemoScore(), { staffSpacePx: 11, systemWidthPx: 2000 });
		const single = layoutScore(createDemoScore(), { staffSpacePx: 11 });
		expect(roomy.width).toBeCloseTo(single.width, 6);
		expect(roomy.height).toBeCloseTo(single.height, 6);
		expect(roomy.systems).toEqual([{ measureIndices: [0, 1, 2, 3], topY: roomy.staffTopY }]);
		for (let i = 0; i < single.measures.length; i++) {
			expect(roomy.measures[i]!.region).toEqual(single.measures[i]!.region);
		}
	});

	it('keeps single-system layout identical when systemWidthPx is omitted entirely', () => {
		// The option is opt-in: not passing it at all must behave exactly as
		// before this feature existed, one system regardless of score width.
		const layout = layoutScore(createDemoScore(), { staffSpacePx: 11 });
		expect(layout.systems).toEqual([{ measureIndices: [0, 1, 2, 3], topY: layout.staffTopY }]);
	});
});

describe('duration rendering', () => {
	const NOTEHEAD_FOR: Readonly<Record<NoteValue, string>> = {
		whole: 'noteheadWhole',
		half: 'noteheadHalf',
		quarter: 'noteheadBlack',
		eighth: 'noteheadBlack',
		'16th': 'noteheadBlack',
		'32nd': 'noteheadBlack',
		'64th': 'noteheadBlack'
	};
	const REST_FOR: Readonly<Record<NoteValue, string>> = {
		whole: 'restWhole',
		half: 'restHalf',
		quarter: 'restQuarter',
		eighth: 'rest8th',
		'16th': 'rest16th',
		'32nd': 'rest32nd',
		'64th': 'rest64th'
	};
	// C4 sits below the treble staff's middle line, so its stem (and any flag)
	// point up: see `layoutStemAndFlag`'s `up = d < TREBLE_MIDDLE_LINE` rule.
	const FLAG_UP_FOR: Readonly<Partial<Record<NoteValue, string>>> = {
		eighth: 'flag8thUp',
		'16th': 'flag16thUp',
		'32nd': 'flag32ndUp',
		'64th': 'flag64thUp'
	};

	it.each(NOTE_VALUES)('draws the %s notehead, and its flag if it has one', (value) => {
		const layout = layoutScore(buildScore([[['C4', value]]]));
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs).toContain(NOTEHEAD_FOR[value]);
		const flag = FLAG_UP_FOR[value];
		if (flag) expect(glyphs).toContain(flag);
		else expect(glyphs.some((g) => g.startsWith('flag'))).toBe(false);
	});

	it.each(NOTE_VALUES)('draws the %s rest glyph', (value) => {
		const layout = layoutScore(buildScore([[[null, value]]]));
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs).toContain(REST_FOR[value]);
	});

	it.each(NOTE_VALUES)('draws one augmentation dot for a single-dotted %s', (value) => {
		const layout = layoutScore(buildScore([[['C4', value, { dots: 1 }]]]));
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs.filter((g) => g === 'augmentationDot')).toHaveLength(1);
	});

	it.each(NOTE_VALUES)('draws two augmentation dots for a double-dotted %s', (value) => {
		const layout = layoutScore(buildScore([[['C4', value, { dots: 2 }]]]));
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs.filter((g) => g === 'augmentationDot')).toHaveLength(2);
	});

	it('draws a dot after a dotted rest too', () => {
		const layout = layoutScore(buildScore([[[null, 'quarter', { dots: 1 }]]]));
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs.filter((g) => g === 'augmentationDot')).toHaveLength(1);
	});

	it('nudges a dot up into the space above when its note sits on a line', () => {
		// B4 sits on the treble staff's middle line.
		const onLine = layoutScore(buildScore([[['B4', 'quarter', { dots: 1 }]]]));
		const onLineOps = onLine.measures[0]!.ops;
		const onLineHead = onLineOps.find((op) => op.kind === 'glyph' && op.glyph === 'noteheadBlack')!;
		const onLineDot = onLineOps.find((op) => op.kind === 'glyph' && op.glyph === 'augmentationDot')!;
		expect(onLineDot.y).toBeLessThan(onLineHead.y);

		// D4 sits in the leger space below the staff (no leger line of its own,
		// unlike C4 which sits on one), so its dot needs no nudge.
		const inSpace = layoutScore(buildScore([[['D4', 'quarter', { dots: 1 }]]]));
		const inSpaceOps = inSpace.measures[0]!.ops;
		const inSpaceHead = inSpaceOps.find((op) => op.kind === 'glyph' && op.glyph === 'noteheadBlack')!;
		const inSpaceDot = inSpaceOps.find((op) => op.kind === 'glyph' && op.glyph === 'augmentationDot')!;
		expect(inSpaceDot.y).toBeCloseTo(inSpaceHead.y, 6);
	});

	it.each(NOTE_VALUES)('gives a triplet %s two-thirds the spacing of a plain one', (value) => {
		// Not pinning down exact numbers: Phase 1's real optical spacing (Slice 9)
		// replaces the linear-in-duration term this relies on. Only the relative
		// ordering matters here, which is what the demo's triplet measure leans on
		// to render at all: a shorter effective duration must claim less width.
		const straight = layoutScore(buildScore([[['C4', value]]]));
		const triplet = layoutScore(buildScore([[['C4', value, { tuplet: TRIPLET }]]]));
		expect(triplet.measures[0]!.region.width).toBeLessThan(straight.measures[0]!.region.width);
	});

	it('validates both duration-showcase measures against 4/4 capacity', () => {
		// The measures `npm run dev` shows to demonstrate this slice's new
		// durations (see `createDurationShowcaseScore`) are exactly the kind of
		// hand-built literal `validateMeasure` exists to catch a mistake in;
		// this pins down that they are in fact capacity-valid.
		const score = createDurationShowcaseScore();
		for (const measure of score.measures) {
			expect(validateMeasure(measure, score.time).valid).toBe(true);
		}
	});

	it('renders the duration showcase with every new glyph, a dot, and a triplet group', () => {
		const score = createDurationShowcaseScore();
		const layout = layoutScore(score);
		const firstMeasureGlyphs = glyphsOf(layout.measures[0]!.ops);
		expect(firstMeasureGlyphs).toEqual(
			expect.arrayContaining([
				'augmentationDot',
				'flag8thUp',
				'flag16thDown',
				'flag32ndDown',
				'flag64thDown'
			])
		);
		// The second measure is a full bar of quarter-note triplets: six notes,
		// each carrying the triplet ratio, none of them a binary fraction of a
		// beat on its own.
		expect(score.measures[1]!.notes).toHaveLength(6);
		expect(score.measures[1]!.notes.every((n) => n.tuplet !== null)).toBe(true);
	});
});
