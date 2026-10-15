// Repeats and voltas in playback (M6 Slice 14): the measure play order and
// the timeline that walks it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../io/index.js';
import { buildScore, type NoteId, type Score } from '../model/index.js';
import { createSatbBracketShowcaseScore } from '../demo-score.js';
import { measurePlayOrder } from './play-order.js';
import { computePlaybackTimeline } from './timeline.js';

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

	it('plays Frost Myth m65 (a one-measure repeat) twice', () => {
		const score = fixture('sfcc/The-Frost-Myth_SATB-Score.musicxml');
		const order = measurePlayOrder(score).map((p) => p.measureIndex);
		const repeated = order.filter((m, k) => order.indexOf(m) !== k);
		expect(repeated).toHaveLength(1);
		const [m65] = repeated;
		expect(score.staves[0]!.measures[m65!]!.startBarline).toBe('repeatStart');
		expect(order.filter((m) => m === m65)).toHaveLength(2);
		// Every voice ties into m65 from m64, so its first pass sounds as the
		// tail of those ties, and the second (entered by the jump) strikes the
		// same notes afresh. Nothing is held over the jump.
		const second = order.lastIndexOf(m65!);
		const events = computePlaybackTimeline(score);
		const measureOf = measureOfNote(score);
		const inM65 = events.filter((e) => measureOf.get(e.noteId) === m65);
		expect(inM65.length).toBeGreaterThan(0);
		expect(new Set(inM65.map((e) => e.playIndex))).toEqual(new Set([second]));
		const jumpAt = Math.min(...inM65.map((e) => e.startSeconds));
		const before = events.filter((e) => e.playIndex! < second);
		expect(Math.max(...before.map((e) => e.startSeconds + e.durationSeconds))).toBeCloseTo(jumpAt, 9);
	});
});
