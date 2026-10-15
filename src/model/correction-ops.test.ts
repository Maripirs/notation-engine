// Correction ops (M6 Slice 7), each run through `EditHistory.record` the way
// the demo runs them, so a success also checks that undo restores the exact
// prior model. The MusicXML side is in `src/io/correction-ops.test.ts`.

import { describe, expect, it } from 'vitest';
import { EditHistory } from './edit-history.js';
import { formatPitch, parsePitch } from './pitch.js';
import { assertScoresEquivalent } from './score-equivalence.js';
import {
	buildScore,
	noteEvents,
	noteValueForWholes,
	restValuesFor,
	Score,
	TRIPLET,
	validateMeasure,
	type MeasureRef,
	type MeasureSpec,
	type NoteId,
	type NoteValue
} from './score.js';

/** Run `op` through a fresh history; return the history (its `current` is
 *  the edited score), what the op returned, and a copy of the score before. */
function edit<T>(score: Score, op: (s: Score) => T): { history: EditHistory; result: T; before: Score } {
	const history = new EditHistory(score);
	const before = history.current.clone();
	const result = history.record(op);
	return { history, result, before };
}

/** Undo, and require the restored score to be the pre-edit one, ids
 *  included (equivalence ignores id values, so they are compared too). */
function expectUndoRestores(history: EditHistory, before: Score): void {
	expect(history.undo()).not.toBeNull();
	assertScoresEquivalent(history.current, before);
	const ids = (s: Score) => s.staves.map((staff) => staff.measures.map((m) => m.notes.map((n) => n.id)));
	expect(ids(history.current)).toEqual(ids(before));
}

/** The measure's notes as compact strings: `C4/quarter`, `r/eighth`,
 *  `+E4` for a chord member, `.` per dot. */
function spell(score: Score, measureIndex = 0, staffIndex = 0): string[] {
	return score.staves[staffIndex]!.measures[measureIndex]!.notes.map((n) => {
		const head = n.pitch === null ? 'r' : formatPitch(n.pitch);
		return `${n.chordWithPrevious ? '+' : ''}${head}/${n.isMeasureRest ? 'measure' : n.value}${'.'.repeat(n.dots)}`;
	});
}

function noteAt(score: Score, measureIndex: number, noteIndex: number, staffIndex = 0) {
	return score.staves[staffIndex]!.measures[measureIndex]!.notes[noteIndex]!;
}

function expectFull(score: Score, measureIndex = 0): void {
	expect(validateMeasure(score.measures[measureIndex]!, score.timeAt(measureIndex)).valid).toBe(true);
}

const at = (measureIndex: number, staffIndex = 0): MeasureRef => ({ staffIndex, measureIndex });

/** `spec` followed by a full second measure. */
const one = (spec: MeasureSpec): Score => buildScore([spec, [['C5', 'whole']]]);

/** A single whole-measure rest in `beats`/`beatType`. */
function measureRest(beats: number, beatType: number): Score {
	const s = new Score({ time: { beats, beatType } });
	s.appendNote(s.appendMeasure(), { pitch: null, value: 'whole', measureRestWholes: beats / beatType });
	return s;
}

const first = (s: Score) => noteAt(s, 0, 0).id;

describe('duration helpers', () => {
	it('noteValueForWholes finds a single value, plain before dotted, or null', () => {
		expect(noteValueForWholes(1)).toEqual({ value: 'whole', dots: 0 });
		expect(noteValueForWholes(3 / 4)).toEqual({ value: 'half', dots: 1 });
		expect(noteValueForWholes(7 / 8)).toEqual({ value: 'half', dots: 2 });
		expect(noteValueForWholes(5 / 8)).toBeNull();
		expect(noteValueForWholes(5 / 4)).toBeNull();
		expect(noteValueForWholes(3 / 8, [0])).toBeNull();
	});

	it('restValuesFor aligns each rest to its own length', () => {
		expect(restValuesFor(1 / 8, 3 / 8)).toEqual(['eighth', 'quarter']);
		expect(restValuesFor(1 / 4, 3 / 4)).toEqual(['quarter', 'half']);
		expect(restValuesFor(0, 3 / 4)).toEqual(['half', 'quarter']);
		expect(restValuesFor(1 / 2, 0)).toEqual([]);
		// Below a 64th (a tuplet fraction): unspellable.
		expect(restValuesFor(0, 1 / 96)).toBeNull();
	});
});

