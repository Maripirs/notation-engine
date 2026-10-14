// M6 Slice 5: articulation and fermata placement. One test (or a small
// group) per rule `layoutEventMarks` implements, each on a hand-built measure
// small enough that the geometry reads straight off the ops. Positions are
// checked in half-space steps relative to the treble staff's bottom line
// (E4), so "in a space, not on a line" is an exact parity check.

import { describe, expect, it } from 'vitest';
import { createArticulationShowcaseScore } from '../demo-score.js';
import { buildScore, type MeasureSpec, type Score } from '../model/score.js';
import { GLYPH_METRICS, type GlyphName } from '../render/glyph-metrics.js';
import { layoutScore, relayoutMeasure } from './layout.js';
import type { DrawOp, LaidOutScore } from './types.js';

const SS = 10;
type GlyphOp = Extract<DrawOp, { kind: 'glyph' }>;
type RectOp = Extract<DrawOp, { kind: 'rect' }>;

function layoutOne(measures: readonly MeasureSpec[]) {
	const score = buildScore(measures, { keyFifths: 0 });
	const layout = layoutScore(score, { staffSpacePx: SS });
	return { score, layout, ops: layout.measures[0]!.ops };
}

const ids = (score: Score, m = 0) => score.measures[m]!.notes.map((note) => note.id);
const isMark = (op: DrawOp): op is GlyphOp =>
	op.kind === 'glyph' && (op.glyph.startsWith('artic') || op.glyph.startsWith('fermata'));
const marksOf = (ops: readonly DrawOp[], id: string) => ops.filter((op): op is GlyphOp => isMark(op) && op.noteId === id);
const headOf = (ops: readonly DrawOp[], id: string) =>
	ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.noteId === id && op.glyph.startsWith('notehead'))!;
const stemOf = (ops: readonly DrawOp[], id: string) =>
	ops.find((op): op is RectOp => op.kind === 'rect' && op.noteId === id && op.height > 2 * SS)!;

/** A glyph op's ink box, canvas coordinates. */
function box(op: GlyphOp): { top: number; bottom: number; centreX: number; centreY: number } {
	const { bBoxSW, bBoxNE } = GLYPH_METRICS[op.glyph as GlyphName];
	const top = op.y - bBoxNE[1] * SS;
	const bottom = op.y - bBoxSW[1] * SS;
	return { top, bottom, centreX: op.x + ((bBoxSW[0] + bBoxNE[0]) / 2) * SS, centreY: (top + bottom) / 2 };
}

/** Half-space steps above the bottom staff line (0 = E4 in treble, 8 = F5). */
const stepsAboveBottomLine = (layout: LaidOutScore, y: number) => (layout.staffTopY + 4 * SS - y) / (SS / 2);
/** A staff line (0..8, even) or a ledger line (even, within `ledgerFrom..ledgerTo`). */
function onLine(steps: number, ledgerFrom = 0, ledgerTo = 8): boolean {
	const p = Math.round(steps);
	return Math.abs(steps - p) < 1e-6 && p % 2 === 0 && p >= Math.min(0, ledgerFrom) && p <= Math.max(8, ledgerTo);
}

