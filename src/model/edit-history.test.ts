import { describe, expect, it } from 'vitest';
import {
	createCrossStaffBeamShowcaseScore,
	createFullDemoScore,
	createSatbBracketShowcaseScore,
	createSlurShowcaseScore,
	createTieShowcaseScore
} from '../demo-score.js';
import { layoutScore } from '../layout/index.js';
import { EditHistory } from './edit-history.js';
import { makeLyric } from './lyrics.js';
import { assertScoresEquivalent } from './score-equivalence.js';
import { ACCIACCATURA, APPOGGIATURA, buildScore, Score, type Note } from './score.js';

/** First pitched (non-rest) note in staff `staffIndex`'s note order. */
function firstPitchedNote(score: Score, staffIndex = 0): Note {
	const note = score.notesInOrder(staffIndex).find((candidate) => !candidate.isRest);
	if (!note) throw new Error('fixture has no pitched note');
	return note;
}

const clefs = (score: Score) => score.measures.map((_m, i) => score.clefAt(i));

const firstNote = (score: Score) => score.measures[0]!.notes[0]!;

const withDirections = () =>
	buildScore(
		[{ notes: [['C4', 'half'], ['D4', 'half']], dynamics: [{ kind: 'f', onset: 0.5 }, { kind: 'p' }] }, [['E4', 'whole']]],
		{},
		[],
		[{ kind: 'crescendo', start: [0, 0], stop: [1, 1], placement: 'above' }]
	);

describe('Score.clone', () => {
	it('re-lays-out to draw ops deep-equal to the source, across every node type', () => {
		for (const make of [
			createFullDemoScore,
			createTieShowcaseScore,
			createSlurShowcaseScore,
			createSatbBracketShowcaseScore,
			createCrossStaffBeamShowcaseScore
		]) {
			const source = make();
			const clone = source.clone();
			expect(layoutScore(clone)).toEqual(layoutScore(source));
			assertScoresEquivalent(clone, source);
		}
	});

	it('preserves note ids and the id counter, and rebuilds the beam index', () => {
		const source = createCrossStaffBeamShowcaseScore();
		const clone = source.clone();
		const ids = (s: Score) => s.staves.flatMap((staff) => staff.measures.flatMap((m) => m.notes.map((n) => n.id)));
		const sourceIds = ids(source);
		expect(ids(clone)).toEqual(sourceIds);
		// Both mint the same next id, colliding with nothing already present.
		const sourceMinted = source.appendNote(source.measures[0]!, { pitch: null, value: 'quarter' });
		const cloneMinted = clone.appendNote(clone.measures[0]!, { pitch: null, value: 'quarter' });
		expect(cloneMinted.id).toBe(sourceMinted.id);
		expect(sourceIds).not.toContain(cloneMinted.id);
		const beamedId = clone.crossStaffBeams[0]!.noteIds[0]!;
		expect(clone.crossStaffBeamContaining(beamedId)).toBe(clone.crossStaffBeams[0]);
		// Equivalence does not compare cross-staff beams, so aliasing is checked directly.
		clone.crossStaffBeams.pop();
		expect(source.crossStaffBeams).toHaveLength(1);
	});

	// Each row: mutating the clone leaves the source untouched (no aliasing),
	// and equivalence notices the change.
	it.each([
		{ name: 'pitch', build: createFullDemoScore, mutate: (s: Score) => s.transposeNote(firstPitchedNote(s).id, 7), differs: /pitch/ },
		{ name: 'staff clef', build: createTieShowcaseScore, mutate: (s: Score) => (s.staves[0]!.clef = 'bass'), differs: /clef/ },
		{ name: 'measure barline', build: createTieShowcaseScore, mutate: (s: Score) => (s.measures[0]!.endBarline = 'double'), differs: /endBarlineAt/ },
		{
			name: 'tie',
			build: createTieShowcaseScore,
			mutate: (s: Score) => (s.notesInOrder().find((n) => n.isTied)!.tiedToId = null),
			differs: /tie/
		},
		{
			name: 'measure clef',
			build: () => {
				const s = createFullDemoScore();
				s.setClefRange(0, 1, 1, 'bass');
				return s;
			},
			mutate: (s: Score) => s.setClefRange(0, 1, 1, 'treble8'),
			differs: /clef/
		},
		{
			name: 'mid-measure clef changes',
			build: () => buildScore([{ notes: [['C4', 'whole']], clefChanges: [{ onset: 0.5, clef: 'tenor' }] }]),
			mutate: (s: Score) => (s.measures[0]!.clefChanges = [{ onset: 0.25, clef: 'alto' }]),
			differs: /clefChanges/
		},
		{
			name: 'articulations',
			build: () => buildScore([[['C4', 'whole', { articulations: ['staccato'], fermata: 'inverted' }]]]),
			mutate: (s: Score) => (firstNote(s).articulations = []),
			differs: /articulations/
		},
		{
			name: 'fermata',
			build: () => buildScore([[['C4', 'whole', { articulations: ['staccato'], fermata: 'inverted' }]]]),
			mutate: (s: Score) => (firstNote(s).fermata = null),
			differs: /fermata/
		},
		{
			name: 'lyrics',
			build: () => buildScore([[['C4', 'whole', { lyrics: [{ text: 'Glo', syllabic: 'begin' }] }]]]),
			mutate: (s: Score) => (firstNote(s).lyrics = [makeLyric({ text: 'ri', syllabic: 'end' })]),
			differs: /lyrics/
		},
		{
			name: 'dynamics',
			build: withDirections,
			mutate: (s: Score) => (s.measures[0]!.dynamics = [{ ...s.measures[0]!.dynamics[0]!, kind: 'pp' }]),
			differs: /dynamics/
		},
		{ name: 'hairpins', build: withDirections, mutate: (s: Score) => (s.wedges[0] = { ...s.wedges[0]!, kind: 'diminuendo' }), differs: /wedges/ },
		{ name: 'slurs', build: createSlurShowcaseScore, mutate: (s: Score) => s.slurs.pop(), differs: /slur/ },
		{ name: 'parts', build: createSatbBracketShowcaseScore, mutate: (s: Score) => (s.parts[0] = { ...s.parts[0]!, name: 'Renamed' }), differs: /part/i }
	])('copies $name without aliasing, and equivalence compares it', ({ build, mutate, differs }) => {
		const source = build();
		const clone = source.clone();
		assertScoresEquivalent(clone, source);
		mutate(clone);
		assertScoresEquivalent(source, build());
		expect(() => assertScoresEquivalent(clone, source)).toThrow(differs);
	});

	it.each([
		{ name: 'a chord from the same heads split apart', a: [[['C4', 'whole'], ['E4', 'whole']]], b: [[[['C4', 'E4'], 'whole']]], differs: /chordWithPrevious/ },
		{
			name: 'an acciaccatura from an appoggiatura',
			a: [[['D5', 'eighth', { grace: APPOGGIATURA }], ['C5', 'whole']]],
			b: [[['D5', 'eighth', { grace: ACCIACCATURA }], ['C5', 'whole']]],
			differs: /grace/
		}
	] as const)('equivalence tells $name', ({ a, b, differs }) => {
		expect(() => assertScoresEquivalent(buildScore(a), buildScore(b))).toThrow(differs);
	});
});

