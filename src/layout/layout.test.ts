import { describe, expect, it } from 'vitest';
import {
	createAccidentalShowcaseScore,
	createDemoScore,
	createDurationShowcaseScore,
	createTieShowcaseScore
} from '../demo-score.js';
import { buildScore, TRIPLET, validateMeasure, type NoteValue } from '../model/score.js';
import { ENGRAVING_DEFAULTS as ED } from '../render/glyph-metrics.js';
import type { GlyphName } from '../render/glyph-metrics.js';
import { layoutScore, relayoutMeasure } from './layout.js';
import type { DrawOp, LaidOutScore } from './types.js';

const NOTE_VALUES: readonly NoteValue[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];

/** Glyph names an ops list draws, in order, dropping the plain rects. */
const glyphsOf = (ops: readonly DrawOp[]) =>
	ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));

/** The first `glyph` op drawing `name`, narrowed so its `x`/`y` are addressable
 *  (a bare `.find` predicate does not narrow `DrawOp`'s union, and `curve` ops
 *  have no single `x`/`y` for a caller to accidentally read off the wrong kind). */
const findGlyph = (ops: readonly DrawOp[], name: GlyphName) =>
	ops.find((op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === name);

/** The first `curve` op, narrowed the same way `findGlyph` narrows a glyph. */
const findCurve = (ops: readonly DrawOp[]) =>
	ops.find((op): op is Extract<DrawOp, { kind: 'curve' }> => op.kind === 'curve');

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
			// `createDemoScore` has no ties, so this never sees a `curve` op, which
			// has no single x/y (see `DrawOp`'s own comment); narrowing to the two
			// kinds that do is what keeps this generic rather than a fixture fact.
			for (const op of measure.ops.filter((o) => o.kind === 'rect' || o.kind === 'glyph')) {
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
		const onLineHead = findGlyph(onLineOps, 'noteheadBlack')!;
		const onLineDot = findGlyph(onLineOps, 'augmentationDot')!;
		expect(onLineDot.y).toBeLessThan(onLineHead.y);

		// D4 sits in the leger space below the staff (no leger line of its own,
		// unlike C4 which sits on one), so its dot needs no nudge.
		const inSpace = layoutScore(buildScore([[['D4', 'quarter', { dots: 1 }]]]));
		const inSpaceOps = inSpace.measures[0]!.ops;
		const inSpaceHead = findGlyph(inSpaceOps, 'noteheadBlack')!;
		const inSpaceDot = findGlyph(inSpaceOps, 'augmentationDot')!;
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

	it('validates every duration-showcase measure against 4/4 capacity', () => {
		// The measures `npm run dev` shows to demonstrate this slice's new
		// durations (see `createDurationShowcaseScore`) are exactly the kind of
		// hand-built literal `validateMeasure` exists to catch a mistake in;
		// this pins down that they are in fact capacity-valid.
		const score = createDurationShowcaseScore();
		for (const measure of score.measures) {
			expect(validateMeasure(measure, score.time).valid).toBe(true);
		}
	});

	it('renders the duration showcase with every new glyph, a dot, a beam, and a triplet group', () => {
		const score = createDurationShowcaseScore();
		const layout = layoutScore(score);
		const firstMeasureGlyphs = glyphsOf(layout.measures[0]!.ops);
		// The eighth lands alone in its beat (Slice 2's grouping pass, see
		// `computeBeamGroups`) and keeps its individual flag; the 16th/32nd/64th
		// right after it share the next beat and beam together instead, so none
		// of their individual flag glyphs are drawn any more.
		expect(firstMeasureGlyphs).toEqual(expect.arrayContaining(['augmentationDot', 'flag8thUp']));
		expect(
			firstMeasureGlyphs.some(
				(g) => g.startsWith('flag16th') || g.startsWith('flag32nd') || g.startsWith('flag64th')
			)
		).toBe(false);

		// The second measure is a full bar of quarter-note triplets: six notes,
		// each carrying the triplet ratio, none of them a binary fraction of a
		// beat on its own. Quarters are never beam-eligible, so nothing here
		// beams regardless of the triplet grouping.
		expect(score.measures[1]!.notes).toHaveLength(6);
		expect(score.measures[1]!.notes.every((n) => n.tuplet !== null)).toBe(true);

		// The third measure is eight plain eighths, a beat's worth (two notes)
		// at a time: 4/4 groups by the quarter beat, so this beams as four
		// separate two-note beams, not one beam across the whole bar, and draws
		// no flag glyphs at all.
		const thirdMeasureGlyphs = glyphsOf(layout.measures[2]!.ops);
		expect(thirdMeasureGlyphs.some((g) => g.startsWith('flag'))).toBe(false);
	});
});

