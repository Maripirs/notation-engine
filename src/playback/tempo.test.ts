import { describe, expect, it } from 'vitest';
import { durationToSeconds } from './tempo.js';

describe('durationToSeconds', () => {
	// A quarter takes 60/bpm seconds, so a whole note takes 2s at 120bpm.
	it.each([
		{ wholes: 1 / 4, bpm: 120, seconds: 0.5 },
		{ wholes: 1 / 4, bpm: 60, seconds: 1 },
		{ wholes: 1 / 4, bpm: 180, seconds: 1 / 3 },
		{ wholes: 1, bpm: 120, seconds: 2 },
		{ wholes: 1 / 16, bpm: 120, seconds: 0.125 },
		{ wholes: (1 / 4) * 1.5, bpm: 120, seconds: 0.75 }, // dotted quarter
		{ wholes: (1 / 8) * (2 / 3), bpm: 120, seconds: 1 / 6 }, // tripleted eighth
		{ wholes: 0, bpm: 120, seconds: 0 }
	])('$wholes of a whole at $bpm bpm is $seconds s', ({ wholes, bpm, seconds }) => {
		expect(durationToSeconds(wholes, bpm)).toBeCloseTo(seconds, 10);
	});
});
