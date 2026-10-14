// Correction ops (M6 Slice 7): noteToRest, restToNote, setDuration,
// addChordMember/removeChordMember and editTie, each run through
// `EditHistory.record` the way the demo runs them, so every test also checks
// that undo restores the exact prior model. The MusicXML side (passthrough
// tie markup, export -> re-import after each op) is in
// `src/io/correction-ops.test.ts`.

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
	type NoteId
} from './score.js';

/** Run `edit` through a fresh history; return the history (its `current` is
 *  the edited score) and what the op returned. */
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
	const measure = score.measures[measureIndex]!;
	expect(validateMeasure(measure, score.timeAt(measureIndex)).valid).toBe(true);
}

const at = (measureIndex: number, staffIndex = 0): MeasureRef => ({ staffIndex, measureIndex });

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

describe('noteToRest', () => {
	const score = () =>
		buildScore([
			[
				['C4', 'quarter', { articulations: ['staccato'], fermata: 'upright' }],
				['D4', 'quarter', { dots: 1 }],
				['E4', 'eighth'],
				['F4', 'quarter']
			]
		]);

	it('keeps the duration (nothing shifts), drops articulations, keeps a fermata, and undoes exactly', () => {
		const { history, result, before } = edit(score(), (s) => s.noteToRest(noteAt(s, 0, 0).id));
		expect(result).toEqual([at(0)]);
		const rest = noteAt(history.current, 0, 0);
		expect(rest.id).toBe(noteAt(before, 0, 0).id);
		expect(spell(history.current)).toEqual(['r/quarter', 'D4/quarter.', 'E4/eighth', 'F4/quarter']);
		expect(rest.articulations).toEqual([]);
		expect(rest.fermata).toBe('upright');
		expectFull(history.current);
		expectUndoRestores(history, before);
	});

	it('refuses a rest or an unknown id without recording', () => {
		const s = buildScore([[[null, 'half'], ['C4', 'half']]]);
		const history = new EditHistory(s);
		expect(history.record((x) => x.noteToRest(noteAt(x, 0, 0).id))).toBeNull();
		expect(history.record((x) => x.noteToRest('nope'))).toBeNull();
		expect(history.canUndo).toBe(false);
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
		expect(after.tiedFromNote(middle.id)).toBeUndefined();
		expect(after.tiedFromNote(noteAt(after, 1, 1).id)).toBeUndefined();
		expectUndoRestores(history, before);
		expect(history.current.tiedFromNote(middle.id)?.id).toBe(noteAt(before, 0, 1).id);
	});

	it('moves a slur end to the nearest note inside the slur, or drops a slur with nothing inside', () => {
		const s = buildScore(
			[[['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter'], ['F4', 'quarter']]],
			{},
			[
				{ start: [0, 0], end: [0, 3] },
				{ start: [0, 2], end: [0, 3] }
			]
		);
		const [c, , e] = s.measures[0]!.notes;
		// Deleting F: C..F ends on E instead; E..F has nothing inside, so it goes.
		const { history, before } = edit(s, (x) => x.noteToRest(noteAt(x, 0, 3).id));
		expect(history.current.slurs).toEqual([{ startNoteId: c!.id, endNoteId: e!.id }]);
		expectUndoRestores(history, before);
		expect(history.current.slurs).toHaveLength(2);
	});

	it('on a chord anchor removes that head and promotes the next head to anchor', () => {
		const s = buildScore([
			[
				[['C4', 'E4', 'G4'], 'half', { articulations: ['accent'], fermata: 'upright' }],
				['A4', 'half']
			]
		]);
		const [anchor, e4, g4] = s.measures[0]!.notes;
		const { history, result, before } = edit(s, (x) => x.noteToRest(anchor!.id));
		expect(result).toEqual([at(0)]);
		const after = history.current;
		expect(spell(after)).toEqual(['E4/half', '+G4/half', 'A4/half']);
		const promoted = after.findNote(e4!.id)!;
		expect(promoted.chordWithPrevious).toBe(false);
		expect(promoted.articulations).toEqual(['accent']);
		expect(promoted.fermata).toBe('upright');
		expect(after.findNote(anchor!.id)).toBeUndefined();
		expect(after.measureOfNote(anchor!.id)).toBeUndefined();
		expect(noteEvents(after.measures[0]!.notes).map((e) => e.map((n) => n.id))).toEqual([[e4!.id, g4!.id], [noteAt(after, 0, 2).id]]);
		expectFull(after);
		expectUndoRestores(history, before);
	});
});

