// M6 Slice 8: grace note layout. Each rule `layoutGraceRun` implements gets a
// hand-built measure small enough to read the geometry straight off the ops:
// cue size, placement just left of the principal, stem up, the acciaccatura
// slash, beamed runs, cue-size accidentals, a grace at the end of a measure,
// hit-testing, and that every grace op stays inside the measure's region.

import { describe, expect, it } from 'vitest';
import { createGraceShowcaseScore } from '../demo-score.js';
import { ACCIACCATURA, APPOGGIATURA, buildScore, validateMeasure, type MeasureSpec, type Score } from '../model/index.js';
import { GLYPH_METRICS, STAFF_SPACES_PER_EM, type GlyphName } from '../render/glyph-metrics.js';
import { hitTest } from './hit-test.js';
import { GRACE_SCALE, layoutScore, relayoutMeasure } from './layout.js';
import type { DrawOp, LaidOutMeasure } from './types.js';

const SS = 10;
type GlyphOp = Extract<DrawOp, { kind: 'glyph' }>;
type RectOp = Extract<DrawOp, { kind: 'rect' }>;
type CurveOp = Extract<DrawOp, { kind: 'curve' }>;

function layoutOne(measures: readonly MeasureSpec[]) {
	const score = buildScore(measures, { keyFifths: 0 });
	const layout = layoutScore(score, { staffSpacePx: SS });
	return { score, layout, measure: layout.measures[0]!, ops: layout.measures[0]!.ops };
}

const ids = (score: Score, m = 0) => score.measures[m]!.notes.map((note) => note.id);
const opsOf = (ops: readonly DrawOp[], id: string) => ops.filter((op) => 'noteId' in op && op.noteId === id);
const headOf = (ops: readonly DrawOp[], id: string) =>
	ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.noteId === id && op.glyph.startsWith('notehead'))!;
const stemsOf = (ops: readonly DrawOp[], id: string) =>
	ops.filter((op): op is RectOp => op.kind === 'rect' && op.noteId === id && op.height > op.width * 4);
const curvesOf = (ops: readonly DrawOp[], id: string) => ops.filter((op): op is CurveOp => op.kind === 'curve' && op.noteId === id);
const graceFont = SS * STAFF_SPACES_PER_EM * GRACE_SCALE;
const right = (op: GlyphOp, unit: number) => op.x + GLYPH_METRICS[op.glyph as GlyphName].bBoxNE[0] * unit;