describe('articulation placement: side and spacing (M6 Slice 5)', () => {
	it('puts a staccato above a stem-down note, centred on the head, in a space', () => {
		const { score, layout, ops } = layoutOne([[['C5', 'quarter', { articulations: ['staccato'] }], [null, 'half', { dots: 1 }]]]);
		const [c5] = ids(score);
		const [mark] = marksOf(ops, c5!);
		expect(mark!.glyph).toBe('articStaccatoAbove');
		const head = box(headOf(ops, c5!));
		const m = box(mark!);
		expect(m.bottom).toBeLessThan(head.top);
		expect(m.centreX).toBeCloseTo(head.centreX, 6);
		// C5 is the third space (step 5); the next space up, E5, is step 7.
		expect(stepsAboveBottomLine(layout, m.centreY)).toBeCloseTo(7, 6);
	});

	it('puts a staccato below a stem-up note, skipping the line a line-note mark would sit on', () => {
		const { score, layout, ops } = layoutOne([[['G4', 'quarter', { articulations: ['staccato'] }], [null, 'half', { dots: 1 }]]]);
		const [g4] = ids(score);
		const [mark] = marksOf(ops, g4!);
		expect(mark!.glyph).toBe('articStaccatoBelow');
		const m = box(mark!);
		expect(m.top).toBeGreaterThan(box(headOf(ops, g4!)).bottom);
		// G4 is step 2 (a line). Two steps down (E4) is the bottom line, so the
		// dot goes one further, into the space below the staff (D4, step -1).
		expect(stepsAboveBottomLine(layout, m.centreY)).toBeCloseTo(-1, 6);
		expect(onLine(stepsAboveBottomLine(layout, m.centreY))).toBe(false);
	});

	it('puts a tenuto in the nearest space too, and a mark above a whole note and a rest', () => {
		const { score, layout, ops } = layoutOne([
			[['B4', 'quarter', { articulations: ['tenuto'] }], [null, 'quarter', { articulations: ['accent'] }], [null, 'half']],
			[['A4', 'whole', { articulations: ['staccato'] }]]
		]);
		const [b4, rest] = ids(score);
		const tenuto = box(marksOf(ops, b4!)[0]!);
		// B4 (middle line, step 4) stems down: tenuto above, step 6 is a line, so step 7.
		expect(stepsAboveBottomLine(layout, tenuto.centreY)).toBeCloseTo(7, 6);
		expect(marksOf(ops, rest!)[0]!.glyph).toBe('articAccentAbove');
		const whole = layout.measures[1]!.ops;
		const [a4] = ids(score, 1);
		expect(marksOf(whole, a4!)[0]!.glyph).toBe('articStaccatoAbove');
	});

	it('moves an accent that would cross the staff lines outside the staff', () => {
		const { score, layout, ops } = layoutOne([[['F4', 'quarter', { articulations: ['accent'] }], [null, 'half', { dots: 1 }]]]);
		const [f4] = ids(score);
		const accent = box(marksOf(ops, f4!)[0]!);
		expect(marksOf(ops, f4!)[0]!.glyph).toBe('articAccentBelow');
		expect(accent.top).toBeGreaterThan(layout.staffTopY + 4 * SS);
	});

	it('always puts a marcato above, beyond the stem tip of a stem-up note', () => {
		const { score, ops } = layoutOne([[['E4', 'quarter', { articulations: ['strong-accent'] }], [null, 'half', { dots: 1 }]]]);
		const [e4] = ids(score);
		const [mark] = marksOf(ops, e4!);
		expect(mark!.glyph).toBe('articMarcatoAbove');
		expect(box(mark!).bottom).toBeLessThan(stemOf(ops, e4!).y);
	});
});

