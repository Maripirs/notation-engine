import { describe, expect, it } from 'vitest';
import { formatPitch, parsePitch } from './pitch.js';
import { assertScoresEquivalent } from './score-equivalence.js';
import {
	buildScore,
	eventArticulations,
	eventFermata,
	measureCapacityWholes,
	measureDurationWholes,
	Note,
	NOTE_VALUE_WHOLES,
	noteEvents,
	Score,
	TRIPLET,
	validateMeasure,
	type NoteValue
} from './score.js';

const NOTE_VALUES: readonly NoteValue[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];

describe('Score', () => {
	const fixture = () =>
		buildScore(
			[
				[['C4', 'quarter']],
				[
					['E4', 'quarter'],
					[null, 'quarter']
				]
			],
			{ keyFifths: 1 }
		);

	it('gives every note a distinct id and remembers its measure', () => {
		const score = fixture();
		const ids = score.measures.flatMap((m) => m.notes.map((n) => n.id));
		expect(new Set(ids).size).toBe(ids.length);
		expect(score.measureOfNote(ids[0]!)?.index).toBe(0);
		expect(score.measureOfNote(ids[1]!)?.index).toBe(1);
	});

	it('reports which measure a transpose touched', () => {
		const score = fixture();
		const target = score.measures[1]!.notes[0]!;
		// This return value is the contract the incremental redraw is built on:
		// the caller repaints the measures an edit names, and no others.
		expect(score.transposeNote(target.id, 1)).toBe(1);
		expect(formatPitch(target.pitch!)).toBe('F4');
	});

	it('treats a rest and an unknown id as no-ops', () => {
		const score = fixture();
		const rest = score.measures[1]!.notes[1]!;
		expect(score.transposeNote(rest.id, 1)).toBeNull();
		expect(score.transposeNote('does-not-exist', 1)).toBeNull();
	});

	it('mutates in place rather than rebuilding the score', () => {
		// An edit must not invalidate note identity: hit-testing, selection and
		// the redraw path all address notes by id across edits.
		const score = fixture();
		const note = score.measures[0]!.notes[0]!;
		score.transposeNote(note.id, 2);
		expect(score.findNote(note.id)).toBe(note);
		expect(formatPitch(note.pitch!)).toBe('D4');
	});

	it('defaults tempoBpm to 120 when ScoreOptions omits it', () => {
		expect(new Score().tempoBpm).toBe(120);
	});

	it('takes an explicit tempoBpm when given', () => {
		expect(new Score({ tempoBpm: 90 }).tempoBpm).toBe(90);
	});
});

describe('Note.durationWholes', () => {
	it.each(NOTE_VALUES)('gives %s its base duration with no dots or tuplet', (value) => {
		const note = new Note('n', { pitch: null, value });
		expect(note.durationWholes).toBeCloseTo(NOTE_VALUE_WHOLES[value], 10);
	});

	it.each(NOTE_VALUES)('adds half again for a single dot on %s', (value) => {
		const note = new Note('n', { pitch: null, value, dots: 1 });
		expect(note.durationWholes).toBeCloseTo(NOTE_VALUE_WHOLES[value] * 1.5, 10);
	});

	it.each(NOTE_VALUES)('adds three quarters for a double dot on %s', (value) => {
		const note = new Note('n', { pitch: null, value, dots: 2 });
		expect(note.durationWholes).toBeCloseTo(NOTE_VALUE_WHOLES[value] * 1.75, 10);
	});

	it.each(NOTE_VALUES)('shrinks %s to two-thirds under a triplet ratio', (value) => {
		const note = new Note('n', { pitch: null, value, tuplet: TRIPLET });
		expect(note.durationWholes).toBeCloseTo(NOTE_VALUE_WHOLES[value] * (2 / 3), 10);
	});

	it('combines a dot and a tuplet ratio on the same note', () => {
		// A dotted-eighth triplet: the dot's 1.5x and the triplet's 2/3 both apply,
		// in either order, since they are independent multipliers on the base value.
		const note = new Note('n', { pitch: null, value: 'eighth', dots: 1, tuplet: TRIPLET });
		expect(note.durationWholes).toBeCloseTo((1 / 8) * 1.5 * (2 / 3), 10);
	});
});