describe('grace note layout (M6 Slice 8)', () => {
	it('draws a grace head cue-sized, just left of its principal', () => {
		const { score, ops } = layoutOne([[['D5', 'eighth', { grace: ACCIACCATURA }], ['C5', 'whole']]]);
		const [grace, principal] = ids(score);
		const graceHead = headOf(ops, grace!);
		const principalHead = headOf(ops, principal!);
		expect(graceHead.fontSizePx).toBeCloseTo(graceFont, 10);
		expect(principalHead.fontSizePx).toBeUndefined();
		const gap = principalHead.x - right(graceHead, GRACE_SCALE * SS);
		expect(gap).toBeGreaterThan(0);
		expect(gap).toBeLessThan(2 * SS);
		// Same staff position as a full-size D5 would have: its own line.
		const full = layoutOne([[['D5', 'whole']]]);
		expect(graceHead.y).toBeCloseTo(headOf(full.ops, ids(full.score)[0]!).y, 10);
	});

	it('makes room for the grace without moving the measure rhythm', () => {
		const plain = layoutOne([[['C5', 'quarter'], ['D5', 'quarter'], ['E5', 'half']]]);
		const graced = layoutOne([[['C5', 'quarter'], ['G5', 'eighth', { grace: APPOGGIATURA }], ['D5', 'quarter'], ['E5', 'half']]]);
		const x = (r: ReturnType<typeof layoutOne>, i: number) => headOf(r.ops, ids(r.score)[i]!).x;
		expect(x(graced, 0)).toBeCloseTo(x(plain, 0), 10);
		// Everything from the principal on shifts by the run's fixed width.
		const shift = x(graced, 2) - x(plain, 1);
		expect(shift).toBeGreaterThan(SS);
		expect(x(graced, 3) - x(plain, 2)).toBeCloseTo(shift, 10);
		expect(graced.measure.region.width - plain.measure.region.width).toBeCloseTo(shift, 10);
	});

	it('stems a grace up even high on the staff, with a cue flag and a slash only when slashed', () => {
		const slashed = layoutOne([[['A5', 'eighth', { grace: ACCIACCATURA }], ['C5', 'whole']]]);
		const [g] = ids(slashed.score);
		const head = headOf(slashed.ops, g!);
		const [stem] = stemsOf(slashed.ops, g!);
		expect(stem!.y).toBeLessThan(head.y - SS);
		expect(stem!.x).toBeGreaterThan(head.x);
		const flag = slashed.ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.noteId === g && op.glyph === 'flag8thUp');
		expect(flag?.fontSizePx).toBeCloseTo(graceFont, 10);
		const [slash] = curvesOf(slashed.ops, g!);
		expect(slash).toBeDefined();
		// Rising to the right, crossing the stem.
		expect(slash!.x0).toBeLessThan(stem!.x);
		expect(slash!.x1).toBeGreaterThan(stem!.x);
		expect(slash!.y1).toBeLessThan(slash!.y0);

		const plain = layoutOne([[['A5', 'eighth', { grace: APPOGGIATURA }], ['C5', 'whole']]]);
		expect(curvesOf(plain.ops, ids(plain.score)[0]!)).toHaveLength(0);
	});

	it('beams consecutive grace 16ths with two cue-thickness beams and no flags', () => {
		const { score, ops } = layoutOne([
			[['B4', '16th', { grace: APPOGGIATURA }], ['D5', '16th', { grace: APPOGGIATURA }], ['C5', 'whole']]
		]);
		const [g1, g2] = ids(score);
		expect(ops.some((op) => op.kind === 'glyph' && op.glyph.startsWith('flag') && (op.noteId === g1 || op.noteId === g2))).toBe(false);
		const beamThickness = 0.5 * GRACE_SCALE * SS;
		const beams = opsOf(ops, g1!).filter((op): op is RectOp => op.kind === 'rect' && Math.abs(op.height - beamThickness) < 1e-6);
		expect(beams).toHaveLength(2);
		const [s1] = stemsOf(ops, g1!);
		const [s2] = stemsOf(ops, g2!);
		// Both stems end at the beam's outer edge.
		expect(s1!.y).toBeCloseTo(s2!.y, 10);
		expect(beams[0]!.x).toBeCloseTo(s1!.x, 10);
		expect(beams[0]!.x + beams[0]!.width).toBeCloseTo(s2!.x + s2!.width, 10);
	});

	it('draws a grace accidental cue-sized, and the principal still states its own', () => {
		const { score, ops } = layoutOne([[['F#5', 'eighth', { grace: ACCIACCATURA }], ['F#5', 'whole']]]);
		const [g, p] = ids(score);
		const graceSharp = ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.noteId === g && op.glyph === 'accidentalSharp');
		const principalSharp = ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.noteId === p && op.glyph === 'accidentalSharp');
		expect(graceSharp?.fontSizePx).toBeCloseTo(graceFont, 10);
		expect(principalSharp).toBeDefined();
		expect(principalSharp!.fontSizePx).toBeUndefined();
		expect(graceSharp!.x).toBeLessThan(headOf(ops, g!).x);
	});

	it('draws a grace with no principal before the barline', () => {
		const { score, measure, ops } = layoutOne([[['C5', 'whole'], ['B4', 'eighth', { grace: ACCIACCATURA }]], [['C5', 'whole']]]);
		const [whole, g] = ids(score);
		const graceHead = headOf(ops, g!);
		expect(graceHead.x).toBeGreaterThan(headOf(ops, whole!).x);
		expect(graceHead.x).toBeLessThan(measure.region.x + measure.region.width - SS);
	});

	it('hit-tests and region-covers every grace op, and a scoped relayout matches the full layout', () => {
		const score = buildScore(
			[
				[['C6', 'eighth', { grace: ACCIACCATURA }], ['C5', 'half'], ['E3', '16th', { grace: APPOGGIATURA }], ['G3', '16th', { grace: APPOGGIATURA }], ['G4', 'half']],
				[['C5', 'whole']]
			],
			{ keyFifths: 0 },
			[{ start: [0, 0], end: [0, 1] }]
		);
		const layout = layoutScore(score, { staffSpacePx: SS });
		const m0 = layout.measures[0]!;
		for (const note of score.measures[0]!.notes.filter((n) => n.isGrace)) {
			const head = headOf(m0.ops, note.id);
			const hit = hitTest(layout, head.x + 2, head.y);
			expect(hit?.noteId).toBe(note.id);
			for (const op of opsOf(m0.ops, note.id)) expectInside(op, m0);
		}
		// A transpose of the grace re-lays out just that measure, identically.
		score.transposeNote(score.measures[0]!.notes[0]!.id, -1);
		const scoped = relayoutMeasure(score, layout, 0, { staffSpacePx: SS });
		const full = layoutScore(score, { staffSpacePx: SS });
		// Same ops up to the staff's vertical position (a full layout may move
		// the staff to fit the lowered grace; a scoped one keeps it).
		const dy = full.staffTopY - layout.staffTopY;
		const xs = (ops: readonly DrawOp[]) => ops.map((op) => ('x' in op ? op.x : op.x0));
		expect(xs(scoped!.measures[0]!.ops)).toEqual(xs(full.measures[0]!.ops));
		const head = (l: typeof layout) => headOf(l.measures[0]!.ops, score.measures[0]!.notes[0]!.id).y;
		expect(head(scoped!) + dy).toBeCloseTo(head(full), 6);
		for (const op of opsOf(scoped!.measures[0]!.ops, score.measures[0]!.notes[0]!.id)) expectInside(op, scoped!.measures[0]!);
	});

	it('draws a slur from a grace to its principal below, under the two heads', () => {
		const score = buildScore([[['D5', 'eighth', { grace: APPOGGIATURA }], ['C5', 'whole']]], { keyFifths: 0 }, [{ start: [0, 0], end: [0, 1] }]);
		const layout = layoutScore(score, { staffSpacePx: SS });
		const ops = layout.measures[0]!.ops;
		const [g, p] = ids(score);
		const slur = curvesOf(ops, g!).find((c) => c.thickness > ED_STEM * SS)!;
		const graceHead = headOf(ops, g!);
		const principalHead = headOf(ops, p!);
		expect(slur.x0).toBeGreaterThan(graceHead.x);
		expect(slur.x1).toBeGreaterThan(principalHead.x);
		expect(slur.y0).toBeGreaterThan(graceHead.y);
		expect(slur.cy0).toBeGreaterThan(slur.y0);
	});

	it('lays out the showcase with every grace drawn cue-sized inside its measure', () => {
		const score = createGraceShowcaseScore();
		for (const measure of score.measures) expect(validateMeasure(measure, score.timeAt(measure.index)).valid).toBe(true);
		const layout = layoutScore(score, { staffSpacePx: SS, systemWidthPx: 900 });
		let graces = 0;
		for (const measure of score.measures) {
			const laid = layout.measures.find((m) => m.index === measure.index)!;
			for (const note of measure.notes.filter((n) => n.isGrace)) {
				graces++;
				expect(headOf(laid.ops, note.id).fontSizePx).toBeCloseTo(graceFont, 10);
				for (const op of opsOf(laid.ops, note.id)) expectInside(op, laid);
			}
		}
		expect(graces).toBe(15);
	});
});

