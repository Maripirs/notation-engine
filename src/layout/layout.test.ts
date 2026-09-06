import { describe, expect, it } from 'vitest';
import {
	createAccidentalShowcaseScore,
	createBarlineShowcaseScore,
	createClefShowcaseScore,
	createCrossStaffBeamShowcaseScore,
	createDemoScore,
	createDurationShowcaseScore,
	createGrandStaffShowcaseScore,
	createKeyTimeChangeShowcaseScore,
	createSatbBracketShowcaseScore,
	createSlurShowcaseScore,
	createTieShowcaseScore,
	createTwoVoiceShowcaseScore,
	createVoiceClashShowcaseScore
} from '../demo-score.js';
import { parsePitch } from '../model/pitch.js';
import { buildScore, type ClefType, TRIPLET, validateMeasure, type NoteValue } from '../model/score.js';
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

	it('draws a slur curve on a non-zero staff, not just staff 0 (fixing notesInOrder\'s old staff-0-only bug)', () => {
		// Before the fix, `notesInOrder()` always read `staves[0]` alone, so
		// `addSlur`'s own order check on any other staff always compared two
		// `Array.indexOf` misses (`-1 >= -1`) and threw "must come before" no
		// matter what the actual notes were; a slur on a non-zero staff was
		// silently impossible. `notesInOrder(staffIndex)` and `addSlur`'s own
		// staff resolution fix that, and `slurSpanNotes`/the slur-drawing loop
		// in `layoutMeasure` thread the slur's actual staff index through
		// instead of assuming staff 0, so the curve lands in the right
		// staff's own measure region.
		const score = buildScore([[['C4', 'quarter']]]); // staff 0, an unrelated filler measure
		score.appendStaff('bass');
		const measure = score.appendMeasure(1);
		const ids = ['C3', 'D3', 'E3', 'F3'].map(
			(pitch) => score.appendNote(measure, { pitch: parsePitch(pitch), value: 'quarter' }).id
		);
		score.addSlur(ids[0]!, ids[3]!);

		const layout = layoutScore(score);
		const bassMeasure = layout.measures.find((m) => m.staffIndex === 1)!;
		expect(curvesOf(bassMeasure.ops)).toHaveLength(1);
		// Staff 0's own unrelated measure draws no slur ink at all: the slur
		// is scoped entirely to the staff it was actually built on, not
		// leaked into every staff the way the old always-staff-0 read could
		// have risked.
		const trebleMeasure = layout.measures.find((m) => m.staffIndex === 0)!;
		expect(curvesOf(trebleMeasure.ops)).toHaveLength(0);
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

	it('spreads three voices\' rests apart into three distinct, ordered offsets at a shared onset', () => {
		// M2 scoping recheck (before M3): `restVoiceOffsetSpaces` used to give
		// voice 3+ no offset at all, letting a third voice's rest print
		// directly on top of whichever of voice 1/2 happened to already be
		// there. It now grows by parity the same way `voiceStemOverride`
		// does: voice 3 (odd) steps a further `REST_VOICE_OFFSET_SPACES`
		// beyond voice 1's own offset, rather than colliding with it.
		const score = buildScore([
			[
				[null, 'quarter', { voice: 1 }],
				['G4', 'quarter', { voice: 1 }],
				['A4', 'quarter', { voice: 1 }],
				['B4', 'quarter', { voice: 1 }],
				[null, 'quarter', { voice: 2 }],
				['C4', 'quarter', { voice: 2 }],
				['D4', 'quarter', { voice: 2 }],
				['E4', 'quarter', { voice: 2 }],
				[null, 'quarter', { voice: 3 }],
				['F4', 'quarter', { voice: 3 }],
				['G4', 'quarter', { voice: 3 }],
				['A4', 'quarter', { voice: 3 }]
			]
		]);
		const layout = layoutScore(score, options);
		const rests = layout.measures[0]!.ops.filter(
			(op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === 'restQuarter'
		);
		expect(rests).toHaveLength(3);
		// Same onset, same shared column: same x for all three.
		expect(rests[1]!.x).toBeCloseTo(rests[0]!.x, 6);
		expect(rests[2]!.x).toBeCloseTo(rests[0]!.x, 6);
		// Three distinct y offsets, ordered voice 3 (furthest up) < voice 1
		// (one step up) < voice 2 (one step down), since voice 3 steps a
		// second `REST_VOICE_OFFSET_SPACES` beyond voice 1's own offset on
		// the same (odd, upward) side rather than sharing it.
		const defaultY = layout.staffTopY + 2 * ss;
		const ys = rests.map((r) => r.y).sort((a, b) => a - b);
		expect(ys[0]).toBeCloseTo(defaultY - 4 * ss, 6); // voice 3: two steps up
		expect(ys[1]).toBeCloseTo(defaultY - 2 * ss, 6); // voice 1: one step up
		expect(ys[2]).toBeCloseTo(defaultY + 2 * ss, 6); // voice 2: one step down
	});

	it('leaves a single voice\'s rest at its ordinary fixed position with no offset', () => {
		const layout = layoutScore(buildScore([[[null, 'quarter']]]), options);
		const rest = layout.measures[0]!.ops.find(
			(op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === 'restQuarter'
		)!;
		expect(rest.y).toBeCloseTo(layout.staffTopY + 2 * ss, 6);
	});

	it('generalizes the stem-direction convention to voices 3 and 4 by parity, odd up and even down', () => {
		// M2 scoping recheck (before M3): voices 3+ used to fall back to the
		// ordinary pitch-based rule here, a documented gap rather than a real
		// convention; `voiceStemOverride` now extends the exact voice-1-up/
		// voice-2-down rule above by parity instead. D5 (voice 3, above the
		// middle line, where the pitch rule would pick a down-stem) is forced
		// up because 3 is odd, the same direction voice 1's C5 gets; D4
		// (voice 4, below the middle line, where the pitch rule would pick an
		// up-stem) is forced down because 4 is even, the same direction voice
		// 2's C4 gets. Every one of the four notes here has its pitch-based
		// answer deliberately overridden by the convention, not agreeing with
		// it by coincidence.
		const score = buildScore([
			[
				['C5', 'eighth', { voice: 1 }],
				['C4', 'eighth', { voice: 2 }],
				['D5', 'eighth', { voice: 3 }],
				['D4', 'eighth', { voice: 4 }]
			]
		]);
		const layout = layoutScore(score, options);
		const ops = layout.measures[0]!.ops;
		const flagGlyphFor = (noteId: string) =>
			ops.find(
				(op): op is Extract<DrawOp, { kind: 'glyph' }> =>
					op.kind === 'glyph' && op.noteId === noteId && op.glyph.startsWith('flag')
			)?.glyph;
		const [v1, v2, v3, v4] = score.measures[0]!.notes;
		expect(flagGlyphFor(v1!.id)).toBe('flag8thUp');
		expect(flagGlyphFor(v2!.id)).toBe('flag8thDown');
		expect(flagGlyphFor(v3!.id)).toBe('flag8thUp');
		expect(flagGlyphFor(v4!.id)).toBe('flag8thDown');
	});

	it('validates every two-voice-showcase measure against 4/4 capacity, one voice at a time', () => {
		// Same discipline as the duration/accidental/tie showcases' own
		// `validateMeasure` tests: fixed by the M2 scoping-recheck per-voice
		// rewrite (see `MeasureValidation.perVoice`'s own comment), which is
		// what makes this test possible at all. Before that fix,
		// `validateMeasure` summed both voices together (2 wholes for a
		// measure where each voice separately fills 4/4 once), which would
		// have failed here for reasons unrelated to anything this showcase
		// actually demonstrates; that is exactly why `createTwoVoiceShowcaseScore`'s
		// own doc comment used to flag this validation as skipped.
		const score = createTwoVoiceShowcaseScore();
		for (const measure of score.measures) {
			expect(validateMeasure(measure, score.time).valid).toBe(true);
		}
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

	it("nudges voice 3's notehead clear of voice 1's the same way voice 2's does, with no voice 2 present", () => {
		// M2 scoping recheck (before M3): `secondIntervalClashShift` used to
		// fire only for `voice === 2` against a single tracked voice-1
		// position. It now checks a placed note against *every*
		// earlier-numbered voice already laid out at this column or the
		// previous one, so a voice 3/voice 1 clash - skipping voice 2
		// entirely, which never appears in this measure at all - still
		// resolves with the exact same rightward-nudge convention voice 2
		// already gets in the test above.
		const score = buildScore([
			[
				['E4', 'quarter', { voice: 1 }],
				['D4', 'quarter', { voice: 3 }]
			]
		]);
		const layout = layoutScore(score, options);
		const measure = layout.measures[0]!;
		const xOf = (index: number) => measure.notes.find((n) => n.id === score.measures[0]!.notes[index]!.id)!.bounds.x;
		const v1x = xOf(0);
		const v3x = xOf(1);
		const noteheadWidth = GLYPH_METRICS.noteheadBlack.advance * ss;
		expect(v3x - v1x).toBeCloseTo(noteheadWidth, 6);
	});

	it('renders the voice-clash showcase without error, with the expected accidental and no crash', () => {
		const score = createVoiceClashShowcaseScore();
		const layout = layoutScore(score);
		expect(layout.measures).toHaveLength(2);
		const glyphs = layout.measures[1]!.ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
		expect(glyphs).toContain('accidentalSharp'); // voice 2's C#5
	});
});

describe('clefs (M2 Slice 3)', () => {
	const ss = 10;
	const options = { staffSpacePx: ss };

	const findGlyph = (ops: readonly DrawOp[], glyph: GlyphName) =>
		ops.find((op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === glyph)!;
	const noteheadYs = (ops: readonly DrawOp[]) =>
		ops.flatMap((op) => (op.kind === 'glyph' && op.glyph === 'noteheadBlack' ? [op.y] : []));

	/**
	 * Canvas y of a single `noteheadBlack` note laid out alone under `clef`.
	 * Only ever used to compare *within* one clef's own single-note score
	 * (e.g. the `treble8`-vs-`treble` and bass-ledger-line tests below), never
	 * across two different pitches: two separate `layoutScore` calls can (and,
	 * for pitches needing different amounts of ledger-line clearance, do)
	 * settle on different `shiftY` translations, so their raw canvas `y`
	 * values are not directly comparable to each other. Tests that need to
	 * compare *two different pitches'* positions instead lay both out
	 * together, in one shared measure/one shared `layoutScore` call, so they
	 * share the same `shiftY` (see `noteheadYs`, and this describe block's own
	 * line-spacing and key-signature tests).
	 */
	function soloNoteheadY(clef: ClefType, pitch: string): number {
		const layout = layoutScore(buildScore([[[pitch, 'quarter']]], { clef }), options);
		return findGlyph(layout.measures[0]!.ops, 'noteheadBlack').y;
	}

	it('places a note on the correct line for treble, bass and treble8, all at the standard 2-space line spacing', () => {
		// Bottom line, middle line, top line for each clef, all three notes in
		// one measure (one `layoutScore` call, so all three share the same
		// vertical `shiftY` and their `y`s are directly comparable). treble8
		// shares plain treble's exact positions (only its clef glyph differs;
		// see `ClefType`'s own comment in model/score.ts), so it is included
		// here as a positive check that it really does, not skipped as
		// redundant.
		const cases: readonly (readonly [ClefType, string, string, string])[] = [
			['treble', 'E4', 'B4', 'F5'],
			['bass', 'G2', 'D3', 'A3'],
			['treble8', 'E4', 'B4', 'F5']
		];
		for (const [clef, bottom, middle, top] of cases) {
			const layout = layoutScore(
				buildScore([[[bottom, 'quarter'], [middle, 'quarter'], [top, 'quarter']]], { clef }),
				options
			);
			const [bottomY, middleY, topY] = noteheadYs(layout.measures[0]!.ops);
			// Canvas y grows downward, so the top line's note has the smallest y;
			// every adjacent staff line is exactly 2 staff spaces (one line's
			// worth) apart, the same geometry the existing (treble-only)
			// ledger-line tests above already rely on.
			expect(middleY! - topY!).toBeCloseTo(2 * ss, 6);
			expect(bottomY! - middleY!).toBeCloseTo(2 * ss, 6);
		}
	});

	it('treble8 places a note at the exact same y as plain treble; only the clef glyph differs', () => {
		// A single, identical pitch in both clefs' own solo layout needs the
		// exact same ledger-line clearance in each, so the two calls' own
		// `shiftY` values agree and `soloNoteheadY`'s cross-call comparison is
		// valid here (unlike comparing two *different* pitches across calls).
		expect(soloNoteheadY('treble8', 'C5')).toBeCloseTo(soloNoteheadY('treble', 'C5'), 6);

		const treble = layoutScore(buildScore([[['C5', 'quarter']]], { clef: 'treble' }), options);
		const treble8 = layoutScore(buildScore([[['C5', 'quarter']]], { clef: 'treble8' }), options);
		expect(findGlyph(treble.measures[0]!.ops, 'gClef')).toBeDefined();
		expect(findGlyph(treble8.measures[0]!.ops, 'gClef8vb')).toBeDefined();
	});

	it('draws a bass clef (fClef) and places middle C on the first ledger line above the staff', () => {
		const layout = layoutScore(buildScore([[['C4', 'quarter']]], { clef: 'bass' }), options);
		const ops = layout.measures[0]!.ops;
		expect(findGlyph(ops, 'fClef')).toBeDefined();
		const ledgerRects = ops.filter(
			(op): op is Extract<DrawOp, { kind: 'rect' }> =>
				op.kind === 'rect' && Math.abs(op.height - ED.legerLineThickness * ss) < 0.001
		);
		expect(ledgerRects).toHaveLength(1);
		// The ledger line sits above the staff (smaller y than the top line),
		// mirroring how the same note needs a ledger line *below* a treble
		// staff (already covered by the "draws ledger lines only for notes off
		// the staff" test above).
		expect(ledgerRects[0]!.y).toBeLessThan(layout.staffTopY);
	});

	it('positions a key signature\'s sharps on the same line/space a real notehead of that letter would use, per clef', () => {
		// The first written sharp is always F (`KEY_SIGNATURE_POSITIONS`); this
		// checks the *musical* claim ("F# lands where an F would") rather than
		// restating this file's own internal position table, so a wrong octave
		// choice for a clef would actually fail it. The reference note is
		// written as F# (matching the one-sharp key already in force), not
		// plain F, so it draws no accidental of its own and its notehead's `y`
		// alone is what gets compared to the key signature's; both are read
		// from the *same* `layoutScore` call (one measure) so they share the
		// same vertical `shiftY`, unlike comparing across two separate calls
		// (see `soloNoteheadY`'s own comment on why that would not be valid).
		const cases: readonly (readonly [ClefType, string])[] = [
			['treble', 'F#5'],
			['bass', 'F#3']
		];
		for (const [clef, fSharpPitch] of cases) {
			const layout = layoutScore(buildScore([[[fSharpPitch, 'quarter']]], { clef, keyFifths: 1 }), options);
			const ops = layout.measures[0]!.ops;
			const keySharpY = findGlyph(ops, 'accidentalSharp').y;
			const [noteY] = noteheadYs(ops);
			expect(keySharpY).toBeCloseTo(noteY!, 6);
		}
	});

	it('positions a key signature\'s flats on the same line/space a real notehead of that letter would use, per clef', () => {
		// The first written flat is always B; same one-`layoutScore`-call
		// reasoning as the sharps test above, with the reference note written
		// as Bb (matching the one-flat key already in force) so it draws no
		// accidental of its own.
		const cases: readonly (readonly [ClefType, string])[] = [
			['treble', 'Bb4'],
			['bass', 'Bb3']
		];
		for (const [clef, bFlatPitch] of cases) {
			const layout = layoutScore(buildScore([[[bFlatPitch, 'quarter']]], { clef, keyFifths: -1 }), options);
			const ops = layout.measures[0]!.ops;
			const keyFlatY = findGlyph(ops, 'accidentalFlat').y;
			const [noteY] = noteheadYs(ops);
			expect(keyFlatY).toBeCloseTo(noteY!, 6);
		}
	});

	it('gives treble8 the exact same key-signature positions as plain treble', () => {
		const treble = layoutScore(buildScore([[['C4', 'quarter']]], { clef: 'treble', keyFifths: 3 }), options);
		const treble8 = layoutScore(buildScore([[['C4', 'quarter']]], { clef: 'treble8', keyFifths: 3 }), options);
		const sharpYs = (l: LaidOutScore) =>
			l.measures[0]!.ops.flatMap((op) => (op.kind === 'glyph' && op.glyph === 'accidentalSharp' ? [op.y] : []));
		expect(sharpYs(treble8)).toEqual(sharpYs(treble));
	});

	it('renders the clef showcase (three staves, one per clef) without error, one system-opening clef glyph each', () => {
		const score = createClefShowcaseScore();
		const layout = layoutScore(score);
		// Two measures per staff, three staves.
		expect(layout.measures).toHaveLength(6);
		const systemFirstMeasures = layout.measures.filter((m) => m.index === 0);
		expect(systemFirstMeasures).toHaveLength(3);
		const clefGlyphsOf = (staffIndex: number) =>
			systemFirstMeasures
				.find((m) => m.staffIndex === staffIndex)!
				.ops.flatMap((op) => (op.kind === 'glyph' && (op.glyph === 'gClef' || op.glyph === 'fClef' || op.glyph === 'gClef8vb') ? [op.glyph] : []));
		expect(clefGlyphsOf(0)).toEqual(['gClef']);
		expect(clefGlyphsOf(1)).toEqual(['fClef']);
		expect(clefGlyphsOf(2)).toEqual(['gClef8vb']);
	});
});

describe('multi-staff redraw isolation (M2 Slice 3)', () => {
	it('relayoutMeasure on one staff never touches another staff\'s measures, even when their indices collide', () => {
		// Two staves, each with its own measure 0/1/2: staff-local indices
		// collide on purpose (both staves have an "index 0", "index 1", ...),
		// which is exactly the case a bare `index` lookup could not have
		// disambiguated before this slice's `(staffIndex, index)` addressing.
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
					['B4', 'quarter'],
					['C5', 'quarter']
				]
			],
			{ clef: 'treble' }
		);
		score.appendStaff('bass');
		for (let i = 0; i < 2; i++) {
			const m = score.appendMeasure(1);
			for (const pitch of ['C3', 'D3', 'E3', 'F3']) {
				score.appendNote(m, { pitch: parsePitch(pitch), value: 'quarter' });
			}
		}

		const layout = layoutScore(score);
		expect(layout.measures.filter((m) => m.staffIndex === 0)).toHaveLength(2);
		expect(layout.measures.filter((m) => m.staffIndex === 1)).toHaveLength(2);

		const target = score.staves[1]!.measures[1]!.notes[0]!;
		const touched = score.transposeNote(target.id, 1);
		expect(touched).toBe(1);

		const updated = relayoutMeasure(score, layout, touched!, {}, 1);
		expect(updated).not.toBeNull();

		// Every measure except (staffIndex 1, index 1) is the exact same
		// object, not merely an equal one: this is the same "untouched
		// measures are not recomputed at all" identity check `relayoutMeasure`'s
		// own single-staff test above uses, now proven across the new staff
		// dimension too.
		for (const m of updated!.measures) {
			if (m.staffIndex === 1 && m.index === 1) {
				expect(m).not.toBe(layout.measures.find((mm) => mm.staffIndex === 1 && mm.index === 1));
			} else {
				const before = layout.measures.find((mm) => mm.staffIndex === m.staffIndex && mm.index === m.index);
				expect(m).toBe(before);
			}
		}
	});
});

describe('multi-staff system layout (M2 Slice 4)', () => {
	const ss = 10;
	const options = { staffSpacePx: ss };

	/** Two-staff score (treble over bass), one measure of one quarter note each
	 *  by default, built the same low-level way the M2 Slice 3 redraw-isolation
	 *  test above does (`buildScore` only ever populates one implicit staff).
	 *  `notes` lets a test give each staff a different phrase without repeating
	 *  the `appendStaff`/`appendMeasure`/`appendNote` boilerplate. */
	function buildTwoStaffScore(
		notes: readonly (readonly (readonly [string, NoteValue])[])[] = [[['C5', 'quarter']], [['C3', 'quarter']]]
	) {
		const score = buildScore([[...notes[0]!]], { clef: 'treble' });
		score.appendStaff('bass');
		const staff1Measure = score.appendMeasure(1);
		for (const [pitch, value] of notes[1]!) {
			score.appendNote(staff1Measure, { pitch: parsePitch(pitch), value });
		}
		return score;
	}

	const rectsOf = (ops: readonly DrawOp[]) =>
		ops.filter((op): op is Extract<DrawOp, { kind: 'rect' }> => op.kind === 'rect');

	it('stacks a second staff tightly below the first, at a fixed offset from its nominal (not ink-measured) bottom', () => {
		const score = buildTwoStaffScore();
		const layout = layoutScore(score, options);

		const sys0 = layout.systems.find((s) => s.staffIndex === 0)!;
		const sys1 = layout.systems.find((s) => s.staffIndex === 1)!;
		expect(sys0).toBeDefined();
		expect(sys1).toBeDefined();
		// Staff 1 starts strictly below staff 0's own nominal bottom (its top
		// line plus 4 staff spaces): the two staves are genuinely stacked, not
		// overlapping or coincident.
		const staffBand = 4 * ss;
		expect(sys1.topY).toBeGreaterThan(sys0.topY + staffBand);
		// Tightly: the two staves interleave within one system, not two whole
		// independent per-staff blocks each carrying its own top-and-bottom
		// margin the way Slice 3's naive placeholder stacked them. Comparing
		// against what laying each staff out *alone* would cost (its own full
		// padding on both sides, not just a staff-to-staff gap) is a
		// self-documenting bound rather than a magic number: the interleaved
		// offset has to be well under what two independent blocks would need.
		const solo0 = layoutScore(buildScore([[['C5', 'quarter']]], { clef: 'treble' }), options);
		const solo1 = layoutScore(buildScore([[['C3', 'quarter']]], { clef: 'bass' }), options);
		expect(sys1.topY - sys0.topY).toBeLessThan(solo0.height + solo1.height);

		// The offset is deterministic, computable from staff 0's own nominal
		// bottom alone: laying out a *third* staff with identical content
		// reproduces the exact same staff-to-staff offset a second time.
		score.appendStaff('bass');
		score.appendNote(score.appendMeasure(2), { pitch: parsePitch('C3'), value: 'quarter' });
		const layout3 = layoutScore(score, options);
		const sys0b = layout3.systems.find((s) => s.staffIndex === 0)!;
		const sys1b = layout3.systems.find((s) => s.staffIndex === 1)!;
		const sys2b = layout3.systems.find((s) => s.staffIndex === 2)!;
		expect(sys1b.topY - sys0b.topY).toBeCloseTo(sys1.topY - sys0.topY, 6);
		expect(sys2b.topY - sys1b.topY).toBeCloseTo(sys1.topY - sys0.topY, 6);

		// Every staff's own measure region sits in its own non-overlapping
		// vertical band: no measure of staff 1 draws above where staff 0's own
		// band ends.
		const m0 = layout.measures.find((m) => m.staffIndex === 0)!;
		const m1 = layout.measures.find((m) => m.staffIndex === 1)!;
		expect(m1.region.y).toBeGreaterThanOrEqual(m0.region.y + m0.region.height - 0.001);
	});

	it('a single-staff score is unaffected: exactly the layout it always produced', () => {
		// The degenerate case `layoutScore`'s own doc comment calls out:
		// `barlineSpan` for a lone staff reduces to the ordinary single-staff
		// band, so this is a regression guard that multi-staff plumbing did not
		// change the common case's output.
		const score = buildScore([[['C4', 'quarter'], ['D4', 'quarter']]], { clef: 'treble' });
		const layout = layoutScore(score, options);
		expect(layout.systems).toHaveLength(1);
		const barlineRect = rectsOf(layout.measures[0]!.ops).find(
			(r) => Math.abs(r.width - ED.thinBarlineThickness * ss) < 0.01
		)!;
		expect(barlineRect).toBeDefined();
		expect(barlineRect.y).toBeCloseTo(layout.staffTopY, 6);
		expect(barlineRect.height).toBeCloseTo(4 * ss, 6);
	});

	it("draws one shared end barline per measure column, each staff's own segment meeting the next with no gap or overlap", () => {
		const score = buildTwoStaffScore([
			[['C5', 'quarter'], ['D5', 'quarter']],
			[['C3', 'quarter'], ['D3', 'quarter']]
		]);
		const layout = layoutScore(score, options);
		const m0 = layout.measures.find((m) => m.staffIndex === 0 && m.index === 0)!;
		const m1 = layout.measures.find((m) => m.staffIndex === 1 && m.index === 0)!;

		// Each staff's own end-barline rect: the thin 'normal' main line (this
		// is measure 0 of 1, not the score's last measure, so `endBarline`
		// resolves to 'normal', a single thin rect with no extra thin line or
		// dots to filter out).
		const barlineOf = (ops: readonly DrawOp[]) =>
			rectsOf(ops).find((r) => Math.abs(r.width - ED.thinBarlineThickness * ss) < 0.01)!;
		const b0 = barlineOf(m0.ops);
		const b1 = barlineOf(m1.ops);
		expect(b0).toBeDefined();
		expect(b1).toBeDefined();

		// Same column, so the same x and the same thickness: two independent
		// segments of what reads as one continuous vertical line.
		expect(b1.x).toBeCloseTo(b0.x, 6);
		expect(b1.width).toBeCloseTo(b0.width, 6);

		// Staff 0 (the group's first staff) only extends *downward*, past its
		// own nominal bottom, into the gap; staff 1 (the group's last staff)
		// only extends *upward*, past its own nominal top, into the same gap.
		expect(b0.height).toBeGreaterThan(4 * ss);
		expect(b1.height).toBeGreaterThan(4 * ss);
		expect(b0.y).toBeCloseTo(layout.staffTopY, 6); // staff 0's own top is unmoved

		// The two ink segments meet near the midpoint of the staff gap, close
		// enough to read as one continuous line, but not touching pixel-for-
		// pixel: a deliberate, small neutral strip is left between them (see
		// `barlineSpan`'s own comment on why splitting at the exact geometric
		// midpoint would make the two staves' *regions* overlap once each one's
		// antialiasing bleed is applied). No overlap in the ink itself either
		// way, which is the property that actually matters here.
		expect(b1.y).toBeGreaterThanOrEqual(b0.y + b0.height - 0.001);
		expect(b1.y - (b0.y + b0.height)).toBeLessThan(5);

		// Each staff's own region bounds at least its own segment...
		expect(m0.region.y + m0.region.height).toBeGreaterThanOrEqual(b0.y + b0.height - 0.001);
		expect(m1.region.y).toBeLessThanOrEqual(b1.y + 0.001);
		// ...and, the property region-scoped redraw actually depends on, the
		// two staves' regions do not overlap vertically at all: redrawing one
		// staff's measure can never clear a pixel that belongs to the other
		// staff's own ink without also being the one to repaint it.
		expect(m0.region.y + m0.region.height).toBeLessThanOrEqual(m1.region.y + 0.001);
	});

	it('a narrower staff has its measure column padded to match the wider staff, keeping both barlines aligned', () => {
		// Staff 0 gets a busy run of eighth notes (wide); staff 1 gets a single
		// whole note (narrow on its own). Column-width sharing (M2 Slice 4)
		// pads staff 1's trailing space, not its note positions, out to match.
		const score = buildTwoStaffScore([
			[
				['C5', 'eighth'],
				['D5', 'eighth'],
				['E5', 'eighth'],
				['F5', 'eighth'],
				['G5', 'eighth'],
				['A5', 'eighth'],
				['B5', 'eighth'],
				['C6', 'eighth']
			],
			[['C3', 'whole']]
		]);
		const layout = layoutScore(score, options);
		const m0 = layout.measures.find((m) => m.staffIndex === 0 && m.index === 0)!;
		const m1 = layout.measures.find((m) => m.staffIndex === 1 && m.index === 0)!;

		// Both measures' columns end (region's right edge) at the same x: the
		// wide staff's own natural width decided the shared column width, and
		// the narrow staff's trailing space was padded out to match it.
		expect(m1.region.x + m1.region.width).toBeCloseTo(m0.region.x + m0.region.width, 6);

		// The narrow staff's one note is untouched by the padding: it still
		// sits at its own natural position, close to the measure's own start,
		// not stretched or re-centred to fill the wider column.
		const noteOp = m1.ops.find((op) => op.kind === 'glyph' && op.glyph === 'noteheadWhole')!;
		expect(noteOp).toBeDefined();
		expect((noteOp as Extract<DrawOp, { kind: 'glyph' }>).x).toBeLessThan(m1.region.x + m1.region.width / 2);
	});

	it("each staff draws its own clef and its own correct key signature, independently of the other staff's", () => {
		// Staff 0: treble, D major (2 sharps, the score's own initial key).
		// Staff 1: bass, Eb major (3 flats), set as an explicit per-measure
		// override on staff 1's own measure 0 (`Score.keyFifthsAt` walks back
		// through each staff's own measures independently; see its own
		// comment), so the two staves genuinely disagree about the key, not
		// just the clef.
		const score = buildScore([[['D5', 'quarter']]], { clef: 'treble', keyFifths: 2 });
		score.appendStaff('bass');
		const m1 = score.appendMeasure(1);
		m1.keyFifths = -3;
		score.appendNote(m1, { pitch: parsePitch('Eb3'), value: 'quarter' });

		const layout = layoutScore(score, options);
		const laid0 = layout.measures.find((m) => m.staffIndex === 0)!;
		const laid1 = layout.measures.find((m) => m.staffIndex === 1)!;

		expect(findGlyph(laid0.ops, 'gClef')).toBeDefined();
		expect(findGlyph(laid0.ops, 'fClef')).toBeUndefined();
		expect(laid0.ops.filter((op) => op.kind === 'glyph' && op.glyph === 'accidentalSharp')).toHaveLength(2);
		expect(laid0.ops.filter((op) => op.kind === 'glyph' && op.glyph === 'accidentalFlat')).toHaveLength(0);

		expect(findGlyph(laid1.ops, 'fClef')).toBeDefined();
		expect(findGlyph(laid1.ops, 'gClef')).toBeUndefined();
		expect(laid1.ops.filter((op) => op.kind === 'glyph' && op.glyph === 'accidentalFlat')).toHaveLength(3);
		expect(laid1.ops.filter((op) => op.kind === 'glyph' && op.glyph === 'accidentalSharp')).toHaveLength(0);
	});

	it('rejects a score whose staves disagree on measure count', () => {
		const score = buildScore([[['C4', 'quarter']]], { clef: 'treble' });
		score.appendStaff('bass');
		score.appendMeasure(1);
		score.appendMeasure(1);
		expect(() => layoutScore(score, options)).toThrow(/measures/);
	});

	it('renders the grand-staff showcase (two staves, one system each measure column) without error', () => {
		const score = createGrandStaffShowcaseScore();
		for (const staff of score.staves) {
			for (const measure of staff.measures) {
				expect(validateMeasure(measure, score.timeAt(measure.index, measure.staffIndex)).valid).toBe(true);
			}
		}

		const layout = layoutScore(score);
		// Four measures, two staves.
		expect(layout.measures).toHaveLength(8);
		expect(findGlyph(layout.measures.find((m) => m.staffIndex === 0 && m.index === 0)!.ops, 'gClef')).toBeDefined();
		expect(findGlyph(layout.measures.find((m) => m.staffIndex === 1 && m.index === 0)!.ops, 'fClef')).toBeDefined();

		// Every measure column's barline aligns across both staves (see the
		// column-width-sharing test above), for all four columns, not just one.
		for (let i = 0; i < 4; i++) {
			const treble = layout.measures.find((m) => m.staffIndex === 0 && m.index === i)!;
			const bass = layout.measures.find((m) => m.staffIndex === 1 && m.index === i)!;
			expect(bass.region.x + bass.region.width).toBeCloseTo(treble.region.x + treble.region.width, 6);
		}
	});
});

describe('part grouping decorations (M2 Slice 5)', () => {
	const ss = 10;
	const options = { staffSpacePx: ss };

	/** An `staffCount`-staff score, `measuresPerStaff` identical one-quarter-
	 *  note measures per staff, with `parts` (`[staffIndices, name?]` pairs)
	 *  registered via `Score.addPart` in order. Built the same low-level way
	 *  every other multi-staff test fixture in this file is (`buildScore` only
	 *  ever populates one implicit staff). */
	function buildStavesScore(
		staffCount: number,
		parts: readonly (readonly [staffIndices: number[], name?: string])[],
		measuresPerStaff = 1
	) {
		const score = buildScore(
			Array.from({ length: measuresPerStaff }, () => [['C4', 'quarter']] as const),
			{ clef: 'treble' }
		);
		for (let staffIndex = 1; staffIndex < staffCount; staffIndex++) {
			score.appendStaff('treble');
			for (let i = 0; i < measuresPerStaff; i++) {
				const m = score.appendMeasure(staffIndex);
				score.appendNote(m, { pitch: parsePitch('C4'), value: 'quarter' });
			}
		}
		for (const [staffIndices, name] of parts) score.addPart(staffIndices, name);
		return score;
	}

	const glyphsOf = (ops: readonly DrawOp[]) => ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
	const textsOf = (ops: readonly DrawOp[]) => ops.flatMap((op) => (op.kind === 'text' ? [op.text] : []));

	it('a two-staff part draws a brace whose ink spans exactly its two staves\' outer height', () => {
		const score = buildStavesScore(2, [[[0, 1], 'Piano']]);
		const layout = layoutScore(score, options);

		expect(glyphsOf(layout.partDecorations)).toEqual(['brace']);
		const brace = layout.partDecorations.find(
			(op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === 'brace'
		)!;
		expect(brace.fontSizePx).toBeDefined();

		const staff0Top = layout.systems.find((s) => s.staffIndex === 0)!.topY;
		const staff1Top = layout.systems.find((s) => s.staffIndex === 1)!.topY;
		const expectedTop = staff0Top;
		const expectedBottom = staff1Top + 4 * ss;

		// Same y-bounds convention `glyphBounds` uses elsewhere in this file:
		// SMuFL bounding boxes are y-up, so `NE` gives the ink's canvas top and
		// `SW` its canvas bottom, scaled by this one glyph's own one-off
		// `fontSizePx` rather than the shared staff-space size.
		const native = GLYPH_METRICS.brace;
		const glyphScale = brace.fontSizePx! / (4 * ss);
		const inkTop = brace.y - native.bBoxNE[1] * ss * glyphScale;
		const inkBottom = brace.y - native.bBoxSW[1] * ss * glyphScale;
		expect(inkTop).toBeCloseTo(expectedTop, 6);
		expect(inkBottom).toBeCloseTo(expectedBottom, 6);
	});

	it('a three-or-more-staff part draws an assembled bracket spanning exactly its staves\' outer height', () => {
		const score = buildStavesScore(4, [[[0, 1, 2, 3], 'Choir']]);
		const layout = layoutScore(score, options);

		// Assembled from fixed hook pieces plus a plain rect spine, not a
		// single scaled `bracket` glyph (see `layoutBracket`'s own comment).
		expect(glyphsOf(layout.partDecorations)).toEqual(['bracketTop', 'bracketBottom']);
		expect(layout.partDecorations.some((op) => op.kind === 'rect')).toBe(true);

		const top = layout.systems.find((s) => s.staffIndex === 0)!.topY;
		const bottom = layout.systems.find((s) => s.staffIndex === 3)!.topY + 4 * ss;
		const hookHeight = GLYPH_METRICS.bracketTop.bBoxNE[1] * ss;

		const hookTopOp = layout.partDecorations.find(
			(op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === 'bracketTop'
		)!;
		const hookBottomOp = layout.partDecorations.find(
			(op): op is Extract<DrawOp, { kind: 'glyph' }> => op.kind === 'glyph' && op.glyph === 'bracketBottom'
		)!;
		const spineRect = layout.partDecorations.find((op): op is Extract<DrawOp, { kind: 'rect' }> => op.kind === 'rect')!;

		// The hooks' own ink meets the target span exactly: the top hook's own
		// outer edge sits `hookHeight` above where it's anchored, and the
		// bottom hook's the same distance below its own anchor.
		expect(hookTopOp.y - hookHeight).toBeCloseTo(top, 6);
		expect(hookBottomOp.y + hookHeight).toBeCloseTo(bottom, 6);
		// The spine rect joins the two hooks with no gap or overlap.
		expect(spineRect.y).toBeCloseTo(hookTopOp.y, 6);
		expect(spineRect.y + spineRect.height).toBeCloseTo(hookBottomOp.y, 6);
	});

	it('a single-staff part draws no brace/bracket, even when named', () => {
		const score = buildStavesScore(2, [[[0], 'Solo']]);
		const layout = layoutScore(score, options);
		expect(glyphsOf(layout.partDecorations)).toEqual([]);
		expect(textsOf(layout.partDecorations)).toEqual(['Solo']);
	});

	it('a non-contiguous multi-staff part is skipped (documented scope cut), not thrown', () => {
		const score = buildStavesScore(3, [[[0, 2], 'Divisi']]);
		expect(() => layoutScore(score, options)).not.toThrow();
		const layout = layoutScore(score, options);
		expect(glyphsOf(layout.partDecorations)).toEqual([]);
		// The (skipped) group's own name still labels staff 0, the most
		// specific named part covering it: the contiguity scope cut only
		// drops the connecting glyph, not the grouping's other effects.
		expect(textsOf(layout.partDecorations)).toEqual(['Divisi']);
	});

	it('a part-name label is drawn only at the first system; a brace/bracket repeats at every system', () => {
		const score = buildStavesScore(2, [[[0, 1], 'Piano']], 6);
		// Small enough that 6 one-quarter-note measures per staff cast off into
		// more than one system.
		const layout = layoutScore(score, { staffSpacePx: ss, systemWidthPx: 90 });
		expect(layout.systems.filter((s) => s.staffIndex === 0).length).toBeGreaterThan(1);

		expect(textsOf(layout.partDecorations)).toEqual(['Piano']);
		const systemCount = layout.systems.filter((s) => s.staffIndex === 0).length;
		expect(glyphsOf(layout.partDecorations).filter((g) => g === 'brace')).toHaveLength(systemCount);
	});

	it('a score with no multi-staff or named Part renders exactly as before this slice', () => {
		// The default `Score` (one staff, one unnamed part) and a score with a
		// second staff `appendStaff` alone adds (M2 Slice 3/4's own demos):
		// neither ever calls `addPart` with a real grouping or a name, so
		// `partDecorations` is empty and every measure's own `x` is unaffected
		// by this slice's new left-margin reservation.
		const solo = layoutScore(createDemoScore(), options);
		expect(solo.partDecorations).toEqual([]);
		// `layoutScore`'s own default `paddingPx` (16), unaffected by this
		// slice's `padding + decorationPlan.headerWidth` when `headerWidth` is 0.
		expect(solo.measures[0]!.region.x).toBeCloseTo(16, 6);

		const grand = layoutScore(createGrandStaffShowcaseScore());
		expect(grand.partDecorations).toEqual([]);
	});

	it('renders the SATB bracket showcase (four staves, one bracket, four labels) without error', () => {
		const score = createSatbBracketShowcaseScore();
		const layout = layoutScore(score);

		expect(glyphsOf(layout.partDecorations)).toEqual(['bracketTop', 'bracketBottom']);
		expect(textsOf(layout.partDecorations).sort()).toEqual(['Alto', 'Bass', 'Soprano', 'Tenor']);

		// Every staff's own measure still lays out and starts to the right of
		// the reserved header column, not on top of it.
		expect(layout.measures).toHaveLength(4);
		for (const measure of layout.measures) {
			expect(measure.region.x).toBeGreaterThan(16);
		}
	});
});

describe('cross-staff beaming (M2 Slice 6)', () => {
	const ss = 10;
	const options = { staffSpacePx: ss };
	const beamHeight = ED.beamThickness * ss;

	const isRect = (op: DrawOp): op is Extract<DrawOp, { kind: 'rect' }> => op.kind === 'rect';
	/** A beam segment: the one rect height unique to beams, the same identity
	 *  the `describe('beaming', ...)` block above uses. */
	const beamRects = (ops: readonly DrawOp[]) =>
		ops.filter(isRect).filter((op) => Math.abs(op.height - beamHeight) < 0.001);

	it("a cross-staff beam's region covers both staves' reach into the gap, without leaking into a neighbour", () => {
		const score = createCrossStaffBeamShowcaseScore();
		const layout = layoutScore(score, options);

		const treble1 = layout.measures.find((m) => m.staffIndex === 0 && m.index === 1)!;
		const bass1 = layout.measures.find((m) => m.staffIndex === 1 && m.index === 1)!;
		expect(treble1).toBeDefined();
		expect(bass1).toBeDefined();

		// (a) The two staves' own regions at the beamed column do not overlap
		// vertically, the same property Slice 4's own shared-barline test
		// checks: redrawing one staff's measure can never clear a pixel that
		// belongs to the other staff's ink.
		expect(treble1.region.y + treble1.region.height).toBeLessThanOrEqual(bass1.region.y + 0.001);

		// (b) Each side's ink genuinely reaches past its own ordinary staff
		// band, into the gap toward the other staff: not merely a vacuous
		// "regions don't overlap" result, but proof a stem/beam really
		// extends there. Compared against the plain single-staff band
		// (`staffTopY` to `staffTopY + 4*ss`) each staff would otherwise stay
		// within.
		const trebleTopY = layout.systems.find((s) => s.staffIndex === 0)!.topY;
		const bassTopY = layout.systems.find((s) => s.staffIndex === 1)!.topY;
		expect(treble1.region.y + treble1.region.height).toBeGreaterThan(trebleTopY + 4 * ss + 10);
		expect(bass1.region.y).toBeLessThan(bassTopY - 10);

		// (c) No leak into an unrelated neighbouring column. Note this is *not*
		// a height comparison against measure 0/2: since M2 Slice 4, every
		// column of a multi-staff score already draws its own segment of the
		// *shared end barline* reaching to this exact same `barlineSpan`
		// bound, regardless of that column's own note content (confirmed by
		// direct inspection: an ordinary filler measure's region already
		// reaches this far too, on the strength of its own barline segment
		// alone). So a plain height comparison to a neighbour cannot
		// distinguish "the beam reached here" from "the barline always
		// reaches here anyway", and would either pass vacuously or fail for
		// the wrong reason. The real, meaningful scoping proof is that the
		// cross-staff beam's own ink (tagged by its own note ids) is drawn
		// only inside its own measure's ops, on both staves, and never
		// appears in either neighbour's: nothing here ever asks a different
		// measure's `layoutMeasure` call to draw another measure's notes.
		const beam = score.crossStaffBeams[0]!;
		const hasCrossInk = (ops: readonly DrawOp[]) =>
			ops.some((op) => 'noteId' in op && op.noteId !== undefined && beam.noteIds.includes(op.noteId));
		expect(hasCrossInk(treble1.ops)).toBe(true);
		expect(hasCrossInk(bass1.ops)).toBe(true);
		const treble0 = layout.measures.find((m) => m.staffIndex === 0 && m.index === 0)!;
		const treble2 = layout.measures.find((m) => m.staffIndex === 0 && m.index === 2)!;
		const bass0 = layout.measures.find((m) => m.staffIndex === 1 && m.index === 0)!;
		const bass2 = layout.measures.find((m) => m.staffIndex === 1 && m.index === 2)!;
		expect(hasCrossInk(treble0.ops)).toBe(false);
		expect(hasCrossInk(treble2.ops)).toBe(false);
		expect(hasCrossInk(bass0.ops)).toBe(false);
		expect(hasCrossInk(bass2.ops)).toBe(false);
	});

	it('draws a real beam segment on each side, meeting at essentially the same y where they face the gap', () => {
		const score = createCrossStaffBeamShowcaseScore();
		const layout = layoutScore(score, options);

		const treble1 = layout.measures.find((m) => m.staffIndex === 0 && m.index === 1)!;
		const bass1 = layout.measures.find((m) => m.staffIndex === 1 && m.index === 1)!;

		const trebleBeams = beamRects(treble1.ops);
		const bassBeams = beamRects(bass1.ops);
		// One primary-level segment on each side (both notes are plain eighths,
		// needing only one beam level), each a genuine multi-note span, not a
		// degenerate stub.
		expect(trebleBeams).toHaveLength(1);
		expect(bassBeams).toHaveLength(1);
		expect(trebleBeams[0]!.width).toBeGreaterThan(0);
		expect(bassBeams[0]!.width).toBeGreaterThan(0);

		// Treble's stems point down into the gap, so its own beam segment sits
		// just above the join line, its *bottom* edge (y + height) at the true
		// shared boundary; bass's stems point up into the same gap, so its
		// beam segment sits just below the join line, its *top* edge there
		// instead. Those two gap-facing edges are what has to line up for the
		// two segments to read as one continuous beam; they land within a
		// couple of pixels of each other (the same `REGION_BLEED_PX`-scale
		// neutral strip `barlineSpan` leaves between the two staves).
		const trebleGapEdge = trebleBeams[0]!.y + trebleBeams[0]!.height;
		const bassGapEdge = bassBeams[0]!.y;
		expect(Math.abs(trebleGapEdge - bassGapEdge)).toBeLessThan(3);
	});

	it("a scoped redraw of one note in the pair correctly repaints both halves", () => {
		const score = createCrossStaffBeamShowcaseScore();
		const layout = layoutScore(score, options);

		const trebleBeamedNote = score.staves[0]!.measures[1]!.notes[0]!;
		const beforeTreble = layout.measures.find((m) => m.staffIndex === 0 && m.index === 1)!;
		const beforeBass = layout.measures.find((m) => m.staffIndex === 1 && m.index === 1)!;
		const beforeBeamGapEdge = beamRects(beforeTreble.ops)[0]!.y + beamRects(beforeTreble.ops)[0]!.height;

		const touched = score.transposeNote(trebleBeamedNote.id, 1);
		expect(touched).toBe(1);

		const updated = relayoutMeasure(score, layout, touched!, options, 0);
		// (a) The fast, genuinely scoped path succeeded, not a fallback to a
		// full `layoutScore`.
		expect(updated).not.toBeNull();

		// (b) The treble measure's own beam segment still meets the gap at
		// essentially the same y as before the edit: the join-y is derived
		// purely from staff geometry (`barlineSpan`), so a pitch change must
		// never move it.
		const afterTreble = updated!.measures.find((m) => m.staffIndex === 0 && m.index === 1)!;
		const afterBeams = beamRects(afterTreble.ops);
		expect(afterBeams).toHaveLength(1);
		const afterBeamGapEdge = afterBeams[0]!.y + afterBeams[0]!.height;
		expect(afterBeamGapEdge).toBeCloseTo(beforeBeamGapEdge, 6);

		// (c) The bass measure's own `LaidOutMeasure` object is the exact same
		// object as before the edit: nothing about the untouched staff was
		// recomputed at all, proving both no cross-region recomputation
		// happened and that "both halves" are still individually correct
		// after only one was actually redrawn.
		const afterBass = updated!.measures.find((m) => m.staffIndex === 1 && m.index === 1)!;
		expect(afterBass).toBe(beforeBass);
	});

	it('renders the cross-staff beam showcase (two staves, one continuous beam at measure 1) without error', () => {
		const score = createCrossStaffBeamShowcaseScore();
		for (const staff of score.staves) {
			for (const measure of staff.measures) {
				expect(validateMeasure(measure, score.timeAt(measure.index, measure.staffIndex)).valid).toBe(true);
			}
		}

		// Laid out at this describe block's own fixed `ss` (not the bare default)
		// so `beamRects`' identity (keyed on `ED.beamThickness * ss`) still
		// applies; every other showcase's own smoke test above lays out at
		// the bare default because it only checks glyphs, never rect sizes.
		const layout = layoutScore(score, options);
		// Three measures, two staves.
		expect(layout.measures).toHaveLength(6);
		const treble1 = layout.measures.find((m) => m.staffIndex === 0 && m.index === 1)!;
		const bass1 = layout.measures.find((m) => m.staffIndex === 1 && m.index === 1)!;
		expect(beamRects(treble1.ops)).toHaveLength(1);
		expect(beamRects(bass1.ops)).toHaveLength(1);
	});
});