describe('measure duration validation', () => {
	it('accepts a measure whose notes exactly fill 4/4', () => {
		const score = buildScore([
			[
				['C4', 'quarter'],
				['D4', 'quarter'],
				['E4', 'quarter'],
				['F4', 'quarter']
			]
		]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.valid).toBe(true);
		expect(result.actualWholes).toBeCloseTo(1, 10);
		expect(result.expectedWholes).toBeCloseTo(1, 10);
		// A single voice's `perVoice` is exactly one entry, and its own
		// `actualWholes`/`valid` agree with the top-level fields by
		// construction (one voice's sum *is* the total sum): the per-voice
		// rewrite must not change a single-voice measure's answer at all.
		expect(result.perVoice).toEqual([{ voice: 1, actualWholes: result.actualWholes, valid: true }]);
	});

	it('accepts a measure of quarter-note triplets, two groups of three', () => {
		// Each group of 3 triplet quarters takes the time of 2 quarters (half a
		// whole note), so two groups exactly fill a 4/4 measure even though no
		// individual note's duration is a binary fraction of a whole note.
		const group = [
			['C4', 'quarter', { tuplet: TRIPLET }],
			['D4', 'quarter', { tuplet: TRIPLET }],
			['E4', 'quarter', { tuplet: TRIPLET }]
		] as const;
		const score = buildScore([[...group, ...group]]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.valid).toBe(true);
	});

	it('flags a measure with too few beats', () => {
		const score = buildScore([
			[
				['C4', 'quarter'],
				['D4', 'quarter']
			]
		]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.valid).toBe(false);
		expect(result.actualWholes).toBeCloseTo(0.5, 10);
		expect(result.expectedWholes).toBeCloseTo(1, 10);
	});

	it('flags a measure with too many beats', () => {
		const score = buildScore([
			[
				['C4', 'quarter'],
				['D4', 'quarter'],
				['E4', 'quarter'],
				['F4', 'quarter'],
				['G4', 'quarter']
			]
		]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.valid).toBe(false);
		expect(result.actualWholes).toBeCloseTo(1.25, 10);
	});

	it('measureDurationWholes and measureCapacityWholes agree with validateMeasure', () => {
		const score = buildScore([[['C4', 'whole']]]);
		expect(measureDurationWholes(score.measures[0]!)).toBeCloseTo(1, 10);
		expect(measureCapacityWholes(score.time)).toBeCloseTo(1, 10);
	});

	it('accepts a two-voice measure where each voice independently fills 4/4 on its own', () => {
		// The bug this per-voice rewrite fixes: before it, `validateMeasure`
		// summed every voice's notes together, so this measure (each voice a
		// full bar of its own, 1 + 1 = 2 wholes total) would have incorrectly
		// failed a check against a 1-wholes-capacity time signature. Voice 1
		// and voice 2 here are two entirely independent full bars of quarter
		// notes sharing the one measure.
		const score = buildScore([
			[
				['C4', 'quarter', { voice: 1 }],
				['D4', 'quarter', { voice: 1 }],
				['E4', 'quarter', { voice: 1 }],
				['F4', 'quarter', { voice: 1 }],
				['C3', 'quarter', { voice: 2 }],
				['D3', 'quarter', { voice: 2 }],
				['E3', 'quarter', { voice: 2 }],
				['F3', 'quarter', { voice: 2 }]
			]
		]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.valid).toBe(true);
		// `actualWholes` keeps its old, documented meaning: the total summed
		// across every voice, i.e. 2 here, not 1 - only `valid` stopped being
		// computed from it.
		expect(result.actualWholes).toBeCloseTo(2, 10);
		expect(result.perVoice).toEqual(
			expect.arrayContaining([
				{ voice: 1, actualWholes: expect.closeTo(1, 10), valid: true },
				{ voice: 2, actualWholes: expect.closeTo(1, 10), valid: true }
			])
		);
		expect(result.perVoice).toHaveLength(2);
	});

	it('accepts a three-voice measure where each voice independently fills 4/4 on its own', () => {
		const group = (voice: number, pitches: readonly string[]) =>
			pitches.map((pitch) => [pitch, 'quarter', { voice }] as const);
		const score = buildScore([
			[
				...group(1, ['C4', 'D4', 'E4', 'F4']),
				...group(2, ['C3', 'D3', 'E3', 'F3']),
				...group(3, ['C5', 'D5', 'E5', 'F5'])
			]
		]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.valid).toBe(true);
		expect(result.perVoice).toHaveLength(3);
		expect(result.perVoice.every((entry) => entry.valid)).toBe(true);
	});

	it('flags a multi-voice measure where one voice is short, even though the totalled-across-voices sum happens to look plausible', () => {
		// Voice 1 (3 quarters, 0.75 wholes) and voice 2 (1 quarter, 0.25
		// wholes) sum to exactly 1.0 wholes together, coincidentally matching
		// 4/4's own capacity - precisely the blind spot the old sum-everything
		// check could not see through: it would have called this measure
		// valid. Per-voice, neither voice actually fills the measure on its
		// own, so the measure is correctly invalid.
		const score = buildScore([
			[
				['C4', 'quarter', { voice: 1 }],
				['D4', 'quarter', { voice: 1 }],
				['E4', 'quarter', { voice: 1 }],
				['C3', 'quarter', { voice: 2 }]
			]
		]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.actualWholes).toBeCloseTo(1, 10); // the coincidental, misleading total
		expect(result.valid).toBe(false);
		const byVoice = new Map(result.perVoice.map((entry) => [entry.voice, entry]));
		expect(byVoice.get(1)!.valid).toBe(false);
		expect(byVoice.get(1)!.actualWholes).toBeCloseTo(0.75, 10);
		expect(byVoice.get(2)!.valid).toBe(false);
		expect(byVoice.get(2)!.actualWholes).toBeCloseTo(0.25, 10);
	});

	it('flags an empty measure (no voices present at all) as invalid against a nonzero-capacity time signature', () => {
		// No notes means no voice groups, so `perVoice` is empty; `valid`
		// stays false rather than vacuously true over zero entries, matching
		// this function's behaviour before the per-voice rewrite (an empty
		// measure's old single sum of 0 already failed a nonzero-capacity
		// check the same way).
		const score = buildScore([[]]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.perVoice).toEqual([]);
		expect(result.valid).toBe(false);
	});
});

describe('key and time changes', () => {
	it('keyFifthsAt inherits the previous measure when a measure states no change', () => {
		const score = buildScore(
			[
				[['G4', 'quarter']],
				[['G4', 'quarter']], // no change: still the score's initial key
				{ notes: [['G4', 'quarter']], keyFifths: 2 }, // D major from here on
				[['G4', 'quarter']] // no change: still D major
			],
			{ keyFifths: 1 }
		);
		expect(score.keyFifthsAt(0)).toBe(1);
		expect(score.keyFifthsAt(1)).toBe(1);
		expect(score.keyFifthsAt(2)).toBe(2);
		expect(score.keyFifthsAt(3)).toBe(2);
	});

	it('timeAt inherits the previous measure the same way keyFifthsAt does', () => {
		const score = buildScore([
			[['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter'], ['F4', 'quarter']],
			[['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter'], ['F4', 'quarter']],
			{ notes: [['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter']], time: { beats: 3, beatType: 4 } },
			[['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter']]
		]);
		expect(score.timeAt(0)).toEqual({ beats: 4, beatType: 4 });
		expect(score.timeAt(1)).toEqual({ beats: 4, beatType: 4 });
		expect(score.timeAt(2)).toEqual({ beats: 3, beatType: 4 });
		expect(score.timeAt(3)).toEqual({ beats: 3, beatType: 4 });
	});

	it('a MeasureBuildSpec with no keyFifths/time still builds a measure with no change recorded', () => {
		// Wrapping a measure in `{ notes, ... }` should not itself count as a
		// change; only an actually-present `keyFifths`/`time` field should.
		const score = buildScore([{ notes: [['G4', 'quarter']] }], { keyFifths: 1 });
		expect(score.measures[0]!.keyFifths).toBeUndefined();
		expect(score.keyFifthsAt(0)).toBe(1);
	});

	it('validateMeasure against timeAt catches a measure that only validates under the wrong time signature', () => {
		// Guards against the exact bug this API exists to prevent: reading the
		// score's single initial `time` for every measure would validate this
		// 3/4 measure as under-full (it does not fill 4/4), when it is in fact
		// exactly full under the 3/4 it actually changed to.
		const score = buildScore([
			[['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter'], ['F4', 'quarter']],
			{ notes: [['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter']], time: { beats: 3, beatType: 4 } }
		]);
		const wrongTime = validateMeasure(score.measures[1]!, score.time);
		expect(wrongTime.valid).toBe(false);
		const rightTime = validateMeasure(score.measures[1]!, score.timeAt(1));
		expect(rightTime.valid).toBe(true);
	});
});

