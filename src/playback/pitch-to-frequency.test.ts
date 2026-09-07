import { describe, expect, it } from 'vitest';
import { midiToFrequency, pitchToFrequency } from './pitch-to-frequency.js';

describe('midiToFrequency', () => {
	it('is exactly 440Hz at MIDI 69 (A4), the formula\'s own anchor point', () => {
		expect(midiToFrequency(69)).toBe(440);
	});

	it('matches the worked-out formula value for middle C (MIDI 60)', () => {
		// 440 * 2^((60-69)/12) = 440 * 2^(-0.75) ~= 261.6255653005986Hz.
		expect(midiToFrequency(60)).toBeCloseTo(261.6255653005986, 8);
	});

	it('matches the worked-out formula value for C#4 (MIDI 61)', () => {
		// 440 * 2^((61-69)/12) = 440 * 2^(-2/3) ~= 277.1826309768721Hz.
		expect(midiToFrequency(61)).toBeCloseTo(277.1826309768721, 8);
	});
});

describe('pitchToFrequency', () => {
	it('agrees with midiToFrequency(69) for A4', () => {
		expect(pitchToFrequency({ step: 'A', alter: 0, octave: 4 })).toBe(midiToFrequency(69));
		expect(pitchToFrequency({ step: 'A', alter: 0, octave: 4 })).toBe(440);
	});

	it('agrees with midiToFrequency(60) for middle C', () => {
		const pitch = { step: 'C', alter: 0, octave: 4 } as const;
		expect(pitchToFrequency(pitch)).toBe(midiToFrequency(60));
		expect(pitchToFrequency(pitch)).toBeCloseTo(261.6255653005986, 8);
	});

	it('agrees with midiToFrequency(61) for C#4, an accidental', () => {
		const pitch = { step: 'C', alter: 1, octave: 4 } as const;
		expect(pitchToFrequency(pitch)).toBe(midiToFrequency(61));
		expect(pitchToFrequency(pitch)).toBeCloseTo(277.1826309768721, 8);
	});
});
