// M6 Slice 8: grace notes in the model. A grace note is an ordinary `Note`
// stored inline before its principal, taking no measure time: these tests pin
// down that every time-walking helper ignores it, that `graceRuns` attaches
// it to the right principal, and that the correction ops treat it on purpose
// rather than as an ordinary event.

import { describe, expect, it } from 'vitest';
import { parsePitch } from './pitch.js';
import {
	ACCIACCATURA,
	APPOGGIATURA,
	buildScore,
	graceRuns,
	measureDurationWholes,
	Note,
	noteEvents,
	Score,
	TRIPLET,
	validateMeasure
} from './score.js';

const FOUR_FOUR = { beats: 4, beatType: 4 };

/** Measure 0: an acciaccatura before C5, two beamed appoggiaturas before
 *  E5, then a half note; measure 1 ends with a grace with no principal. */
function graceScore(): Score {
	return buildScore([
		[
			['D5', 'eighth', { grace: ACCIACCATURA }],
			['C5', 'quarter'],
			['F4', '16th', { grace: APPOGGIATURA }],
			['G4', '16th', { grace: APPOGGIATURA }],
			['E5', 'quarter'],
			['G4', 'half']
		],
		[
			['C5', 'whole'],
			['B4', 'eighth', { grace: ACCIACCATURA }]
		],
		[['C5', 'whole']]
	]);
}

describe('grace notes take no measure time', () => {
	it('has zero duration, so a measure with graces still sums and validates as full', () => {
		const score = graceScore();
		const [m0, m1] = score.measures;
		const graces = m0!.notes.filter((n) => n.isGrace);
		expect(graces).toHaveLength(3);
		for (const grace of graces) expect(grace.durationWholes).toBe(0);
		expect(measureDurationWholes(m0!)).toBe(1);
		expect(validateMeasure(m0!, FOUR_FOUR).valid).toBe(true);
		expect(validateMeasure(m1!, FOUR_FOUR).valid).toBe(true);
		expect(validateMeasure(m1!, FOUR_FOUR).perVoice).toHaveLength(1);
	});

	it('is not an event: noteEvents leaves graces out and keeps chords intact', () => {
		const score = buildScore([[['A4', 'eighth', { grace: APPOGGIATURA }], [['C5', 'E5'], 'half'], ['G4', 'half']]]);
		const events = noteEvents(score.measures[0]!.notes);
		expect(events.map((e) => e.map((n) => n.pitch!.step).join(''))).toEqual(['CE', 'G']);
	});
});

describe('graceRuns', () => {
	it('attaches each run to the next event anchor of its own voice', () => {
		const score = graceScore();
		const [m0, m1] = score.measures;
		const runs = graceRuns(m0!.notes);
		expect(runs.map((r) => [r.notes.map((n) => n.pitch!.step).join(''), r.principal?.pitch?.step])).toEqual([
			['D', 'C'],
			['FG', 'E']
		]);
		// A run at the end of its voice has no principal in the measure.
		const trailing = graceRuns(m1!.notes);
		expect(trailing).toHaveLength(1);
		expect(trailing[0]!.principal).toBeNull();
	});

	it('keeps voices apart, and a voice holding only graces is not a voice to fill', () => {
		const score = new Score();
		const measure = score.appendMeasure();
		const g1 = score.appendNote(measure, { pitch: parsePitch('D5'), value: 'eighth', grace: ACCIACCATURA });
		const g2 = score.appendNote(measure, { pitch: parsePitch('D4'), value: 'eighth', voice: 2, grace: APPOGGIATURA });
		const p1 = score.appendNote(measure, { pitch: parsePitch('C5'), value: 'whole' });
		const p2 = score.appendNote(measure, { pitch: parsePitch('C4'), value: 'whole', voice: 2 });
		const g3 = score.appendNote(measure, { pitch: parsePitch('E4'), value: 'eighth', voice: 3, grace: APPOGGIATURA });
		expect(graceRuns(measure.notes).map((r) => [r.notes[0]!.id, r.principal?.id ?? null])).toEqual([
			[g1.id, p1.id],
			[g2.id, p2.id],
			[g3.id, null]
		]);
		const validation = validateMeasure(measure, FOUR_FOUR);
		expect(validation.valid).toBe(true);
		expect(validation.perVoice.map((v) => v.voice)).toEqual([1, 2]);
	});

	it('refuses grace rests, grace chord members, tupleted graces and chords anchored on a grace', () => {
		expect(() => new Note('x', { pitch: null, value: 'eighth', grace: APPOGGIATURA })).toThrow(/grace/);
		expect(() => new Note('x', { pitch: parsePitch('C4'), value: 'eighth', chordWithPrevious: true, grace: APPOGGIATURA })).toThrow(/grace/);
		expect(() => new Note('x', { pitch: parsePitch('C4'), value: 'eighth', tuplet: TRIPLET, grace: APPOGGIATURA })).toThrow(/grace/);
		// Nor may a later chord member stand on a grace note as its anchor.
		const score = new Score();
		const measure = score.appendMeasure();
		score.appendNote(measure, { pitch: parsePitch('D5'), value: 'eighth', grace: APPOGGIATURA });
		expect(() => score.appendNote(measure, { pitch: parsePitch('F5'), value: 'quarter', chordWithPrevious: true })).toThrow();
	});

	it('ties past grace notes to the next event in buildScore', () => {
		const score = buildScore([[['C5', 'half', { tiedToNext: true }], ['C5', 'eighth', { grace: APPOGGIATURA }], ['C5', 'half']]]);
		const [first, , last] = score.measures[0]!.notes;
		expect(first!.tiedToId).toBe(last!.id);
	});
});