describe('clef changes (M5 Slice 5)', () => {
	const fourMeasures = () =>
		buildScore([[['C4', 'quarter']], [['C4', 'quarter']], [['C4', 'quarter']], [['C4', 'quarter']], [['C4', 'quarter']]]);

	it('clefAt walks back to the nearest explicit clef, falling back to the staff\'s own clef', () => {
		const score = buildScore(
			[
				[['C4', 'quarter']],
				{ notes: [['C4', 'quarter']], clef: 'bass' }, // bass from here on
				[['C4', 'quarter']], // no change: still bass
				{ notes: [['C4', 'quarter']], clef: 'treble' }, // reverts partway
				[['C4', 'quarter']] // no change: treble again
			],
			{ clef: 'treble' }
		);
		expect([0, 1, 2, 3, 4].map((m) => score.clefAt(m))).toEqual(['treble', 'bass', 'bass', 'treble', 'treble']);
	});

	it('clefAt treats an explicit measure-0 clef as an override of Staff.clef, which stays the initial clef', () => {
		const score = buildScore([{ notes: [['C4', 'quarter']], clef: 'treble8' }, [['C4', 'quarter']]], {
			clef: 'bass'
		});
		expect(score.staves[0]!.clef).toBe('bass');
		expect(score.clefAt(0)).toBe('treble8');
		expect(score.clefAt(1)).toBe('treble8');
	});

	it('clefAt resolves a named staff independently of staff 0', () => {
		const score = new Score();
		score.appendMeasure();
		score.appendMeasure();
		score.appendStaff('bass');
		score.appendMeasure(1);
		score.appendMeasure(1).clef = 'treble';
		expect(score.clefAt(1)).toBe('treble');
		expect(score.clefAt(0, 1)).toBe('bass');
		expect(score.clefAt(1, 1)).toBe('treble');
	});

	it('setClefRange changes the range and restores the prior clef right after it', () => {
		const score = fourMeasures();
		expect(score.setClefRange(0, 1, 2, 'bass')).toEqual({ from: 1, to: 2 });
		expect([0, 1, 2, 3, 4].map((m) => score.clefAt(m))).toEqual(['treble', 'bass', 'bass', 'treble', 'treble']);
	});

	it('setClefRange accepts a reversed range and runs to the staff end with nothing to restore', () => {
		const score = fourMeasures();
		expect(score.setClefRange(0, 4, 2, 'treble8')).toEqual({ from: 2, to: 4 });
		expect([0, 1, 2, 3, 4].map((m) => score.clefAt(m))).toEqual([
			'treble',
			'treble',
			'treble8',
			'treble8',
			'treble8'
		]);
	});

	it('setClefRange makes the range uniform, overriding an earlier change inside it, and keeps the clef after it', () => {
		const score = fourMeasures();
		score.setClefRange(0, 2, 2, 'bass'); // treble, treble, bass, treble, treble
		score.setClefRange(0, 1, 3, 'treble8');
		expect(score.measures[2]!.clef).toBeUndefined();
		expect([0, 1, 2, 3, 4].map((m) => score.clefAt(m))).toEqual([
			'treble',
			'treble8',
			'treble8',
			'treble8',
			'treble'
		]);
	});

	it('setClefRange is a no-op (returns null) when the range is already in that clef or out of bounds', () => {
		const score = fourMeasures();
		expect(score.setClefRange(0, 0, 4, 'treble')).toBeNull();
		expect(score.setClefRange(0, 3, 9, 'bass')).toBeNull();
		expect(score.setClefRange(5, 0, 0, 'bass')).toBeNull();
		expect(score.measures.every((m) => m.clef === undefined)).toBe(true);
	});

	it('setClefRange on one staff leaves another staff\'s clefs alone', () => {
		const score = new Score();
		score.appendMeasure();
		score.appendMeasure();
		score.appendStaff('bass');
		score.appendMeasure(1);
		score.appendMeasure(1);
		score.setClefRange(1, 0, 0, 'treble');
		expect([score.clefAt(0, 1), score.clefAt(1, 1)]).toEqual(['treble', 'bass']);
		expect([score.clefAt(0), score.clefAt(1)]).toEqual(['treble', 'treble']);
	});
});

