// Dynamics and hairpins (M6 Slice 6): where layout puts them.

import { describe, expect, it } from 'vitest';
import { buildScore, Score, type MeasureBuildSpec, type MeasureSpec, type WedgeSpec } from '../model/score.js';
import { GLYPH_METRICS } from '../render/glyph-metrics.js';
import { layoutScore, relayoutMeasure } from './layout.js';
import type { DrawOp, LaidOutMeasure, LaidOutScore } from './types.js';

const SS = 10;

type GlyphOp = Extract<DrawOp, { kind: 'glyph' }>;
type CurveOp = Extract<DrawOp, { kind: 'curve' }>;

function lay(
	measures: readonly (MeasureSpec | MeasureBuildSpec)[],
	wedges: readonly WedgeSpec[] = [],
	systemWidthPx?: number
): { score: Score; layout: LaidOutScore } {
	const score = buildScore(measures, { keyFifths: 0 }, [], wedges);
	return { score, layout: layoutScore(score, { staffSpacePx: SS, systemWidthPx }) };
}

const dynamicsIn = (measure: LaidOutMeasure): GlyphOp[] =>
	measure.ops.filter((op): op is GlyphOp => op.kind === 'glyph' && op.glyph.startsWith('dynamic'));
const curvesIn = (measure: LaidOutMeasure): CurveOp[] => measure.ops.filter((op): op is CurveOp => op.kind === 'curve');
const glyphTop = (op: GlyphOp): number => op.y - GLYPH_METRICS[op.glyph].bBoxNE[1] * SS;
const glyphBottom = (op: GlyphOp): number => op.y - GLYPH_METRICS[op.glyph].bBoxSW[1] * SS;

describe('layout: dynamics (M6 Slice 6)', () => {
	it('draws a dynamic below the staff, centred under the note at its onset, from Bravura', () => {
		const { layout } = lay([{ notes: [['G4', 'half'], ['G4', 'half']], dynamics: [{ kind: 'p', onset: 0.5 }] }]);
		const measure = layout.measures[0]!;
		const [p] = dynamicsIn(measure);
		expect(p!.glyph).toBe('dynamicPiano');
		const staffBottom = layout.staffTopY + 4 * SS;
		expect(glyphTop(p!)).toBeGreaterThan(staffBottom);
		const note = measure.notes[1]!.bounds;
		const { bBoxSW, bBoxNE } = GLYPH_METRICS.dynamicPiano;
		const centre = p!.x + ((bBoxSW[0] + bBoxNE[0]) / 2) * SS;
		expect(centre).toBeCloseTo(note.x + note.width / 2, 6);
	});

	it('clears a low note, its ledger lines and its down stem', () => {
		const plain = lay([{ notes: [['G4', 'whole']], dynamics: [{ kind: 'f' }] }]).layout;
		const low = lay([{ notes: [['E3', 'quarter'], ['C6', 'quarter'], ['G4', 'half']], dynamics: [{ kind: 'f' }] }]).layout;
		const f = dynamicsIn(low.measures[0]!)[0]!;
		// Lower than with nothing below the staff...
		expect(f.y - low.staffTopY).toBeGreaterThan(dynamicsIn(plain.measures[0]!)[0]!.y - plain.staffTopY);
		// ...and clear of every other op's ink: the E3 head and ledgers, and C6's
		// down stem.
		const others = low.measures[0]!.ops.filter((op) => op !== f);
		const inkBottom = Math.max(
			...others.map((op) =>
				op.kind === 'rect'
					? op.y + op.height
					: op.kind === 'glyph'
						? glyphBottom(op)
						: op.kind === 'curve'
							? Math.max(op.y0, op.cy0, op.cy1, op.y1)
							: op.y
			)
		);
		expect(glyphTop(f)).toBeGreaterThan(inkBottom);
	});

	it('honours placement="above"', () => {
		const { layout } = lay([{ notes: [['C4', 'whole']], dynamics: [{ kind: 'mf', placement: 'above' }] }]);
		const mf = dynamicsIn(layout.measures[0]!)[0]!;
		expect(glyphBottom(mf)).toBeLessThan(layout.staffTopY);
	});

	it('puts every dynamic and hairpin of a system on one baseline per side', () => {
		const { layout } = lay(
			[
				{ notes: [['G4', 'whole']], dynamics: [{ kind: 'p' }] },
				{ notes: [['C4', 'whole']], dynamics: [{ kind: 'ff' }] },
				{ notes: [['A3', 'whole']], dynamics: [{ kind: 'mp' }] },
				{ notes: [['G4', 'whole']], dynamics: [{ kind: 'sfz', placement: 'above' }] }
			],
			[{ kind: 'crescendo', start: [0, 0.25], stop: [0, 1] }]
		);
		const below = layout.measures.slice(0, 3).map((m) => dynamicsIn(m)[0]!.y);
		expect(new Set(below).size).toBe(1);
		// The lowest note (A3 with its ledger lines) decides it for all three.
		const a3 = layout.measures[2]!.notes[0]!.bounds;
		expect(glyphTop(dynamicsIn(layout.measures[0]!)[0]!)).toBeGreaterThan(a3.y + a3.height - 0.3 * SS);
		// The hairpin's centre line sits on the same line, half an x-height up.
		const [upper, lower] = curvesIn(layout.measures[0]!);
		expect((upper!.y1 + lower!.y1) / 2).toBeCloseTo(below[0]! - 0.55 * SS, 6);
		// Above-staff marks keep their own line.
		expect(dynamicsIn(layout.measures[3]!)[0]!.y).toBeLessThan(layout.staffTopY);
	});
});

