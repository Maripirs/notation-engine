// M6 Slice 2: chord engraving. One test (or a small group) per layout rule in
// plan.md's Slice 2 list, each on a hand-built measure small enough that the
// geometry can be read straight off the ops. Kept in its own file rather than
// appended to `layout.test.ts` (already ~2.9k lines) since every case here
// shares the same few helpers for "the ops belonging to one head".

import { describe, expect, it } from 'vitest';
import { createChordShowcaseScore } from '../demo-score.js';
import { buildScore, measureDurationWholes, validateMeasure, type MeasureSpec, type Score } from '../model/score.js';
import { ENGRAVING_DEFAULTS as ED, GLYPH_METRICS, type GlyphName } from '../render/glyph-metrics.js';
import { computeBeamGroups, layoutScore, middleLineForClef, relayoutMeasure } from './layout.js';
import type { DrawOp } from './types.js';

const SS = 10;
type GlyphOp = Extract<DrawOp, { kind: 'glyph' }>;
type RectOp = Extract<DrawOp, { kind: 'rect' }>;
type CurveOp = Extract<DrawOp, { kind: 'curve' }>;

function layoutOne(measures: readonly MeasureSpec[], keyFifths = 0) {
	const score = buildScore(measures, { keyFifths });
	const layout = layoutScore(score, { staffSpacePx: SS });
	return { score, layout, ops: layout.measures[0]!.ops };
}

/** Note ids of measure `m`, in `measure.notes` order (heads included). */
const ids = (score: Score, m = 0) => score.measures[m]!.notes.map((note) => note.id);

const glyphs = (ops: readonly DrawOp[], name: GlyphName) =>
	ops.filter((op): op is GlyphOp => op.kind === 'glyph' && op.glyph === name);
const headOf = (ops: readonly DrawOp[], id: string) =>
	ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.noteId === id && op.glyph.startsWith('notehead'))!;
const isStem = (op: DrawOp): op is RectOp =>
	op.kind === 'rect' && Math.abs(op.width - ED.stemThickness * SS) < 1e-6 && op.noteId !== undefined;
const isLedger = (op: DrawOp): op is RectOp =>
	op.kind === 'rect' && Math.abs(op.height - ED.legerLineThickness * SS) < 1e-6 && op.noteId !== undefined;
const curves = (ops: readonly DrawOp[]) => ops.filter((op): op is CurveOp => op.kind === 'curve');

describe('chord layout: one stem per chord (M6 Slice 2)', () => {
	it('draws a single stem spanning every head, measured from the near head', () => {
		const { score, ops } = layoutOne([[[['C4', 'E4', 'G4'], 'half'], [null, 'half']]]);
		const [c, e, g] = ids(score);
		const stems = ops.filter(isStem);
		expect(stems).toHaveLength(1);
		const stem = stems[0]!;
		// Up stem: from the lowest head (C4) to STEM_LENGTH (3.5) above the highest (G4).
		expect(stem.y + stem.height).toBeGreaterThan(headOf(ops, c!).y - SS);
		expect(stem.y + stem.height).toBeLessThanOrEqual(headOf(ops, c!).y);
		expect(stem.y).toBeCloseTo(headOf(ops, g!).y - 3.5 * SS, 6);
		// Every head shares one x (no seconds), right of which the up stem stands.
		expect(headOf(ops, e!).x).toBe(headOf(ops, c!).x);
		expect(stem.x).toBeGreaterThan(headOf(ops, c!).x);
	});

	it('picks the direction from the outermost head: a high triad stems down', () => {
		const { score, ops } = layoutOne([[[['E5', 'G5', 'C6'], 'half'], [['C4', 'E4', 'A4'], 'half']]]);
		const [e5, , c6, c4, , a4] = ids(score);
		const [down, up] = ops.filter(isStem);
		// Down stem: on the left edge of the heads, from the top head (C6) to
		// 3.5 spaces below the bottom one (E5).
		expect(down!.x).toBeCloseTo(headOf(ops, e5!).x, 6);
		const downAnchorY = GLYPH_METRICS.noteheadHalf.anchors.stemDownNW![1];
		expect(down!.y).toBeCloseTo(headOf(ops, c6!).y - downAnchorY * SS, 6);
		expect(down!.y + down!.height).toBeCloseTo(headOf(ops, e5!).y + 3.5 * SS, 6);
		expect(up!.x).toBeGreaterThan(headOf(ops, c4!).x);
		expect(up!.y).toBeCloseTo(headOf(ops, a4!).y - 3.5 * SS, 6);
	});
});

