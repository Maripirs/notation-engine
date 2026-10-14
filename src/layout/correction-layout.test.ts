// Correction ops (M6 Slice 7) and region-scoped redraw: after each op, the
// caller re-lays-out just the measures the op reported, falling back to a full
// `layoutScore` when `relayoutMeasure` declines (a width change, a moved
// dynamics baseline). Either way the touched measures must come out exactly
// as a fresh full layout draws them, i.e. accidental state, beaming, chord
// second displacement and direction baselines are all recomputed.

import { describe, expect, it } from 'vitest';
import { parsePitch } from '../model/pitch.js';
import { buildScore, type MeasureRef, type Score } from '../model/score.js';
import { layoutScore, relayoutMeasure } from './layout.js';
import type { LaidOutMeasure, LaidOutScore } from './types.js';

const OPTIONS = { staffSpacePx: 10 };

/** The demo's redraw path: scoped for each touched measure, or `null` when
 *  any of them declines (the caller then lays the whole score out). */
function scoped(score: Score, layout: LaidOutScore, touched: readonly MeasureRef[]): LaidOutScore | null {
	let current: LaidOutScore | null = layout;
	for (const { staffIndex, measureIndex } of touched) {
		current = relayoutMeasure(score, current, measureIndex, OPTIONS, staffIndex);
		if (current === null) return null;
	}
	return current;
}

/** A measure's ops with every number rounded, so a scoped relayout (computed
 *  in place) and a full one (computed then translated) compare equal. */
function opsKey(measure: LaidOutMeasure): string {
	return JSON.stringify(measure.ops, (_key, value: unknown) => (typeof value === 'number' ? Number(value.toFixed(4)) : value));
}

function measureOf(layout: LaidOutScore, ref: MeasureRef): LaidOutMeasure {
	return layout.measures.find((m) => m.staffIndex === ref.staffIndex && m.index === ref.measureIndex)!;
}

const fixture = () =>
	buildScore(
		[
			{
				notes: [
					['F#4', 'eighth'],
					['F4', 'eighth'],
					['A4', 'quarter'],
					[['C5', 'D5'], 'quarter'],
					[null, 'quarter']
				],
				dynamics: [{ kind: 'p' }]
			},
			[
				['G4', 'half', { tiedToNext: true }],
				['G4', 'quarter'],
				[null, 'quarter']
			],
			[['E5', 'whole']]
		],
		{ keyFifths: 0 }
	);

describe('scoped redraw after correction ops (M6 Slice 7)', () => {
	const id = (score: Score, m: number, i: number) => score.measures[m]!.notes[i]!.id;
	const cases: [string, (score: Score) => readonly MeasureRef[] | null][] = [
		// The natural on F4 depends on the F# before it: deleting the F# must
		// drop the natural, which only a re-layout of the measure does.
		['noteToRest (accidental state)', (s) => s.noteToRest(id(s, 0, 0))],
		['restToNote', (s) => s.restToNote(id(s, 0, 5), parsePitch('B4'))],
		['setDuration (beaming changes)', (s) => s.setDuration(id(s, 0, 1), '16th')],
		['setDuration lengthen into a rest', (s) => s.setDuration(id(s, 1, 1), 'half')],
		['addChordMember (a second, displaced)', (s) => s.addChordMember(id(s, 0, 2), parsePitch('B4'))],
		['removeChordMember', (s) => s.removeChordMember(id(s, 0, 4))],
		['editTie off across the barline', (s) => s.editTie(id(s, 1, 0), null)],
		['noteToRest on a tie target', (s) => s.noteToRest(id(s, 1, 1))]
	];

	for (const [name, op] of cases) {
		it(`${name}: touched measures match a fresh full layout`, () => {
			const score = fixture();
			const layout = layoutScore(score, OPTIONS);
			const touched = op(score);
			expect(touched).not.toBeNull();
			const fresh = layoutScore(score, OPTIONS);
			const updated = scoped(score, layout, touched!) ?? fresh;
			for (const ref of touched!) {
				expect(opsKey(measureOf(updated, ref)), `measure ${ref.measureIndex}`).toBe(opsKey(measureOf(fresh, ref)));
			}
			// And nothing outside the touched set changed.
			for (const measure of fresh.measures) {
				if (touched!.some((r) => r.staffIndex === measure.staffIndex && r.measureIndex === measure.index)) continue;
				if (updated === fresh) continue;
				expect(opsKey(measure)).toBe(opsKey(measureOf(layout, { staffIndex: measure.staffIndex, measureIndex: measure.index })));
			}
		});
	}

	it('a width-keeping op redraws scoped; a width-changing one falls back', () => {
		const score = fixture();
		const layout = layoutScore(score, OPTIONS);
		const tieOff = score.editTie(score.measures[1]!.notes[0]!.id, null)!;
		expect(scoped(score, layout, tieOff)).not.toBeNull();
		const before = layoutScore(score, OPTIONS);
		const shorter = score.setDuration(score.measures[2]!.notes[0]!.id, '16th')!;
		expect(scoped(score, before, shorter)).toBeNull();
	});
});