describe('refused correction ops', () => {
	const restThenNote = () => buildScore([[[null, 'half'], ['C4', 'half']]]);
	const chordThenRest = () => buildScore([[[['C4', 'E4'], 'half'], [null, 'half']]]);
	const quarterQuarterRest = () => one([['C4', 'quarter'], ['D4', 'quarter'], [null, 'half']]);
	const tieFixture = () => buildScore([[['G4', 'half'], ['C5', 'quarter'], ['D5', 'quarter']], [['D5', 'half'], ['D5', 'half']]]);
	const tupletRests = { tuplet: TRIPLET };

	it.each([
		{ label: 'noteToRest on a rest', build: restThenNote, op: (s: Score) => s.noteToRest(first(s)) },
		{ label: 'noteToRest on an unknown id', build: restThenNote, op: (s: Score) => s.noteToRest('nope') },
		{ label: 'removeChordMember on a lone note', build: () => one([['C4', 'whole']]), op: (s: Score) => s.removeChordMember(first(s)) },
		{ label: 'removeChordMember on a rest', build: restThenNote, op: (s: Score) => s.removeChordMember(first(s)) },
		{ label: 'restToNote on a pitched note', build: () => one([['C4', 'whole']]), op: (s: Score) => s.restToNote(first(s), parsePitch('D4')) },
		{ label: 'restToNote on a measure rest no single value fills', build: () => measureRest(5, 4), op: (s: Score) => s.restToNote(first(s), parsePitch('B4')) },
		{ label: 'setDuration into a following note', build: quarterQuarterRest, op: (s: Score) => s.setDuration(first(s), 'half') },
		{ label: 'setDuration past the barline', build: quarterQuarterRest, op: (s: Score) => s.setDuration(noteAt(s, 0, 1).id, 'whole') },
		{ label: 'setDuration to the unchanged value', build: chordThenRest, op: (s: Score) => s.setDuration(noteAt(s, 0, 1).id, 'half') },
		{
			label: 'setDuration on a tupleted note',
			build: () => one([['C4', 'eighth', tupletRests], ['D4', 'eighth', tupletRests], ['E4', 'eighth', tupletRests], [null, 'quarter', { dots: 1 }], [null, 'half']]),
			op: (s: Score) => s.setDuration(first(s), 'quarter')
		},
		{
			label: 'setDuration into tupleted rests',
			build: () => one([['C4', 'quarter'], [null, 'eighth', tupletRests], [null, 'eighth', tupletRests], [null, 'eighth', tupletRests], [null, 'half']]),
			op: (s: Score) => s.setDuration(first(s), 'half')
		},
		{
			label: 'setDuration past an under-full voice\'s capacity',
			build: () => buildScore([[['C4', 'quarter'], [null, 'quarter']]]),
			op: (s: Score) => s.setDuration(first(s), 'whole', 1)
		},
		{ label: 'addChordMember on a rest', build: chordThenRest, op: (s: Score) => s.addChordMember(noteAt(s, 0, 2).id, parsePitch('E4')) },
		{ label: 'addChordMember with a pitch the chord has', build: chordThenRest, op: (s: Score) => s.addChordMember(first(s), parsePitch('E4')) },
		{ label: 'editTie to a different pitch', build: tieFixture, op: (s: Score) => s.editTie(noteAt(s, 0, 1).id, noteAt(s, 0, 2).id) },
		{ label: 'editTie to a non-adjacent event', build: tieFixture, op: (s: Score) => s.editTie(noteAt(s, 0, 2).id, noteAt(s, 1, 1).id) },
		{ label: 'editTie from a rest', build: restThenNote, op: (s: Score) => s.editTie(first(s), noteAt(s, 0, 1).id) },
		{ label: 'editTie(null) on an untied note', build: tieFixture, op: (s: Score) => s.editTie(noteAt(s, 0, 2).id, null) },
		{
			label: 'editTie from a chord head to a different-pitch head',
			build: () => buildScore([[[['C4', 'E4'], 'half'], [['C4', 'E4'], 'half']]]),
			op: (s: Score) => s.editTie(noteAt(s, 0, 1).id, noteAt(s, 0, 2).id)
		}
	])('$label returns null and records nothing', ({ build, op }) => {
		const history = new EditHistory(build());
		expect(history.record(op)).toBeNull();
		expect(history.canUndo).toBe(false);
		assertScoresEquivalent(history.current, build());
	});
});