describe('beaming', () => {
	// A fixed staff space size makes the engraving-default thicknesses below
	// round, distinct numbers instead of whatever `DEFAULTS.staffSpacePx`
	// happens to be, which is what makes identifying a stem/beam rect by exact
	// width/height reliable rather than a fuzzy size heuristic.
	const ss = 10;
	const options = { staffSpacePx: ss };
	const stemWidth = ED.stemThickness * ss;
	const beamHeight = ED.beamThickness * ss;

	const isRect = (op: DrawOp): op is Extract<DrawOp, { kind: 'rect' }> => op.kind === 'rect';

	/** A note's stem: the one rect width that is unique among everything else
	 *  `layoutMeasure` draws (staff lines, ledger lines, barlines, beams all
	 *  use different constants from `ENGRAVING_DEFAULTS`), so this identifies
	 *  a stem regardless of whether it belongs to a beamed group or a single
	 *  note's own flag. */
	const stemRects = (ops: readonly DrawOp[]) =>
		ops.filter(isRect).filter((op) => Math.abs(op.width - stemWidth) < 0.001);

	/** A beam segment: the one rect height unique to beams. Matches every
	 *  level (primary, secondary, ...) and both full segments and beamlet
	 *  stubs, since all of them share the font's one beam thickness. */
	const beamRects = (ops: readonly DrawOp[]) =>
		ops.filter(isRect).filter((op) => Math.abs(op.height - beamHeight) < 0.001);

	// Pitches in this section stay within the staff (E4-F5) and off the key
	// signature's altered steps (C major, the `buildScore` default), so
	// nothing here draws a ledger line or an accidental to complicate the
	// rect/glyph counts above.

	it('beams a pair of eighths sharing a quarter-note beat in 4/4, with no individual flags', () => {
		const layout = layoutScore(buildScore([[['D4', 'eighth'], ['E4', 'eighth']]]), options);
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs.some((g) => g.startsWith('flag'))).toBe(false);
		expect(stemRects(layout.measures[0]!.ops)).toHaveLength(2);
		expect(beamRects(layout.measures[0]!.ops)).toHaveLength(1);
	});

	it('does not beam two eighths that fall in different beats, even with no rest between them', () => {
		// A quarter rest (one full beat) then a dotted eighth rest push the two
		// eighths that follow to start at 0.4375 and 0.5625 wholes: the first is
		// still in beat 1 ([0.25, 0.5)), the second has already crossed into
		// beat 2 ([0.5, 0.75)). Adjacent notes, no rest directly between them,
		// but a beat boundary falls between their start positions, so they must
		// not beam.
		const layout = layoutScore(
			buildScore([[[null, 'quarter'], [null, 'eighth', { dots: 1 }], ['D4', 'eighth'], ['E4', 'eighth']]]),
			options
		);
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs.filter((g) => g.startsWith('flag'))).toHaveLength(2);
		expect(beamRects(layout.measures[0]!.ops)).toHaveLength(0);
		expect(stemRects(layout.measures[0]!.ops)).toHaveLength(2);
	});

	it('groups by the dotted-quarter beat in 6/8, not the eighth', () => {
		// Six eighths in 6/8 form two three-note beams (one per dotted-quarter
		// beat), not six individual flags or one six-note beam across the bar.
		const score = buildScore(
			[[['D4', 'eighth'], ['E4', 'eighth'], ['F4', 'eighth'], ['G4', 'eighth'], ['A4', 'eighth'], ['B4', 'eighth']]],
			{ time: { beats: 6, beatType: 8 } }
		);
		const layout = layoutScore(score, options);
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs.some((g) => g.startsWith('flag'))).toBe(false);
		expect(stemRects(layout.measures[0]!.ops)).toHaveLength(6);
		expect(beamRects(layout.measures[0]!.ops)).toHaveLength(2);
	});

	it('breaks a beam group at a rest, leaving a beamed pair and a singleton', () => {
		// Beat 0: eighth, eighth (beams together). Beat 1: eighth rest, eighth
		// (the rest breaks the group, so the lone eighth after it falls back to
		// its own individual flag rather than beaming with the pair before it).
		const score = buildScore([
			[
				['D4', 'eighth'],
				['E4', 'eighth'],
				[null, 'eighth'],
				['F4', 'eighth'],
				['G4', 'quarter'],
				['A4', 'quarter']
			]
		]);
		const layout = layoutScore(score, options);
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs.filter((g) => g.startsWith('flag'))).toHaveLength(1);
		expect(beamRects(layout.measures[0]!.ops)).toHaveLength(1);
		// Two beamed stems, the singleton eighth's own, and the two trailing
		// quarter notes' stems (quarters always get a stem, just never a flag):
		// five stems total.
		expect(stemRects(layout.measures[0]!.ops)).toHaveLength(5);
	});

	it('gives a mixed eighth/16th group a full-group primary beam and a secondary beam over just the 16ths', () => {
		// One beat: an eighth followed by two 16ths (1/8 + 1/16 + 1/16 = 1/4).
		const score = buildScore([[['D4', 'eighth'], ['E4', '16th'], ['F4', '16th']]]);
		const layout = layoutScore(score, options);
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs.some((g) => g.startsWith('flag'))).toBe(false);
		expect(stemRects(layout.measures[0]!.ops)).toHaveLength(3);
		// Primary beam (all three) plus a secondary beam over the two 16ths.
		expect(beamRects(layout.measures[0]!.ops)).toHaveLength(2);
	});

	it('draws one shared, flat beam for a group straddling the middle line', () => {
		// B4 sits on the middle line itself (down, by the existing single-note
		// split), D5 sits above it (also down); both notes therefore already
		// agree on direction, so this is really checking that the beam comes
		// out flat and shared rather than two independent per-note stems of
		// different lengths landing at different heights.
		const layout = layoutScore(buildScore([[['B4', 'eighth'], ['D5', 'eighth']]]), options);
		const stems = stemRects(layout.measures[0]!.ops);
		expect(stems).toHaveLength(2);
		// A flat beam means both stems reach the same y on the beam side. Down
		// stems hang from the notehead, so the beam is each stem's bottom edge:
		// `y + height`.
		const beamSideY = stems.map((s) => s.y + s.height);
		expect(beamSideY[0]).toBeCloseTo(beamSideY[1]!, 6);
	});
});

