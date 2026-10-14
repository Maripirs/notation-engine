import { describe, expect, it } from 'vitest';
import { buildScore, formatPitch, Score } from '../model/index.js';
import { createSatbBracketShowcaseScore, createTwoVoiceShowcaseScore } from '../demo-score.js';
import { ACCENT_VELOCITY, computePlaybackTimeline, DYNAMIC_LEVELS, type OnsetEvent } from './timeline.js';

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

describe('computePlaybackTimeline: chords (M6 Slice 2)', () => {
	it('sounds every head at the chord onset and advances the cursor once per chord', () => {
		const score = buildScore([[[['C4', 'E4', 'G4'], 'half'], ['A4', 'half']]]);
		const events = computePlaybackTimeline(score);
		expect(pitches(events)).toEqual(['C4', 'E4', 'G4', 'A4']);
		// Half notes at 120bpm last 1s: the chord's three heads all start at 0
		// for 1s, and A4 starts at 1s, not at 3s (once per head).
		expect(events.map((event) => event.startSeconds)).toEqual([0, 0, 0, 1]);
		for (const event of events) expect(event.durationSeconds).toBeCloseTo(1, 10);
	});

	it('extends each tied head into its own continuation', () => {
		const score = buildScore([
			[[['C4', 'E4'], 'half', { tiedToNext: true }], [['C4', 'E4'], 'quarter'], ['G4', 'quarter']]
		]);
		const events = computePlaybackTimeline(score);
		expect(pitches(events)).toEqual(['C4', 'E4', 'G4']);
		expect(events[0]!.durationSeconds).toBeCloseTo(1.5, 10);
		expect(events[1]!.durationSeconds).toBeCloseTo(1.5, 10);
		expect(events[2]!.startSeconds).toBeCloseTo(1.5, 10);
	});

	it('measures a measure of chords by its events when later measures start', () => {
		const score = buildScore([[[['C4', 'E4', 'G4', 'C5'], 'whole']], [['D4', 'whole']]]);
		const events = computePlaybackTimeline(score);
		expect(events.at(-1)!.startSeconds).toBeCloseTo(2, 10);
	});
});

describe('computePlaybackTimeline: articulations and fermatas (M6 Slice 5)', () => {
	// 120bpm: a quarter is 0.5s.
	it('shortens a staccato to half and a staccatissimo to a quarter of its length, onsets unchanged', () => {
		const score = buildScore([
			[
				['C4', 'quarter', { articulations: ['staccato'] }],
				['D4', 'quarter', { articulations: ['staccatissimo'] }],
				['E4', 'quarter', { articulations: ['tenuto'] }],
				[['F4', 'A4'], 'quarter', { articulations: ['staccato'] }]
			]
		]);
		const events = computePlaybackTimeline(score);
		expect(events.map((event) => event.startSeconds)).toEqual([0, 0.5, 1, 1.5, 1.5]);
		expect(events.map((event) => event.durationSeconds)).toEqual([0.25, 0.125, 0.5, 0.25, 0.25]);
	});

	it('applies a mark written on a chord member to every head', () => {
		const score = buildScore([[[['C4', 'E4'], 'half'], [null, 'half']]]);
		const [, member] = score.measures[0]!.notes;
		member!.articulations = ['staccato'];
		expect(computePlaybackTimeline(score).map((event) => event.durationSeconds)).toEqual([0.5, 0.5]);
	});

	it('marks an accented attack louder, a marcato louder still', () => {
		const score = buildScore([
			[
				['C4', 'quarter', { articulations: ['accent'] }],
				['D4', 'quarter', { articulations: ['strong-accent'] }],
				['E4', 'half']
			]
		]);
		expect(computePlaybackTimeline(score).map((event) => event.velocity)).toEqual([1.3, 1.5, undefined]);
	});

	it('lengthens a fermata note 2x and pushes everything after it later, in every voice', () => {
		const score = buildScore([
			[
				['C5', 'quarter', { voice: 1 }],
				['D5', 'quarter', { voice: 1, fermata: 'upright' }],
				['E5', 'half', { voice: 1 }],
				// Voice 2 has an eighth pair under the fermata quarter.
				['C4', 'quarter', { voice: 2 }],
				['D4', 'eighth', { voice: 2 }],
				['E4', 'eighth', { voice: 2 }],
				['F4', 'half', { voice: 2 }]
			],
			[['G4', 'whole']]
		]);
		const events = computePlaybackTimeline(score);
		const at = (name: string) => events.find((event) => formatPitch(event.pitch) === name)!;
		expect(at('C5').startSeconds).toBe(0);
		expect(at('D5').startSeconds).toBe(0.5);
		expect(at('D5').durationSeconds).toBe(1);
		expect(at('E5').startSeconds).toBe(1.5);
		// Voice 2's eighths inside the fermata span are stretched with it.
		expect(at('D4').startSeconds).toBe(0.5);
		expect(at('D4').durationSeconds).toBe(0.5);
		expect(at('E4').startSeconds).toBe(1);
		expect(at('F4').startSeconds).toBe(1.5);
		// The next measure starts 0.5s later than unwarped.
		expect(at('G4').startSeconds).toBe(2.5);
	});

	it('stretches a fermata rest, and stretches once when several voices share one fermata', () => {
		const score = buildScore([
			[
				['C4', 'half', { voice: 1 }],
				[null, 'half', { voice: 1, fermata: 'upright' }],
				['E4', 'half', { voice: 2 }],
				['F4', 'half', { voice: 2, fermata: 'inverted' }]
			],
			[['G4', 'whole']]
		]);
		const events = computePlaybackTimeline(score);
		const at = (name: string) => events.find((event) => formatPitch(event.pitch) === name)!;
		expect(at('F4').durationSeconds).toBe(2);
		expect(at('G4').startSeconds).toBe(3);
	});
});