describe('C clefs and clef changes inside a measure (M6 Slice 4)', () => {
	const quarters = (pitch: string) => [
		[pitch, 'quarter'],
		[pitch, 'quarter'],
		[pitch, 'quarter'],
		[pitch, 'quarter']
	] as const;

	it('clefAtOnset reads a change from its own onset on, and clefAt carries the last one into later measures', () => {
		const score = buildScore(
			[
				{ notes: quarters('C4'), clefChanges: [{ onset: 0.5, clef: 'tenor' }] },
				quarters('C4'),
				{ notes: quarters('C4'), clefChanges: [{ onset: 0.75, clef: 'bass' }, { onset: 0.25, clef: 'alto' }] },
				quarters('C4')
			],
			{ clef: 'bass' }
		);
		// buildScore sorts the changes by onset.
		expect(score.measures[2]!.clefChanges.map((c) => c.clef)).toEqual(['alto', 'bass']);
		expect([0, 0.25, 0.5, 0.75].map((t) => score.clefAtOnset(0, t))).toEqual(['bass', 'bass', 'tenor', 'tenor']);
		expect(score.clefAt(0)).toBe('bass');
		expect(score.clefAtEnd(0)).toBe('tenor');
		expect(score.clefAt(1)).toBe('tenor');
		expect([0, 0.25, 0.5, 0.75].map((t) => score.clefAtOnset(2, t))).toEqual(['tenor', 'alto', 'alto', 'bass']);
		expect(score.clefAt(3)).toBe('bass');
	});

	it('an explicit downbeat clef still wins over a change the previous measure ended in', () => {
		const score = buildScore([
			{ notes: quarters('C4'), clefChanges: [{ onset: 1, clef: 'tenor' }] },
			{ notes: quarters('C4'), clef: 'alto' }
		]);
		expect(score.clefAtEnd(0)).toBe('tenor');
		expect(score.clefAt(1)).toBe('alto');
	});

	it('setClefRange takes a mid-staff bass -> tenor -> bass range, and its undo restores it in one step', async () => {
		const { EditHistory } = await import('./edit-history.js');
		const score = buildScore([quarters('C4'), quarters('C4'), quarters('C4'), quarters('C4'), quarters('C4')], {
			clef: 'bass'
		});
		const history = new EditHistory(score);
		const clefs = (s: Score) => s.measures.map((_m, i) => s.clefAt(i));
		expect(history.record((s) => s.setClefRange(0, 1, 3, 'tenor'))).toEqual({ from: 1, to: 3 });
		expect(clefs(history.current)).toEqual(['bass', 'tenor', 'tenor', 'tenor', 'bass']);
		history.undo();
		expect(clefs(history.current)).toEqual(['bass', 'bass', 'bass', 'bass', 'bass']);
		expect(history.current.measures.every((m) => m.clef === undefined)).toBe(true);
		history.redo();
		expect(clefs(history.current)).toEqual(['bass', 'tenor', 'tenor', 'tenor', 'bass']);
		// And the reverse direction, alto as well.
		expect(history.record((s) => s.setClefRange(0, 2, 2, 'alto'))).toEqual({ from: 2, to: 2 });
		expect(clefs(history.current)).toEqual(['bass', 'tenor', 'alto', 'tenor', 'bass']);
	});

	it('setClefRange clears the range\'s mid-measure changes and keeps the clef the range used to end in after it', () => {
		const score = buildScore([
			quarters('C4'),
			{ notes: quarters('C4'), clefChanges: [{ onset: 0.5, clef: 'bass' }] },
			quarters('C4')
		]);
		expect(score.clefAt(2)).toBe('bass');
		// Already treble at the downbeat, but the change inside makes it no no-op.
		expect(score.setClefRange(0, 1, 1, 'treble')).toEqual({ from: 1, to: 1 });
		expect(score.measures[1]!.clefChanges).toEqual([]);
		expect(score.clefAtEnd(1)).toBe('treble');
		// Measure 2 had inherited bass from that change, and keeps it.
		expect(score.clefAt(2)).toBe('bass');
	});

	it('clone copies clef changes without aliasing the array', () => {
		const source = buildScore([{ notes: quarters('C4'), clefChanges: [{ onset: 0.5, clef: 'tenor' }] }]);
		const clone = source.clone();
		expect(clone.measures[0]!.clefChanges).toEqual(source.measures[0]!.clefChanges);
		expect(clone.measures[0]!.clefChanges).not.toBe(source.measures[0]!.clefChanges);
		assertScoresEquivalent(clone, source);
		clone.measures[0]!.clefChanges = [{ onset: 0.25, clef: 'alto' }];
		expect(source.clefAtOnset(0, 0.25)).toBe('treble');
		expect(() => assertScoresEquivalent(clone, source)).toThrow(/clefChanges/);
	});
});

describe('barlines', () => {
	it('defaults to normal everywhere except a final barline at the score\'s true last measure', () => {
		const score = buildScore([[['G4', 'quarter']], [['G4', 'quarter']], [['G4', 'quarter']]]);
		expect(score.endBarlineAt(0)).toBe('normal');
		expect(score.endBarlineAt(1)).toBe('normal');
		expect(score.endBarlineAt(2)).toBe('final');
	});

	it('honours an explicit endBarline, including overriding the automatic final default', () => {
		const score = buildScore([
			{ notes: [['G4', 'quarter']], endBarline: 'double' },
			{ notes: [['G4', 'quarter']], endBarline: 'double' } // the score's last measure
		]);
		expect(score.endBarlineAt(0)).toBe('double');
		// Without the explicit annotation this would default to 'final'; an
		// explicit choice on the last measure wins over that default.
		expect(score.endBarlineAt(1)).toBe('double');
	});

	it('a MeasureBuildSpec with no endBarline/startBarline still builds a measure with no change recorded', () => {
		const score = buildScore([{ notes: [['G4', 'quarter']] }, [['G4', 'quarter']]]);
		expect(score.measures[0]!.endBarline).toBeUndefined();
		expect(score.measures[0]!.startBarline).toBeUndefined();
	});

	it('a repeatStart on the next measure wins over this measure\'s own endBarline', () => {
		const score = buildScore([
			{ notes: [['G4', 'quarter']], endBarline: 'double' },
			{ notes: [['G4', 'quarter']], startBarline: 'repeatStart' },
			[['G4', 'quarter']] // the score's true last measure
		]);
		// Measure 0 asked for 'double', but measure 1 opens with its own
		// repeat-start mark, which is the only barline the boundary between
		// them actually draws.
		expect(score.endBarlineAt(0)).toBe('repeatStart');
		expect(score.endBarlineAt(1)).toBe('normal');
		expect(score.endBarlineAt(2)).toBe('final');
	});

	it('a repeatEnd is just this measure\'s own endBarline, no lookahead involved', () => {
		const score = buildScore([
			{ notes: [['G4', 'quarter']], endBarline: 'repeatEnd' },
			[['G4', 'quarter']]
		]);
		expect(score.endBarlineAt(0)).toBe('repeatEnd');
	});
});

describe('multi-voice literals (M2 Slice 1)', () => {
	it('defaults every note to voice 1 when extra.voice is omitted', () => {
		// The single-voice case, unchanged: every score built before this
		// slice never mentioned voice at all, and must keep landing on
		// `Note.voice`'s own default of 1.
		const score = buildScore([[['C4', 'quarter'], [null, 'quarter']]]);
		expect(score.measures[0]!.notes.map((n) => n.voice)).toEqual([1, 1]);
	});

	it('wires extra.voice through to the built Note, regardless of array order', () => {
		// One flat literal array holding two voices' notes side by side (not
		// interleaved token-for-token): `buildScore` does not need to know
		// anything about voices beyond copying this field through, since
		// layout is what groups by voice, not the model or its builder.
		const score = buildScore([
			[
				['C4', 'quarter', { voice: 1 }],
				['D4', 'quarter', { voice: 1 }],
				['E4', 'half', { voice: 2 }]
			]
		]);
		const [first, second, third] = score.measures[0]!.notes;
		expect(first!.voice).toBe(1);
		expect(second!.voice).toBe(1);
		expect(third!.voice).toBe(2);
	});
});

