import { describe, expect, it } from 'vitest';
import { buildScore, formatPitch, Score } from '../model/index.js';
import { createSatbBracketShowcaseScore, createTwoVoiceShowcaseScore } from '../demo-score.js';
import { ACCENT_VELOCITY, computePlaybackTimeline, DYNAMIC_LEVELS } from './timeline.js';

// At the default 120bpm a quarter is 0.5s and a whole note 2s.

const timeline = (score: Score) => computePlaybackTimeline(score);
const pitches = (score: Score) => timeline(score).map((event) => formatPitch(event.pitch));
const starts = (score: Score) => timeline(score).map((event) => event.startSeconds);
const durations = (score: Score) => timeline(score).map((event) => event.durationSeconds);
/** `[startSeconds, durationSeconds]` of the first event at each pitch name. */
const byPitch = (score: Score) =>
	Object.fromEntries(timeline(score).map((e) => [formatPitch(e.pitch), [e.startSeconds, e.durationSeconds]] as const));

describe('computePlaybackTimeline', () => {
	it('schedules a single voice of quarter notes at sequential onsets', () => {
		const score = buildScore([[['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter'], ['F4', 'quarter']]]);
		expect(pitches(score)).toEqual(['C4', 'D4', 'E4', 'F4']);
		expect(starts(score)).toEqual([0, 0.5, 1, 1.5]);
		expect(durations(score)).toEqual([0.5, 0.5, 0.5, 0.5]);
	});

	it.each([2, 3])('collapses a chain of %i tied quarters into one event', (count) => {
		const notes = Array.from({ length: count }, (_, i) => ['G4', 'quarter', { tiedToNext: i < count - 1 }] as const);
		const score = buildScore([notes]);
		expect(pitches(score)).toEqual(['G4']);
		expect(starts(score)).toEqual([0]);
		expect(durations(score)[0]).toBeCloseTo(count * 0.5, 10);
	});

	it('realigns two voices with differing rhythms (and leading rests) on shared beats', () => {
		// Voice 1: halves, then a quarter rest and quarters. Voice 2: eighths,
		// then a quarter rest and quarters. Both open together and resume
		// together after measure 1's rest, at 1.25 wholes = 2.5s.
		const events = timeline(createTwoVoiceShowcaseScore());
		const at = (name: string, start: number) =>
			events.find((e) => formatPitch(e.pitch) === name && e.startSeconds === start)?.durationSeconds;
		expect(at('G4', 0)).toBeCloseTo(1, 10);
		expect(at('C4', 0)).toBeCloseTo(0.25, 10);
		expect(at('G4', 2.5)).toBeCloseTo(0.5, 10);
		expect(at('C4', 2.5)).toBeCloseTo(0.5, 10);
	});

	it('schedules three independent voices sharing one measure', () => {
		const score = buildScore([
			[
				['C4', 'quarter', { voice: 1 }],
				['D4', 'quarter', { voice: 1 }],
				['E4', 'half', { voice: 2 }],
				['G4', 'eighth', { voice: 3 }],
				['A4', 'eighth', { voice: 3 }],
				['B4', 'eighth', { voice: 3 }],
				['C5', 'eighth', { voice: 3 }]
			]
		]);
		expect(byPitch(score)).toEqual({
			C4: [0, 0.5],
			D4: [0.5, 0.5],
			E4: [0, 1],
			G4: [0, 0.25],
			A4: [0.25, 0.25],
			B4: [0.5, 0.25],
			C5: [0.75, 0.25]
		});
	});

	it('starts a voice that first appears in a later measure at that measure, not at time 0', () => {
		// Regression: a voice absent from measures 0-1 used to count from 0 in
		// measure 2 and sound on top of measure 0, bouncing the demo cursor.
		const score = new Score({ tempoBpm: 60 });
		for (let m = 0; m < 3; m++) {
			const measure = score.appendMeasure();
			const voices = m === 2 ? [1, 2] : [1];
			for (const voice of voices) {
				for (let beat = 0; beat < 4; beat++) {
					score.appendNote(measure, { pitch: { step: voice === 1 ? 'C' : 'E', alter: 0, octave: 4 }, value: 'quarter', voice });
				}
			}
		}
		const voice2 = timeline(score).filter((e) => formatPitch(e.pitch) === 'E4');
		// 60 bpm quarter = 1s; measure 2 starts at 8s.
		expect(voice2.map((e) => e.startSeconds)).toEqual([8, 9, 10, 11]);
	});

	it('lands every staff of an SATB score on the same shared onsets', () => {
		const counts = new Map<number, number>();
		for (const start of starts(createSatbBracketShowcaseScore())) counts.set(start, (counts.get(start) ?? 0) + 1);
		expect([...counts.entries()].sort(([a], [b]) => a - b)).toEqual([
			[0, 4],
			[0.5, 4],
			[1, 4],
			[1.5, 4]
		]);
	});
});

describe('computePlaybackTimeline: chords (M6 Slice 2)', () => {
	it('sounds every head at the chord onset and advances the cursor once per chord', () => {
		const score = buildScore([[[['C4', 'E4', 'G4'], 'half'], ['A4', 'half']]]);
		expect(pitches(score)).toEqual(['C4', 'E4', 'G4', 'A4']);
		expect(starts(score)).toEqual([0, 0, 0, 1]);
		expect(durations(score)).toEqual([1, 1, 1, 1]);
	});

	it('extends each tied head into its own continuation', () => {
		const score = buildScore([[[['C4', 'E4'], 'half', { tiedToNext: true }], [['C4', 'E4'], 'quarter'], ['G4', 'quarter']]]);
		expect(byPitch(score)).toEqual({ C4: [0, 1.5], E4: [0, 1.5], G4: [1.5, 0.5] });
	});

	it('measures a measure of chords by its events when later measures start', () => {
		const score = buildScore([[[['C4', 'E4', 'G4', 'C5'], 'whole']], [['D4', 'whole']]]);
		expect(starts(score).at(-1)).toBeCloseTo(2, 10);
	});
});

