import { describe, expect, it } from 'vitest';
import { formatPitch } from './pitch.js';
import { buildScore } from './score.js';

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
