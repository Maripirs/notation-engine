import { describe, expect, it } from 'vitest';
import { formatPitch, parsePitch } from './pitch.js';
import {
	buildScore,
	eventArticulations,
	eventFermata,
	measureCapacityWholes,
	measureDurationWholes,
	Note,
	NOTE_VALUE_WHOLES,
	NOTE_VALUES,
	noteEvents,
	Score,
	TRIPLET,
	validateMeasure,
	type ClefType,
	type MeasureSpec,
	type NoteValue
} from './score.js';

/** A bar of quarter notes, one per pitch, optionally all in `voice`. */
const quarters = (pitches: readonly string[], voice?: number): MeasureSpec =>
	pitches.map((pitch) => [pitch, 'quarter', voice === undefined ? {} : { voice }] as const);

const FULL_BAR = quarters(['C4', 'D4', 'E4', 'F4']);

/** Staff 0's clef at every measure. */
const clefs = (score: Score, staffIndex = 0): ClefType[] =>
	score.staves[staffIndex]!.measures.map((_m, i) => score.clefAt(i, staffIndex));

type NoteLiteral = readonly [string | null, NoteValue];

/** A score whose staff `i` holds `staves[i]`'s measures, built with
 *  appendStaff/appendMeasure/appendNote (buildScore only fills staff 0).
 *  Returns every staff's note ids, flattened across its measures. */
function multiStaff(clefList: readonly ClefType[], staves: readonly (readonly (readonly NoteLiteral[])[])[]) {
	const score = new Score({ clef: clefList[0] });
	for (const clef of clefList.slice(1)) score.appendStaff(clef);
	const ids = staves.map((measures, staffIndex) =>
		measures.flatMap((notes) => {
			const measure = score.appendMeasure(staffIndex);
			return notes.map(([pitch, value]) => score.appendNote(measure, { pitch: pitch === null ? null : parsePitch(pitch), value }).id);
		})
	);
	return { score, ids };
}

describe('Score', () => {
	const fixture = () => buildScore([[['C4', 'quarter']], [['E4', 'quarter'], [null, 'quarter']]], { keyFifths: 1 });

	it('gives every note a distinct id and remembers its measure', () => {
		const score = fixture();
		const ids = score.measures.flatMap((m) => m.notes.map((n) => n.id));
		expect(new Set(ids).size).toBe(ids.length);
		expect(score.measureOfNote(ids[0]!)?.index).toBe(0);
		expect(score.measureOfNote(ids[1]!)?.index).toBe(1);
	});

	it('transposes in place and reports the measure it touched', () => {
		// The return value is the contract the incremental redraw is built on, and
		// note identity must survive the edit (hit-testing addresses notes by id).
		const score = fixture();
		const target = score.measures[1]!.notes[0]!;
		expect(score.transposeNote(target.id, 1)).toBe(1);
		expect(score.findNote(target.id)).toBe(target);
		expect(formatPitch(target.pitch!)).toBe('F4');
	});

	it('treats a rest and an unknown id as no-ops', () => {
		const score = fixture();
		expect(score.transposeNote(score.measures[1]!.notes[1]!.id, 1)).toBeNull();
		expect(score.transposeNote('does-not-exist', 1)).toBeNull();
	});

	it('defaults tempoBpm to 120 and takes an explicit one', () => {
		expect(new Score().tempoBpm).toBe(120);
		expect(new Score({ tempoBpm: 90 }).tempoBpm).toBe(90);
	});
});

describe('Note.durationWholes', () => {
	it.each([
		{ label: 'plain', extra: {}, factor: 1 },
		{ label: 'one dot', extra: { dots: 1 as const }, factor: 1.5 },
		{ label: 'two dots', extra: { dots: 2 as const }, factor: 1.75 },
		{ label: 'triplet', extra: { tuplet: TRIPLET }, factor: 2 / 3 },
		{ label: 'dot and triplet', extra: { dots: 1 as const, tuplet: TRIPLET }, factor: 1.5 * (2 / 3) }
	])('scales every base value by its modifiers: $label', ({ extra, factor }) => {
		for (const value of NOTE_VALUES) {
			const note = new Note('n', { pitch: null, value, ...extra });
			expect(note.durationWholes).toBeCloseTo(NOTE_VALUE_WHOLES[value] * factor, 10);
		}
	});
});