describe('removeChordMember', () => {
	it('moves a removed member\'s marks to the anchor and clears its tie', () => {
		const s = buildScore([
			[[['C4', 'E4'], 'half'], [['C4', 'E4'], 'half']]
		]);
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

	it('refuses a lone note (that is noteToRest) and a rest', () => {
		const s = buildScore([[['C4', 'half'], [null, 'half']]]);
		expect(s.removeChordMember(noteAt(s, 0, 0).id)).toBeNull();
		expect(s.removeChordMember(noteAt(s, 0, 1).id)).toBeNull();
	});

	it('removing the anchor moves its slur and keeps the promoted head\'s own tie', () => {
		const s = buildScore(
			[
				[['G4', 'half'], [['C4', 'E4'], 'half', { tiedToNext: true }]],
				[[['C4', 'E4'], 'whole']]
			],
			{},
			[{ start: [0, 0], end: [0, 1] }]
		);
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
		history.undo();
		expectUndoRestores(history, before);
	});

	it('refuses a pitched note', () => {
		const s = buildScore([[['C4', 'whole']]]);
		expect(s.restToNote(noteAt(s, 0, 0).id, parsePitch('D4'))).toBeNull();
	});

	const measureRest = (beats: number, beatType: number): Score => {
		const s = new Score({ time: { beats, beatType } });
		const m = s.appendMeasure();
		s.appendNote(m, { pitch: null, value: 'whole', measureRestWholes: beats / beatType });
		return s;
	};

	it('turns a whole-measure rest into a note of the measure\'s length when one value spells it', () => {
		for (const [beats, beatType, expected] of [
			[4, 4, 'B4/whole'],
			[2, 2, 'B4/whole'],
			[3, 4, 'B4/half.'],
			[6, 8, 'B4/half.'],
			[7, 8, 'B4/half..']
		] as const) {
			const { history, before } = edit(measureRest(beats, beatType), (x) =>
				x.restToNote(noteAt(x, 0, 0).id, parsePitch('B4'))
			);
			expect(spell(history.current)).toEqual([expected]);
			expectFull(history.current);
			expectUndoRestores(history, before);
		}
	});

	it('refuses a whole-measure rest no single note value fills', () => {
		const s = measureRest(5, 4);
		expect(s.restToNote(noteAt(s, 0, 0).id, parsePitch('B4'))).toBeNull();
		expect(noteAt(s, 0, 0).isMeasureRest).toBe(true);
	});
});

describe('setDuration', () => {
	const one = (spec: MeasureSpec): Score => buildScore([spec, [['C5', 'whole']]]);

	it('shortening pads with aligned rests so the measure stays full', () => {
		const s = one([['C4', 'half'], ['D4', 'half']]);
		const { history, result, before } = edit(s, (x) => x.setDuration(noteAt(x, 0, 0).id, 'eighth'));
		expect(result).toEqual([at(0)]);
		expect(spell(history.current)).toEqual(['C4/eighth', 'r/eighth', 'r/quarter', 'D4/half']);
		expectFull(history.current);
		expectUndoRestores(history, before);
	});

	it('lengthening consumes a following rest exactly', () => {
		const s = one([['C4', 'quarter'], [null, 'quarter'], ['D4', 'half']]);
		const { history, before } = edit(s, (x) => x.setDuration(noteAt(x, 0, 0).id, 'half'));
		expect(spell(history.current)).toEqual(['C4/half', 'D4/half']);
		expectFull(history.current);
		expectUndoRestores(history, before);
	});

	it('lengthening consumes several rests and re-spells the leftover', () => {
		const s = one([['C4', 'quarter'], [null, 'eighth'], [null, 'eighth'], [null, 'half']]);
		const { history } = edit(s, (x) => x.setDuration(noteAt(x, 0, 0).id, 'quarter', 1));
		expect(spell(history.current)).toEqual(['C4/quarter.', 'r/eighth', 'r/half']);
		expectFull(history.current);
		const s2 = one([['C4', 'quarter'], [null, 'half', { dots: 1 }]]);
		const { history: h2 } = edit(s2, (x) => x.setDuration(noteAt(x, 0, 0).id, 'half'));
		expect(spell(h2.current)).toEqual(['C4/half', 'r/half']);
		expectFull(h2.current);
	});

	it('refuses to lengthen into a following note, or past the barline, and records nothing', () => {
		const s = one([['C4', 'quarter'], ['D4', 'quarter'], [null, 'half']]);
		const history = new EditHistory(s);
		expect(history.record((x) => x.setDuration(noteAt(x, 0, 0).id, 'half'))).toBeNull();
		expect(history.record((x) => x.setDuration(noteAt(x, 0, 1).id, 'whole'))).toBeNull();
		expect(history.canUndo).toBe(false);
		expect(spell(history.current)).toEqual(['C4/quarter', 'D4/quarter', 'r/half']);
		// Into the following rest is fine.
		expect(history.record((x) => x.setDuration(noteAt(x, 0, 1).id, 'half', 1))).toEqual([at(0)]);
		expect(spell(history.current)).toEqual(['C4/quarter', 'D4/half.']);
	});

	it('may lengthen into an under-full voice\'s slack, but not past capacity', () => {
		const s = new Score();
		const m = s.appendMeasure();
		const c = s.appendNote(m, { pitch: parsePitch('C4'), value: 'quarter' });
		s.appendNote(m, { pitch: null, value: 'quarter' });
		// Quarter + quarter rest fill half the bar: a dotted whole would need
		// 1.5 wholes, a whole fits (the rest, then the slack).
		expect(s.setDuration(c.id, 'whole', 1)).toBeNull();
		expect(s.setDuration(c.id, 'whole')).toEqual([at(0)]);
		expect(spell(s)).toEqual(['C4/whole']);
	});

	it('changes every head of a chord, keeps its ties, and refuses an unchanged value or a tuplet', () => {
		const t = buildScore([
			[[['C5', 'E5'], 'quarter'], [null, 'quarter'], [null, 'half']],
			[[['C5', 'E5'], 'whole']]
		]);
		const [c5, e5] = t.measures[0]!.notes;
		t.setTie(c5!.id, noteAt(t, 1, 0).id);
		const { history, before } = edit(t, (x) => x.setDuration(e5!.id, 'half'));
		expect(spell(history.current)).toEqual(['C5/half', '+E5/half', 'r/half']);
		expect(history.current.findNote(c5!.id)!.tiedToId).toBe(noteAt(t, 1, 0).id);
		expect(history.record((x) => x.setDuration(c5!.id, 'half'))).toBeNull();
		expectUndoRestores(history, before);

		const triplets = buildScore([
			[['C4', 'eighth', { tuplet: TRIPLET }], ['D4', 'eighth', { tuplet: TRIPLET }], ['E4', 'eighth', { tuplet: TRIPLET }], [null, 'quarter', { dots: 1 }], [null, 'half']]
		]);
		expect(triplets.setDuration(noteAt(triplets, 0, 0).id, 'quarter')).toBeNull();
		// Lengthening into a run of tupleted rests is refused too.
		const intoTuplet = buildScore([[['C4', 'quarter'], [null, 'eighth', { tuplet: TRIPLET }], [null, 'eighth', { tuplet: TRIPLET }], [null, 'eighth', { tuplet: TRIPLET }], [null, 'half']]]);
		expect(intoTuplet.setDuration(noteAt(intoTuplet, 0, 0).id, 'half')).toBeNull();
	});

	it('cuts a whole-measure rest down to an ordinary rest plus padding', () => {
		const s = new Score({ time: { beats: 3, beatType: 4 } });
		const m = s.appendMeasure();
		const rest = s.appendNote(m, { pitch: null, value: 'whole', measureRestWholes: 3 / 4 });
		const { history, before } = edit(s, (x) => x.setDuration(rest.id, 'quarter'));
		expect(spell(history.current)).toEqual(['r/quarter', 'r/quarter', 'r/quarter']);
		expect(history.current.findNote(rest.id)!.isMeasureRest).toBe(false);
		expectFull(history.current);
		expectUndoRestores(history, before);
	});

	it('only touches its own voice in a two-voice measure', () => {
		const s = buildScore([
			[
				['E5', 'half', { voice: 1 }],
				['F5', 'half', { voice: 1 }],
				['C4', 'quarter', { voice: 2 }],
				[null, 'quarter', { voice: 2 }],
				['D4', 'half', { voice: 2 }]
			]
		]);
		const { history } = edit(s, (x) => x.setDuration(noteAt(x, 0, 2).id, 'half'));
		const voices = noteEvents(history.current.measures[0]!.notes).map((e) => `${e[0]!.voice}:${e[0]!.value}`);
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
		// D5 (followed by the rest) becomes a quarter, leaving the top staff
		// one beamable note: the beam is dropped.
		const { history, result } = edit(s, (x) => x.setDuration(ids[1]!, 'quarter'));
		expect(result).toEqual([at(0, 0), at(0, 1)]);
		expect(history.current.crossStaffBeams).toEqual([]);
		expect(history.current.crossStaffBeamContaining(ids[0]!)).toBeUndefined();
	});
});

describe('addChordMember', () => {
	it('adds a head to the note\'s event with the anchor\'s duration', () => {
		const s = buildScore([[['C4', 'half', { dots: 1 }], ['D4', 'quarter']]]);
		const c = noteAt(s, 0, 0);
		const { history, result, before } = edit(s, (x) => x.addChordMember(c.id, parsePitch('E4')));
		expect(result).toEqual([at(0)]);
		expect(spell(history.current)).toEqual(['C4/half.', '+E4/half.', 'D4/quarter']);
		expect(noteEvents(history.current.measures[0]!.notes)).toHaveLength(2);
		expectFull(history.current);
		// Adding a third to the new member lands in the same event.
		const member = noteAt(history.current, 0, 1);
		history.record((x) => x.addChordMember(member.id, parsePitch('G4')));
		expect(spell(history.current)).toEqual(['C4/half.', '+E4/half.', '+G4/half.', 'D4/quarter']);
		history.undo();
		expectUndoRestores(history, before);
	});

	it('refuses a rest or a pitch the chord already has', () => {
		const s = buildScore([[[['C4', 'E4'], 'half'], [null, 'half']]]);
		expect(s.addChordMember(noteAt(s, 0, 0).id, parsePitch('E4'))).toBeNull();
		expect(s.addChordMember(noteAt(s, 0, 2).id, parsePitch('E4'))).toBeNull();
	});
});

describe('editTie', () => {
	const s = () =>
		buildScore([
			[['G4', 'half'], ['C5', 'quarter'], ['D5', 'quarter']],
			[['D5', 'half'], ['D5', 'half']]
		]);

	it('ties to the same-pitch head of the next event, across a barline, and undoes', () => {
		const score = s();
		const d5 = noteAt(score, 0, 2);
		const target = noteAt(score, 1, 0);
		expect(score.tieTargetFor(d5.id)).toBe(target.id);
		const { history, result, before } = edit(score, (x) => x.editTie(d5.id, target.id));
		expect(result).toEqual([at(0), at(1)]);
		expect(history.current.findNote(d5.id)!.tiedToId).toBe(target.id);
		expect(history.current.tiedFromNote(target.id)?.id).toBe(d5.id);
		expect(history.record((x) => x.editTie(d5.id, target.id))).toBeNull();
		// Untie.
		expect(history.record((x) => x.editTie(d5.id, null))).toEqual([at(0), at(1)]);
		expect(history.current.tiedFromNote(target.id)).toBeUndefined();
		expect(history.record((x) => x.editTie(d5.id, null))).toBeNull();
		history.undo();
		history.undo();
		assertScoresEquivalent(history.current, before);
		expect(history.current.findNote(d5.id)!.tiedToId).toBeNull();
	});

	it('refuses a different pitch, a non-adjacent target and a rest', () => {
		const score = s();
		const c5 = noteAt(score, 0, 1);
		expect(score.editTie(c5.id, noteAt(score, 0, 2).id)).toBeNull();
		expect(score.tieTargetFor(c5.id)).toBeNull();
		// D5 in measure 2's second half is not the next event after measure 1's D5.
		expect(score.editTie(noteAt(score, 0, 2).id, noteAt(score, 1, 1).id)).toBeNull();
		const r = buildScore([[[null, 'half'], ['C4', 'half']]]);
		expect(r.editTie(noteAt(r, 0, 0).id, noteAt(r, 0, 1).id)).toBeNull();
	});

	it('ties chord heads to their own same-pitch heads', () => {
		const score = buildScore([[[['C4', 'E4'], 'half'], [['C4', 'E4'], 'half']]]);
		const [, e4, c4b, e4b] = score.measures[0]!.notes;
		expect(score.tieTargetFor(e4!.id)).toBe(e4b!.id);
		expect(score.editTie(e4!.id, c4b!.id)).toBeNull();
		expect(score.editTie(e4!.id, e4b!.id)).toEqual([at(0)]);
	});
});
