import { describe, expect, it } from 'vitest';
import { buildScore, formatPitch, Score } from '../model/index.js';
import { createSatbBracketShowcaseScore, createTwoVoiceShowcaseScore } from '../demo-score.js';
import { computePlaybackTimeline, type OnsetEvent } from './timeline.js';

/** `formatPitch` on an event's pitch, for readable assertions instead of
 *  comparing raw `{ step, alter, octave }` objects field by field. */
const pitches = (events: readonly OnsetEvent[]) => events.map((event) => formatPitch(event.pitch));

describe('computePlaybackTimeline', () => {
	it('schedules a single voice of quarter notes at sequential onsets', () => {
		// Four quarters at the default 120bpm: each is durationToSeconds(0.25, 120)
		// = 0.5s, so onsets land at 0, 0.5, 1.0, 1.5.
		const score = buildScore([
			[
				['C4', 'quarter'],
				['D4', 'quarter'],
				['E4', 'quarter'],
				['F4', 'quarter']
			]
		]);
		const events = computePlaybackTimeline(score);

		expect(events).toHaveLength(4);
		expect(pitches(events)).toEqual(['C4', 'D4', 'E4', 'F4']);
		expect(events.map((event) => event.startSeconds)).toEqual([0, 0.5, 1, 1.5]);
		for (const event of events) {
			expect(event.durationSeconds).toBeCloseTo(0.5, 10);
		}
	});

	it('collapses a tied pair into one event summing both durations', () => {
		// Same pitch, first note ties into the second via buildScore's
		// `extra.tiedToNext` sugar. The one resulting event should start where
		// the first note started and last as long as both notes combined:
		// 0.5s (quarter) + 0.5s (quarter) = 1.0s.
		const score = buildScore([
			[
				['C4', 'quarter', { tiedToNext: true }],
				['C4', 'quarter']
			]
		]);
		const events = computePlaybackTimeline(score);

		expect(events).toHaveLength(1);
		expect(formatPitch(events[0]!.pitch)).toBe('C4');
		expect(events[0]!.startSeconds).toBe(0);
		expect(events[0]!.durationSeconds).toBeCloseTo(1, 10);
	});

	it('collapses a three-note tied chain (A ties to B ties to C) into one event', () => {
		// Three quarters, same pitch throughout, each tying into the next.
		// Combined duration: 3 * 0.5s = 1.5s.
		const score = buildScore([
			[
				['G4', 'quarter', { tiedToNext: true }],
				['G4', 'quarter', { tiedToNext: true }],
				['G4', 'quarter']
			]
		]);
		const events = computePlaybackTimeline(score);

		expect(events).toHaveLength(1);
		expect(formatPitch(events[0]!.pitch)).toBe('G4');
		expect(events[0]!.startSeconds).toBe(0);
		expect(events[0]!.durationSeconds).toBeCloseTo(1.5, 10);
	});

	it('schedules two voices with differing rhythms so shared beats land at the same startSeconds', () => {
		// createTwoVoiceShowcaseScore: voice 1 is half notes (measure 0) then
		// quarters (measure 1, after a leading quarter rest); voice 2 is eighth
		// notes (measure 0) then quarters (measure 1, after its own leading
		// quarter rest). Both voices' cursors start at cumulative wholes 0, so
		// their very first onsets coincide, and after measure 0 both voices have
		// each accumulated exactly one whole note (a full 4/4 bar), so they
		// realign again at the start of measure 1 despite the differing rhythm
		// in between.
		const score = createTwoVoiceShowcaseScore();
		const events = computePlaybackTimeline(score);

		const voice1First = events.find((event) => formatPitch(event.pitch) === 'G4' && event.startSeconds === 0);
		const voice2First = events.find((event) => formatPitch(event.pitch) === 'C4' && event.startSeconds === 0);
		expect(voice1First).toBeDefined();
		expect(voice2First).toBeDefined();
		expect(voice1First!.durationSeconds).toBeCloseTo(1, 10); // half note
		expect(voice2First!.durationSeconds).toBeCloseTo(0.25, 10); // eighth note

		// Measure 1: both voices open with a quarter rest (0.25 wholes, 0.5s),
		// then resume together at cumulative 1.25 wholes = 2.5 seconds.
		const voice1SecondBar = events.find((event) => formatPitch(event.pitch) === 'G4' && event.startSeconds === 2.5);
		const voice2SecondBar = events.find((event) => formatPitch(event.pitch) === 'C4' && event.startSeconds === 2.5);
		expect(voice1SecondBar).toBeDefined();
		expect(voice2SecondBar).toBeDefined();
		expect(voice1SecondBar!.durationSeconds).toBeCloseTo(0.5, 10);
		expect(voice2SecondBar!.durationSeconds).toBeCloseTo(0.5, 10);
	});

	it('schedules three independent voices sharing one measure', () => {
		const score = new Score();
		const measure = score.appendMeasure();
		score.appendNote(measure, { pitch: { step: 'C', alter: 0, octave: 4 }, value: 'quarter', voice: 1 });
		score.appendNote(measure, { pitch: { step: 'C', alter: 0, octave: 4 }, value: 'quarter', voice: 1 });
		score.appendNote(measure, { pitch: { step: 'E', alter: 0, octave: 4 }, value: 'half', voice: 2 });
		score.appendNote(measure, { pitch: { step: 'G', alter: 0, octave: 4 }, value: 'eighth', voice: 3 });
		score.appendNote(measure, { pitch: { step: 'A', alter: 0, octave: 4 }, value: 'eighth', voice: 3 });
		score.appendNote(measure, { pitch: { step: 'B', alter: 0, octave: 4 }, value: 'eighth', voice: 3 });
		score.appendNote(measure, { pitch: { step: 'C', alter: 0, octave: 5 }, value: 'eighth', voice: 3 });

		const events = computePlaybackTimeline(score);

		const voice1 = events.filter((event) => ['C4'].includes(formatPitch(event.pitch)));
		// All three voices open at cumulative time 0.
		expect(events.filter((event) => event.startSeconds === 0)).toHaveLength(3);

		const byPitch = (pitch: string) => events.find((event) => formatPitch(event.pitch) === pitch);
		expect(voice1).toHaveLength(2);
		expect(voice1[0]!.startSeconds).toBe(0);
		expect(voice1[1]!.startSeconds).toBeCloseTo(0.5, 10); // second C4 quarter, voice 1
		expect(byPitch('E4')!.startSeconds).toBe(0);
		expect(byPitch('E4')!.durationSeconds).toBeCloseTo(1, 10); // half note
		expect(byPitch('G4')!.startSeconds).toBe(0);
		expect(byPitch('A4')!.startSeconds).toBeCloseTo(0.25, 10);
		expect(byPitch('B4')!.startSeconds).toBeCloseTo(0.5, 10);
		expect(byPitch('C5')!.startSeconds).toBeCloseTo(0.75, 10);
	});

	it('starts a voice that first appears in a later measure at that measure, not at time 0', () => {
		// Regression: each voice used to keep its own cursor that only advanced
		// over that voice's own notes, so a voice absent from measures 0-1 began
		// counting from 0 in measure 2 and sounded on top of measure 0. That is
		// exactly `createFullDemoScore`'s shape (voice 2 only in its last few
		// measures), where it made the demo's playback cursor, and its
		// auto-scroll, bounce between the top and the bottom of the score.
		const score = new Score({ tempoBpm: 60 });
		const quarter = (step: 'C' | 'E' | 'G', voice: number) => ({
			pitch: { step, alter: 0 as const, octave: 4 },
			value: 'quarter' as const,
			voice
		});
		for (let m = 0; m < 3; m++) {
			const measure = score.appendMeasure();
			for (let beat = 0; beat < 4; beat++) score.appendNote(measure, quarter('C', 1));
			if (m === 2) for (let beat = 0; beat < 4; beat++) score.appendNote(measure, quarter('E', 2));
		}

		const events = computePlaybackTimeline(score);
		const voice2Starts = events
			.filter((event) => formatPitch(event.pitch) === 'E4')
			.map((event) => event.startSeconds);
		// 60 bpm quarter = 1s; measure 2 starts at 2 bars * 4 beats = 8s.
		expect(voice2Starts).toEqual([8, 9, 10, 11]);
	});

	it('lands every staff of an SATB score on the same shared onsets', () => {
		// createSatbBracketShowcaseScore: 4 staves, each one voice, each 4 quarter
		// notes per measure, rhythmically identical across staves. Every staff's
		// onsets should therefore land at the same startSeconds: 0, 0.5, 1.0, 1.5
		// at the default 120bpm.
		const score = createSatbBracketShowcaseScore();
		const events = computePlaybackTimeline(score);

		expect(events).toHaveLength(4 * 4); // 4 staves * 4 quarter notes each
		const onsetsByStart = new Map<number, number>();
		for (const event of events) {
			onsetsByStart.set(event.startSeconds, (onsetsByStart.get(event.startSeconds) ?? 0) + 1);
		}
		expect([...onsetsByStart.keys()].sort((a, b) => a - b)).toEqual([0, 0.5, 1, 1.5]);
		for (const count of onsetsByStart.values()) {
			expect(count).toBe(4); // all 4 staves share each onset
		}
	});
});