describe('chord layout: seconds (M6 Slice 2)', () => {
	const headWidth = GLYPH_METRICS.noteheadBlack.advance * SS;

	it('puts the upper head of a second right of an up stem', () => {
		const { score, ops } = layoutOne([[[['F4', 'G4'], 'quarter'], [null, 'quarter'], [null, 'half']]]);
		const [f, g] = ids(score);
		const stem = ops.find(isStem)!;
		expect(headOf(ops, g!).x - headOf(ops, f!).x).toBeCloseTo(headWidth - ED.stemThickness * SS, 6);
		// The stem sits between the two heads.
		expect(stem.x).toBeGreaterThan(headOf(ops, f!).x);
		expect(stem.x).toBeLessThanOrEqual(headOf(ops, g!).x + 1e-6);
	});

	it('puts the lower head of a second left of a down stem', () => {
		const { score, ops } = layoutOne([[[['C5', 'D5'], 'quarter'], [null, 'quarter'], [null, 'half']]]);
		const [c, d] = ids(score);
		const stem = ops.find(isStem)!;
		expect(headOf(ops, d!).x - headOf(ops, c!).x).toBeCloseTo(headWidth - ED.stemThickness * SS, 6);
		expect(stem.x).toBeCloseTo(headOf(ops, d!).x, 6);
	});

	it('alternates sides through a cluster', () => {
		const { score, ops } = layoutOne([
			[[['E4', 'F4', 'G4'], 'quarter'], [['B4', 'C5', 'D5', 'E5'], 'quarter'], [null, 'half']]
		]);
		const [e4, f4, g4, b4, c5, d5, e5] = ids(score);
		// Up stem, bottom-up: E4 normal, F4 across, G4 back on the normal side.
		expect(headOf(ops, g4!).x).toBe(headOf(ops, e4!).x);
		expect(headOf(ops, f4!).x).toBeGreaterThan(headOf(ops, e4!).x);
		// Down stem, top-down: E5 normal, D5 across (left), C5 normal, B4 across.
		expect(headOf(ops, c5!).x).toBe(headOf(ops, e5!).x);
		expect(headOf(ops, d5!).x).toBeLessThan(headOf(ops, e5!).x);
		expect(headOf(ops, b4!).x).toBe(headOf(ops, d5!).x);
	});

	it('reserves a notehead width for a chord with a second, so it never crowds the next column', () => {
		const plain = layoutOne([[[['F4', 'A4'], 'quarter'], ['C5', 'quarter'], [null, 'half']]]);
		const second = layoutOne([[[['F4', 'G4'], 'quarter'], ['C5', 'quarter'], [null, 'half']]]);
		const nextX = (run: typeof plain) => headOf(run.ops, ids(run.score)[2]!).x;
		expect(nextX(second) - nextX(plain)).toBeCloseTo(GLYPH_METRICS.noteheadBlack.advance * SS, 6);
	});
});

describe('chord layout: accidentals (M6 Slice 2)', () => {
	it('stacks three accidentals in columns: top nearest, then bottom, then the middle furthest left', () => {
		const { score, ops } = layoutOne([[[['Eb4', 'Gb4', 'Bb4'], 'whole']]]);
		const [eb, gb, bb] = ids(score);
		const flatX = (id: string) => glyphs(ops, 'accidentalFlat').find((op) => op.noteId === id)!.x;
		const headX = headOf(ops, eb!).x;
		expect(glyphs(ops, 'accidentalFlat')).toHaveLength(3);
		expect(flatX(bb!)).toBeGreaterThan(flatX(eb!));
		expect(flatX(eb!)).toBeGreaterThan(flatX(gb!));
		// Columns do not overlap one another, and all sit left of the heads.
		const flatWidth = GLYPH_METRICS.accidentalFlat.advance * SS;
		expect(flatX(bb!) - flatX(eb!)).toBeGreaterThanOrEqual(flatWidth);
		expect(flatX(eb!) - flatX(gb!)).toBeGreaterThanOrEqual(flatWidth);
		expect(flatX(bb!) + flatWidth).toBeLessThan(headX);
	});

	it('lets accidentals a seventh or more apart share a column', () => {
		const { ops } = layoutOne([[[['F#4', 'F#5'], 'whole']]]);
		const sharps = glyphs(ops, 'accidentalSharp');
		// Both octaves show their sharp: the chord is judged against the state before it.
		expect(sharps).toHaveLength(2);
		expect(sharps[0]!.x).toBeCloseTo(sharps[1]!.x, 6);
	});

	it('keeps the per-measure accidental state working through chord members', () => {
		const { ops } = layoutOne([[[['F#4', 'A4'], 'quarter'], ['F#4', 'quarter'], ['F4', 'quarter'], [['F#4', 'C5'], 'quarter']]]);
		// F#4 stated in the chord carries to the next F#4 (suppressed); F4 needs
		// its natural; the chord's F#4 after it needs its sharp again.
		expect(glyphs(ops, 'accidentalSharp')).toHaveLength(2);
		expect(glyphs(ops, 'accidentalNatural')).toHaveLength(1);
	});
});