describe('noteToRest', () => {
	it('keeps the duration (nothing shifts), drops articulations, keeps a fermata, and keeps the id', () => {
		const s = buildScore([
			[['C4', 'quarter', { articulations: ['staccato'], fermata: 'upright' }], ['D4', 'quarter', { dots: 1 }], ['E4', 'eighth'], ['F4', 'quarter']]
		]);
		const id = first(s);
		const { history, result, before } = edit(s, (x) => x.noteToRest(id));
		expect(result).toEqual([at(0)]);
		const rest = noteAt(history.current, 0, 0);
		expect(rest.id).toBe(id);
		expect(spell(history.current)).toEqual(['r/quarter', 'D4/quarter.', 'E4/eighth', 'F4/quarter']);
		expect(rest.articulations).toEqual([]);
		expect(rest.fermata).toBe('upright');
		expectFull(history.current);
		expectUndoRestores(history, before);
	});

	it('clears ties into and out of the note, touching the partner measures across barlines', () => {
		const s = buildScore([
			[['G4', 'half'], ['C5', 'half', { tiedToNext: true }]],
			[['C5', 'half', { tiedToNext: true }], ['C5', 'half']],
			[['C5', 'whole']]
		]);
		const middle = noteAt(s, 1, 0);
		const { history, result, before } = edit(s, (x) => x.noteToRest(middle.id));
		expect(result).toEqual([at(0), at(1)]);
		const after = history.current;
		expect(noteAt(after, 0, 1).tiedToId).toBeNull();
		expect(noteAt(after, 1, 0).tiedToId).toBeNull();
		expect(after.tiedFromNote(noteAt(after, 1, 1).id)).toBeUndefined();
		expectUndoRestores(history, before);
	});

	it('moves a slur end to the nearest note inside the slur, or drops a slur with nothing inside', () => {
		const s = buildScore([[['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter'], ['F4', 'quarter']]], {}, [
			{ start: [0, 0], end: [0, 3] },
			{ start: [0, 2], end: [0, 3] }
		]);
		const [c, , e] = s.measures[0]!.notes;
		// Deleting F: C..F ends on E instead; E..F has nothing inside, so it goes.
		const { history, before } = edit(s, (x) => x.noteToRest(noteAt(x, 0, 3).id));
		expect(history.current.slurs).toEqual([{ startNoteId: c!.id, endNoteId: e!.id }]);
		expectUndoRestores(history, before);
	});

	it('on a chord anchor removes that head and promotes the next head to anchor, marks included', () => {
		const s = buildScore([[[['C4', 'E4', 'G4'], 'half', { articulations: ['accent'], fermata: 'upright' }], ['A4', 'half']]]);
		const [anchor, e4, g4] = s.measures[0]!.notes;
		const { history, result, before } = edit(s, (x) => x.noteToRest(anchor!.id));
		expect(result).toEqual([at(0)]);
		const after = history.current;
		expect(spell(after)).toEqual(['E4/half', '+G4/half', 'A4/half']);
		const promoted = after.findNote(e4!.id)!;
		expect(promoted.articulations).toEqual(['accent']);
		expect(promoted.fermata).toBe('upright');
		expect(after.findNote(anchor!.id)).toBeUndefined();
		expect(after.measureOfNote(anchor!.id)).toBeUndefined();
		expect(noteEvents(after.measures[0]!.notes).map((ev) => ev.map((n) => n.id))).toEqual([[e4!.id, g4!.id], [noteAt(after, 0, 2).id]]);
		expectUndoRestores(history, before);
	});
});

describe('removeChordMember', () => {
	it('moves a removed member\'s marks to the anchor and clears its tie', () => {
		const s = buildScore([[[['C4', 'E4'], 'half'], [['C4', 'E4'], 'half']]]);
		const notes = s.measures[0]!.notes;
		const member = notes[1]!;
		member.articulations = ['tenuto'];
		member.fermata = 'inverted';
		s.setTie(member.id, notes[3]!.id);
		const { history, result, before } = edit(s, (x) => x.removeChordMember(member.id));
		expect(result).toEqual([at(0)]);
		const after = history.current;
		expect(spell(after)).toEqual(['C4/half', 'C4/half', '+E4/half']);
		expect(after.findNote(notes[0]!.id)!.articulations).toEqual(['tenuto']);
		expect(after.findNote(notes[0]!.id)!.fermata).toBe('inverted');
		expect(after.tiedFromNote(notes[3]!.id)).toBeUndefined();
		expectUndoRestores(history, before);
	});

	it('removing the anchor moves its slur and keeps the promoted head\'s own tie', () => {
		const s = buildScore([[['G4', 'half'], [['C4', 'E4'], 'half', { tiedToNext: true }]], [[['C4', 'E4'], 'whole']]], {}, [
			{ start: [0, 0], end: [0, 1] }
		]);
		const [g4, anchor, member] = s.measures[0]!.notes;
		const { history, result, before } = edit(s, (x) => x.removeChordMember(anchor!.id));
		// The anchor's tie went to measure 2, so both measures are touched.
		expect(result).toEqual([at(0), at(1)]);
		const after = history.current;
		expect(after.slurs).toEqual([{ startNoteId: g4!.id, endNoteId: member!.id }]);
		expect(after.findNote(member!.id)!.chordWithPrevious).toBe(false);
		expect(after.findNote(member!.id)!.tiedToId).toBe(noteAt(after, 1, 1).id);
		expect(after.tiedFromNote(noteAt(after, 1, 0).id)).toBeUndefined();
		expectUndoRestores(history, before);
	});
});