const ED_STEM = 0.12;

function expectInside(op: DrawOp, measure: LaidOutMeasure): void {
	const r = measure.region;
	if (op.kind === 'glyph') {
		const unit = (op.fontSizePx ?? SS * STAFF_SPACES_PER_EM) / STAFF_SPACES_PER_EM;
		const { bBoxSW, bBoxNE } = GLYPH_METRICS[op.glyph as GlyphName];
		expect(op.x + bBoxSW[0] * unit).toBeGreaterThanOrEqual(r.x);
		expect(op.x + bBoxNE[0] * unit).toBeLessThanOrEqual(r.x + r.width);
		expect(op.y - bBoxNE[1] * unit).toBeGreaterThanOrEqual(r.y);
		expect(op.y - bBoxSW[1] * unit).toBeLessThanOrEqual(r.y + r.height);
	} else if (op.kind === 'rect') {
		expect(op.x).toBeGreaterThanOrEqual(r.x);
		expect(op.y).toBeGreaterThanOrEqual(r.y);
		expect(op.y + op.height).toBeLessThanOrEqual(r.y + r.height);
	} else if (op.kind === 'curve') {
		for (const y of [op.y0, op.cy0, op.cy1, op.y1]) {
			expect(y).toBeGreaterThanOrEqual(r.y);
			expect(y).toBeLessThanOrEqual(r.y + r.height);
		}
	}
}