describe('measure duration validation', () => {
	const triplets = quarters(['C4', 'D4', 'E4', 'C4', 'D4', 'E4']).map(([p, v]) => [p, v, { tuplet: TRIPLET }] as const);

	it.each([
		{ label: 'exactly full', notes: FULL_BAR, valid: true, actual: 1 },
		{ label: 'two quarter-note triplet groups', notes: triplets, valid: true, actual: 1 },
		{ label: 'too few beats', notes: FULL_BAR.slice(0, 2), valid: false, actual: 0.5 },
		{ label: 'too many beats', notes: [...FULL_BAR, ['G4', 'quarter'] as const], valid: false, actual: 1.25 }
	])('$label', ({ notes, valid, actual }) => {
		const score = buildScore([notes]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.valid).toBe(valid);
		expect(result.actualWholes).toBeCloseTo(actual, 10);
		expect(result.expectedWholes).toBeCloseTo(1, 10);
		expect(measureDurationWholes(score.measures[0]!)).toBeCloseTo(actual, 10);
	});

	it('measureCapacityWholes reads the time signature', () => {
		expect(measureCapacityWholes({ beats: 4, beatType: 4 })).toBeCloseTo(1, 10);
		expect(measureCapacityWholes({ beats: 6, beatType: 8 })).toBeCloseTo(0.75, 10);
	});

	it('validates each voice on its own, reporting the cross-voice total as actualWholes', () => {
		const score = buildScore([[...quarters(['C4', 'D4', 'E4', 'F4'], 1), ...quarters(['C3', 'D3', 'E3', 'F3'], 2)]]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.valid).toBe(true);
		expect(result.actualWholes).toBeCloseTo(2, 10);
		expect(result.perVoice).toEqual([
			{ voice: 1, actualWholes: expect.closeTo(1, 10), valid: true },
			{ voice: 2, actualWholes: expect.closeTo(1, 10), valid: true }
		]);
	});

	it('flags short voices even when the cross-voice total happens to equal the capacity', () => {
		// 3 quarters + 1 quarter sum to 1 whole: the old sum-everything check called this valid.
		const score = buildScore([[...quarters(['C4', 'D4', 'E4'], 1), ...quarters(['C3'], 2)]]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.actualWholes).toBeCloseTo(1, 10);
		expect(result.valid).toBe(false);
		expect(result.perVoice.map((v) => [v.voice, v.valid])).toEqual([
			[1, false],
			[2, false]
		]);
	});

	it('flags an empty measure rather than calling it vacuously valid', () => {
		const score = buildScore([[]]);
		const result = validateMeasure(score.measures[0]!, score.time);
		expect(result.perVoice).toEqual([]);
		expect(result.valid).toBe(false);
	});
});

describe('key and time changes', () => {
	it('keyFifthsAt and timeAt carry the last stated change forward', () => {
		const three = quarters(['C4', 'D4', 'E4']);
		const score = buildScore(
			[
				FULL_BAR,
				{ notes: FULL_BAR }, // the spec form alone is not a change
				{ notes: three, keyFifths: 2, time: { beats: 3, beatType: 4 } },
				three
			],
			{ keyFifths: 1 }
		);
		expect([0, 1, 2, 3].map((m) => score.keyFifthsAt(m))).toEqual([1, 1, 2, 2]);
		expect([0, 1, 2, 3].map((m) => score.timeAt(m).beats)).toEqual([4, 4, 3, 3]);
		// Validating against the score's initial time would wrongly call measure 3 short.
		expect(validateMeasure(score.measures[3]!, score.time).valid).toBe(false);
		expect(validateMeasure(score.measures[3]!, score.timeAt(3)).valid).toBe(true);
	});
});