describe('ties', () => {
	it('resolves extra.tiedToNext across a barline to the next note in the same voice', () => {
		const score = buildScore([
			[
				['C4', 'half'],
				['C4', 'half', { tiedToNext: true }]
			],
			[
				['C4', 'quarter'], // the tie's target: same pitch, first note of measure 1
				['D4', 'quarter'],
				['E4', 'half']
			]
		]);
		const source = score.measures[0]!.notes[1]!;
		const target = score.measures[1]!.notes[0]!;
		expect(source.tiedToId).toBe(target.id);
		expect(source.isTied).toBe(true);
		// The reverse index answers the question layout asks from the
		// *receiving* measure's side: "does some earlier note tie into this one".
		expect(score.tiedFromNote(target.id)).toBe(source);
		expect(score.tiedFromNote(source.id)).toBeUndefined();
	});

	it('resolves extra.tiedToNext to a same-measure neighbour', () => {
		const score = buildScore([
			[
				['G4', 'quarter', { tiedToNext: true }],
				['G4', 'quarter'],
				['A4', 'half']
			]
		]);
		const source = score.measures[0]!.notes[0]!;
		const target = score.measures[0]!.notes[1]!;
		expect(source.tiedToId).toBe(target.id);
		expect(score.tiedFromNote(target.id)).toBe(source);
	});

	it('leaves each tied note counting its own duration toward its own measure', () => {
		// A tie is a sounding/perceptual construct, not a way to write less than
		// a measure's full capacity: both the source and the target still have
		// to fill their own measure exactly, tied or not.
		const score = buildScore([
			[
				['C4', 'quarter'],
				['D4', 'quarter'],
				['E4', 'quarter'],
				['F4', 'quarter', { tiedToNext: true }]
			],
			[
				['F4', 'whole'] // the tie's target, alone filling the second measure
			]
		]);
		const first = validateMeasure(score.measures[0]!, score.time);
		const second = validateMeasure(score.measures[1]!, score.time);
		expect(first.valid).toBe(true);
		expect(first.actualWholes).toBeCloseTo(1, 10);
		expect(second.valid).toBe(true);
		expect(second.actualWholes).toBeCloseTo(1, 10);
	});

	it('throws when tiedToNext has no following note in its voice', () => {
		expect(() => buildScore([[['C4', 'quarter', { tiedToNext: true }]]])).toThrow(/no following note/);
	});

	it('setTie validates the target exists and shares the source note\'s pitch', () => {
		const score = buildScore([
			[
				['C4', 'quarter'],
				['D4', 'quarter']
			]
		]);
		const [c4, d4] = score.measures[0]!.notes;
		expect(() => score.setTie(c4!.id, 'does-not-exist')).toThrow(/not a note in this score/);
		expect(() => score.setTie(c4!.id, d4!.id)).toThrow(/same pitch/);
		expect(() => score.setTie('does-not-exist', c4!.id)).toThrow(/unknown note id/);
	});

	it('setTie(id, null) clears an existing tie from both sides of the index', () => {
		const score = buildScore([[['C4', 'quarter'], ['C4', 'quarter']]]);
		const [first, second] = score.measures[0]!.notes;
		score.setTie(first!.id, second!.id);
		expect(first!.tiedToId).toBe(second!.id);

		score.setTie(first!.id, null);
		expect(first!.tiedToId).toBeNull();
		expect(first!.isTied).toBe(false);
		expect(score.tiedFromNote(second!.id)).toBeUndefined();
	});
});

describe('Staff/Part model (M2 Slice 3)', () => {
	it('gives every score a default staff 0, treble, with plain buildScore/appendMeasure landing there', () => {
		const score = buildScore([[['C4', 'quarter']]]);
		expect(score.staves).toHaveLength(1);
		expect(score.staves[0]!.index).toBe(0);
		expect(score.staves[0]!.clef).toBe('treble');
		expect(score.clef).toBe('treble');
		expect(score.staves[0]!.measures).toBe(score.measures);
		expect(score.measures[0]!.staffIndex).toBe(0);
		expect(score.parts).toEqual([{ staffIndices: [0] }]);
	});

	it('lets ScoreOptions.clef choose staff 0\'s own clef', () => {
		const score = buildScore([[['G2', 'quarter']]], { clef: 'bass' });
		expect(score.staves[0]!.clef).toBe('bass');
		expect(score.clef).toBe('bass');
	});

	it('appendStaff adds a further staff with its own clef and independent measures', () => {
		const score = buildScore([[['C4', 'quarter']]]);
		const bass = score.appendStaff('bass');
		expect(score.staves).toHaveLength(2);
		expect(bass.index).toBe(1);
		expect(bass.clef).toBe('bass');
		expect(bass.measures).toHaveLength(0);

		const m = score.appendMeasure(1);
		expect(m.staffIndex).toBe(1);
		expect(m.index).toBe(0);
		score.appendNote(m, { pitch: null, value: 'quarter' });
		// The new staff's own measures are untouched by, and do not touch,
		// staff 0's: each staff owns its own independent measures array.
		expect(bass.measures).toHaveLength(1);
		expect(score.staves[0]!.measures).toHaveLength(1);
		expect(score.measures).toHaveLength(1);
	});

	it('addPart records a grouping without drawing anything (Slice 5\'s own job)', () => {
		const score = buildScore([[['C4', 'quarter']]]);
		score.appendStaff('bass');
		const part = score.addPart([0, 1], 'Piano');
		expect(score.parts).toEqual([{ staffIndices: [0] }, { name: 'Piano', staffIndices: [0, 1] }]);
	});

	it('keyFifthsAt/timeAt/endBarlineAt default to staff 0 but resolve a named staff independently', () => {
		const score = buildScore([{ notes: [['G4', 'quarter']], keyFifths: 2 }], { keyFifths: 1 });
		score.appendStaff('bass');
		const m0 = score.appendMeasure(1);
		score.appendNote(m0, { pitch: null, value: 'quarter' });
		const m1 = score.appendMeasure(1);
		score.appendNote(m1, { pitch: null, value: 'quarter' });

		// Staff 0 (default, matching the no-staffIndex call) sees its own key
		// change; staff 1 has none of its own, so it walks back to the score's
		// initial key instead, entirely independently of staff 0's.
		expect(score.keyFifthsAt(0)).toBe(2);
		expect(score.keyFifthsAt(0, 1)).toBe(1);
		expect(score.timeAt(0, 1)).toEqual({ beats: 4, beatType: 4 });
		expect(score.endBarlineAt(1, 1)).toBe('final');
	});
});