describe('stem direction', () => {
	// Same fixed staff space as the beaming suite above, for the same reason:
	// round, distinct stem/beam sizes to key rect assertions off of.
	const ss = 10;
	const options = { staffSpacePx: ss };
	const stemWidth = ED.stemThickness * ss;
	const isRect = (op: DrawOp): op is Extract<DrawOp, { kind: 'rect' }> => op.kind === 'rect';
	const isGlyph = (op: DrawOp): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph';
	const stemRects = (ops: readonly DrawOp[]) =>
		ops.filter(isRect).filter((op) => Math.abs(op.width - stemWidth) < 0.001);
	const headYsOf = (ops: readonly DrawOp[]) =>
		ops
			.filter(isGlyph)
			.filter((op) => op.glyph === 'noteheadBlack')
			.map((op) => op.y);

	// A range of pitches on both sides of the treble staff's middle line (B4),
	// including the on-the-line tie-break case, checked via which flag glyph a
	// lone (unbeamed) eighth note draws: an up-stem note always uses the "Up"
	// flag, a down-stem note the "Down" one.
	const SINGLE_NOTE_DIRECTION: readonly (readonly [string, 'Up' | 'Down'])[] = [
		['C4', 'Up'], // well below the staff, on a ledger line
		['E4', 'Up'], // bottom line
		['G4', 'Up'], // just below the middle line
		['A4', 'Up'], // one step below the middle line
		['B4', 'Down'], // exactly on the middle line: this engine's tie-break
		['C5', 'Down'], // one step above the middle line
		['D5', 'Down'], // just above the middle line
		['F5', 'Down'], // top line
		['A5', 'Down'] // well above the staff, on a ledger line
	];

	it.each(SINGLE_NOTE_DIRECTION)('gives a lone %s an %s-stem', (pitch, direction) => {
		const layout = layoutScore(buildScore([[[pitch, 'eighth']]]), options);
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs).toContain(`flag8th${direction}`);
	});

	it('picks a beamed group\'s farthest note over the group average', () => {
		// G4 sits 2 diatonic steps below the middle line, E5 sits 3 steps above
		// it. Averaging all three positions ((32 + 32 + 37) / 3 = 33.67, below
		// the middle line at 34) would give an up-stem, Slice 2's old rule; the
		// farthest-note rule instead looks only at E5, the single most extreme
		// member, which sits above the line, so the whole group takes a
		// down-stem instead, including the two G4s that would each want an
		// up-stem on their own.
		//
		// Three eighths in a row cross a quarter-note beat boundary in simple
		// meter, which would split the group before the direction rule ever
		// runs, so this uses 6/8 (a dotted-quarter beat) to keep all three in
		// one beam group.
		const score = buildScore(
			[[['G4', 'eighth'], ['G4', 'eighth'], ['E5', 'eighth']]],
			{ time: { beats: 6, beatType: 8 } }
		);
		const layout = layoutScore(score, options);
		const ops = layout.measures[0]!.ops;
		expect(glyphsOf(ops).some((g) => g.startsWith('flag'))).toBe(false);

		const stems = stemRects(ops);
		expect(stems).toHaveLength(3);
		// A down stem hangs from the notehead, so the beam is each stem's
		// bottom edge (`y + height`); asserting every member lands on the same
		// one confirms the direction is uniform across the group, with no
		// per-note flip back to what G4 alone would have chosen.
		const beamSideY = stems.map((s) => s.y + s.height);
		expect(beamSideY[1]).toBeCloseTo(beamSideY[0]!, 6);
		expect(beamSideY[2]).toBeCloseTo(beamSideY[0]!, 6);
		// The beam sits below every notehead in the group: a down-stem group,
		// not an up-stem one.
		expect(beamSideY[0]).toBeGreaterThan(Math.max(...headYsOf(ops)));
	});

	it('breaks a farthest-note tie by majority when both sides are equally far', () => {
		// G4 (2 steps below the middle line) and D5 (2 steps above) tie for
		// farthest, but A4 (1 step below) tips the group's overall majority to
		// the below side, so the whole group takes an up-stem despite the tie.
		const score = buildScore(
			[[['G4', 'eighth'], ['A4', 'eighth'], ['D5', 'eighth']]],
			{ time: { beats: 6, beatType: 8 } }
		);
		const layout = layoutScore(score, options);
		const ops = layout.measures[0]!.ops;
		const stems = stemRects(ops);
		expect(stems).toHaveLength(3);
		// An up stem rises from the notehead, so the beam is each stem's top
		// edge (`y`).
		const beamSideY = stems.map((s) => s.y);
		expect(beamSideY[1]).toBeCloseTo(beamSideY[0]!, 6);
		expect(beamSideY[2]).toBeCloseTo(beamSideY[0]!, 6);
		expect(beamSideY[0]).toBeLessThan(Math.min(...headYsOf(ops)));
	});

	it('falls back to the down-stem convention when farthest and majority both tie', () => {
		// G4 (2 below) and D5 (2 above) are equally far from the middle line in
		// opposite directions: farthest-note is tied, and with one note on each
		// side the majority vote ties too. Both tie-breaks exhausted, the group
		// falls back to the same down-stem convention a single on-the-line note
		// uses.
		const layout = layoutScore(buildScore([[['G4', 'eighth'], ['D5', 'eighth']]]), options);
		const ops = layout.measures[0]!.ops;
		const stems = stemRects(ops);
		expect(stems).toHaveLength(2);
		const beamSideY = stems.map((s) => s.y + s.height);
		expect(beamSideY[1]).toBeCloseTo(beamSideY[0]!, 6);
		expect(beamSideY[0]).toBeGreaterThan(Math.max(...headYsOf(ops)));
	});
});