describe('clefs', () => {
	const fiveMeasures = (clef: ClefType = 'treble') => buildScore([FULL_BAR, FULL_BAR, FULL_BAR, FULL_BAR, FULL_BAR], { clef });

	it('clefAt walks back to the nearest explicit clef, falling back to the staff\'s own clef', () => {
		const score = buildScore([FULL_BAR, { notes: FULL_BAR, clef: 'bass' }, FULL_BAR, { notes: FULL_BAR, clef: 'treble' }, FULL_BAR]);
		expect(clefs(score)).toEqual(['treble', 'bass', 'bass', 'treble', 'treble']);
	});

	it('treats an explicit measure-0 clef as an override, leaving Staff.clef the initial clef', () => {
		const score = buildScore([{ notes: FULL_BAR, clef: 'treble8' }, FULL_BAR], { clef: 'bass' });
		expect(score.staves[0]!.clef).toBe('bass');
		expect(clefs(score)).toEqual(['treble8', 'treble8']);
	});

	it.each([
		{ label: 'mid-staff range restores the clef after it', from: 1, to: 2, clef: 'bass', expected: ['treble', 'bass', 'bass', 'treble', 'treble'] },
		{ label: 'reversed range running to the end', from: 4, to: 2, clef: 'treble8', expected: ['treble', 'treble', 'treble8', 'treble8', 'treble8'] },
		{ label: 'C clef range', from: 1, to: 3, clef: 'tenor', expected: ['treble', 'tenor', 'tenor', 'tenor', 'treble'] }
	] as const)('setClefRange: $label', ({ from, to, clef, expected }) => {
		const score = fiveMeasures();
		expect(score.setClefRange(0, from, to, clef)).toEqual({ from: Math.min(from, to), to: Math.max(from, to) });
		expect(clefs(score)).toEqual(expected);
	});

	it('setClefRange makes the range uniform, overriding an earlier change inside it', () => {
		const score = fiveMeasures();
		score.setClefRange(0, 2, 2, 'bass');
		score.setClefRange(0, 1, 3, 'alto');
		expect(clefs(score)).toEqual(['treble', 'alto', 'alto', 'alto', 'treble']);
	});

	it('setClefRange returns null when nothing would change or the range is out of bounds', () => {
		const score = fiveMeasures();
		expect(score.setClefRange(0, 0, 4, 'treble')).toBeNull();
		expect(score.setClefRange(0, 3, 9, 'bass')).toBeNull();
		expect(score.setClefRange(5, 0, 0, 'bass')).toBeNull();
		expect(clefs(score)).toEqual(['treble', 'treble', 'treble', 'treble', 'treble']);
	});

	it('clefAt and setClefRange keep each staff independent', () => {
		const { score } = multiStaff(['treble', 'bass'], [[[], []], [[], [], []]]);
		score.staves[1]!.measures[1]!.clef = 'alto';
		expect(clefs(score, 1)).toEqual(['bass', 'alto', 'alto']);
		score.setClefRange(1, 0, 0, 'treble');
		expect(clefs(score, 1)).toEqual(['treble', 'alto', 'alto']);
		expect(clefs(score)).toEqual(['treble', 'treble']);
	});

	it('clefAtOnset reads a mid-measure change from its onset on, and later measures inherit the last one', () => {
		const score = buildScore(
			[
				{ notes: FULL_BAR, clefChanges: [{ onset: 0.5, clef: 'tenor' }] },
				FULL_BAR,
				// Given out of order: buildScore sorts them by onset.
				{ notes: FULL_BAR, clefChanges: [{ onset: 0.75, clef: 'bass' }, { onset: 0.25, clef: 'alto' }] },
				FULL_BAR,
				{ notes: FULL_BAR, clef: 'treble' }
			],
			{ clef: 'bass' }
		);
		const onsets = [0, 0.25, 0.5, 0.75];
		expect(onsets.map((t) => score.clefAtOnset(0, t))).toEqual(['bass', 'bass', 'tenor', 'tenor']);
		expect(score.clefAtEnd(0)).toBe('tenor');
		expect(score.clefAt(1)).toBe('tenor');
		expect(onsets.map((t) => score.clefAtOnset(2, t))).toEqual(['tenor', 'alto', 'alto', 'bass']);
		expect(score.clefAt(3)).toBe('bass');
		// An explicit downbeat clef wins over the clef the previous measure ended in.
		expect(score.clefAt(4)).toBe('treble');
	});

	it('setClefRange clears the range\'s mid-measure changes and keeps the clef the range used to end in after it', () => {
		const score = buildScore([FULL_BAR, { notes: FULL_BAR, clefChanges: [{ onset: 0.5, clef: 'bass' }] }, FULL_BAR]);
		// Already treble at the downbeat, but the change inside makes it no no-op.
		expect(score.setClefRange(0, 1, 1, 'treble')).toEqual({ from: 1, to: 1 });
		expect(score.measures[1]!.clefChanges).toEqual([]);
		expect(score.clefAtEnd(1)).toBe('treble');
		expect(score.clefAt(2)).toBe('bass');
	});
});

