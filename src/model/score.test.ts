import { describe, expect, it } from 'vitest';
import { formatPitch } from './pitch.js';
import {
	buildScore,
	measureCapacityWholes,
	measureDurationWholes,
	Note,
	NOTE_VALUE_WHOLES,
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