describe('accidental placement', () => {
	// Same fixed staff space as the beaming/stem-direction suites, for the
	// same reason: round, distinct geometry to key exact-position assertions
	// off of.
	const ss = 10;
	const options = { staffSpacePx: ss };
	const isRect = (op: DrawOp): op is Extract<DrawOp, { kind: 'rect' }> => op.kind === 'rect';
	/** A ledger line rect: the one rect height unique to it among everything
	 *  else `layoutMeasure` draws (staff lines, stems, beams and barlines all
	 *  use different `ENGRAVING_DEFAULTS` constants). */
	const ledgerRects = (ops: readonly DrawOp[]) =>
		ops.filter(isRect).filter((op) => Math.abs(op.height - ED.legerLineThickness * ss) < 0.001);

	it('suppresses a repeated accidental on the same pitch later in the same measure', () => {
		// C major (no sharps): both F-sharps need an accidental the key
		// signature does not supply on its own. The second, an identical
		// pitch restated later in the same measure, should not repeat it.
		const score = buildScore([[['F#5', 'quarter'], ['G4', 'quarter'], ['F#5', 'quarter']]]);
		const layout = layoutScore(score, options);
		const sharps = glyphsOf(layout.measures[0]!.ops).filter((g) => g === 'accidentalSharp');
		expect(sharps).toHaveLength(1);
	});

	it('redraws the accidental whenever the alter actually changes, even back to one already stated', () => {
		// F-sharp, then F-natural, then F-sharp again: each is a change from
		// whatever was last stated for the F step (sharp, then natural), so
		// all three draw their own accidental. The third is not treated as a
		// repeat of the first just because they share a pitch.
		const score = buildScore([[['F#5', 'quarter'], ['F5', 'quarter'], ['F#5', 'quarter']]]);
		const layout = layoutScore(score, options);
		const glyphs = glyphsOf(layout.measures[0]!.ops);
		expect(glyphs.filter((g) => g === 'accidentalSharp')).toHaveLength(2);
		expect(glyphs.filter((g) => g === 'accidentalNatural')).toHaveLength(1);
	});

	it('resets the same-measure carry-over at the next barline', () => {
		// The same altered pitch, restated as the first note of the next
		// measure, is not "later in the same measure": the barline between
		// them resets what is in force for the step, so it draws its own
		// accidental too, rather than the second measure inheriting the
		// first's.
		const score = buildScore([[['F#5', 'quarter']], [['F#5', 'quarter']]]);
		const layout = layoutScore(score, options);
		const sharpsIn = (i: number) =>
			glyphsOf(layout.measures[i]!.ops).filter((g) => g === 'accidentalSharp').length;
		expect(sharpsIn(0)).toBe(1);
		expect(sharpsIn(1)).toBe(1);
	});

	it("pushes a tight accidental right by exactly the minimum clearance past the previous note's ledger line", () => {
		// C4, the shortest duration (a 64th), draws a ledger line one line
		// below the staff and claims barely more horizontal room than that
		// ledger line's own ink reaches: the tightest realistic case this
		// collision check exists for. C-sharp 4 right after it needs a sharp
		// (C major has none), which without the extra clearance would land
		// only about 0.76 staff spaces past the ledger line (worked out from
		// this file's own spacing/glyph constants), short of the 0.9 minimum.
		const score = buildScore([[['C4', '64th'], ['C#4', '64th']]]);
		const layout = layoutScore(score, options);
		const ops = layout.measures[0]!.ops;

		// Both notes sit on the same ledger-line position (a sharp does not
		// move a note on the staff), so there are two rects here, one per
		// note; the leftmost belongs to C4, the one this accidental must
		// clear.
		const ledgers = ledgerRects(ops).slice().sort((a, b) => a.x - b.x);
		expect(ledgers.length).toBeGreaterThanOrEqual(1);
		const ledgerRight = ledgers[0]!.x + ledgers[0]!.width;

		const accidental = findGlyph(ops, 'accidentalSharp')!;
		// The shift closes the gap to exactly the minimum rather than
		// over-padding it.
		expect(accidental.x - ledgerRight).toBeCloseTo(0.9 * ss, 5);
	});

	it('validates every accidental-showcase measure against 4/4 capacity', () => {
		// Same discipline as the duration showcase: the hand-built measures
		// `npm run dev` shows for this slice are exactly the kind of mistake
		// `validateMeasure` exists to catch.
		const score = createAccidentalShowcaseScore();
		for (const measure of score.measures) {
			expect(validateMeasure(measure, score.time).valid).toBe(true);
		}
	});

	it('renders the accidental showcase with repeat suppression, the reverting case, and collision clearance', () => {
		const score = createAccidentalShowcaseScore();
		const layout = layoutScore(score);

		// Measure 1: F-sharp, F-sharp (suppressed), F-natural, F-sharp again.
		// Two sharps and one natural, not three sharps.
		const firstMeasureGlyphs = glyphsOf(layout.measures[0]!.ops);
		expect(firstMeasureGlyphs.filter((g) => g === 'accidentalSharp')).toHaveLength(2);
		expect(firstMeasureGlyphs.filter((g) => g === 'accidentalNatural')).toHaveLength(1);

		// Measure 2: the tight C4/C-sharp-4 pair draws exactly one sharp, and
		// (this measure's whole point) it does not throw or silently overlap;
		// the geometry itself is pinned down by the collision-clearance test
		// above, using the same pair built directly rather than through this
		// showcase.
		const secondMeasureGlyphs = glyphsOf(layout.measures[1]!.ops);
		expect(secondMeasureGlyphs.filter((g) => g === 'accidentalSharp')).toHaveLength(1);
	});
});

