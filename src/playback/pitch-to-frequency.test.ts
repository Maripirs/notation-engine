import { describe, expect, it } from 'vitest';
import { midiToFrequency, pitchToFrequency } from './pitch-to-frequency.js';

// Expected values worked out by hand from 440 * 2^((midi - 69) / 12).
describe('midiToFrequency and pitchToFrequency', () => {
	it.each([
		{ name: 'A4', midi: 69, pitch: { step: 'A', alter: 0, octave: 4 } as const, hz: 440 },
		{ name: 'middle C', midi: 60, pitch: { step: 'C', alter: 0, octave: 4 } as const, hz: 261.6255653005986 },
		{ name: 'C#4', midi: 61, pitch: { step: 'C', alter: 1, octave: 4 } as const, hz: 277.1826309768721 }
	])('$name (MIDI $midi) is $hz Hz', ({ midi, pitch, hz }) => {
		expect(midiToFrequency(midi)).toBeCloseTo(hz, 8);
		expect(pitchToFrequency(pitch)).toBe(midiToFrequency(midi));
	});

	it('is exactly 440Hz at the formula anchor', () => {
		expect(midiToFrequency(69)).toBe(440);
	});
});