describe('layout: hairpins (M6 Slice 6)', () => {
	it('draws a crescendo as two lines opening from a point, starting after a dynamic at its start', () => {
		const { layout } = lay(
			[{ notes: [['G4', 'quarter'], ['G4', 'quarter'], ['G4', 'quarter'], ['G4', 'quarter']], dynamics: [{ kind: 'p' }, { kind: 'f', onset: 0.75 }] }],
			[{ kind: 'crescendo', start: [0, 0], stop: [0, 0.75] }]
		);
		const measure = layout.measures[0]!;
		const [p, f] = dynamicsIn(measure);
		const [upper, lower] = curvesIn(measure);
		// Closed at the start, open at the end.
		expect(upper!.y0).toBeCloseTo(lower!.y0, 6);
		expect(lower!.y1 - upper!.y1).toBeCloseTo(1.1 * SS, 6);
		// Clear of both dynamics.
		const pRight = p!.x + GLYPH_METRICS.dynamicPiano.bBoxNE[0] * SS;
		const fLeft = f!.x + GLYPH_METRICS.dynamicForte.bBoxSW[0] * SS;
		expect(upper!.x0).toBeGreaterThan(pRight);
		expect(upper!.x1).toBeLessThan(fLeft);
	});

	it('draws a diminuendo closing to a point', () => {
		const { layout } = lay([[['G4', 'whole']]], [{ kind: 'diminuendo', start: [0, 0], stop: [0, 1] }]);
		const [upper, lower] = curvesIn(layout.measures[0]!);
		expect(lower!.y0 - upper!.y0).toBeCloseTo(1.1 * SS, 6);
		expect(upper!.y1).toBeCloseTo(lower!.y1, 6);
	});

	it('splits a hairpin at every barline into pieces owned by each measure, forming one straight wedge', () => {
		const { layout } = lay(
			[[['G4', 'whole']], [['G4', 'whole']], [['G4', 'whole']]],
			[{ kind: 'crescendo', start: [0, 0], stop: [2, 1] }]
		);
		const pieces = layout.measures.map((m) => curvesIn(m));
		for (const [i, piece] of pieces.entries()) {
			expect(piece).toHaveLength(2);
			const region = layout.measures[i]!.region;
			for (const line of piece) {
				expect(line.x0).toBeGreaterThanOrEqual(region.x - 1e-6);
				expect(line.x1).toBeLessThanOrEqual(region.x + region.width + 1e-6);
			}
		}
		// Consecutive pieces meet, and the slope is the same throughout.
		const slope = (line: CurveOp) => (line.y1 - line.y0) / (line.x1 - line.x0);
		for (let i = 1; i < 3; i++) {
			expect(pieces[i]![0]!.x0).toBeCloseTo(pieces[i - 1]![0]!.x1, 6);
			expect(pieces[i]![0]!.y0).toBeCloseTo(pieces[i - 1]![0]!.y1, 6);
			expect(slope(pieces[i]![0]!)).toBeCloseTo(slope(pieces[0]![0]!), 6);
		}
	});

	it('continues a hairpin crossing a system break as an open segment at the left of the new system', () => {
		const measures: MeasureSpec[] = Array.from({ length: 6 }, () => [
			['G4', 'quarter'],
			['A4', 'quarter'],
			['B4', 'quarter'],
			['C5', 'quarter']
		]);
		const { layout } = lay(measures, [{ kind: 'crescendo', start: [1, 0], stop: [4, 0.5] }], 400);
		const systemOf = (index: number) => layout.systems.findIndex((s) => s.measureIndices.includes(index));
		expect(systemOf(1)).not.toBe(systemOf(4));
		const segments = systemOf(4) - systemOf(1) + 1;
		const firstOfSecond = layout.systems[systemOf(1) + 1]!.measureIndices[0]!;
		const lastOfFirst = layout.systems[systemOf(1)]!.measureIndices.at(-1)!;
		const outgoing = curvesIn(layout.measures[lastOfFirst]!);
		const incoming = curvesIn(layout.measures[firstOfSecond]!);
		const opening = (lines: CurveOp[], end: 0 | 1) =>
			end === 0 ? lines[1]!.y0 - lines[0]!.y0 : lines[1]!.y1 - lines[0]!.y1;
		// The first system's segment ends partly open (each system takes an
		// equal share of the growth); the continuation starts at that same
		// opening, at the left of the new system's music, and the last
		// segment ends fully open.
		expect(opening(outgoing, 1)).toBeCloseTo((1.1 * SS) / segments, 6);
		expect(opening(incoming, 0)).toBeCloseTo((1.1 * SS) / segments, 6);
		const music = Math.min(...layout.measures[firstOfSecond]!.notes.map((n) => n.bounds.x));
		expect(incoming[0]!.x0).toBeLessThan(music);
		expect(incoming[0]!.x0).toBeGreaterThan(music - SS);
		const stopMeasure = curvesIn(layout.measures[4]!);
		expect(opening(stopMeasure, 1)).toBeCloseTo(1.1 * SS, 6);
	});

	it('draws a stop on the downbeat of a new system at the end of the previous one, not as a stub', () => {
		const measures: MeasureSpec[] = Array.from({ length: 6 }, () => [['G4', 'half'], ['G4', 'half']]);
		const probe = lay(measures, [], 300).layout;
		const secondSystemStart = probe.systems[1]!.measureIndices[0]!;
		const { layout } = lay(measures, [{ kind: 'diminuendo', start: [0, 0], stop: [secondSystemStart, 0] }], 300);
		expect(curvesIn(layout.measures[secondSystemStart]!)).toHaveLength(0);
		expect(curvesIn(layout.measures[secondSystemStart - 1]!)).toHaveLength(2);
	});

	it('draws nothing for a zero-length hairpin', () => {
		const { layout } = lay([[['G4', 'whole']]], [{ kind: 'crescendo', start: [0, 0], stop: [0, 0] }]);
		expect(curvesIn(layout.measures[0]!)).toHaveLength(0);
	});
});