describe('ties', () => {
	const curvesOf = (ops: readonly DrawOp[]) => ops.filter((op) => op.kind === 'curve');

	it('draws one curve for a tie fully contained in a measure', () => {
		const score = buildScore([
			[
				['C4', 'quarter', { tiedToNext: true }],
				['C4', 'quarter'],
				['D4', 'half']
			]
		]);
		const layout = layoutScore(score);
		const ops = layout.measures[0]!.ops;
		expect(curvesOf(ops)).toHaveLength(1);
		const curve = findCurve(ops)!;
		// Same pitch, so the curve returns to the same height at both ends.
		expect(curve.y0).toBeCloseTo(curve.y1, 6);
		expect(curve.x0).toBeLessThan(curve.x1);
	});

	it('draws two independent halves for a tie crossing a barline', () => {
		const score = buildScore([
			[
				['C4', 'half'],
				['C4', 'half', { tiedToNext: true }]
			],
			[['C4', 'whole']]
		]);
		const layout = layoutScore(score);
		const first = layout.measures[0]!;
		const second = layout.measures[1]!;

		// One half per measure, not a single curve reaching across the barline:
		// that split is what keeps each measure's ops self-contained for
		// region-scoped redraw (see the tie pass's own comment in layout.ts).
		expect(curvesOf(first.ops)).toHaveLength(1);
		expect(curvesOf(second.ops)).toHaveLength(1);

		const outgoing = findCurve(first.ops)!;
		const incoming = findCurve(second.ops)!;

		// The outgoing half ends inside measure 0's own region (at its barline);
		// the incoming half starts inside measure 1's own region (at its left
		// edge). Neither reaches into the other measure's band.
		expect(outgoing.x1).toBeLessThanOrEqual(first.region.x + first.region.width + 0.001);
		expect(outgoing.x1).toBeGreaterThanOrEqual(first.region.x);
		expect(incoming.x0).toBeGreaterThanOrEqual(second.region.x - 0.001);
		expect(incoming.x0).toBeLessThanOrEqual(second.region.x + second.region.width);

		// Both notes are C4 in the same system, so the two halves meet at the
		// same height even though each was computed from only its own note.
		expect(outgoing.y0).toBeCloseTo(incoming.y1, 6);
	});

	it('curves below a stem-up note and above a stem-down note', () => {
		// C4 sits well below the treble staff's middle line: an up stem, so the
		// tie curves below (a larger canvas y).
		const low = layoutScore(
			buildScore([[['C4', 'quarter', { tiedToNext: true }], ['C4', 'quarter']]])
		);
		const lowCurve = findCurve(low.measures[0]!.ops)!;
		expect(lowCurve.cy0).toBeGreaterThan(lowCurve.y0);
		expect(lowCurve.cy1).toBeGreaterThan(lowCurve.y1);

		// A5 sits well above the middle line: a down stem, so the tie curves
		// above (a smaller canvas y).
		const high = layoutScore(
			buildScore([[['A5', 'quarter', { tiedToNext: true }], ['A5', 'quarter']]])
		);
		const highCurve = findCurve(high.measures[0]!.ops)!;
		expect(highCurve.cy0).toBeLessThan(highCurve.y0);
		expect(highCurve.cy1).toBeLessThan(highCurve.y1);
	});

	it('keeps a tie curve inside its own measure region', () => {
		const score = buildScore([[['C4', 'quarter', { tiedToNext: true }], ['C4', 'quarter']]]);
		const layout = layoutScore(score);
		const measure = layout.measures[0]!;
		const curve = findCurve(measure.ops)!;
		for (const y of [curve.y0, curve.cy0, curve.cy1, curve.y1]) {
			expect(y).toBeGreaterThanOrEqual(measure.region.y - 0.001);
			expect(y).toBeLessThanOrEqual(measure.region.y + measure.region.height + 0.001);
		}
	});

	it('survives relayoutMeasure re-laying out its own measure incrementally', () => {
		// Because the tie pass lives inside `layoutMeasure` itself rather than a
		// separate whole-score pass, `relayoutMeasure` (which calls exactly that
		// function) recomputes a measure's ties for free on an incremental edit,
		// with no extra plumbing. Transposing the untied D4 here is a same-
		// measure edit that leaves the tied C4 pair itself untouched.
		const score = buildScore([
			[
				['C4', 'quarter', { tiedToNext: true }],
				['C4', 'quarter'],
				['D4', 'quarter'],
				['E4', 'quarter']
			]
		]);
		const layout = layoutScore(score);
		const target = score.measures[0]!.notes[2]!;
		const touched = score.transposeNote(target.id, 1);
		const updated = relayoutMeasure(score, layout, touched!);
		expect(updated).not.toBeNull();
		expect(curvesOf(updated!.measures[0]!.ops)).toHaveLength(1);
	});

	it('renders the tie showcase, valid measures and all', () => {
		const score = createTieShowcaseScore();
		for (const measure of score.measures) {
			expect(validateMeasure(measure, score.time).valid).toBe(true);
		}
		const layout = layoutScore(score);
		// Measure 0: one curve, the same-measure D5 tie. Measure 1: one curve,
		// the outgoing half of the F#5 tie into measure 2. Measure 2: one
		// curve, that tie's incoming half.
		expect(curvesOf(layout.measures[0]!.ops)).toHaveLength(1);
		expect(curvesOf(layout.measures[1]!.ops)).toHaveLength(1);
		expect(curvesOf(layout.measures[2]!.ops)).toHaveLength(1);
	});
});
