import { describe, expect, it } from 'vitest';
import {
	createAccidentalShowcaseScore,
	createBarlineShowcaseScore,
	createDemoScore,
	createDurationShowcaseScore,
	createKeyTimeChangeShowcaseScore,
	createSlurShowcaseScore,
	createTieShowcaseScore,
	createTwoVoiceShowcaseScore,
	createVoiceClashShowcaseScore
} from '../demo-score.js';
import { buildScore, TRIPLET, validateMeasure, type NoteValue } from '../model/score.js';
import { ENGRAVING_DEFAULTS as ED, GLYPH_METRICS } from '../render/glyph-metrics.js';
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
		const options = { staffSpacePx: 11, systemWidthPx: 700 };
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
	const options = { staffSpacePx: 11, systemWidthPx: 700 };

	it('casts measures off onto a new system once they would overflow the width', () => {
		const layout = layoutScore(createDemoScore(), options);
		expect(layout.systems.map((s) => s.measureIndices)).toEqual([
			[0, 1],
			[2, 3]
		]);
		// Every measure still appears exactly once, in score order, across systems.
		expect(layout.systems.flatMap((s) => s.measureIndices)).toEqual([0, 1, 2, 3]);
		// The first system is justified (stretched to fill the width budget);
		// the score's own last system never is (see `systemSpacingScale`'s own
		// comment on why a piece's final line stays at its natural width).
		expect(layout.systems[0]!.spacingScale).toBeGreaterThan(1);
		expect(layout.systems[1]!.spacingScale).toBe(1);
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
		expect(roomy.systems.map((s) => s.measureIndices)).toEqual([[0, 1, 2, 3]]);
		// The whole score fits in one system, which is therefore also the
		// score's last, so it stays at natural (unjustified) spacing.
		expect(roomy.systems[0]!.spacingScale).toBe(1);
		for (let i = 0; i < single.measures.length; i++) {
			expect(roomy.measures[i]!.region).toEqual(single.measures[i]!.region);
		}
	});

	it('keeps single-system layout identical when systemWidthPx is omitted entirely', () => {
		// The option is opt-in: not passing it at all must behave exactly as
		// before this feature existed, one system regardless of score width.
		const layout = layoutScore(createDemoScore(), { staffSpacePx: 11 });
		expect(layout.systems.map((s) => s.measureIndices)).toEqual([[0, 1, 2, 3]]);
		expect(layout.systems[0]!.spacingScale).toBe(1);
	});
});

describe('note spacing (Slice 9: optical spacing curve)', () => {
	// Isolates one note's own horizontal advance from a measure's fixed
	// overhead (clef, key, time signature, lead-in/trail-out, barline ink): the
	// difference between a measure holding two notes of `value` and one
	// holding just one is exactly the second note's own advance, since both
	// measures share every other component identically. Robust to whether the
	// pair happens to fall into one beam group or not: a beamed note's own
	// advance is computed the same way as an unbeamed one's (see `layoutNote`),
	// beaming only changes how its stem is drawn, not how much horizontal room
	// it claims.
	const noteAdvancePx = (value: NoteValue) => {
		const one = layoutScore(buildScore([[['C4', value]]])).measures[0]!.region.width;
		const two = layoutScore(buildScore([[['C4', value], ['C4', value]]])).measures[0]!.region.width;
		return two - one;
	};

	it('grows monotonically with duration', () => {
		// NOTE_VALUES is ordered longest ('whole') to shortest ('64th'); each
		// value's own advance should be strictly less than the one before it.
		const advances = NOTE_VALUES.map(noteAdvancePx);
		for (let i = 1; i < advances.length; i++) {
			expect(advances[i]!).toBeLessThan(advances[i - 1]!);
		}
	});

	it("grows sub-linearly: a whole note's room is nowhere near 8x an eighth note's", () => {
		const whole = noteAdvancePx('whole');
		const eighth = noteAdvancePx('eighth');
		// A whole note lasts 8 times as long as an eighth. The naive linear-
		// in-duration model this slice replaces would give it 8x the room; the
		// log-based curve (`noteAdvanceSpaces`) instead adds a constant
		// increment of space per *doubling* of duration, so real growth is far
		// shallower: still strictly more room (longer notes are not cramped),
		// but comfortably under even a generous 3-4x allowance.
		expect(whole).toBeGreaterThan(eighth);
		expect(whole).toBeLessThan(eighth * 4);
	});

	it("gives a tripleted 64th (the model's shortest reachable duration) strictly less room than a plain one", () => {
		// The one case the curve's reference point (`noteSpaceReferenceWholes`,
		// a plain 64th) sits *above*: a triplet shortens even the shortest
		// plain value. Worth its own assertion since a naive implementation
		// that clamps the log term at zero (floors every sub-reference
		// duration to the same space) would fail this, and this file's own
		// constants comment explains why that clamp was deliberately not done.
		const plain = noteAdvancePx('64th');
		const tripleted = layoutScore(buildScore([[['C4', '64th', { tuplet: TRIPLET }]]])).measures[0]!.region
			.width;
		const plainSingle = layoutScore(buildScore([[['C4', '64th']]])).measures[0]!.region.width;
		expect(tripleted).toBeLessThan(plainSingle);
		expect(plain).toBeGreaterThan(0);
	});
});