describe('barlines', () => {
	it('defaults to normal, with a final barline at the true last measure, and honours an explicit override', () => {
		const one = [['G4', 'quarter']] as const;
		expect([0, 1, 2].map((m) => buildScore([{ notes: one }, one, one]).endBarlineAt(m))).toEqual(['normal', 'normal', 'final']);
		const explicit = buildScore([{ notes: one, endBarline: 'repeatEnd' }, { notes: one, endBarline: 'double' }]);
		expect([explicit.endBarlineAt(0), explicit.endBarlineAt(1)]).toEqual(['repeatEnd', 'double']);
	});

	it('a repeatStart on the next measure wins over this measure\'s own endBarline', () => {
		const one = [['G4', 'quarter']] as const;
		const score = buildScore([{ notes: one, endBarline: 'double' }, { notes: one, startBarline: 'repeatStart' }, one]);
		expect([0, 1, 2].map((m) => score.endBarlineAt(m))).toEqual(['repeatStart', 'normal', 'final']);
	});
});

describe('voices and ties', () => {
	it('defaults a note to voice 1 and wires extra.voice through regardless of array order', () => {
		const score = buildScore([[['C4', 'quarter'], ['E4', 'half', { voice: 2 }], [null, 'quarter']]]);
		expect(score.measures[0]!.notes.map((n) => n.voice)).toEqual([1, 2, 1]);
	});

	it('resolves tiedToNext to the next same-voice note, within a measure or across a barline', () => {
		const score = buildScore([
			[['G4', 'quarter', { tiedToNext: true }], ['G4', 'quarter'], ['C4', 'half', { tiedToNext: true }]],
			[['C4', 'whole']]
		]);
		const [g, g2, c] = score.measures[0]!.notes;
		const c2 = score.measures[1]!.notes[0]!;
		expect(g!.tiedToId).toBe(g2!.id);
		expect(c!.tiedToId).toBe(c2.id);
		expect(c!.isTied).toBe(true);
		expect(score.tiedFromNote(c2.id)).toBe(c);
		expect(score.tiedFromNote(c!.id)).toBeUndefined();
		// Each tied note still counts its own duration toward its own measure.
		expect(validateMeasure(score.measures[0]!, score.time).valid).toBe(true);
		expect(validateMeasure(score.measures[1]!, score.time).valid).toBe(true);
	});

	it('throws when tiedToNext has no following note in its voice', () => {
		expect(() => buildScore([[['C4', 'quarter', { tiedToNext: true }]]])).toThrow(/no following note/);
	});

	it('setTie validates both ends, and setTie(id, null) clears both sides of the index', () => {
		const score = buildScore([[['C4', 'quarter'], ['D4', 'quarter'], ['C4', 'half']]]);
		const [c4, d4, c4b] = score.measures[0]!.notes;
		expect(() => score.setTie(c4!.id, 'does-not-exist')).toThrow(/not a note in this score/);
		expect(() => score.setTie(c4!.id, d4!.id)).toThrow(/same pitch/);
		expect(() => score.setTie('does-not-exist', c4!.id)).toThrow(/unknown note id/);
		score.setTie(c4!.id, c4b!.id);
		expect(score.tiedFromNote(c4b!.id)).toBe(c4);
		score.setTie(c4!.id, null);
		expect(c4!.isTied).toBe(false);
		expect(score.tiedFromNote(c4b!.id)).toBeUndefined();
	});
});

describe('staves and parts', () => {
	it('gives every score a default staff 0 whose clef ScoreOptions.clef chooses', () => {
		const score = buildScore([[['C4', 'quarter']]]);
		expect(score.staves.map((s) => s.clef)).toEqual(['treble']);
		expect(score.staves[0]!.measures).toBe(score.measures);
		expect(score.parts).toEqual([{ staffIndices: [0] }]);
		expect(buildScore([[['G2', 'quarter']]], { clef: 'bass' }).clef).toBe('bass');
	});

	it('appendStaff adds a staff with its own clef and independent measures', () => {
		const score = buildScore([[['C4', 'quarter']]]);
		const bass = score.appendStaff('bass');
		expect([bass.index, bass.clef]).toEqual([1, 'bass']);
		const m = score.appendMeasure(1);
		expect([m.staffIndex, m.index]).toEqual([1, 0]);
		score.appendMeasure(1);
		expect(bass.measures).toHaveLength(2);
		expect(score.measures).toHaveLength(1);
	});

	it('addPart records a grouping', () => {
		const score = buildScore([[['C4', 'quarter']]]);
		score.appendStaff('bass');
		score.addPart([0, 1], 'Piano');
		expect(score.parts).toEqual([{ staffIndices: [0] }, { name: 'Piano', staffIndices: [0, 1] }]);
	});

	it('keyFifthsAt/timeAt/endBarlineAt default to staff 0 but resolve a named staff independently', () => {
		const score = buildScore([{ notes: [['G4', 'quarter']], keyFifths: 2 }], { keyFifths: 1 });
		score.appendStaff('bass');
		score.appendMeasure(1);
		score.appendMeasure(1);
		expect(score.keyFifthsAt(0)).toBe(2);
		expect(score.keyFifthsAt(0, 1)).toBe(1);
		expect(score.timeAt(0, 1)).toEqual({ beats: 4, beatType: 4 });
		expect(score.endBarlineAt(1, 1)).toBe('final');
	});

	it('notesInOrder walks one staff\'s measures in order', () => {
		const { score, ids } = multiStaff(['treble', 'bass'], [[[['C4', 'quarter'], ['D4', 'quarter']], [['E4', 'quarter']]], [[['G2', 'quarter'], ['A2', 'quarter']]]]);
		expect(score.notesInOrder().map((n) => n.id)).toEqual(ids[0]);
		expect(score.notesInOrder(1).map((n) => n.id)).toEqual(ids[1]);
	});
});