describe('restToNote', () => {
	it('turns a rest into a note of the same duration, and noteToRest turns it back', () => {
		const s = buildScore([[['C4', 'quarter'], [null, 'quarter', { dots: 1 }], ['E4', 'eighth'], ['F4', 'quarter']]]);
		const rest = noteAt(s, 0, 1);
		const { history, result, before } = edit(s, (x) => x.restToNote(rest.id, parsePitch('B4')));
		expect(result).toEqual([at(0)]);
		expect(spell(history.current)).toEqual(['C4/quarter', 'B4/quarter.', 'E4/eighth', 'F4/quarter']);
		history.record((x) => x.noteToRest(rest.id));
		assertScoresEquivalent(history.current, before);
	});

	it.each([
		[4, 4, 'B4/whole'],
		[2, 2, 'B4/whole'],
		[3, 4, 'B4/half.'],
		[6, 8, 'B4/half.'],
		[7, 8, 'B4/half..']
	] as const)('turns a %i/%i whole-measure rest into %s', (beats, beatType, expected) => {
		const { history, before } = edit(measureRest(beats, beatType), (x) => x.restToNote(first(x), parsePitch('B4')));
		expect(spell(history.current)).toEqual([expected]);
		expectFull(history.current);
		expectUndoRestores(history, before);
	});
});

describe('setDuration', () => {
	// [label, score, index of the note to change, new value, dots, resulting measure]
	it.each<[string, () => Score, number, NoteValue, 0 | 1, string[]]>([
		['shortening pads with aligned rests', () => one([['C4', 'half'], ['D4', 'half']]), 0, 'eighth', 0, ['C4/eighth', 'r/eighth', 'r/quarter', 'D4/half']],
		['lengthening consumes a following rest exactly', () => one([['C4', 'quarter'], [null, 'quarter'], ['D4', 'half']]), 0, 'half', 0, ['C4/half', 'D4/half']],
		[
			'lengthening consumes several rests and re-spells the leftover',
			() => one([['C4', 'quarter'], [null, 'eighth'], [null, 'eighth'], [null, 'half']]),
			0,
			'quarter',
			1,
			['C4/quarter.', 'r/eighth', 'r/half']
		],
		['lengthening into part of a dotted rest', () => one([['C4', 'quarter'], [null, 'half', { dots: 1 }]]), 0, 'half', 0, ['C4/half', 'r/half']],
		['lengthening the last note into the trailing rest', () => one([['C4', 'quarter'], ['D4', 'quarter'], [null, 'half']]), 1, 'half', 1, ['C4/quarter', 'D4/half.']],
		['lengthening into an under-full voice\'s slack', () => buildScore([[['C4', 'quarter'], [null, 'quarter']]]), 0, 'whole', 0, ['C4/whole']],
		['cutting a whole-measure rest to rests plus padding', () => measureRest(3, 4), 0, 'quarter', 0, ['r/quarter', 'r/quarter', 'r/quarter']]
	])('%s', (_label, build, note, value, dots, expected) => {
		const { history, result, before } = edit(build(), (x) => x.setDuration(noteAt(x, 0, note).id, value, dots));
		expect(result).toEqual([at(0)]);
		expect(spell(history.current)).toEqual(expected);
		expectFull(history.current);
		expectUndoRestores(history, before);
	});

	it('changes every head of a chord and keeps its ties', () => {
		const t = buildScore([[[['C5', 'E5'], 'quarter'], [null, 'quarter'], [null, 'half']], [[['C5', 'E5'], 'whole']]]);
		const [c5, e5] = t.measures[0]!.notes;
		t.setTie(c5!.id, noteAt(t, 1, 0).id);
		const { history, before } = edit(t, (x) => x.setDuration(e5!.id, 'half'));
		expect(spell(history.current)).toEqual(['C5/half', '+E5/half', 'r/half']);
		expect(history.current.findNote(c5!.id)!.tiedToId).toBe(noteAt(t, 1, 0).id);
		expectUndoRestores(history, before);
	});

	it('only touches its own voice in a two-voice measure', () => {
		const s = buildScore([
			[['E5', 'half', { voice: 1 }], ['F5', 'half', { voice: 1 }], ['C4', 'quarter', { voice: 2 }], [null, 'quarter', { voice: 2 }], ['D4', 'half', { voice: 2 }]]
		]);
		const { history } = edit(s, (x) => x.setDuration(noteAt(x, 0, 2).id, 'half'));
		const voices = noteEvents(history.current.measures[0]!.notes).map((ev) => `${ev[0]!.voice}:${ev[0]!.value}`);
		expect(voices).toEqual(['1:half', '1:half', '2:half', '2:half']);
		expectFull(history.current);
	});

	it('takes a note that is now too long to beam out of its cross-staff beam', () => {
		const s = new Score();
		s.appendStaff('bass');
		const top = s.appendMeasure(0);
		const bottom = s.appendMeasure(1);
		const ids: NoteId[] = [];
		for (const [measure, pitch] of [[top, 'C5'], [top, 'D5'], [bottom, 'C3'], [bottom, 'D3']] as const) {
			ids.push(s.appendNote(measure, { pitch: parsePitch(pitch), value: 'eighth' }).id);
		}
		s.appendNote(top, { pitch: null, value: 'half', dots: 1 });
		s.appendNote(bottom, { pitch: null, value: 'half', dots: 1 });
		s.addCrossStaffBeam(ids);
		// D5 becomes a quarter, leaving the top staff one beamable note.
		const { history, result } = edit(s, (x) => x.setDuration(ids[1]!, 'quarter'));
		expect(result).toEqual([at(0, 0), at(0, 1)]);
		expect(history.current.crossStaffBeams).toEqual([]);
		expect(history.current.crossStaffBeamContaining(ids[0]!)).toBeUndefined();
	});
});