describe('articulation placement: stacks, chords, ledger lines (M6 Slice 5)', () => {
	it('stacks several marks outward: staccato nearest, then the accent', () => {
		const { score, layout, ops } = layoutOne([
			[['C5', 'quarter', { articulations: ['accent', 'staccato'] }], ['F4', 'quarter', { articulations: ['accent', 'tenuto'] }], [null, 'half']]
		]);
		const [c5, f4] = ids(score);
		const above = marksOf(ops, c5!);
		expect(above.map((op) => op.glyph)).toEqual(['articStaccatoAbove', 'articAccentAbove']);
		const [staccato, accent] = above.map(box);
		expect(accent!.bottom).toBeLessThan(staccato!.top);
		// The accent ends up outside the staff, the staccato inside it.
		expect(accent!.bottom).toBeLessThan(layout.staffTopY);
		expect(staccato!.centreY).toBeGreaterThan(layout.staffTopY);
		const below = marksOf(ops, f4!);
		expect(below.map((op) => op.glyph)).toEqual(['articTenutoBelow', 'articAccentBelow']);
		expect(box(below[1]!).top).toBeGreaterThan(box(below[0]!).bottom);
	});

	it('draws a chord mark once, at the stem-opposite end, whichever head carries it', () => {
		const score = buildScore([[[['C4', 'E4', 'G4'], 'quarter'], [['C5', 'E5', 'G5'], 'quarter'], [null, 'half']]], { keyFifths: 0 });
		// Put the marks on members rather than anchors, as an import can.
		const [c4, e4, , c5, , g5] = ids(score);
		score.findNote(e4!)!.articulations = ['accent'];
		score.findNote(g5!)!.articulations = ['staccato'];
		const ops = layoutScore(score, { staffSpacePx: SS }).measures[0]!.ops;
		const all = ops.filter(isMark);
		expect(all).toHaveLength(2);
		// Up-stem low triad: below its lowest head, centred on the column.
		const accent = box(marksOf(ops, e4!)[0]!);
		expect(accent.top).toBeGreaterThan(box(headOf(ops, c4!)).bottom);
		expect(accent.centreX).toBeCloseTo(box(headOf(ops, c4!)).centreX, 6);
		// Down-stem high triad: above its highest head.
		const staccato = box(marksOf(ops, g5!)[0]!);
		expect(staccato.bottom).toBeLessThan(box(headOf(ops, g5!)).top);
		expect(staccato.bottom).toBeLessThan(box(headOf(ops, c5!)).top);
	});

	it('clears ledger lines: a staccato beyond a ledger-line note sits in a space past the head', () => {
		const { score, layout, ops } = layoutOne([
			[['A5', 'quarter', { articulations: ['staccato'] }], ['C6', 'quarter', { articulations: ['staccato'] }], ['A3', 'quarter', { articulations: ['staccato'] }], ['C4', 'quarter', { articulations: ['tenuto'] }]]
		]);
		const [a5, c6, a3, c4] = ids(score);
		// A5 (step 10, on its ledger line) stems down: the dot goes above, one
		// space out (step 12). No ledger line exists there (they only reach out
		// to the head), so it needs no further step.
		const overA5 = box(marksOf(ops, a5!)[0]!);
		expect(overA5.bottom).toBeLessThan(box(headOf(ops, a5!)).top);
		expect(stepsAboveBottomLine(layout, overA5.centreY)).toBeCloseTo(12, 6);
		expect(onLine(stepsAboveBottomLine(layout, overA5.centreY), 0, 10)).toBe(false);
		const overC6 = box(marksOf(ops, c6!)[0]!);
		expect(onLine(stepsAboveBottomLine(layout, overC6.centreY), 0, 12)).toBe(false);
		// A3 (step -4, on the second ledger line below) stems up: the dot goes
		// below it, past every ledger line, one space out.
		const underA3 = box(marksOf(ops, a3!)[0]!);
		expect(underA3.top).toBeGreaterThan(box(headOf(ops, a3!)).bottom);
		expect(stepsAboveBottomLine(layout, underA3.centreY)).toBeCloseTo(-6, 6);
		const underC4 = box(marksOf(ops, c4!)[0]!);
		expect(underC4.top).toBeGreaterThan(box(headOf(ops, c4!)).bottom);
		expect(onLine(stepsAboveBottomLine(layout, underC4.centreY), -2, 8)).toBe(false);
	});
});

describe('fermata placement (M6 Slice 5)', () => {
	it('puts a fermata above the staff and above the stem, centred on the note', () => {
		const { score, layout, ops } = layoutOne([
			[['G4', 'quarter', { fermata: 'upright' }], ['A5', 'quarter', { fermata: 'upright', articulations: ['accent'] }], [null, 'half']]
		]);
		const [g4, a5] = ids(score);
		const overG4 = box(marksOf(ops, g4!)[0]!);
		expect(marksOf(ops, g4!)[0]!.glyph).toBe('fermataAbove');
		expect(overG4.bottom).toBeLessThan(layout.staffTopY);
		expect(overG4.bottom).toBeLessThan(stemOf(ops, g4!).y);
		expect(overG4.centreX).toBeCloseTo(box(headOf(ops, g4!)).centreX, 6);
		// Above the high note's own accent, not just above the staff.
		const [accent, fermata] = marksOf(ops, a5!).map(box);
		expect(fermata!.bottom).toBeLessThan(accent!.top);
	});

	it('puts a fermata over a rest (and over a whole-measure rest once centred)', () => {
		const { score, layout, ops } = layoutOne([[['C5', 'half'], [null, 'half', { fermata: 'upright' }]]]);
		const [, rest] = ids(score);
		const restGlyph = ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.noteId === rest && op.glyph.startsWith('rest'))!;
		const fermata = box(marksOf(ops, rest!)[0]!);
		expect(fermata.bottom).toBeLessThan(layout.staffTopY);
		expect(fermata.centreX).toBeCloseTo(box(restGlyph).centreX, 6);

		const measureRest = new (score.constructor as typeof Score)({ keyFifths: 0 });
		const m = measureRest.appendMeasure();
		const r = measureRest.appendNote(m, { pitch: null, value: 'whole', measureRestWholes: 1, fermata: 'upright' });
		const mops = layoutScore(measureRest, { staffSpacePx: SS }).measures[0]!.ops;
		const rg = mops.find((op): op is GlyphOp => op.kind === 'glyph' && op.glyph === 'restWhole')!;
		expect(box(marksOf(mops, r.id)[0]!).centreX).toBeCloseTo(box(rg).centreX, 6);
	});

	it('puts an inverted fermata below the staff', () => {
		const { score, layout, ops } = layoutOne([[['D4', 'quarter', { fermata: 'inverted' }], [null, 'half', { dots: 1 }]]]);
		const [d4] = ids(score);
		const [mark] = marksOf(ops, d4!);
		expect(mark!.glyph).toBe('fermataBelow');
		expect(box(mark!).top).toBeGreaterThan(Math.max(layout.staffTopY + 4 * SS, box(headOf(ops, d4!)).bottom));
	});
});

