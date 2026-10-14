import { describe, expect, it } from 'vitest';
import {
	createCrossStaffBeamShowcaseScore,
	createFullDemoScore,
	createSatbBracketShowcaseScore,
	createSlurShowcaseScore,
	createTieShowcaseScore
} from '../demo-score.js';
import { layoutScore, relayoutMeasure } from '../layout/index.js';
import { assertScoresEquivalent } from './score-equivalence.js';
import { buildScore, Score, type Note } from './score.js';

/** First pitched (non-rest) note in staff `staffIndex`'s note order. */
function firstPitchedNote(score: Score, staffIndex = 0): Note {
	const note = score.notesInOrder(staffIndex).find((candidate) => !candidate.isRest);
	if (!note) throw new Error('fixture has no pitched note');
	return note;
}

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

	it('preserves every note id and the id counter, so the clone mints non-colliding ids', () => {
		const source = createFullDemoScore();
		const clone = source.clone();

		const sourceIds = source.staves.flatMap((s) => s.measures.flatMap((m) => m.notes.map((n) => n.id)));
		const cloneIds = clone.staves.flatMap((s) => s.measures.flatMap((m) => m.notes.map((n) => n.id)));
		expect(cloneIds).toEqual(sourceIds);

		// Both start from the same #nextNoteId, so an append on each mints the
		// same fresh id, and it collides with nothing already present.
		const sourceMinted = source.appendNote(source.measures[0]!, { pitch: null, value: 'quarter' });
		const cloneMinted = clone.appendNote(clone.measures[0]!, { pitch: null, value: 'quarter' });
		expect(cloneMinted.id).toBe(sourceMinted.id);
		expect(sourceIds).not.toContain(cloneMinted.id);
	});

	it('shares no mutable node with the source: pitch, both directions', () => {
		const source = createFullDemoScore();
		const clone = source.clone();
		const id = firstPitchedNote(source).id;

		clone.transposeNote(id, 7);
		expect(source.findNote(id)!.pitch).toEqual(firstPitchedNote(createFullDemoScore()).pitch);

		const source2 = createFullDemoScore();
		const clone2 = source2.clone();
		const id2 = firstPitchedNote(source2).id;
		const clonePitchBefore = { ...clone2.findNote(id2)!.pitch! };
		source2.transposeNote(id2, -5);
		expect(clone2.findNote(id2)!.pitch).toEqual(clonePitchBefore);
	});

	it('shares no mutable node: staff clef, measure barline, tiedToId', () => {
		const source = createTieShowcaseScore();
		const clone = source.clone();

		clone.staves[0]!.clef = 'bass';
		expect(source.staves[0]!.clef).toBe('treble');

		clone.staves[0]!.measures[0]!.endBarline = 'double';
		expect(source.staves[0]!.measures[0]!.endBarline).toBeUndefined();

		const tiedSource = source.notesInOrder().find((n) => n.isTied)!;
		expect(clone.findNote(tiedSource.id)!.tiedToId).toBe(tiedSource.tiedToId);
		clone.findNote(tiedSource.id)!.tiedToId = null;
		expect(source.findNote(tiedSource.id)!.tiedToId).toBe(tiedSource.tiedToId);
		expect(source.findNote(tiedSource.id)!.tiedToId).not.toBeNull();
	});

	it('recreates parts, slurs and cross-staff beams as fresh objects, not aliases', () => {
		const satb = createSatbBracketShowcaseScore();
		const satbClone = satb.clone();
		expect(satbClone.parts.map((p) => ({ name: p.name, idx: [...p.staffIndices] }))).toEqual(
			satb.parts.map((p) => ({ name: p.name, idx: [...p.staffIndices] }))
		);
		for (let i = 0; i < satb.parts.length; i++) {
			expect(satbClone.parts[i]).not.toBe(satb.parts[i]);
			expect(satbClone.parts[i]!.staffIndices).not.toBe(satb.parts[i]!.staffIndices);
		}
		// The constructor seeds one staff + one part; a cloned 4-staff score
		// keeps exactly 4 staves and the source's part list, no stray seed.
		expect(satbClone.staves.length).toBe(4);

		const slurScore = createSlurShowcaseScore();
		const slurClone = slurScore.clone();
		expect(slurClone.slurs).toEqual(slurScore.slurs);
		expect(slurClone.slurs[0]).not.toBe(slurScore.slurs[0]);

		const csb = createCrossStaffBeamShowcaseScore();
		const csbClone = csb.clone();
		expect(csbClone.crossStaffBeams).toEqual(csb.crossStaffBeams);
		expect(csbClone.crossStaffBeams[0]).not.toBe(csb.crossStaffBeams[0]);
		const beamedId = csb.crossStaffBeams[0]!.noteIds[0]!;
		expect(csbClone.crossStaffBeamContaining(beamedId)).toBe(csbClone.crossStaffBeams[0]);
	});
});