describe('addChordMember', () => {
	it('adds a head to the note\'s event with the anchor\'s duration, also from a member', () => {
		const s = buildScore([[['C4', 'half', { dots: 1 }], ['D4', 'quarter']]]);
		const { history, result, before } = edit(s, (x) => x.addChordMember(first(x), parsePitch('E4')));
		expect(result).toEqual([at(0)]);
		expect(spell(history.current)).toEqual(['C4/half.', '+E4/half.', 'D4/quarter']);
		expectFull(history.current);
		history.record((x) => x.addChordMember(noteAt(x, 0, 1).id, parsePitch('G4')));
		expect(spell(history.current)).toEqual(['C4/half.', '+E4/half.', '+G4/half.', 'D4/quarter']);
		history.undo();
		expectUndoRestores(history, before);
	});
});

describe('editTie', () => {
	it('ties to the same-pitch head of the next event, across a barline, then unties, and undoes', () => {
		const score = buildScore([[['G4', 'half'], ['C5', 'quarter'], ['D5', 'quarter']], [['D5', 'half'], ['D5', 'half']]]);
		const d5 = noteAt(score, 0, 2);
		const target = noteAt(score, 1, 0);
		expect(score.tieTargetFor(d5.id)).toBe(target.id);
		expect(score.tieTargetFor(noteAt(score, 0, 1).id)).toBeNull();
		const { history, result, before } = edit(score, (x) => x.editTie(d5.id, target.id));
		expect(result).toEqual([at(0), at(1)]);
		expect(history.current.tiedFromNote(target.id)?.id).toBe(d5.id);
		expect(history.record((x) => x.editTie(d5.id, target.id))).toBeNull();
		expect(history.record((x) => x.editTie(d5.id, null))).toEqual([at(0), at(1)]);
		expect(history.current.tiedFromNote(target.id)).toBeUndefined();
		history.undo();
		expectUndoRestores(history, before);
	});

	it('ties chord heads to their own same-pitch heads', () => {
		const score = buildScore([[[['C4', 'E4'], 'half'], [['C4', 'E4'], 'half']]]);
		const [, e4, , e4b] = score.measures[0]!.notes;
		expect(score.tieTargetFor(e4!.id)).toBe(e4b!.id);
		expect(score.editTie(e4!.id, e4b!.id)).toEqual([at(0)]);
	});
});