describe('justification (Slice 9: fill a system width)', () => {
	it("stretches a justified system's measures to fill systemWidthPx exactly", () => {
		const options = { staffSpacePx: 11, systemWidthPx: 700 };
		const layout = layoutScore(createDemoScore(), options);
		// System 0 ([0, 1], see the multi-system tests above) is not the score's
		// last system, so `systemSpacingScale` justifies it: its own measures'
		// combined span should reach exactly the system's width budget, and
		// since it is also this score's widest system at this width, the whole
		// layout's declared `width` should land on `systemWidthPx` itself.
		expect(layout.width).toBeCloseTo(options.systemWidthPx, 1);

		// `layout.width` already proves the fill; this additionally confirms it
		// is system 0 specifically (not some coincidence of the last system)
		// that reaches the budget. Every measure starts at the same left
		// margin (see the multi-system test above), so that margin doubles as
		// the right-hand margin `layout.width` reserves too.
		const system0 = layout.measures.filter((m) => layout.systems[0]!.measureIndices.includes(m.index));
		const leftEdge = Math.min(...system0.map((m) => m.region.x));
		const rightEdge = Math.max(...system0.map((m) => m.region.x + m.region.width));
		expect(rightEdge - leftEdge).toBeCloseTo(options.systemWidthPx - 2 * leftEdge, 1);

		// The score's last system ([2, 3]) is never justified: its natural
		// width is left alone rather than stretched to match.
		const system1 = layout.measures.filter((m) => layout.systems[1]!.measureIndices.includes(m.index));
		const system1Span =
			Math.max(...system1.map((m) => m.region.x + m.region.width)) -
			Math.min(...system1.map((m) => m.region.x));
		expect(system1Span).toBeLessThan(rightEdge - leftEdge);
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
		// Not pinning down exact numbers: only the relative ordering matters
		// here, which is what the demo's triplet measure leans on to render
		// at all: a shorter effective duration must claim less width. This
		// holds even at '64th', this model's shortest plain value, since
		// Slice 9's log-based curve (`noteAdvanceSpaces`) deliberately lets a
		// tripleted duration compute a small *negative* log term rather than
		// clamping it to the same floor a plain 64th gets; see
		// `noteSpaceReferenceWholes`'s own comment on why, and the dedicated
		// "note spacing" test above that pins this exact case down.
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
		// below the staff, and its own natural advance (Slice 9's log curve
		// floors a 64th at just `noteSpaceBase`, 2 staff spaces) is actually
		// *narrower* than that ledger line's own ink: the tightest realistic
		// case this collision check exists for. C-sharp 4 right after it needs
		// a sharp (C major has none), which without the extra clearance would
		// land about 0.38 staff spaces to the *left* of the ledger line's own
		// right edge, i.e. genuinely overlapping it (worked out from this
		// file's own spacing/glyph constants), not merely short of the 0.9
		// minimum.
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

describe('slurs', () => {
	const curvesOf = (ops: readonly DrawOp[]) => ops.filter((op) => op.kind === 'curve');

	it('draws one curve for a slur spanning several notes within a measure', () => {
		const score = buildScore(
			[
				[
					['G4', 'eighth'],
					['A4', 'eighth'],
					['B4', 'eighth'],
					['C5', 'eighth'],
					[null, 'half']
				]
			],
			{},
			[{ start: [0, 0], end: [0, 3] }]
		);
		const layout = layoutScore(score);
		const ops = layout.measures[0]!.ops;
		expect(curvesOf(ops)).toHaveLength(1);
		const curve = findCurve(ops)!;

		// The curve starts clear of the first note (G4) and ends clear of the
		// last (C5), not glued to either notehead: strictly to the right of
		// G4's own bounds and strictly to the left of C5's.
		const g4 = layout.measures[0]!.notes[0]!;
		const c5 = layout.measures[0]!.notes[3]!;
		expect(curve.x0).toBeGreaterThan(g4.bounds.x + g4.bounds.width);
		expect(curve.x1).toBeLessThan(c5.bounds.x);
		expect(curve.x0).toBeLessThan(curve.x1);
	});

	it('curves below the majority stem direction: below when the spanned notes sit under the middle line', () => {
		// G4, A4, B4 (middle line), C5: G4 is farthest from the middle line and
		// sits below it, so the shared direction is up-stem and the slur curves
		// below (a larger canvas y at its control points than its endpoints).
		const score = buildScore(
			[[['G4', 'eighth'], ['A4', 'eighth'], ['B4', 'eighth'], ['C5', 'eighth'], [null, 'half']]],
			{},
			[{ start: [0, 0], end: [0, 3] }]
		);
		const layout = layoutScore(score);
		const curve = findCurve(layout.measures[0]!.ops)!;
		expect(curve.cy0).toBeGreaterThan(curve.y0);
		expect(curve.cy1).toBeGreaterThan(curve.y1);
	});

	it('curves above the majority stem direction: above when the spanned notes sit over the middle line', () => {
		// G5 is farthest from the middle line and sits above it, so the shared
		// direction is down-stem and the slur curves above (a smaller canvas y).
		const score = buildScore(
			[[['C5', 'eighth'], ['D5', 'eighth'], ['E5', 'eighth'], ['G5', 'eighth'], [null, 'half']]],
			{},
			[{ start: [0, 0], end: [0, 3] }]
		);
		const layout = layoutScore(score);
		const curve = findCurve(layout.measures[0]!.ops)!;
		expect(curve.cy0).toBeLessThan(curve.y0);
		expect(curve.cy1).toBeLessThan(curve.y1);
	});

	it('splits a slur crossing a barline into two segments that meet at the same roof height', () => {
		const score = buildScore(
			[
				[
					['C4', 'quarter'],
					['D4', 'quarter'],
					['E4', 'quarter'],
					['F4', 'quarter']
				],
				[
					['G4', 'quarter'],
					['A4', 'quarter'],
					['B4', 'half']
				]
			],
			{},
			[{ start: [0, 3], end: [1, 1] }]
		);
		const layout = layoutScore(score);
		const first = layout.measures[0]!;
		const second = layout.measures[1]!;

		expect(curvesOf(first.ops)).toHaveLength(1);
		expect(curvesOf(second.ops)).toHaveLength(1);

		const outgoing = findCurve(first.ops)!;
		const incoming = findCurve(second.ops)!;

		// The outgoing half stays inside measure 0's own region; the incoming
		// half starts at measure 1's own left edge, never reaching backwards
		// into measure 0's band, same discipline the tie pass already follows.
		expect(outgoing.x1).toBeLessThanOrEqual(first.region.x + first.region.width + 0.001);
		expect(incoming.x0).toBeGreaterThanOrEqual(second.region.x - 0.001);

		// Both halves are computed from the same whole-slur `spanNotes`, so
		// they land on the same "roof" height at the barline even though each
		// was laid out from only its own measure's notes.
		expect(outgoing.y1).toBeCloseTo(incoming.y0, 6);
	});

	it('draws a flat pass-through segment in a measure holding neither of the slur\'s two ends', () => {
		const score = buildScore(
			[
				[['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter'], ['F4', 'quarter']],
				[['G4', 'quarter'], ['A4', 'quarter'], ['B4', 'quarter'], ['C5', 'quarter']],
				[['D5', 'quarter'], ['E5', 'quarter'], ['F5', 'quarter'], ['G5', 'quarter']]
			],
			{},
			[{ start: [0, 0], end: [2, 3] }]
		);
		const layout = layoutScore(score);
		const [m0, m1, m2] = layout.measures;

		expect(curvesOf(m0!.ops)).toHaveLength(1);
		expect(curvesOf(m1!.ops)).toHaveLength(1);
		expect(curvesOf(m2!.ops)).toHaveLength(1);

		// Measure 1 holds neither end: its segment runs the full width of its
		// own region, and being a pure pass-through, both its true endpoints
		// are the same "roof" height (a flat shelf, not an arch of its own).
		const middle = findCurve(m1!.ops)!;
		expect(middle.x0).toBeCloseTo(m1!.region.x, 6);
		expect(middle.x1).toBeGreaterThan(middle.x0);
		expect(middle.y0).toBeCloseTo(middle.y1, 6);
	});

	it('keeps a slur curve inside its own measure region', () => {
		const score = buildScore(
			[[['G4', 'eighth'], ['A4', 'eighth'], ['B4', 'eighth'], ['C5', 'eighth'], [null, 'half']]],
			{},
			[{ start: [0, 0], end: [0, 3] }]
		);
		const layout = layoutScore(score);
		const measure = layout.measures[0]!;
		const curve = findCurve(measure.ops)!;
		for (const y of [curve.y0, curve.cy0, curve.cy1, curve.y1]) {
			expect(y).toBeGreaterThanOrEqual(measure.region.y - 0.001);
			expect(y).toBeLessThanOrEqual(measure.region.y + measure.region.height + 0.001);
		}
	});

	it('survives relayoutMeasure re-laying out its own measure incrementally', () => {
		const score = buildScore(
			[
				[
					['G4', 'eighth'],
					['A4', 'eighth'],
					['B4', 'eighth'],
					['C5', 'eighth'],
					['D5', 'quarter'],
					['E5', 'quarter']
				]
			],
			{},
			[{ start: [0, 0], end: [0, 3] }]
		);
		const layout = layoutScore(score);
		// Transpose the last, unslurred note: a same-measure edit that leaves
		// the slurred run itself untouched, the same shape as the ties test
		// this one is modelled on.
		const target = score.measures[0]!.notes[5]!;
		const touched = score.transposeNote(target.id, 1);
		const updated = relayoutMeasure(score, layout, touched!);
		expect(updated).not.toBeNull();
		expect(curvesOf(updated!.measures[0]!.ops)).toHaveLength(1);
	});

	it('renders the slur showcase, valid measures and all', () => {
		const score = createSlurShowcaseScore();
		for (const measure of score.measures) {
			expect(validateMeasure(measure, score.time).valid).toBe(true);
		}
		const layout = layoutScore(score);
		// Measure 0: two curves (the single-measure G4..C5 slur, plus the
		// outgoing half of the D5->G5 slur). Measure 1: one curve, that
		// second slur's incoming half.
		expect(curvesOf(layout.measures[0]!.ops)).toHaveLength(2);
		expect(curvesOf(layout.measures[1]!.ops)).toHaveLength(1);
	});
});

describe('key and time changes', () => {
	it('draws the new key signature in full at the measure where the key changes, no clef repeated', () => {
		const score = buildScore(
			[
				[['G4', 'quarter']],
				{ notes: [['G4', 'quarter']], keyFifths: 2 } // G major (1 sharp) -> D major (2 sharps)
			],
			{ keyFifths: 1 }
		);
		const layout = layoutScore(score);
		const firstGlyphs = glyphsOf(layout.measures[0]!.ops);
		expect(firstGlyphs.filter((g) => g === 'accidentalSharp')).toHaveLength(1);

		const changeGlyphs = glyphsOf(layout.measures[1]!.ops);
		// D major's full two-sharp signature is restated, not just the newly
		// added C#: a courtesy signature is always the whole new key, the same
		// as the score's very first measure states a whole key from nothing.
		expect(changeGlyphs.filter((g) => g === 'accidentalSharp')).toHaveLength(2);
		expect(changeGlyphs).not.toContain('accidentalNatural'); // nothing dropped, nothing to cancel
		expect(changeGlyphs).not.toContain('gClef'); // this measure does not open a system
	});

	it('cancels a dropped accidental with a natural when the key change removes it', () => {
		const score = buildScore(
			[
				[['G4', 'quarter']],
				{ notes: [['G4', 'quarter']], keyFifths: 0 } // G major (F#) -> C major (no sharps)
			],
			{ keyFifths: 1 }
		);
		const layout = layoutScore(score);
		// C major itself draws no accidentals of its own, so the only key-
		// signature glyph the change measure needs is the natural cancelling
		// the old F#; the note's own head is the only other glyph it draws.
		const changeGlyphs = glyphsOf(layout.measures[1]!.ops);
		expect(changeGlyphs.filter((g) => g === 'accidentalNatural')).toHaveLength(1);
		expect(changeGlyphs.filter((g) => g === 'accidentalSharp')).toHaveLength(0);
	});

	it('cancels only the dropped accidental, not one the new key still shares', () => {
		// D major (F#, C#) -> G major (F#): F# carries straight over and needs
		// no natural; only C# is dropped and needs cancelling.
		const score = buildScore(
			[
				[['G4', 'quarter']],
				{ notes: [['G4', 'quarter']], keyFifths: 1 }
			],
			{ keyFifths: 2 }
		);
		const layout = layoutScore(score);
		const changeGlyphs = glyphsOf(layout.measures[1]!.ops);
		expect(changeGlyphs.filter((g) => g === 'accidentalNatural')).toHaveLength(1);
		expect(changeGlyphs.filter((g) => g === 'accidentalSharp')).toHaveLength(1); // G major's own F#
	});

	it('draws the new time signature at the measure where the time changes', () => {
		const score = buildScore([
			[
				['C4', 'quarter'],
				['D4', 'quarter'],
				['E4', 'quarter'],
				['F4', 'quarter']
			],
			{
				notes: [
					['C4', 'quarter'],
					['D4', 'quarter'],
					['E4', 'quarter']
				],
				time: { beats: 3, beatType: 4 }
			}
		]);
		const layout = layoutScore(score);
		expect(glyphsOf(layout.measures[0]!.ops)).toContain('timeSig4');
		const changeGlyphs = glyphsOf(layout.measures[1]!.ops);
		expect(changeGlyphs).toContain('timeSig3');
		expect(changeGlyphs).toContain('timeSig4');
	});

	it('draws both a courtesy key and time signature when both change at the same measure', () => {
		const score = buildScore(
			[
				[
					['G4', 'quarter'],
					['A4', 'quarter'],
					['B4', 'quarter'],
					['C5', 'quarter']
				],
				{
					keyFifths: 2,
					time: { beats: 3, beatType: 4 },
					notes: [
						['D5', 'quarter'],
						['E5', 'quarter'],
						['F#5', 'quarter']
					]
				}
			],
			{ keyFifths: 1 }
		);
		const layout = layoutScore(score);
		const changeGlyphs = glyphsOf(layout.measures[1]!.ops);
		expect(changeGlyphs.filter((g) => g === 'accidentalSharp')).toHaveLength(2);
		expect(changeGlyphs).toContain('timeSig3');
	});

	it('does not restate a courtesy signature at a later measure with no change of its own', () => {
		const score = buildScore(
			[[['G4', 'quarter']], { notes: [['G4', 'quarter']], keyFifths: 2 }, [['G4', 'quarter']]],
			{ keyFifths: 1 }
		);
		const layout = layoutScore(score);
		// Measure 2 is neither a system's first measure nor a change of its
		// own, so it draws no clef, key or time glyph at all, only its one note.
		expect(glyphsOf(layout.measures[2]!.ops)).toEqual(['noteheadBlack']);
	});

	it('still shows the changed key (and clef) when the change lands on a new system\'s own first measure', () => {
		// An unreasonably tight budget forces every measure onto its own
		// system, so measure 1 (the key change) also happens to open a system:
		// exactly the case the existing "repeat key at system start" logic has
		// to get right once the key it repeats can itself have just changed.
		const score = buildScore(
			[
				[['G4', 'half'], ['A4', 'half']],
				{ notes: [['G4', 'half'], ['A4', 'half']], keyFifths: 2 }
			],
			{ keyFifths: 1 }
		);
		const layout = layoutScore(score, { staffSpacePx: 11, systemWidthPx: 1 });
		expect(layout.systems[1]!.measureIndices).toEqual([1]);
		const glyphs = glyphsOf(layout.measures[1]!.ops);
		expect(glyphs).toContain('gClef');
		expect(glyphs.filter((g) => g === 'accidentalSharp')).toHaveLength(2);
	});

	it('groups beams by the new time signature after a mid-score change', () => {
		// Six eighths under 4/4's simple quarter beat form three two-note
		// beams; the same six eighths under 6/8's compound dotted-quarter beat
		// form two three-note beams instead.
		const ss = 10;
		const beamHeight = ED.beamThickness * ss;
		const isRect = (op: DrawOp): op is Extract<DrawOp, { kind: 'rect' }> => op.kind === 'rect';
		const beamRects = (ops: readonly DrawOp[]) =>
			ops.filter(isRect).filter((op) => Math.abs(op.height - beamHeight) < 0.001);

		const sixEighths: readonly (readonly [string, NoteValue])[] = [
			['D4', 'eighth'],
			['E4', 'eighth'],
			['F4', 'eighth'],
			['G4', 'eighth'],
			['A4', 'eighth'],
			['B4', 'eighth']
		];
		const score = buildScore(
			[[...sixEighths], { notes: [...sixEighths], time: { beats: 6, beatType: 8 } }],
			{ time: { beats: 4, beatType: 4 } }
		);
		const layout = layoutScore(score, { staffSpacePx: ss });
		expect(beamRects(layout.measures[0]!.ops)).toHaveLength(3);
		expect(beamRects(layout.measures[1]!.ops)).toHaveLength(2);
	});

	it('renders the key/time-change showcase, valid measures and all', () => {
		const score = createKeyTimeChangeShowcaseScore();
		for (const measure of score.measures) {
			expect(validateMeasure(measure, score.timeAt(measure.index)).valid).toBe(true);
		}
		const layout = layoutScore(score);
		// Measure 1 is the key change (D major, 2 sharps); measure 3 is the
		// time change (3/4).
		expect(glyphsOf(layout.measures[1]!.ops).filter((g) => g === 'accidentalSharp')).toHaveLength(2);
		expect(glyphsOf(layout.measures[3]!.ops)).toContain('timeSig3');
	});
});

describe('barline types', () => {
	// Every barline rect (thin or thick) spans the full staff height, `4 * ss`;
	// nothing else drawn (staff lines, ledger lines, stems, beams) shares that
	// height, so filtering on it isolates barline ink from everything else a
	// measure draws without having to know any barline's x position up front.
	const ss = 10;
	const isBarlineRect = (op: DrawOp): op is Extract<DrawOp, { kind: 'rect' }> =>
		op.kind === 'rect' && Math.abs(op.height - 4 * ss) < 0.001;
	const barlineRects = (ops: readonly DrawOp[]) => ops.filter(isBarlineRect);
	const repeatDots = (ops: readonly DrawOp[]) =>
		ops.filter((op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === 'repeatDot');

	it('draws a normal barline as a single thin line', () => {
		const score = buildScore([[['G4', 'quarter']], [['G4', 'quarter']], [['G4', 'quarter']]]);
		const layout = layoutScore(score, { staffSpacePx: ss });
		// Measure 0's own end (mid-score) defaults to 'normal': exactly one line.
		const bars = barlineRects(layout.measures[0]!.ops);
		expect(bars).toHaveLength(1);
		expect(bars[0]!.width).toBeCloseTo(ED.thinBarlineThickness * ss, 6);
	});

	it('draws a double barline as two thin lines close together', () => {
		const score = buildScore([
			{ notes: [['G4', 'quarter']], endBarline: 'double' },
			[['G4', 'quarter']]
		]);
		const layout = layoutScore(score, { staffSpacePx: ss });
		const bars = barlineRects(layout.measures[0]!.ops).sort((a, b) => a.x - b.x);
		expect(bars).toHaveLength(2);
		expect(bars[0]!.width).toBeCloseTo(ED.thinBarlineThickness * ss, 6);
		expect(bars[1]!.width).toBeCloseTo(ED.thinBarlineThickness * ss, 6);
		// The gap between them is the font's own recommended separation, the
		// same spacing a final barline's thin-then-thick pair already uses.
		const gap = bars[1]!.x - (bars[0]!.x + bars[0]!.width);
		expect(gap).toBeCloseTo(ED.barlineSeparation * ss, 6);
	});

	it('draws a final barline as thin-then-thick, reachable both automatically and explicitly', () => {
		// Automatic: the score's true last measure, no annotation at all.
		const automatic = layoutScore(buildScore([[['G4', 'quarter']]]), { staffSpacePx: ss });
		// Explicit: the same shape, requested by name.
		const explicit = layoutScore(
			buildScore([{ notes: [['G4', 'quarter']], endBarline: 'final' }]),
			{ staffSpacePx: ss }
		);
		for (const layout of [automatic, explicit]) {
			const bars = barlineRects(layout.measures[0]!.ops).sort((a, b) => a.x - b.x);
			expect(bars).toHaveLength(2);
			expect(bars[0]!.width).toBeCloseTo(ED.thinBarlineThickness * ss, 6);
			expect(bars[1]!.width).toBeCloseTo(ED.thickBarlineThickness * ss, 6);
			// The thick line is the outer (rightmost) one, same as before this
			// slice's ctx.isLast-only version of this shape.
			expect(bars[1]!.x).toBeGreaterThan(bars[0]!.x);
		}
	});

	it('an explicit endBarline on the last measure overrides the automatic final default', () => {
		const layout = layoutScore(
			buildScore([{ notes: [['G4', 'quarter']], endBarline: 'double' }]),
			{ staffSpacePx: ss }
		);
		const bars = barlineRects(layout.measures[0]!.ops).sort((a, b) => a.x - b.x);
		expect(bars).toHaveLength(2);
		expect(bars[0]!.width).toBeCloseTo(ED.thinBarlineThickness * ss, 6);
		expect(bars[1]!.width).toBeCloseTo(ED.thinBarlineThickness * ss, 6); // both thin, not final's thin+thick
	});

	it('draws a repeatEnd as two dots then a thick line', () => {
		const score = buildScore([
			{ notes: [['G4', 'quarter']], endBarline: 'repeatEnd' },
			[['G4', 'quarter']]
		]);
		const layout = layoutScore(score, { staffSpacePx: ss });
		const ops = layout.measures[0]!.ops;
		const bars = barlineRects(ops);
		expect(bars).toHaveLength(1);
		expect(bars[0]!.width).toBeCloseTo(ED.thickBarlineThickness * ss, 6);
		const dots = repeatDots(ops);
		expect(dots).toHaveLength(2);
		// Both dots sit left of (before) the thick line, and at the same x as
		// each other: two dots stacked vertically, not side by side.
		for (const dot of dots) expect(dot.x).toBeLessThan(bars[0]!.x);
		expect(dots[0]!.x).toBeCloseTo(dots[1]!.x, 6);
		// One dot in the staff space above the middle line, one below, straddling it.
		const middleY = layout.staffTopY + 2 * ss;
		expect(Math.min(dots[0]!.y, dots[1]!.y)).toBeCloseTo(middleY - ss / 2, 6);
		expect(Math.max(dots[0]!.y, dots[1]!.y)).toBeCloseTo(middleY + ss / 2, 6);
	});

	it('draws a repeatStart as a thick line then two dots, at the measure it opens', () => {
		// A third measure keeps measure 1 from also being the score's true last
		// measure, which would otherwise add its own automatic 'final' pair at
		// its *end* on top of the 'repeatStart' ink this test isolates at its
		// *start*.
		const score = buildScore([
			[['G4', 'quarter']],
			{ notes: [['G4', 'quarter']], startBarline: 'repeatStart' },
			[['G4', 'quarter']]
		]);
		const layout = layoutScore(score, { staffSpacePx: ss });
		// The boundary's only barline is owned by measure 1 (the one that opens
		// the repeat), not measure 0: measure 0 draws no barline rect of its own.
		expect(barlineRects(layout.measures[0]!.ops)).toHaveLength(0);

		const ops = layout.measures[1]!.ops;
		// Two bars total: the repeat-start's own thick line at this measure's
		// start, plus its own (mid-score, so 'normal') thin line at its end.
		const bars = barlineRects(ops).sort((a, b) => a.x - b.x);
		expect(bars).toHaveLength(2);
		const openingBar = bars[0]!;
		expect(openingBar.width).toBeCloseTo(ED.thickBarlineThickness * ss, 6);
		const dots = repeatDots(ops);
		expect(dots).toHaveLength(2);
		// Dots sit right of (after) the thick line here, the mirror of repeatEnd.
		for (const dot of dots) expect(dot.x).toBeGreaterThan(openingBar.x);
		// Both the thick line and the dots sit at this measure's own left edge,
		// well before any note (a real measure region always starts there).
		expect(openingBar.x).toBeCloseTo(layout.measures[1]!.region.x, 3);
	});

	it('this slice draws barline shapes only, no repeat-playback semantics', () => {
		// Nothing in the model or layout resolves a repeatStart/repeatEnd pair
		// into a jump, a repeat count, or an ending bracket; a repeatEnd with no
		// matching repeatStart anywhere in the score (as here) still lays out
		// without error, exactly as a purely visual mark should.
		const score = buildScore([{ notes: [['G4', 'quarter']], endBarline: 'repeatEnd' }]);
		expect(() => layoutScore(score)).not.toThrow();
	});

	it('renders the barline showcase, valid measures and all', () => {
		const score = createBarlineShowcaseScore();
		for (const measure of score.measures) {
			expect(validateMeasure(measure, score.timeAt(measure.index)).valid).toBe(true);
		}
		const layout = layoutScore(score, { staffSpacePx: ss });
		expect(barlineRects(layout.measures[0]!.ops)).toHaveLength(2); // double
		expect(repeatDots(layout.measures[2]!.ops)).toHaveLength(2); // repeatStart's own
		expect(repeatDots(layout.measures[3]!.ops)).toHaveLength(2); // repeatEnd's own
	});
});

describe('two voices in one staff (M2 Slice 1)', () => {
	const ss = 10;
	const options = { staffSpacePx: ss };
	const isRect = (op: DrawOp): op is Extract<DrawOp, { kind: 'rect' }> => op.kind === 'rect';
	const isGlyph = (op: DrawOp): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph';
	const stemWidth = ED.stemThickness * ss;
	const beamHeight = ED.beamThickness * ss;
	const stemRects = (ops: readonly DrawOp[]) =>
		ops.filter(isRect).filter((op) => Math.abs(op.width - stemWidth) < 0.001);
	const beamRects = (ops: readonly DrawOp[]) =>
		ops.filter(isRect).filter((op) => Math.abs(op.height - beamHeight) < 0.001);

	// A half-note voice (voice 1) against a running-eighths voice (voice 2),
	// the task's own suggested two-voice example: voice 1's two half notes
	// land at onsets 0 and 0.5, voice 2's four eighths land at 0, 0.125,
	// 0.25 and 0.375 and its own half note at 0.5. Per `noteAdvanceSpaces`'s
	// documented table (half=7, eighth=5 staff spaces), the shared columns
	// are 7 (onset 0, driven by voice 1's half note, wider than voice 2's
	// eighth there), 5, 5, 5 (voice 2's interior eighths, voice 1 has
	// nothing there) and 7 (onset 0.5, both voices land here, tied at 7).
	const halfAgainstEighths = [
		['D4', 'half', { voice: 1 }],
		['E4', 'half', { voice: 1 }],
		['C4', 'eighth', { voice: 2 }],
		['D4', 'eighth', { voice: 2 }],
		['E4', 'eighth', { voice: 2 }],
		['F4', 'eighth', { voice: 2 }],
		['G4', 'half', { voice: 2 }]
	] as const;

	it('aligns two voices of differing rhythm on the same x at a shared onset', () => {
		const score = buildScore([halfAgainstEighths]);
		const layout = layoutScore(score, options);
		const measure = layout.measures[0]!;
		const idOf = (index: number) => score.measures[0]!.notes[index]!.id;
		const xOf = (id: string) => measure.notes.find((n) => n.id === id)!.bounds.x;

		// Voice 1's second half note and voice 2's half note both start at
		// onset 0.5, the same shared column, but M2 Slice 2 (voice-to-voice
		// collision avoidance) means they no longer necessarily land at the
		// exact same x: this fixture's own onset-0 pair (D4 voice 1, C4
		// voice 2) happens to be a second apart, so voice 2's very first note
		// gets nudged one notehead's width right there (see the "voice-to-
		// voice collision avoidance" describe block below), and that nudge
		// persists through the rest of voice 2's own notes, this half note
		// included, the same way an accidental's own collision shift already
		// always propagated forward. The two notes still share the same
		// column offset from voice 1's first note; they are just offset from
		// each other by that one persistent nudge on top of it.
		const v1SecondX = xOf(idOf(1));
		const v2HalfX = xOf(idOf(6));
		const noteheadWidth = GLYPH_METRICS.noteheadBlack.advance * ss;
		expect(v2HalfX - v1SecondX).toBeCloseTo(noteheadWidth, 6);

		// The exact offset from voice 1's first note (onset 0): the three
		// columns in between (7 + 5 + 5 + 5 = 22 staff spaces) scaled to
		// pixels, not wherever voice 1's own single half-note advance alone
		// would have put it (which would be 7 staff spaces, i.e. 70px, a
		// very different, wrong answer this test also rules out), plus that
		// same persistent notehead-collision nudge from onset 0.
		const v1FirstX = xOf(idOf(0));
		expect(v2HalfX - v1FirstX).toBeCloseTo(22 * ss + noteheadWidth, 6);
	});

	it('does not widen a shared column when the other voice needs no more room than it already has', () => {
		// Same measure as above, minus voice 2's trailing half note: the
		// shared onset-0.5 column is then driven by voice 1's own half note
		// alone (width 7), same as when voice 2's half note is also there
		// (also width 7, tied). Adding voice 2's half note back must not grow
		// the measure at all, since the column's width is a max, not a sum;
		// a per-note-across-both-voices sum (the bug this slice's column
		// model replaces) would have grown it by a whole extra half note's
		// worth of room.
		const without = buildScore([halfAgainstEighths.slice(0, 6)]);
		const withTail = buildScore([halfAgainstEighths]);
		const w1 = layoutScore(without, options).measures[0]!.region.width;
		const w2 = layoutScore(withTail, options).measures[0]!.region.width;
		expect(w2).toBeCloseTo(w1, 6);
	});

	it("does not double-count both voices' advances in a system's justification scale", () => {
		// The same measure's shared columns sum to 7 + 5 + 5 + 5 + 7 = 29
		// staff spaces (see the alignment test above), not 7 + 7 + 5 + 5 + 5
		// + 5 + 7 = 41, which is what summing every voice's every note's own
		// advance across both voices (the bug `systemSpacingScale` no longer
		// has) would give.
		const filler = [['C4', 'whole']] as const;
		const scoreWithFillers = buildScore([halfAgainstEighths, filler, filler, filler]);

		// Read the measure's own natural (unscaled) width with the exact same
		// context flags `systemSpacingScale`'s probe uses (system-first,
		// score-first, not the score's last measure): a huge systemWidthPx
		// keeps every measure in one, therefore-last, therefore-unjustified
		// system, so this measure's width there is its true natural width.
		const naturalLayout = layoutScore(scoreWithFillers, { staffSpacePx: ss, systemWidthPx: 5000 });
		expect(naturalLayout.systems[0]!.spacingScale).toBe(1);
		const naturalWidth = naturalLayout.measures[0]!.region.width;

		const systemWidthPx = 500;
		const layout = layoutScore(scoreWithFillers, { staffSpacePx: ss, systemWidthPx });
		// This measure lands alone in system 0, not the score's last system,
		// so it is justified (stretched): exactly the case that exercises the
		// scale computation this test targets.
		expect(layout.systems[0]!.measureIndices).toEqual([0]);

		const padding = 16; // DEFAULTS.paddingPx, not exported
		const availableWidth = systemWidthPx - 2 * padding;
		const correctColumnWidthSum = 29;
		const expectedScale = Math.max(0.5, 1 + (availableWidth - naturalWidth) / (correctColumnWidthSum * ss));
		expect(layout.systems[0]!.spacingScale).toBeCloseTo(expectedScale, 6);
	});

	it('groups beams independently per voice, even when the two voices interleave in the notes array', () => {
		// Voice 2's four eighths (C4, D4 in beat 0; E4, F4 in beat 1, per
		// 4/4's quarter-note beat) are written with voice 1's two quarters
		// physically between them, exactly the interleaving that would
		// corrupt a single shared beat-position cursor run over the flat
		// array: voice 1's quarters' durations would be counted against
		// voice 2's own beat math if the two were not split apart first.
		const score = buildScore([
			[
				['C4', 'eighth', { voice: 2 }],
				['G4', 'quarter', { voice: 1 }],
				['D4', 'eighth', { voice: 2 }],
				['A4', 'quarter', { voice: 1 }],
				['E4', 'eighth', { voice: 2 }],
				['F4', 'eighth', { voice: 2 }]
			]
		]);
		const layout = layoutScore(score, options);
		const ops = layout.measures[0]!.ops;
		// No individual flags: both eighth pairs beamed, not four flags.
		expect(ops.filter(isGlyph).some((op) => op.glyph.startsWith('flag'))).toBe(false);
		// Two two-note beams (one per beat), not one four-note beam and not
		// zero (which either a crash or a mis-grouping could produce).
		expect(beamRects(ops)).toHaveLength(2);
		// Voice 2's 4 beamed eighths + voice 1's 2 quarters (always stemmed,
		// beamed or not) = 6 stems total.
		expect(stemRects(ops)).toHaveLength(6);
	});

	it('forces voice 1 up and voice 2 down when a measure holds two voices, regardless of pitch', () => {
		// C5 (voice 1) sits above the middle line, where the ordinary
		// pitch-based rule (Slice 3) would pick a down-stem; C4 (voice 2)
		// sits well below it, where that same rule would pick an up-stem.
		// The multi-voice convention overrides both, in the opposite
		// direction pitch alone would have chosen for each.
		const layout = layoutScore(
			buildScore([[['C5', 'eighth', { voice: 1 }], ['C4', 'eighth', { voice: 2 }]]]),
			options
		);
		const glyphs = layout.measures[0]!.ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
		expect(glyphs).toContain('flag8thUp'); // voice 1, forced up despite C5's own pitch
		expect(glyphs).toContain('flag8thDown'); // voice 2, forced down despite C4's own pitch
	});

	it('also overrides a beamed group\'s shared direction per voice, not just a lone note\'s', () => {
		const score = buildScore([
			[
				['C5', 'eighth', { voice: 1 }],
				['D5', 'eighth', { voice: 1 }],
				['C4', 'eighth', { voice: 2 }],
				['D4', 'eighth', { voice: 2 }]
			]
		]);
		const layout = layoutScore(score, options);
		const ops = layout.measures[0]!.ops;
		expect(beamRects(ops)).toHaveLength(2); // one beam per voice
		const stems = stemRects(ops);
		expect(stems).toHaveLength(4);

		// Both voices share the same rhythm here (two eighths each, at onsets
		// 0 and 0.125), so they also share the same shared columns and land
		// at the same x (expected and fine per this slice's own scope: cross-
		// voice ink collision avoidance is a later slice). x cannot tell the
		// two beams apart here, so identify each stem's owning voice via the
		// note id every stem rect already carries.
		const voiceOf = (noteId: string | undefined) => score.findNote(noteId!)!.voice;
		const voice1Stems = stems.filter((s) => voiceOf(s.noteId) === 1);
		const voice2Stems = stems.filter((s) => voiceOf(s.noteId) === 2);
		expect(voice1Stems).toHaveLength(2);
		expect(voice2Stems).toHaveLength(2);

		const heads = ops
			.filter(isGlyph)
			.filter((op) => op.glyph === 'noteheadBlack')
			.map((op) => op.y);

		// Voice 1 (C5, D5: both above the middle line, where the pitch rule
		// would pick a down-stem group) is forced up instead: an up-stem's
		// beam-side is each stem's own top edge (`y`), and a shared flat beam
		// means both agree with each other, above every notehead.
		const voice1BeamSideYs = voice1Stems.map((s) => s.y);
		expect(voice1BeamSideYs[0]).toBeCloseTo(voice1BeamSideYs[1]!, 6);
		expect(Math.max(...voice1BeamSideYs)).toBeLessThan(Math.min(...heads));

		// Voice 2 (C4, D4: both below the middle line, where the pitch rule
		// would pick an up-stem group) is forced down instead: a down-stem's
		// beam-side is each stem's bottom edge (`y + height`), below every
		// notehead.
		const voice2BeamSideYs = voice2Stems.map((s) => s.y + s.height);
		expect(voice2BeamSideYs[0]).toBeCloseTo(voice2BeamSideYs[1]!, 6);
		expect(Math.min(...voice2BeamSideYs)).toBeGreaterThan(Math.max(...heads));
	});

	it('keeps the ordinary pitch-based rule unchanged when only voice 1 is present', () => {
		// Same C5 pitch as above, alone: the plain single-voice rule (above
		// the middle line -> down-stem, Slice 3) applies exactly as before
		// this slice, confirming the override never engages for a
		// single-voice measure.
		const layout = layoutScore(buildScore([[['C5', 'eighth']]]), options);
		const glyphs = layout.measures[0]!.ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
		expect(glyphs).toContain('flag8thDown');
	});

	it("offsets voice 1 and voice 2 rests apart when they share the same onset", () => {
		const score = buildScore([
			[
				[null, 'quarter', { voice: 1 }],
				['G4', 'quarter', { voice: 1 }],
				['A4', 'quarter', { voice: 1 }],
				['B4', 'quarter', { voice: 1 }],
				[null, 'quarter', { voice: 2 }],
				['C4', 'quarter', { voice: 2 }],
				['D4', 'quarter', { voice: 2 }],
				['E4', 'quarter', { voice: 2 }]
			]
		]);
		const layout = layoutScore(score, options);
		const rests = layout.measures[0]!.ops.filter(
			(op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === 'restQuarter'
		);
		expect(rests).toHaveLength(2);
		// Same onset, same shared column: same x.
		expect(rests[0]!.x).toBeCloseTo(rests[1]!.x, 6);
		// Different y: one shifted two fixed staff spaces up from the
		// ordinary default, the other the same distance down, so neither
		// prints on top of the other's ink at this shared column (see
		// `REST_VOICE_OFFSET_SPACES`'s own comment on why two spaces, not
		// one, is what actually clears a quarter rest's own glyph height).
		const defaultY = layout.staffTopY + 2 * ss;
		const ys = rests.map((r) => r.y).sort((a, b) => a - b);
		expect(ys[0]).toBeCloseTo(defaultY - 2 * ss, 6); // voice 1: shifted up
		expect(ys[1]).toBeCloseTo(defaultY + 2 * ss, 6); // voice 2: shifted down
	});

	it('leaves a single voice\'s rest at its ordinary fixed position with no offset', () => {
		const layout = layoutScore(buildScore([[[null, 'quarter']]]), options);
		const rest = layout.measures[0]!.ops.find(
			(op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === 'restQuarter'
		)!;
		expect(rest.y).toBeCloseTo(layout.staffTopY + 2 * ss, 6);
	});

	it('lays out a third voice without crashing, falling back to the ordinary pitch-based stem rule', () => {
		// Voices 3+ are explicitly out of this slice's scope (see
		// `voiceStemOverride`'s own comment): this only asserts the
		// documented gap (no crash, pitch-based fallback), not a real
		// third-voice convention.
		const layout = layoutScore(
			buildScore([
				[
					['C5', 'eighth', { voice: 1 }],
					['C4', 'eighth', { voice: 2 }],
					['D5', 'eighth', { voice: 3 }]
				]
			]),
			options
		);
		const glyphs = layout.measures[0]!.ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
		// D5 sits above the middle line: the ordinary pitch rule (not voice 1
		// or 2's forced override, neither of which applies to voice 3) gives
		// it a down-stem.
		expect(glyphs).toContain('flag8thDown');
	});

	it('renders the two-voice showcase without error, with both voices\' notes/rests all present', () => {
		const score = createTwoVoiceShowcaseScore();
		const layout = layoutScore(score, options);
		expect(layout.measures).toHaveLength(2);
		// Measure 0: voice 1's 2 half notes + voice 2's 8 eighths.
		expect(layout.measures[0]!.notes).toHaveLength(10);
		// Measure 1: voice 1's rest + 3 quarters, voice 2's rest + 3 quarters
		// (a rest still gets a `LaidOutNote` entry; see `layoutNote`'s rest
		// branch).
		expect(layout.measures[1]!.notes).toHaveLength(8);
		// Measure 0's voice 2 still beams into four quarter-beat pairs, the
		// same grouping it would get as the only voice in the measure,
		// unaffected by voice 1's two much slower half notes sharing it.
		expect(beamRects(layout.measures[0]!.ops)).toHaveLength(4);
	});
});

describe('voice-to-voice collision avoidance (M2 Slice 2)', () => {
	const ss = 10;
	const options = { staffSpacePx: ss };
	const ledgerRects = (ops: readonly DrawOp[]) =>
		ops
			.filter((op): op is Extract<DrawOp, { kind: 'rect' }> => op.kind === 'rect')
			.filter((op) => Math.abs(op.height - ED.legerLineThickness * ss) < 0.001);
	const findGlyph = (ops: readonly DrawOp[], glyph: GlyphName) =>
		ops.find((op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === glyph);

	it("nudges voice 2's notehead a full notehead's width right of voice 1's, when the two land a second apart at the same onset", () => {
		const score = buildScore([
			[
				['E4', 'quarter', { voice: 1 }],
				['D4', 'quarter', { voice: 2 }]
			]
		]);
		const layout = layoutScore(score, options);
		const measure = layout.measures[0]!;
		const xOf = (index: number) => measure.notes.find((n) => n.id === score.measures[0]!.notes[index]!.id)!.bounds.x;
		const v1x = xOf(0);
		const v2x = xOf(1);
		const noteheadWidth = GLYPH_METRICS.noteheadBlack.advance * ss;
		expect(v2x - v1x).toBeCloseTo(noteheadWidth, 6);
	});

	it('never moves voice 1, even when voice 2 is written first in the note array', () => {
		const solo = layoutScore(buildScore([[['E4', 'quarter']]]), options);
		const soloX = solo.measures[0]!.notes[0]!.bounds.x;

		const score = buildScore([
			[
				['D4', 'quarter', { voice: 2 }],
				['E4', 'quarter', { voice: 1 }]
			]
		]);
		const layout = layoutScore(score, options);
		const measure = layout.measures[0]!;
		const xOf = (index: number) => measure.notes.find((n) => n.id === score.measures[0]!.notes[index]!.id)!.bounds.x;
		const v2x = xOf(0);
		const v1x = xOf(1);
		expect(v1x).toBeCloseTo(soloX, 6); // voice 1 unmoved by voice 2's presence
		const noteheadWidth = GLYPH_METRICS.noteheadBlack.advance * ss;
		expect(v2x - v1x).toBeCloseTo(noteheadWidth, 6); // voice 2 the one that yields
	});

	it('does not nudge when the two voices are further apart than a second', () => {
		const score = buildScore([
			[
				['C4', 'quarter', { voice: 1 }],
				['G4', 'quarter', { voice: 2 }]
			]
		]);
		const layout = layoutScore(score, options);
		const measure = layout.measures[0]!;
		const xOf = (index: number) => measure.notes.find((n) => n.id === score.measures[0]!.notes[index]!.id)!.bounds.x;
		expect(xOf(0)).toBeCloseTo(xOf(1), 6);
	});

	it('does not nudge a second-apart pair once normal column spacing already clears them', () => {
		// Voice 1's quarter note is alone at onset 0; voice 2's own note, a
		// second below it, lands a full quarter-note column later (onset
		// 0.25), naturally far enough right that the previous-column check
		// this slice adds finds nothing to close.
		const score = buildScore([
			[
				['C4', 'quarter', { voice: 1 }],
				[null, 'quarter', { voice: 2 }],
				['B3', 'quarter', { voice: 2 }]
			]
		]);
		const layout = layoutScore(score, options);
		const measure = layout.measures[0]!;
		const c4Id = score.measures[0]!.notes[0]!.id;
		const b3Id = score.measures[0]!.notes[2]!.id;
		const c4X = measure.notes.find((n) => n.id === c4Id)!.bounds.x;
		const b3X = measure.notes.find((n) => n.id === b3Id)!.bounds.x;
		const noteheadWidth = GLYPH_METRICS.noteheadBlack.advance * ss;
		expect(b3X - c4X).toBeGreaterThan(noteheadWidth); // natural column gap, not the clash nudge
	});

	it("shifts an accidental in voice 2 past voice 1's ledger-line ink at the same onset", () => {
		// Voice 1's C4 whole note draws a ledger line below the staff and has
		// no stem (a whole note never gets one), keeping its ink here to the
		// ledger line alone. Voice 2's C#5 quarter, at the very same onset,
		// is nowhere near a second away from C4 (over an octave), so the
		// notehead-clash nudge above never engages; this test isolates the
		// other collision path, an accidental checking the other voice's ink
		// at the shared column x, not just its own voice's previous note
		// (which for voice 2's very first note would otherwise be `null`,
		// giving no clearance at all).
		const score = buildScore([
			[
				['C4', 'whole', { voice: 1 }],
				['C#5', 'quarter', { voice: 2 }]
			]
		]);
		const layout = layoutScore(score, options);
		const ops = layout.measures[0]!.ops;

		const ledger = ledgerRects(ops)[0]!;
		const ledgerRight = ledger.x + ledger.width;
		const accidental = findGlyph(ops, 'accidentalSharp')!;
		// The same "close to exactly the minimum" assertion M1 Slice 4's own
		// single-voice collision test used, extended across voices.
		expect(accidental.x - ledgerRight).toBeCloseTo(0.9 * ss, 5);
	});

	it('renders the voice-clash showcase without error, with the expected accidental and no crash', () => {
		const score = createVoiceClashShowcaseScore();
		const layout = layoutScore(score);
		expect(layout.measures).toHaveLength(2);
		const glyphs = layout.measures[1]!.ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
		expect(glyphs).toContain('accidentalSharp'); // voice 2's C#5
	});
});
