// Repeats and voltas in playback (M6 Slice 14): the measure play order and
// the timeline that walks it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../io/index.js';
import { buildScore, type NoteId, type Score } from '../model/index.js';
import { createSatbBracketShowcaseScore } from '../demo-score.js';
import { measurePlayOrder } from './play-order.js';
import { computePlaybackTimeline, firstOnsetSeconds } from './timeline.js';

const fixture = (path: string): Score =>
	importMusicXml(readFileSync(join(import.meta.dirname, '../test/fixtures', path), 'utf8'));
const VOLTAS = fixture('repeats-voltas.musicxml');

/** Each note id's measure index, across every staff. */
function measureOfNote(score: Score): Map<NoteId, number> {
	const out = new Map<NoteId, number>();
	for (const staff of score.staves) for (const m of staff.measures) for (const n of m.notes) out.set(n.id, m.index);
	return out;
}

describe('measure play order', () => {
	it('unfolds the fixture: 1st/2nd endings, then a times="3" repeat with "1, 2" and 3rd endings', () => {
		expect(measurePlayOrder(VOLTAS).map(({ measureIndex, pass }) => `${measureIndex + 1}.${pass}`)).toEqual([
			'1.1',
			'2.1',
			'3.1',
			'4.1',
			'2.2',
			'5.2',
			'6.1',
			'7.1',
			'6.2',
			'7.2',
			'6.3',
			'8.3',
			'9.1'
		]);
	});

	it('plays a score without repeats in written order, and its events carry no play index', () => {
		const score = createSatbBracketShowcaseScore();
		const count = score.staves[0]!.measures.length;
		expect(measurePlayOrder(score).map((p) => p.measureIndex)).toEqual([...Array(count).keys()]);
		expect(computePlaybackTimeline(score).some((e) => 'playIndex' in e)).toBe(false);
	});
});

describe('computePlaybackTimeline: repeats (M6 Slice 14)', () => {
	it('lays the fixture out in play order, time increasing', () => {
		const events = computePlaybackTimeline(VOLTAS);
		const measureOf = measureOfNote(VOLTAS);
		const order = measurePlayOrder(VOLTAS);
		for (let i = 1; i < events.length; i++) expect(events[i]!.startSeconds).toBeGreaterThan(events[i - 1]!.startSeconds);
		// Every event sits in the measure its play index names.
		for (const e of events) expect(order[e.playIndex!]!.measureIndex).toBe(measureOf.get(e.noteId));
		expect(new Set(events.map((e) => e.playIndex)).size).toBe(order.length);
	});

	it.each([
		['the first repeat', 1, 2],
		['the times="3" repeat', 5, 3]
	])('plays a note of %s once per pass', (_, measureIndex, times) => {
		const noteId = VOLTAS.staves[0]!.measures[measureIndex]!.notes[0]!.id;
		const starts = computePlaybackTimeline(VOLTAS)
			.filter((e) => e.noteId === noteId)
			.map((e) => e.startSeconds);
		expect(starts).toHaveLength(times);
		expect([...starts].sort((a, b) => a - b)).toEqual(starts);
	});

	it('ends a tie chain at a jump, and keeps it on the pass that runs on', () => {
		// A whole note tied over a repeat barline: pass 1 jumps back, pass 2
		// runs on into the tie's target.
		const score = buildScore([
			{ notes: [['G4', 'whole', { tiedToNext: true }]], endBarline: 'repeatEnd' },
			[['G4', 'whole']]
		]);
		const events = computePlaybackTimeline(score);
		const first = score.staves[0]!.measures[0]!.notes[0]!.id;
		expect(events.map((e) => [e.noteId, e.startSeconds, e.durationSeconds])).toEqual([
			[first, 0, 2],
			[first, 2, 4]
		]);
	});

	it('ends a tie into a one-measure repeat at the jump, and strikes the measure afresh on pass 2', () => {
		// A shape real choral scores have, every voice tied into the repeated
		// measure: pass 1 sounds the repeated measure as the tie's
		// tail, the jump back strikes it again, and nothing is held over the
		// jump.
		const score = buildScore([
			[['G4', 'whole', { tiedToNext: true }]],
			{ notes: [['G4', 'whole']], startBarline: 'repeatStart', endBarline: 'repeatEnd' },
			[['C5', 'whole']]
		]);
		const [tail, repeated, after] = score.staves[0]!.measures.map((m) => m.notes[0]!.id);
		expect(measurePlayOrder(score).map((p) => p.measureIndex)).toEqual([0, 1, 1, 2]);
		expect(computePlaybackTimeline(score).map((e) => [e.noteId, e.startSeconds, e.durationSeconds, e.playIndex])).toEqual([
			[tail, 0, 4, 0],
			[repeated, 4, 2, 2],
			[after, 6, 2, 3]
		]);
	});
});

describe('firstOnsetSeconds (M6 Slice 15)', () => {
	// Measure (1-based) and the pass to start at: m2 plays twice, m6 three
	// times, m5 (2nd ending) only on the second pass.
	it.each([
		[2, 1],
		[6, 1],
		[5, 2]
	])('seeks to measure %i on pass %i', (measure, pass) => {
		const events = computePlaybackTimeline(VOLTAS);
		const order = measurePlayOrder(VOLTAS);
		const note = VOLTAS.staves[0]!.measures[measure - 1]!.notes[0]!.id;
		const at = firstOnsetSeconds(events, note);
		const hit = events.find((e) => e.noteId === note && e.startSeconds === at)!;
		expect(order[hit.playIndex!]).toEqual({ measureIndex: measure - 1, pass });
	});

	it('is undefined for an id with no event', () => {
		expect(firstOnsetSeconds(computePlaybackTimeline(VOLTAS), 'nope' as NoteId)).toBeUndefined();
	});
});