describe('chord layout: ledger lines and dots (M6 Slice 2)', () => {
	it('draws each ledger once, widened where a displaced head needs it', () => {
		const { score, ops } = layoutOne([[[['A3', 'B3', 'D4'], 'whole']]]);
		const [a3, b3] = ids(score);
		const ledgers = ops.filter(isLedger);
		// C4 and A3: two ledgers, no duplicates for the three heads.
		expect(ledgers).toHaveLength(2);
		const [c4Ledger, a3Ledger] = [...ledgers].sort((p, q) => p.y - q.y);
		// The C4 ledger is needed by both A3 (normal) and B3 (displaced right):
		// it spans both columns. The A3 ledger only the normal one.
		expect(c4Ledger!.width).toBeGreaterThan(a3Ledger!.width);
		expect(c4Ledger!.x + c4Ledger!.width).toBeGreaterThan(headOf(ops, b3!).x + GLYPH_METRICS.noteheadWhole.advance * SS);
		expect(a3Ledger!.x).toBeLessThan(headOf(ops, a3!).x);
	});

	it('draws a dot per head in one column, a line head moving to the space above', () => {
		const { score, ops } = layoutOne([[[['F4', 'G4', 'B4'], 'half', { dots: 1 }], [null, 'quarter']]]);
		const [, g4] = ids(score);
		const dots = glyphs(ops, 'augmentationDot');
		expect(dots).toHaveLength(3);
		// One column, right of the displaced G4 head.
		expect(new Set(dots.map((dot) => dot.x)).size).toBe(1);
		expect(dots[0]!.x).toBeGreaterThan(headOf(ops, g4!).x + GLYPH_METRICS.noteheadHalf.advance * SS);
		// F4 (space) keeps its own y; G4 and B4 (lines) move half a space up:
		// three distinct spaces, F4, A4 and C5.
		const ys = dots.map((dot) => dot.y).sort((p, q) => p - q);
		expect(ys[1]! - ys[0]!).toBeCloseTo(SS, 6);
		expect(ys[2]! - ys[1]!).toBeCloseTo(SS, 6);
	});

	it('moves a clashing dot to the space below instead of losing it', () => {
		// E4 and F4 are a second apart with E4 on a line: E4's space above is
		// F4's own space, so E4's dot drops to the space below (D4).
		const { ops } = layoutOne([[[['E4', 'F4'], 'half', { dots: 1 }], [null, 'quarter']]]);
		const ys = glyphs(ops, 'augmentationDot').map((dot) => dot.y).sort((p, q) => p - q);
		expect(ys).toHaveLength(2);
		expect(ys[1]! - ys[0]!).toBeCloseTo(SS, 6);
	});
});

describe('chord layout: ties per member (M6 Slice 2)', () => {
	it('ties each head to its own target, upper heads curving up and lower heads down', () => {
		const { score, ops } = layoutOne([
			[[['D4', 'F4', 'A4'], 'half', { tiedToNext: true }], [['D4', 'F4', 'A4'], 'half']]
		]);
		const [d, f, a, d2, f2, a2] = ids(score);
		expect(score.findNote(d!)!.tiedToId).toBe(d2);
		expect(score.findNote(f!)!.tiedToId).toBe(f2);
		expect(score.findNote(a!)!.tiedToId).toBe(a2);
		const ties = curves(ops);
		expect(ties.map((tie) => tie.noteId).sort()).toEqual([d, f, a].sort());
		const bulgesBelow = (id: string) => {
			const tie = ties.find((t) => t.noteId === id)!;
			return tie.cy0 > tie.y0;
		};
		expect(bulgesBelow(d!)).toBe(true);
		expect(bulgesBelow(a!)).toBe(false);
		// The middle head of an odd count goes away from the (up) stem: below.
		expect(bulgesBelow(f!)).toBe(true);
	});
});