describe('EditHistory', () => {
	it('undo/redo round-trips a real transpose by musical content', () => {
		const history = new EditHistory(createFullDemoScore());
		const id = firstPitchedNote(history.current).id;
		const before = history.current.clone();
		expect(typeof history.record((s) => s.transposeNote(id, 3))).toBe('number');
		const after = history.current.clone();
		expect(history.undo()).toBe(history.current);
		assertScoresEquivalent(history.current, before);
		expect(history.redo()).toBe(history.current);
		assertScoresEquivalent(history.current, after);
	});

	it('recording after an undo clears the redo stack', () => {
		const history = new EditHistory(createFullDemoScore());
		const [a, b] = history.current.notesInOrder().filter((n) => !n.isRest);
		history.record((s) => s.transposeNote(a!.id, 2));
		history.undo();
		expect(history.canRedo).toBe(true);
		history.record((s) => s.transposeNote(b!.id, 2));
		expect(history.canRedo).toBe(false);
		expect(history.redo()).toBeNull();
	});

	it('caps the undo stack, dropping the oldest snapshot', () => {
		const history = new EditHistory(createFullDemoScore(), { cap: 3 });
		const id = firstPitchedNote(history.current).id;
		for (let i = 0; i < 5; i++) history.record((s) => s.transposeNote(id, 1));
		for (let i = 0; i < 3; i++) expect(history.undo()).not.toBeNull();
		expect(history.canUndo).toBe(false);
		expect(history.undo()).toBeNull();
	});

	it('tracks dirty against the markSaved baseline by content, not identity', () => {
		const history = new EditHistory(createFullDemoScore());
		const [a, b] = history.current.notesInOrder().filter((n) => !n.isRest);
		expect(history.dirty).toBe(false);
		history.record((s) => s.transposeNote(a!.id, 1));
		expect(history.dirty).toBe(true);
		history.markSaved();
		expect(history.dirty).toBe(false);
		history.record((s) => s.transposeNote(b!.id, 1));
		expect(history.dirty).toBe(true);
		history.undo();
		expect(history.dirty).toBe(false);
	});

	it('setClefRange records exactly one entry, and its undo restores every affected measure\'s clef', () => {
		const history = new EditHistory(createFullDemoScore());
		const before = clefs(history.current);
		expect(history.record((s) => s.setClefRange(0, 1, 2, 'bass'))).toEqual({ from: 1, to: 2 });
		expect(clefs(history.current).slice(0, 4)).toEqual([before[0], 'bass', 'bass', before[3]]);
		expect(history.record((s) => s.setClefRange(0, 1, 2, 'bass'))).toBeNull();
		expect(history.undo()).not.toBeNull();
		expect(history.canUndo).toBe(false);
		expect(clefs(history.current)).toEqual(before);
		expect(history.dirty).toBe(false);
		history.redo();
		expect(clefs(history.current).slice(1, 3)).toEqual(['bass', 'bass']);
		expect(history.dirty).toBe(true);
	});

	it('owns its current score: the initial argument is never mutated', () => {
		const initial = buildScore([[['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'half']]]);
		const snapshot = initial.clone();
		const history = new EditHistory(initial);
		history.record((s) => s.transposeNote(s.notesInOrder()[0]!.id, 4));
		assertScoresEquivalent(initial, snapshot);
	});
});