describe('computePlaybackTimeline: articulations and fermatas (M6 Slice 5)', () => {
	it('shortens a staccato to half and a staccatissimo to a quarter of its length, onsets unchanged', () => {
		const score = buildScore([
			[
				['C4', 'quarter', { articulations: ['staccato'] }],
				['D4', 'quarter', { articulations: ['staccatissimo'] }],
				['E4', 'quarter', { articulations: ['tenuto'] }],
				[['F4', 'A4'], 'quarter', { articulations: ['staccato'] }]
			]
		]);
		expect(starts(score)).toEqual([0, 0.5, 1, 1.5, 1.5]);
		expect(durations(score)).toEqual([0.25, 0.125, 0.5, 0.25, 0.25]);
	});

	it('applies a mark written on a chord member to every head', () => {
		const score = buildScore([[[['C4', 'E4'], 'half'], [null, 'half']]]);
		score.measures[0]!.notes[1]!.articulations = ['staccato'];
		expect(durations(score)).toEqual([0.5, 0.5]);
	});

	it('marks an accented attack louder, a marcato louder still', () => {
		const score = buildScore([
			[
				['C4', 'quarter', { articulations: ['accent'] }],
				['D4', 'quarter', { articulations: ['strong-accent'] }],
				['E4', 'half']
			]
		]);
		expect(timeline(score).map((event) => event.velocity)).toEqual([1.3, 1.5, undefined]);
	});

	it('lengthens a fermata note 2x and pushes everything after it later, in every voice', () => {
		const score = buildScore([
			[
				['C5', 'quarter', { voice: 1 }],
				['D5', 'quarter', { voice: 1, fermata: 'upright' }],
				['E5', 'half', { voice: 1 }],
				// Voice 2's eighth pair under the fermata quarter stretches with it.
				['C4', 'quarter', { voice: 2 }],
				['D4', 'eighth', { voice: 2 }],
				['E4', 'eighth', { voice: 2 }],
				['F4', 'half', { voice: 2 }]
			],
			[['G4', 'whole']]
		]);
		const t = byPitch(score);
		expect(t.D5).toEqual([0.5, 1]);
		expect(t.E5![0]).toBe(1.5);
		expect(t.D4).toEqual([0.5, 0.5]);
		expect(t.E4![0]).toBe(1);
		expect(t.F4![0]).toBe(1.5);
		expect(t.G4![0]).toBe(2.5);
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
		const t = byPitch(score);
		expect(t.F4![1]).toBe(2);
		expect(t.G4![0]).toBe(3);
	});
});

describe('computePlaybackTimeline: dynamics and hairpins (M6 Slice 6)', () => {
	const velocities = (score: Score) => timeline(score).map((event) => event.velocity ?? 1);
	const quarters = (step: string): [string, 'quarter'][] => Array.from({ length: 4 }, () => [`${step}4`, 'quarter']);
	const { p, f, mf, mp, pp } = DYNAMIC_LEVELS as Record<string, number>;

	it('holds a dynamic until the next one; music before the first keeps full level', () => {
		const score = buildScore([
			[['C4', 'half'], ['D4', 'half']],
			{ notes: [['E4', 'half'], ['F4', 'half']], dynamics: [{ kind: 'pp' }, { kind: 'f', onset: 0.5 }] },
			[['G4', 'whole']]
		]);
		expect(velocities(score)).toEqual([1, 1, pp, f, f]);
	});

	it('plays an accent dynamic on its own attack only, and fp as forte then piano', () => {
		const score = buildScore([
			{ notes: quarters('C'), dynamics: [{ kind: 'p' }, { kind: 'sfz', onset: 0.25 }, { kind: 'fp', onset: 0.5 }] }
		]);
		expect(velocities(score)).toEqual([p, 1, 0.88, p]);
	});

	it('multiplies the dynamic level with an accent', () => {
		const score = buildScore([{ notes: [['C4', 'whole', { articulations: ['accent'] }]], dynamics: [{ kind: 'p' }] }]);
		expect(velocities(score)[0]).toBeCloseTo(p! * ACCENT_VELOCITY, 9);
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
		velocities(score).forEach((level, i) => expect(level).toBeCloseTo(p! + (f! - p!) * (i / 4), 9));
	});

	it('moves one step when no dynamic follows the hairpin, and holds that after the stop', () => {
		const score = buildScore(
			[{ notes: quarters('C'), dynamics: [{ kind: 'mf' }] }, [['D4', 'whole']]],
			{},
			[],
			[{ kind: 'diminuendo', start: [0, 0], stop: [0, 1] }]
		);
		const levels = velocities(score);
		expect(levels[2]).toBeCloseTo((mf! + mp!) / 2, 9);
		expect(levels[4]).toBeCloseTo(mp!, 9);
	});

	it("keeps each staff's dynamics to that staff", () => {
		const score = new Score();
		score.appendStaff();
		for (const staffIndex of [0, 1]) {
			score.appendNote(score.appendMeasure(staffIndex), { pitch: { step: 'C', alter: 0, octave: 4 }, value: 'whole' });
		}
		score.addDynamic(1, 0, { kind: 'pp' });
		expect(velocities(score)).toEqual([1, pp]);
	});
});