describe('correction ops on grace notes', () => {
	it('noteToRest removes a grace note outright, dropping a slur to its principal', () => {
		const score = graceScore();
		const grace = score.measures[0]!.notes[0]!;
		expect(score.noteToRest(grace.id)).toEqual([{ staffIndex: 0, measureIndex: 0 }]);
		expect(score.findNote(grace.id)).toBeUndefined();
		expect(score.measures[0]!.notes.filter((n) => n.isGrace)).toHaveLength(2);
		expect(validateMeasure(score.measures[0]!, FOUR_FOUR).valid).toBe(true);

		const slurred = buildScore([[['D5', 'eighth', { grace: APPOGGIATURA }], ['C5', 'whole']]], {}, [{ start: [0, 0], end: [0, 1] }]);
		slurred.noteToRest(slurred.measures[0]!.notes[0]!.id);
		expect(slurred.slurs).toHaveLength(0);
	});

	it('refuses setDuration, chord edits and ties on a grace note', () => {
		const score = graceScore();
		const grace = score.measures[0]!.notes[0]!;
		expect(score.setDuration(grace.id, 'quarter')).toBeNull();
		expect(score.addChordMember(grace.id, parsePitch('F5'))).toBeNull();
		expect(score.removeChordMember(grace.id)).toBeNull();
		expect(score.editTie(grace.id, null)).toBeNull();
		expect(score.tieTargetFor(grace.id)).toBeNull();
	});

	it('transposes a grace note like any note', () => {
		const score = graceScore();
		const grace = score.measures[0]!.notes[0]!;
		expect(score.transposeNote(grace.id, 2)).toBe(0);
		expect(grace.pitch).toEqual(parsePitch('E5'));
	});

	it('edits the principal as if the graces were not there', () => {
		const score = graceScore();
		const [, c5, , , e5] = score.measures[0]!.notes;
		// Shortening the principal pads after it; the graces stay in front.
		expect(score.setDuration(c5!.id, 'eighth')).not.toBeNull();
		expect(score.measures[0]!.notes.map((n) => `${n.pitch?.step ?? 'r'}${n.isGrace ? 'g' : ''}`)).toEqual(['Dg', 'C', 'r', 'Fg', 'Gg', 'E', 'G']);
		expect(validateMeasure(score.measures[0]!, FOUR_FOUR).valid).toBe(true);
		// The next event in the voice skips the graces in between.
		expect(score.addChordMember(e5!.id, parsePitch('G5'))).not.toBeNull();
		expect(graceRuns(score.measures[0]!.notes)[1]!.principal).toBe(e5);
	});
});
