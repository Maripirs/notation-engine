// Dynamics and hairpins in the model (M6 Slice 6): building, validation,
// clone (undo) and equivalence.

import { describe, expect, it } from 'vitest';
import { assertScoresEquivalent } from './score-equivalence.js';
import { buildScore, EditHistory } from './index.js';

const twoMeasures = () =>
	buildScore(
		[
			{ notes: [['C4', 'half'], ['D4', 'half']], dynamics: [{ kind: 'f', onset: 0.5 }, { kind: 'p' }] },
			[['E4', 'whole']]
		],
		{},
		[],
		[{ kind: 'crescendo', start: [0, 0], stop: [1, 1], placement: 'above' }]
	);

describe('model: dynamics and hairpins (M6 Slice 6)', () => {
	it('keeps a measure\'s dynamics sorted by onset, in the stream of its first voice', () => {
		const score = twoMeasures();
		expect(score.measures[0]!.dynamics.map((d) => [d.kind, d.onset, d.voice, d.placement])).toEqual([
			['p', 0, 1, null],
			['f', 0.5, 1, null]
		]);
		expect(score.wedges).toEqual([
			{
				kind: 'crescendo',
				staffIndex: 0,
				placement: 'above',
				start: { measureIndex: 0, onset: 0, voice: 1, source: null },
				stop: { measureIndex: 1, onset: 1, voice: 1, source: null }
			}
		]);
	});

	it('rejects a hairpin ending before it starts, or outside the staff', () => {
		const score = twoMeasures();
		expect(() => score.addWedge({ kind: 'diminuendo', start: { measureIndex: 1 }, stop: { measureIndex: 0, onset: 0.5 } })).toThrow(
			/before the start/
		);
		expect(() => score.addWedge({ kind: 'diminuendo', start: { measureIndex: 0 }, stop: { measureIndex: 5 } })).toThrow(/measure 5/);
		expect(() => score.addDynamic(0, 9, { kind: 'p' })).toThrow(/no measure 9/);
	});

	it('clones independently, and equivalence sees a changed dynamic or hairpin', () => {
		const score = twoMeasures();
		const copy = score.clone();
		assertScoresEquivalent(copy, score);
		copy.measures[0]!.dynamics = [{ ...copy.measures[0]!.dynamics[0]!, kind: 'pp' }];
		expect(score.measures[0]!.dynamics[0]!.kind).toBe('p');
		expect(() => assertScoresEquivalent(copy, score)).toThrow(/dynamics/);

		const other = score.clone();
		other.wedges[0] = { ...other.wedges[0]!, kind: 'diminuendo' };
		expect(score.wedges[0]!.kind).toBe('crescendo');
		expect(() => assertScoresEquivalent(other, score)).toThrow(/wedges/);
	});

	it('restores dynamics and hairpins on undo', () => {
		const history = new EditHistory(twoMeasures());
		history.record((s) => {
			s.addDynamic(0, 1, { kind: 'mf' });
			s.wedges.length = 0;
			return 1;
		});
		expect(history.current.wedges).toHaveLength(0);
		history.undo();
		assertScoresEquivalent(history.current, twoMeasures());
	});
});