describe('chord layout: beaming (M6 Slice 2)', () => {
	it('treats a chord as one beam member and attaches the stems to it', () => {
		const measure: MeasureSpec = [
			[['C4', 'E4'], 'eighth'],
			[['D4', 'F4'], 'eighth'],
			[null, 'quarter'],
			[null, 'half']
		];
		const { score, ops } = layoutOne([measure]);
		const notes = score.measures[0]!.notes;
		const groups = computeBeamGroups(notes, score.time, middleLineForClef('treble'));
		expect(groups).toHaveLength(1);
		expect(groups[0]!.notes.map((note) => note.id)).toEqual([notes[0]!.id, notes[2]!.id]);
		expect(groups[0]!.direction).toBe('up');

		// Two stems (one per chord) reaching the beam, and no flags.
		const stems = ops.filter(isStem);
		expect(stems).toHaveLength(2);
		expect(glyphs(ops, 'flag8thUp')).toHaveLength(0);
		expect(stems[0]!.y).toBeCloseTo(stems[1]!.y, 6);
		// Each stem reaches down to its chord's lowest head.
		expect(stems[0]!.y + stems[0]!.height).toBeGreaterThan(headOf(ops, notes[1]!.id).y);
	});

	it('lets every head vote in the group direction', () => {
		// Lone anchors C5/D5 would stem down, but the chords' far-low A3/B3
		// heads are the farthest from the middle line: the group stems up.
		const score = buildScore([[[['A3', 'C5'], 'eighth'], [['B3', 'D5'], 'eighth'], [null, 'quarter'], [null, 'half']]]);
		const groups = computeBeamGroups(score.measures[0]!.notes, score.time, middleLineForClef('treble'));
		expect(groups[0]!.direction).toBe('up');
	});
});

describe('chord layout: two voices of chords (M6 Slice 2)', () => {
	it('stems voice 1 up and voice 2 down, every voice counting its chords once', () => {
		const { score, ops } = layoutOne([
			[
				[['E5', 'G5'], 'half', { voice: 1 }],
				[['D5', 'F5'], 'half', { voice: 1 }],
				[['C4', 'E4'], 'half', { voice: 2 }],
				[['B3', 'D4'], 'half', { voice: 2 }]
			]
		]);
		expect(validateMeasure(score.measures[0]!, score.time).valid).toBe(true);
		const [e5, , d5, , c4, , b3] = ids(score);
		// The two voices' chords share onset columns.
		expect(headOf(ops, c4!).x).toBeCloseTo(headOf(ops, e5!).x, 6);
		expect(headOf(ops, b3!).x).toBeCloseTo(headOf(ops, d5!).x, 6);
		const stems = ops.filter(isStem);
		expect(stems).toHaveLength(4);
		const stemOf = (id: string) => stems.find((stem) => stem.noteId === id)!;
		expect(stemOf(e5!).y).toBeLessThan(headOf(ops, e5!).y);
		expect(stemOf(c4!).y + stemOf(c4!).height).toBeGreaterThan(headOf(ops, c4!).y);
	});
});

describe('chord layout: per-head identity (M6 Slice 2)', () => {
	it('gives every head its own hit box', () => {
		const { score, layout } = layoutOne([[[['C4', 'E4', 'G4'], 'whole']]]);
		expect(layout.measures[0]!.notes.map((note) => note.id)).toEqual(ids(score));
	});

	it('transposes one member alone and re-lays out its displacement', () => {
		const score = buildScore([[[['E4', 'G4'], 'half'], [null, 'half']]]);
		const layout = layoutScore(score, { staffSpacePx: SS });
		const [e4, g4] = ids(score);
		expect(headOf(layout.measures[0]!.ops, g4!).x).toBe(headOf(layout.measures[0]!.ops, e4!).x);

		// G4 down two semitones to F4: now a second above E4, so it crosses the stem.
		expect(score.transposeNote(g4!, -2)).toBe(0);
		expect(score.findNote(e4!)!.pitch).toEqual({ step: 'E', alter: 0, octave: 4 });
		// The column widens for the new second, so the scoped path declines and
		// a full relayout is the honest answer.
		expect(relayoutMeasure(score, layout, 0, { staffSpacePx: SS })).toBeNull();
		const fresh = layoutScore(score, { staffSpacePx: SS }).measures[0]!.ops;
		expect(headOf(fresh, g4!).x).toBeGreaterThan(headOf(fresh, e4!).x);
	});

	it('lays out the chord showcase with every measure full', () => {
		const score = createChordShowcaseScore();
		for (const measure of score.measures) {
			expect(validateMeasure(measure, score.timeAt(measure.index)).valid).toBe(true);
		}
		// A single-voice chord measure sums to one 4/4 bar, not one per head.
		expect(measureDurationWholes(score.measures[0]!)).toBeCloseTo(1, 9);
		expect(() => layoutScore(score)).not.toThrow();
	});
});
