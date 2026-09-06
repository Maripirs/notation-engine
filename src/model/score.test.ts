import { describe, expect, it } from 'vitest';
import { formatPitch, parsePitch } from './pitch.js';
import {
	buildScore,
	measureCapacityWholes,
	measureDurationWholes,
	Note,
	NOTE_VALUE_WHOLES,
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