describe('slurs', () => {
	const fixture = () => buildScore([[['C4', 'quarter'], [null, 'quarter'], ['D4', 'quarter'], ['B4', 'quarter']]]);

	it('addSlur wires a span between notes of any pitch, on any staff', () => {
		const score = fixture();
		const [c4, , , b4] = score.measures[0]!.notes;
		const slur = score.addSlur(c4!.id, b4!.id);
		expect(slur).toEqual({ startNoteId: c4!.id, endNoteId: b4!.id });
		expect(score.slurs).toEqual([slur]);
		// A staff other than 0 checks order within its own staff.
		const { score: two, ids } = multiStaff(['treble', 'bass'], [[[['C4', 'quarter']]], [[['G2', 'quarter'], ['A2', 'quarter']]]]);
		expect(two.addSlur(ids[1]![0]!, ids[1]![1]!)).toEqual({ startNoteId: ids[1]![0], endNoteId: ids[1]![1] });
		expect(() => two.addSlur(ids[0]![0]!, ids[1]![1]!)).toThrow(/must be on the same staff/);
	});

	it.each([
		{ label: 'unknown start', start: 'x', end: 0, error: /unknown start note id/ },
		{ label: 'unknown end', start: 0, end: 'x', error: /unknown end note id/ },
		{ label: 'rest start', start: 1, end: 2, error: /is a rest/ },
		{ label: 'rest end', start: 0, end: 1, error: /is a rest/ },
		{ label: 'reversed', start: 2, end: 0, error: /must come before/ },
		{ label: 'same note', start: 0, end: 0, error: /must come before/ }
	])('addSlur rejects $label', ({ start, end, error }) => {
		const score = fixture();
		const id = (i: number | string) => (typeof i === 'string' ? i : score.measures[0]!.notes[i]!.id);
		expect(() => score.addSlur(id(start), id(end))).toThrow(error);
	});

	it('buildScore resolves a SlurSpec by [measureIndex, noteIndex], throwing on a missing note', () => {
		const score = buildScore([FULL_BAR, FULL_BAR], {}, [{ start: [0, 0], end: [1, 0] }]);
		expect(score.slurs).toEqual([{ startNoteId: score.measures[0]!.notes[0]!.id, endNoteId: score.measures[1]!.notes[0]!.id }]);
		expect(() => buildScore([FULL_BAR], {}, [{ start: [0, 0], end: [0, 5] }])).toThrow(/slur end \[0, 5\] is not a note/);
	});
});