describe('EditHistory', () => {
	// Imported lazily inside the block only to keep the top import list short;
	// it is a normal static import at module scope.
	// eslint-disable-next-line @typescript-eslint/no-var-requires

	it('a no-op edit records nothing', async () => {
		const { EditHistory } = await import('./edit-history.js');
		const history = new EditHistory(createFullDemoScore());
		const id = firstPitchedNote(history.current).id;

		expect(history.canUndo).toBe(false);
		expect(history.record((s) => s.transposeNote(id, 0))).toBeNull();
		expect(history.record((s) => s.transposeNote('no-such-note', 5))).toBeNull();
		expect(history.canUndo).toBe(false);
	});

	it('undo/redo round-trips a real transpose by musical content', async () => {
		const { EditHistory } = await import('./edit-history.js');
		const history = new EditHistory(createFullDemoScore());
		const id = firstPitchedNote(history.current).id;

		const before = history.current.clone();
		const measureIndex = history.record((s) => s.transposeNote(id, 3));
		expect(typeof measureIndex).toBe('number');
		const after = history.current.clone();

		expect(history.undo()).toBe(history.current);
		assertScoresEquivalent(history.current, before);
		expect(history.redo()).toBe(history.current);
		assertScoresEquivalent(history.current, after);
	});

	it('recording after an undo clears the redo stack', async () => {
		const { EditHistory } = await import('./edit-history.js');
		const history = new EditHistory(createFullDemoScore());
		const [a, b] = history.current.notesInOrder().filter((n) => !n.isRest);

		history.record((s) => s.transposeNote(a!.id, 2));
		history.undo();
		expect(history.canRedo).toBe(true);

		history.record((s) => s.transposeNote(b!.id, 2));
		expect(history.canRedo).toBe(false);
		expect(history.redo()).toBeNull();
	});

	it('caps the undo stack, dropping the oldest snapshot', async () => {
		const { EditHistory } = await import('./edit-history.js');
		const history = new EditHistory(createFullDemoScore(), { cap: 3 });
		const id = firstPitchedNote(history.current).id;

		for (let i = 0; i < 5; i++) history.record((s) => s.transposeNote(id, 1));

		expect(history.undo()).not.toBeNull();
		expect(history.undo()).not.toBeNull();
		expect(history.undo()).not.toBeNull();
		expect(history.canUndo).toBe(false);
		expect(history.undo()).toBeNull();
	});

	it('tracks dirty against the markSaved baseline by content, not identity', async () => {
		const { EditHistory } = await import('./edit-history.js');
		const history = new EditHistory(createFullDemoScore());
		const [a, b] = history.current.notesInOrder().filter((n) => !n.isRest);

		expect(history.dirty).toBe(false);

		history.record((s) => s.transposeNote(a!.id, 1));
		expect(history.dirty).toBe(true);

		history.markSaved();
		expect(history.dirty).toBe(false);

		history.record((s) => s.transposeNote(b!.id, 1));
		expect(history.dirty).toBe(true);

		history.undo(); // back to the (content-equal) saved baseline
		expect(history.dirty).toBe(false);
	});

	it('undoing a transpose restores the exact prior pitch and re-lays-out identically', async () => {
		const { EditHistory } = await import('./edit-history.js');
		const history = new EditHistory(createFullDemoScore());
		const target = firstPitchedNote(history.current);
		const id = target.id;
		const originalPitch = { ...target.pitch! };
		const layoutBefore = layoutScore(history.current);
		// Compare against a relayout of the pre-edit state, not `layoutBefore`
		// itself: `layoutScore` and `relayoutMeasure` can disagree in the last
		// float ulp of staff-line y (a pre-existing drift unrelated to undo).
		const preEdit = relayoutMeasure(history.current.clone(), layoutBefore, history.current.measureOfNote(id)!.index);
		const measureIndex = history.record((s) => s.transposeNote(id, 5)) as number;

		history.undo();

		expect(history.current.findNote(id)!.pitch).toEqual(originalPitch);
		const relaid = relayoutMeasure(history.current, layoutBefore, measureIndex);
		expect(relaid).not.toBeNull();
		const relaidMeasure = relaid!.measures.find((m) => m.index === measureIndex && m.staffIndex === 0);
		const originalMeasure = preEdit!.measures.find((m) => m.index === measureIndex && m.staffIndex === 0);
		expect(relaidMeasure).toEqual(originalMeasure);
	});

	it('setClefRange records exactly one entry, and its undo restores every affected measure\'s clef', async () => {
		const { EditHistory } = await import('./edit-history.js');
		const history = new EditHistory(createFullDemoScore());
		const measureCount = history.current.measures.length;
		expect(measureCount).toBeGreaterThan(3);
		const clefs = (score: Score) => score.measures.map((_m, i) => score.clefAt(i));
		const before = clefs(history.current);

		expect(history.record((s) => s.setClefRange(0, 1, 2, 'bass'))).toEqual({ from: 1, to: 2 });
		expect(clefs(history.current).slice(0, 4)).toEqual([before[0], 'bass', 'bass', before[3]]);
		// A no-op clef edit (the range is already bass) records nothing.
		expect(history.record((s) => s.setClefRange(0, 1, 2, 'bass'))).toBeNull();

		expect(history.undo()).not.toBeNull();
		expect(history.canUndo).toBe(false);
		expect(clefs(history.current)).toEqual(before);
		expect(history.current.measures.every((m) => m.clef === undefined)).toBe(true);
		expect(history.dirty).toBe(false);

		history.redo();
		expect(clefs(history.current).slice(1, 3)).toEqual(['bass', 'bass']);
		expect(history.dirty).toBe(true);
	});

	it('Score.clone copies a measure\'s explicit clef without aliasing it', () => {
		const source = createFullDemoScore();
		source.setClefRange(0, 1, 1, 'bass');
		const clone = source.clone();
		expect(clone.clefAt(1)).toBe('bass');
		assertScoresEquivalent(clone, source);
		clone.setClefRange(0, 1, 1, 'treble8');
		expect(source.clefAt(1)).toBe('bass');
	});

	it('owns its current score: the initial argument is never mutated', async () => {
		const { EditHistory } = await import('./edit-history.js');
		const initial = buildScore([[['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'half']]]);
		const snapshot = initial.clone();
		const history = new EditHistory(initial);
		history.record((s) => s.transposeNote(s.notesInOrder()[0]!.id, 4));
		assertScoresEquivalent(initial, snapshot);
	});
});