describe('relayoutMeasure with dynamics and hairpins (M6 Slice 6)', () => {
	it('reproduces the full layout\'s direction ops for an edit that leaves the baseline alone', () => {
		const { score, layout } = lay(
			[
				{ notes: [['G4', 'whole']], dynamics: [{ kind: 'p' }] },
				[['A4', 'whole']],
				{ notes: [['B4', 'whole']], dynamics: [{ kind: 'f' }] }
			],
			[{ kind: 'crescendo', start: [0, 0.5], stop: [2, 0] }]
		);
		const touched = score.transposeNote(score.measures[1]!.notes[0]!.id, 2)!;
		const updated = relayoutMeasure(score, layout, touched, { staffSpacePx: SS });
		expect(updated).not.toBeNull();
		const fresh = layoutScore(score, { staffSpacePx: SS });
		const pick = (l: LaidOutScore) => curvesIn(l.measures[1]!).map((c) => [c.x0, c.y0, c.x1, c.y1]);
		const scoped = pick(updated!);
		const full = pick(fresh);
		expect(scoped).toHaveLength(2);
		scoped.flat().forEach((v, i) => expect(v).toBeCloseTo(full.flat()[i]!, 6));
	});

	it('falls back to a full layout when the edit moves the system\'s shared baseline', () => {
		const { score, layout } = lay([
			{ notes: [['G4', 'whole']], dynamics: [{ kind: 'p' }] },
			{ notes: [['A4', 'whole']], dynamics: [{ kind: 'f' }] }
		]);
		// A4 down 14 semitones (to G3): below the staff, so measure 1's ink, and
		// with it the baseline measure 0's p shares, goes lower.
		const id = score.measures[1]!.notes[0]!.id;
		for (let i = 0; i < 14; i++) score.transposeNote(id, -1);
		expect(relayoutMeasure(score, layout, 1, { staffSpacePx: SS })).toBeNull();
	});
});