describe('slurs', () => {
	it('addSlur wires a span between two arbitrary-pitch notes, no shared pitch required', () => {
		const score = buildScore([
			[
				['C4', 'quarter'],
				['E4', 'quarter'],
				['G4', 'quarter'],
				['B4', 'quarter']
			]
		]);
		const [c4, , , b4] = score.measures[0]!.notes;
		const slur = score.addSlur(c4!.id, b4!.id);
		expect(slur).toEqual({ startNoteId: c4!.id, endNoteId: b4!.id });
		expect(score.slurs).toEqual([slur]);
	});

	it('addSlur validates both ids exist', () => {
		const score = buildScore([[['C4', 'quarter'], ['D4', 'quarter']]]);
		const [c4] = score.measures[0]!.notes;
		expect(() => score.addSlur('does-not-exist', c4!.id)).toThrow(/unknown start note id/);
		expect(() => score.addSlur(c4!.id, 'does-not-exist')).toThrow(/unknown end note id/);
	});

	it('addSlur rejects a rest as either end', () => {
		const score = buildScore([
			[
				['C4', 'quarter'],
				[null, 'quarter'],
				['D4', 'quarter']
			]
		]);
		const [c4, rest, d4] = score.measures[0]!.notes;
		expect(() => score.addSlur(rest!.id, d4!.id)).toThrow(/is a rest/);
		expect(() => score.addSlur(c4!.id, rest!.id)).toThrow(/is a rest/);
	});

	it('addSlur rejects a start that does not precede the end in score order', () => {
		const score = buildScore([[['C4', 'quarter'], ['D4', 'quarter']]]);
		const [c4, d4] = score.measures[0]!.notes;
		expect(() => score.addSlur(d4!.id, c4!.id)).toThrow(/must come before/);
		expect(() => score.addSlur(c4!.id, c4!.id)).toThrow(/must come before/);
	});

	it('notesInOrder flattens measures in score order', () => {
		const score = buildScore([
			[['C4', 'quarter'], ['D4', 'quarter']],
			[['E4', 'quarter'], ['F4', 'quarter']]
		]);
		const order = score.notesInOrder();
		expect(order.map((n) => n.pitch?.step)).toEqual(['C', 'D', 'E', 'F']);
	});

	it('notesInOrder(staffIndex) walks a non-zero staff\'s own notes independently of staff 0', () => {
		// This is the fix for a real bug, not just a scope cut: before it,
		// `notesInOrder` unconditionally read `staves[0]` alone, so a caller
		// asking for staff 1's own order got staff 0's notes instead (or an
		// empty array once staff 0 out-measured staff 1), silently wrong
		// rather than throwing.
		const score = buildScore([[['C4', 'quarter'], ['D4', 'quarter']]]);
		score.appendStaff('bass');
		const bassMeasure = score.appendMeasure(1);
		const g2 = score.appendNote(bassMeasure, { pitch: parsePitch('G2'), value: 'quarter' });
		const a2 = score.appendNote(bassMeasure, { pitch: parsePitch('A2'), value: 'quarter' });
		expect(score.notesInOrder(1)).toEqual([g2, a2]);
		// Staff 0's own order (the default, unchanged) is still just staff 0's.
		expect(score.notesInOrder().map((n) => n.pitch?.step)).toEqual(['C', 'D']);
	});

	it('addSlur succeeds between two notes on a non-zero staff (fixing the old staff-0-only bug)', () => {
		// Before the fix, `addSlur`'s order check always ran against
		// `notesInOrder()` (staff 0 only), so both `order.indexOf(start)` and
		// `order.indexOf(end)` came back `-1` for any staff-1 note, and
		// `-1 >= -1` always threw "must come before" regardless of the
		// actual notes - making a slur on any staff but 0 silently
		// impossible. `addSlur` now resolves each note's own staff and
		// checks order within that staff instead.
		const score = buildScore([[['C4', 'quarter']]]); // staff 0, unrelated filler
		score.appendStaff('bass');
		const bassMeasure = score.appendMeasure(1);
		const g2 = score.appendNote(bassMeasure, { pitch: parsePitch('G2'), value: 'quarter' });
		const a2 = score.appendNote(bassMeasure, { pitch: parsePitch('A2'), value: 'quarter' });
		const slur = score.addSlur(g2.id, a2.id);
		expect(slur).toEqual({ startNoteId: g2.id, endNoteId: a2.id });
	});

	it('addSlur rejects two notes on different staves', () => {
		const score = buildScore([[['C4', 'quarter']]]);
		score.appendStaff('bass');
		const bassMeasure = score.appendMeasure(1);
		const trebleNote = score.measures[0]!.notes[0]!;
		const bassNote = score.appendNote(bassMeasure, { pitch: parsePitch('G2'), value: 'quarter' });
		expect(() => score.addSlur(trebleNote.id, bassNote.id)).toThrow(/must be on the same staff/);
	});

	it('buildScore resolves a SlurSpec by [measureIndex, noteIndex] position', () => {
		const score = buildScore(
			[
				[
					['G4', 'eighth'],
					['A4', 'eighth'],
					['B4', 'eighth'],
					['C5', 'eighth']
				],
				[['D5', 'quarter'], [null, 'quarter'], [null, 'half']]
			],
			{},
			[{ start: [0, 0], end: [1, 0] }]
		);
		const start = score.measures[0]!.notes[0]!;
		const end = score.measures[1]!.notes[0]!;
		expect(score.slurs).toEqual([{ startNoteId: start.id, endNoteId: end.id }]);
	});

	it('buildScore throws when a SlurSpec names a position with no note there', () => {
		expect(() =>
			buildScore([[['C4', 'quarter'], ['D4', 'quarter']]], {}, [{ start: [0, 0], end: [0, 5] }])
		).toThrow(/slur end \[0, 5\] is not a note/);
	});
});