describe('two voices on one staff (M6 Slice 5)', () => {
	it("puts voice 1's marks above (beyond its up stem) and voice 2's below", () => {
		const { score, ops } = layoutOne([
			[
				['E5', 'half', { voice: 1, articulations: ['staccato'] }],
				['D5', 'half', { voice: 1, articulations: ['accent'] }],
				['G4', 'half', { voice: 2, articulations: ['staccato'] }],
				['F4', 'half', { voice: 2, articulations: ['tenuto'] }]
			]
		]);
		const [e5, d5, g4, f4] = ids(score);
		for (const id of [e5!, d5!]) {
			const [mark] = marksOf(ops, id);
			expect(mark!.glyph.endsWith('Above')).toBe(true);
			const stem = stemOf(ops, id);
			expect(box(mark!).bottom).toBeLessThan(stem.y);
			// Centred on the stem at the stem end.
			expect(box(mark!).centreX).toBeCloseTo(stem.x + stem.width / 2, 6);
		}
		for (const id of [g4!, f4!]) {
			const [mark] = marksOf(ops, id);
			expect(mark!.glyph.endsWith('Below')).toBe(true);
			const stem = stemOf(ops, id);
			expect(box(mark!).top).toBeGreaterThan(stem.y + stem.height);
		}
	});
});

describe('marks and region-scoped redraw (M6 Slice 5)', () => {
	it("grows the measure's region to cover its fermata, and a relayout keeps it covered", () => {
		const score = buildScore([[['A5', 'whole', { fermata: 'upright', articulations: ['accent'] }]], [['C5', 'whole']]], { keyFifths: 0 });
		const layout = layoutScore(score, { staffSpacePx: SS });
		const measure = layout.measures[0]!;
		const fermata = box(measure.ops.find((op): op is GlyphOp => isMark(op) && op.glyph === 'fermataAbove')!);
		expect(measure.region.y).toBeLessThanOrEqual(fermata.top);
		const plain = layout.measures[1]!;
		expect(measure.region.y).toBeLessThan(plain.region.y);

		const id = score.measures[0]!.notes[0]!.id;
		score.transposeNote(id, -2);
		const relaid = relayoutMeasure(score, layout, 0, { staffSpacePx: SS });
		expect(relaid).not.toBeNull();
		const after = relaid!.measures[0]!;
		for (const op of after.ops.filter(isMark)) {
			expect(box(op).top).toBeGreaterThanOrEqual(after.region.y);
		}
	});

	it('lays out the showcase with one mark op per written mark', () => {
		const score = createArticulationShowcaseScore();
		const layout = layoutScore(score, { staffSpacePx: SS, systemWidthPx: 900 });
		let written = 0;
		for (const measure of score.measures) {
			for (const note of measure.notes) written += note.articulations.length + (note.fermata ? 1 : 0);
		}
		const drawn = layout.measures.reduce((sum, m) => sum + m.ops.filter(isMark).length, 0);
		expect(drawn).toBe(written);
	});
});
