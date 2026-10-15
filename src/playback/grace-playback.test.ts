// M6 Slice 8: how grace notes play. Every grace plays on the beat, stealing
// its time from the start of its principal; the rules are the documented
// constants next to `APPOGGIATURA_FRACTION`. At the default 120 bpm a whole
// note lasts 2 s, so a quarter is 0.5 s and a 32nd 0.0625 s.

import { describe, expect, it } from 'vitest';
import { ACCIACCATURA, APPOGGIATURA, buildScore, formatPitch, type GraceNote } from '../model/index.js';
import {
	ACCIACCATURA_WHOLES,
	APPOGGIATURA_FRACTION,
	computePlaybackTimeline,
	DOTTED_APPOGGIATURA_FRACTION,
	type OnsetEvent
} from './timeline.js';

const WHOLE_SECONDS = 2;
const byPitch = (events: readonly OnsetEvent[]) =>
	Object.fromEntries(events.map((e) => [formatPitch(e.pitch), [e.startSeconds, e.durationSeconds] as const]));

describe('grace note playback (M6 Slice 8)', () => {
	it('plays an acciaccatura as a 32nd stolen from the start of its principal', () => {
		const events = computePlaybackTimeline(
			buildScore([[['C4', 'quarter'], ['E5', 'eighth', { grace: ACCIACCATURA }], ['D5', 'quarter'], ['E4', 'half']]])
		);
		const t = byPitch(events);
		const grace = ACCIACCATURA_WHOLES * WHOLE_SECONDS;
		expect(t.E5![0]).toBeCloseTo(0.5, 10);
		expect(t.E5![1]).toBeCloseTo(grace, 10);
		expect(t.D5![0]).toBeCloseTo(0.5 + grace, 10);
		expect(t.D5![1]).toBeCloseTo(0.5 - grace, 10);
		// Nothing else moves.
		expect(t.C4).toEqual([0, 0.5]);
		expect(t.E4![0]).toBeCloseTo(1, 10);
	});

	it('gives a lone appoggiatura half its principal, two thirds of a dotted one', () => {
		const plain = byPitch(computePlaybackTimeline(buildScore([[['D5', 'eighth', { grace: APPOGGIATURA }], ['C5', 'half'], ['C4', 'half']]])));
		expect(plain.D5![1]).toBeCloseTo(1 * APPOGGIATURA_FRACTION, 10);
		expect(plain.C5![0]).toBeCloseTo(0.5, 10);
		expect(plain.C5![1]).toBeCloseTo(0.5, 10);

		const dotted = byPitch(
			computePlaybackTimeline(buildScore([[['D5', 'eighth', { grace: APPOGGIATURA }], ['C5', 'half', { dots: 1 }], ['C4', 'quarter']]]))
		);
		expect(dotted.D5![1]).toBeCloseTo(1.5 * DOTTED_APPOGGIATURA_FRACTION, 10);
		expect(dotted.C5![0]).toBeCloseTo(1, 10);
	});

	it('plays a run of graces quickly, one after another, before the principal', () => {
		const events = computePlaybackTimeline(
			buildScore([
				[
					['F4', '16th', { grace: APPOGGIATURA }],
					['G4', '16th', { grace: APPOGGIATURA }],
					['A4', 'whole']
				]
			])
		);
		const t = byPitch(events);
		const each = ACCIACCATURA_WHOLES * WHOLE_SECONDS;
		expect(t.F4).toEqual([0, each]);
		expect(t.G4![0]).toBeCloseTo(each, 10);
		expect(t.A4![0]).toBeCloseTo(2 * each, 10);
		expect(t.A4![0] + t.A4![1]).toBeCloseTo(2, 10);
	});

	it('never lets a run take more than half of a short principal', () => {
		const run = Array.from({ length: 4 }, () => ['C5', '16th', { grace: ACCIACCATURA }] as const);
		const t = byPitch(computePlaybackTimeline(buildScore([[...run, ['D5', '16th'], ['E5', 'half', { dots: 2 }]]])));
		// A 16th lasts 0.125 s; the four graces share at most half of it.
		expect(t.D5![0]).toBeCloseTo(0.0625, 10);
	});

	it('honours steal-time-following', () => {
		const grace: GraceNote = { ...APPOGGIATURA, stealTimeFollowing: 25 };
		const t = byPitch(computePlaybackTimeline(buildScore([[['D5', 'eighth', { grace }], ['C5', 'whole']]])));
		expect(t.D5![1]).toBeCloseTo(0.5, 10);
		expect(t.C5![0]).toBeCloseTo(0.5, 10);
	});

	it('plays a grace left at the end of a measure before the next downbeat', () => {
		const t = byPitch(
			computePlaybackTimeline(
				buildScore([
					[['C4', 'whole'], ['B4', 'eighth', { grace: ACCIACCATURA }]],
					[['C5', 'whole']]
				])
			)
		);
		const grace = ACCIACCATURA_WHOLES * WHOLE_SECONDS;
		expect(t.C4).toEqual([0, 2]);
		expect(t.B4![0]).toBeCloseTo(2, 10);
		expect(t.C5![0]).toBeCloseTo(2 + grace, 10);
	});

	it('leaves measure starts and other voices untouched', () => {
		const score = buildScore([
			[['D5', 'eighth', { grace: APPOGGIATURA }], ['C5', 'whole']],
			[['E4', 'whole']]
		]);
		const t = byPitch(computePlaybackTimeline(score));
		expect(t.E4![0]).toBeCloseTo(2, 10);
	});
});