describe('computePlaybackTimeline: dynamics and hairpins (M6 Slice 6)', () => {
	const velocities = (score: Score) => computePlaybackTimeline(score).map((event) => event.velocity ?? 1);
	const quarters = (step: string): [string, 'quarter'][] => [
		[`${step}4`, 'quarter'],
		[`${step}4`, 'quarter'],
		[`${step}4`, 'quarter'],
		[`${step}4`, 'quarter']
	];

	it('holds a dynamic until the next one; music before the first keeps full level', () => {
		const score = buildScore([
			[['C4', 'half'], ['D4', 'half']],
			{ notes: [['E4', 'half'], ['F4', 'half']], dynamics: [{ kind: 'pp' }, { kind: 'f', onset: 0.5 }] },
			[['G4', 'whole']]
		]);
		expect(velocities(score)).toEqual([1, 1, DYNAMIC_LEVELS.pp, DYNAMIC_LEVELS.f, DYNAMIC_LEVELS.f]);
	});

	it('plays an accent dynamic on its own attack only, and fp as forte then piano', () => {
		const score = buildScore([
			{ notes: quarters('C'), dynamics: [{ kind: 'p' }, { kind: 'sfz', onset: 0.25 }, { kind: 'fp', onset: 0.5 }] }
		]);
		expect(velocities(score)).toEqual([DYNAMIC_LEVELS.p, 1, 0.88, DYNAMIC_LEVELS.p]);
	});

	it('multiplies the dynamic level with an accent', () => {
		const score = buildScore([{ notes: [['C4', 'whole', { articulations: ['accent'] }]], dynamics: [{ kind: 'p' }] }]);
		expect(velocities(score)[0]).toBeCloseTo(DYNAMIC_LEVELS.p! * ACCENT_VELOCITY, 9);
	});

	it('ramps a hairpin linearly from the level at its start to the dynamic after its stop', () => {
		const score = buildScore(
			[
				{ notes: quarters('C'), dynamics: [{ kind: 'p' }] },
				{ notes: [['D4', 'whole']], dynamics: [{ kind: 'f' }] }
			],
			{},
			[],
			[{ kind: 'crescendo', start: [0, 0], stop: [1, 0] }]
		);
		const [a, b, c, d, e] = velocities(score);
		const p = DYNAMIC_LEVELS.p!;
		const f = DYNAMIC_LEVELS.f!;
		expect(a).toBeCloseTo(p, 9);
		expect(b).toBeCloseTo(p + (f - p) * 0.25, 9);
		expect(c).toBeCloseTo(p + (f - p) * 0.5, 9);
		expect(d).toBeCloseTo(p + (f - p) * 0.75, 9);
		expect(e).toBeCloseTo(f, 9);
	});

	it('moves one step when no dynamic follows the hairpin, and holds that after the stop', () => {
		const score = buildScore(
			[{ notes: quarters('C'), dynamics: [{ kind: 'mf' }] }, [['D4', 'whole']]],
			{},
			[],
			[{ kind: 'diminuendo', start: [0, 0], stop: [0, 1] }]
		);
		const levels = velocities(score);
		expect(levels[2]).toBeCloseTo((DYNAMIC_LEVELS.mf! + DYNAMIC_LEVELS.mp!) / 2, 9);
		expect(levels[4]).toBeCloseTo(DYNAMIC_LEVELS.mp!, 9);
	});

	it('keeps each staff\'s dynamics to that staff', () => {
		const score = new Score();
		score.appendStaff();
		for (const staffIndex of [0, 1]) {
			const measure = score.appendMeasure(staffIndex);
			score.appendNote(measure, { pitch: { step: 'C', alter: 0, octave: 4 }, value: 'whole' });
		}
		score.addDynamic(1, 0, { kind: 'pp' });
		expect(velocities(score)).toEqual([1, DYNAMIC_LEVELS.pp]);
	});
});