describe('cross-staff beams', () => {
	/** A small two-staff score (treble over bass), each staff's measure 0
	 *  holding two notes at the same measure column, mirroring the shape
	 *  `addCrossStaffBeam` actually needs (see layout.ts's own integration):
	 *  each staff's own notes already correctly notated in its own Measure.
	 *  `trebleNotes`/`bassNotes` let a test vary either side's own content
	 *  (a rest, a too-long duration) without repeating the
	 *  appendStaff/appendMeasure/appendNote boilerplate `buildScore` cannot
	 *  do for a genuinely multi-staff fixture (it only ever populates one
	 *  implicit staff). */
	function buildTwoStaffScore(
		trebleNotes: readonly (readonly [string | null, NoteValue])[] = [
			['G4', 'eighth'],
			['A4', 'eighth']
		],
		bassNotes: readonly (readonly [string | null, NoteValue])[] = [
			['C3', 'eighth'],
			['D3', 'eighth']
		]
	) {
		const score = new Score({ clef: 'treble' });
		score.appendStaff('bass');
		const treble = score.appendMeasure(0);
		const trebleIds = trebleNotes.map(
			([pitch, value]) => score.appendNote(treble, { pitch: pitch === null ? null : parsePitch(pitch), value }).id
		);
		const bass = score.appendMeasure(1);
		const bassIds = bassNotes.map(
			([pitch, value]) => score.appendNote(bass, { pitch: pitch === null ? null : parsePitch(pitch), value }).id
		);
		return { score, trebleIds, bassIds };
	}

	it('addCrossStaffBeam wires a beam findable from either note', () => {
		const { score, trebleIds, bassIds } = buildTwoStaffScore();
		const beam = score.addCrossStaffBeam([...trebleIds, ...bassIds]);
		expect(beam.staffIndices).toEqual([0, 1]);
		expect(score.crossStaffBeams).toEqual([beam]);
		expect(score.crossStaffBeamContaining(trebleIds[0]!)).toBe(beam);
		expect(score.crossStaffBeamContaining(bassIds[1]!)).toBe(beam);
	});

	it('addCrossStaffBeam rejects fewer than 2 note ids', () => {
		const { score, trebleIds } = buildTwoStaffScore();
		expect(() => score.addCrossStaffBeam([trebleIds[0]!])).toThrow(/at least 2/);
	});

	it('addCrossStaffBeam rejects an unknown note id', () => {
		const { score, trebleIds, bassIds } = buildTwoStaffScore();
		expect(() => score.addCrossStaffBeam([...trebleIds, ...bassIds, 'does-not-exist'])).toThrow(
			/unknown note id/
		);
	});

	it('addCrossStaffBeam rejects a rest', () => {
		const { score, trebleIds, bassIds } = buildTwoStaffScore(undefined, [
			['C3', 'eighth'],
			[null, 'eighth']
		]);
		expect(() => score.addCrossStaffBeam([...trebleIds, ...bassIds])).toThrow(/is a rest/);
	});

	it('addCrossStaffBeam rejects a note too long to beam', () => {
		const { score, trebleIds, bassIds } = buildTwoStaffScore([
			['G4', 'quarter'],
			['A4', 'eighth']
		]);
		expect(() => score.addCrossStaffBeam([...trebleIds, ...bassIds])).toThrow(/too long to beam/);
	});

	it('addCrossStaffBeam rejects notes whose measures disagree on index', () => {
		const score = new Score({ clef: 'treble' });
		score.appendStaff('bass');
		const trebleMeasure0 = score.appendMeasure(0);
		const trebleIds = [
			score.appendNote(trebleMeasure0, { pitch: parsePitch('G4'), value: 'eighth' }).id,
			score.appendNote(trebleMeasure0, { pitch: parsePitch('A4'), value: 'eighth' }).id
		];
		// Bass staff gets a padding measure 0 so its actual notes land at
		// measure *index 1*, one column later than the treble notes above.
		score.appendMeasure(1);
		const bassMeasure1 = score.appendMeasure(1);
		const bassIds = [
			score.appendNote(bassMeasure1, { pitch: parsePitch('C3'), value: 'eighth' }).id,
			score.appendNote(bassMeasure1, { pitch: parsePitch('D3'), value: 'eighth' }).id
		];
		expect(() => score.addCrossStaffBeam([...trebleIds, ...bassIds])).toThrow(/same measure column/);
	});

	it('addCrossStaffBeam rejects a single-staff set', () => {
		const { score, trebleIds } = buildTwoStaffScore([
			['G4', 'eighth'],
			['A4', 'eighth'],
			['B4', 'eighth'],
			['C5', 'eighth']
		]);
		expect(() => score.addCrossStaffBeam(trebleIds)).toThrow(/exactly two distinct staves/);
	});

	it('addCrossStaffBeam rejects non-adjacent staff indices', () => {
		const score = new Score({ clef: 'treble' });
		score.appendStaff('treble'); // staff 1, sits between the two staves the beam tries to span
		score.appendStaff('bass'); // staff 2
		const staff0Measure = score.appendMeasure(0);
		const staff0Ids = [
			score.appendNote(staff0Measure, { pitch: parsePitch('G4'), value: 'eighth' }).id,
			score.appendNote(staff0Measure, { pitch: parsePitch('A4'), value: 'eighth' }).id
		];
		score.appendMeasure(1); // staff 1's own measure 0, deliberately empty and not part of the beam
		const staff2Measure = score.appendMeasure(2);
		const staff2Ids = [
			score.appendNote(staff2Measure, { pitch: parsePitch('C3'), value: 'eighth' }).id,
			score.appendNote(staff2Measure, { pitch: parsePitch('D3'), value: 'eighth' }).id
		];
		expect(() => score.addCrossStaffBeam([...staff0Ids, ...staff2Ids])).toThrow(/must be adjacent/);
	});

	it('addCrossStaffBeam rejects fewer than 2 notes on one side', () => {
		const { score, trebleIds, bassIds } = buildTwoStaffScore([['G4', 'eighth']]);
		expect(() => score.addCrossStaffBeam([...trebleIds, ...bassIds])).toThrow(/needs at least 2 notes/);
	});
});

