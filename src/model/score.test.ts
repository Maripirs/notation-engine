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