describe('cross-staff beams', () => {
	const eighths = (...pitches: (string | null)[]): NoteLiteral[] => pitches.map((p) => [p, 'eighth'] as const);

	it('addCrossStaffBeam wires a beam findable from either note', () => {
		const { score, ids } = multiStaff(['treble', 'bass'], [[eighths('G4', 'A4')], [eighths('C3', 'D3')]]);
		const beam = score.addCrossStaffBeam(ids.flat());
		expect(beam.staffIndices).toEqual([0, 1]);
		expect(score.crossStaffBeams).toEqual([beam]);
		expect(score.crossStaffBeamContaining(ids[0]![0]!)).toBe(beam);
		expect(score.crossStaffBeamContaining(ids[1]![1]!)).toBe(beam);
	});

	it.each([
		{ label: 'fewer than 2 ids', staves: [[eighths('G4', 'A4')], [eighths('C3', 'D3')]], pick: (ids: string[][]) => [ids[0]![0]!], error: /at least 2/ },
		{ label: 'an unknown id', staves: [[eighths('G4', 'A4')], [eighths('C3', 'D3')]], pick: (ids: string[][]) => [...ids.flat(), 'x'], error: /unknown note id/ },
		{ label: 'a rest', staves: [[eighths('G4', 'A4')], [eighths('C3', null)]], error: /is a rest/ },
		{ label: 'a note too long to beam', staves: [[[['G4', 'quarter'], ['A4', 'eighth']]], [eighths('C3', 'D3')]], error: /too long to beam/ },
		{ label: 'different measure columns', staves: [[eighths('G4', 'A4')], [[], eighths('C3', 'D3')]], error: /same measure column/ },
		{ label: 'a single staff', staves: [[eighths('G4', 'A4', 'B4', 'C5')], [[]]], error: /exactly two distinct staves/ },
		{ label: 'non-adjacent staves', staves: [[eighths('G4', 'A4')], [[]], [eighths('C3', 'D3')]], error: /must be adjacent/ },
		{ label: 'one side with a single note', staves: [[eighths('G4')], [eighths('C3', 'D3')]], error: /needs at least 2 notes/ }
	] as { label: string; staves: NoteLiteral[][][]; pick?: (ids: string[][]) => string[]; error: RegExp }[])(
		'addCrossStaffBeam rejects $label',
		({ staves, pick, error }) => {
			const { score, ids } = multiStaff(['treble', 'treble', 'bass'].slice(0, staves.length) as ClefType[], staves);
			expect(() => score.addCrossStaffBeam(pick ? pick(ids) : ids.flat())).toThrow(error);
		}
	);
});

describe('chords', () => {
	it('buildScore turns a pitch array into an anchor plus chordWithPrevious members, counted once in time', () => {
		const score = buildScore([[[['C4', 'E4', 'G4'], 'half'], [['D4', 'F4'], 'half']]]);
		const measure = score.measures[0]!;
		expect(measure.notes.map((note) => note.chordWithPrevious)).toEqual([false, true, true, false, true]);
		expect(new Set(measure.notes.map((note) => note.id)).size).toBe(5);
		expect(measureDurationWholes(measure)).toBeCloseTo(1, 12);
		expect(validateMeasure(measure, score.time).perVoice).toEqual([{ voice: 1, actualWholes: 1, valid: true }]);
	});

	it('groups notes into events per voice with noteEvents, interleaved voices included', () => {
		const score = buildScore([[[['C5', 'E5'], 'half', { voice: 1 }], [['C4', 'E4'], 'whole', { voice: 2 }], ['D5', 'half', { voice: 1 }]]]);
		const events = noteEvents(score.measures[0]!.notes);
		expect(events.map((event) => event.map((note) => formatPitch(note.pitch!)))).toEqual([['C5', 'E5'], ['C4', 'E4'], ['D5']]);
	});

	it('rejects a chord member with no pitched anchor in its own voice', () => {
		const score = new Score();
		const measure = score.appendMeasure();
		const member = (pitch: string | null, voice = 1) => () =>
			score.appendNote(measure, { pitch: pitch === null ? null : parsePitch(pitch), value: 'quarter', voice, chordWithPrevious: true });
		expect(member('C4')).toThrow(/chord member/);
		score.appendNote(measure, { pitch: null, value: 'quarter' });
		expect(member('C4')).toThrow(/chord member/);
		score.appendNote(measure, { pitch: parsePitch('C4'), value: 'quarter', voice: 2 });
		// Voice 1's latest note is still the rest.
		expect(member('E4')).toThrow();
		expect(member('E4', 2)).not.toThrow();
		expect(member(null, 2)).toThrow(/rest/);
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

	it('transposes one chord member alone', () => {
		const score = buildScore([[[['C4', 'E4', 'G4'], 'whole']]]);
		const [c, e, g] = score.measures[0]!.notes;
		expect(score.transposeNote(e!.id, 1)).toBe(0);
		expect([c, e, g].map((n) => formatPitch(n!.pitch!))).toEqual(['C4', 'F4', 'G4']);
	});
});

describe('articulations and fermatas', () => {
	it('normalizes marks into ARTICULATIONS order without duplicates, and defaults to none', () => {
		const note = new Note('n1', { pitch: parsePitch('C4'), value: 'quarter', articulations: ['accent', 'staccato', 'accent'] });
		expect(note.articulations).toEqual(['staccato', 'accent']);
		expect(note.fermata).toBeNull();
		expect(new Note('n2', { pitch: null, value: 'quarter' }).articulations).toEqual([]);
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
});