describe('chords (M6 Slice 2)', () => {
	it('buildScore turns a pitch array into an anchor plus chordWithPrevious members', () => {
		const score = buildScore([[[['C4', 'E4', 'G4'], 'half'], ['A4', 'half']]]);
		const notes = score.measures[0]!.notes;
		expect(notes.map((note) => note.chordWithPrevious)).toEqual([false, true, true, false]);
		expect(new Set(notes.map((note) => note.id)).size).toBe(4);
	});

	it('counts a chord once in measureDurationWholes and validateMeasure', () => {
		const score = buildScore([[[['C4', 'E4', 'G4'], 'half'], [['D4', 'F4'], 'half']]]);
		const measure = score.measures[0]!;
		expect(measureDurationWholes(measure)).toBeCloseTo(1, 12);
		const validation = validateMeasure(measure, score.time);
		expect(validation.valid).toBe(true);
		expect(validation.perVoice).toEqual([{ voice: 1, actualWholes: 1, valid: true }]);
	});

	it('groups notes into events per voice with noteEvents, interleaved voices included', () => {
		const score = buildScore([
			[
				[['C5', 'E5'], 'half', { voice: 1 }],
				[['C4', 'E4'], 'whole', { voice: 2 }],
				['D5', 'half', { voice: 1 }]
			]
		]);
		const events = noteEvents(score.measures[0]!.notes);
		expect(events.map((event) => event.map((note) => formatPitch(note.pitch!)))).toEqual([
			['C5', 'E5'],
			['C4', 'E4'],
			['D5']
		]);
	});

	it('rejects a chord member with no pitched anchor in its voice', () => {
		const score = new Score();
		const measure = score.appendMeasure();
		expect(() => score.appendNote(measure, { pitch: parsePitch('C4'), value: 'quarter', chordWithPrevious: true })).toThrow(
			/chord member/
		);
		score.appendNote(measure, { pitch: null, value: 'quarter' });
		expect(() => score.appendNote(measure, { pitch: parsePitch('C4'), value: 'quarter', chordWithPrevious: true })).toThrow(
			/chord member/
		);
		score.appendNote(measure, { pitch: parsePitch('C4'), value: 'quarter', voice: 2 });
		// Voice 1's latest note is the rest, so a voice-1 member still has no anchor.
		expect(() => score.appendNote(measure, { pitch: parsePitch('E4'), value: 'quarter', chordWithPrevious: true })).toThrow();
		expect(() =>
			score.appendNote(measure, { pitch: parsePitch('E4'), value: 'quarter', voice: 2, chordWithPrevious: true })
		).not.toThrow();
		expect(() => score.appendNote(measure, { pitch: null, value: 'quarter', voice: 2, chordWithPrevious: true })).toThrow(
			/rest/
		);
	});

	it('ties each head of a tiedToNext chord to the same-pitch head of the next event', () => {
		const score = buildScore([[[['C4', 'E4'], 'half', { tiedToNext: true }]], [[['E4', 'C4', 'G4'], 'half']]], {
			time: { beats: 2, beatType: 4 }
		});
		const [c, e] = score.measures[0]!.notes;
		const [e2, c2] = score.measures[1]!.notes;
		expect(c!.tiedToId).toBe(c2!.id);
		expect(e!.tiedToId).toBe(e2!.id);
	});

	it('keeps chord membership through clone and checks it in assertScoresEquivalent', () => {
		const score = buildScore([[[['C4', 'E4'], 'whole']]]);
		const copy = score.clone();
		expect(copy.measures[0]!.notes.map((note) => note.chordWithPrevious)).toEqual([false, true]);
		assertScoresEquivalent(copy, score);
		// Same heads, not a chord: one more onset, so not the same music.
		const split = buildScore([[['C4', 'whole'], ['E4', 'whole']]]);
		expect(() => assertScoresEquivalent(split, score)).toThrow(/chordWithPrevious/);
	});

	it('transposes one chord member alone', () => {
		const score = buildScore([[[['C4', 'E4', 'G4'], 'whole']]]);
		const [c, e, g] = score.measures[0]!.notes;
		expect(score.transposeNote(e!.id, 1)).toBe(0);
		expect(formatPitch(e!.pitch!)).toBe('F4');
		expect(formatPitch(c!.pitch!)).toBe('C4');
		expect(formatPitch(g!.pitch!)).toBe('G4');
	});
});

describe('articulations and fermatas on Note (M6 Slice 5)', () => {
	it('normalizes marks into ARTICULATIONS order without duplicates, and defaults to none', () => {
		const note = new Note('n1', { pitch: parsePitch('C4'), value: 'quarter', articulations: ['accent', 'staccato', 'accent'] });
		expect(note.articulations).toEqual(['staccato', 'accent']);
		expect(note.fermata).toBeNull();
		const plain = new Note('n2', { pitch: null, value: 'quarter' });
		expect(plain.articulations).toEqual([]);
	});

	it('puts buildScore marks on a chord\'s anchor, and reads the chord\'s union per event', () => {
		const score = buildScore([[[['C4', 'E4'], 'half', { articulations: ['tenuto'], fermata: 'upright' }], [null, 'half']]]);
		const [anchor, member] = score.measures[0]!.notes;
		expect(anchor!.articulations).toEqual(['tenuto']);
		expect(member!.articulations).toEqual([]);
		member!.articulations = ['accent'];
		member!.fermata = 'inverted';
		const [chord] = noteEvents(score.measures[0]!.notes);
		expect(eventArticulations(chord!)).toEqual(['tenuto', 'accent']);
		expect(eventFermata(chord!)).toBe('upright');
	});

	it('keeps marks through clone (undo) and compares them in equivalence', () => {
		const score = buildScore([[['C4', 'whole', { articulations: ['staccato'], fermata: 'inverted' }]]]);
		const copy = score.clone();
		const note = copy.measures[0]!.notes[0]!;
		expect(note.articulations).toEqual(['staccato']);
		expect(note.fermata).toBe('inverted');
		assertScoresEquivalent(copy, score);
		note.fermata = null;
		expect(() => assertScoresEquivalent(copy, score)).toThrow(/fermata/);
	});
});
