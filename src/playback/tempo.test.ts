import { describe, expect, it } from 'vitest';
import { durationToSeconds } from './tempo.js';

describe('durationToSeconds', () => {
	it('converts a quarter note across a range of tempos', () => {
		// A quarter note is 1/4 of a whole note; at bpm beats per minute each
		// quarter note takes 60/bpm seconds, so a quarter note's own duration
		// converts straight to that.
		// By hand: 120bpm -> 60/120 = 0.5s; 60bpm -> 60/60 = 1s;
		// 180bpm -> 60/180 = 1/3 s.
		expect(durationToSeconds(0.25, 120)).toBeCloseTo(0.5, 10);
		expect(durationToSeconds(0.25, 60)).toBeCloseTo(1, 10);
		expect(durationToSeconds(0.25, 180)).toBeCloseTo(1 / 3, 10);
	});

	it('scales linearly with duration at a fixed tempo, across plain, dotted and tripleted fractions', () => {
		// All at 120bpm, where a whole note takes 4 * (60/120) = 2 seconds.
		expect(durationToSeconds(1, 120)).toBeCloseTo(2, 10); // whole
		expect(durationToSeconds(1 / 2, 120)).toBeCloseTo(1, 10); // half
		expect(durationToSeconds(1 / 4, 120)).toBeCloseTo(0.5, 10); // quarter
		expect(durationToSeconds(1 / 8, 120)).toBeCloseTo(0.25, 10); // eighth
		expect(durationToSeconds(1 / 16, 120)).toBeCloseTo(0.125, 10); // 16th
		// Dotted quarter: 1/4 * 1.5 = 3/8 of a whole note.
		expect(durationToSeconds((1 / 4) * 1.5, 120)).toBeCloseTo(0.75, 10);
		// Tripleted eighth: 1/8 * 2/3 = 1/12 of a whole note.
		expect(durationToSeconds((1 / 8) * (2 / 3), 120)).toBeCloseTo(1 / 6, 10);
	});

	it('is zero for a zero duration, at any tempo', () => {
		expect(durationToSeconds(0, 120)).toBe(0);
	});
});
