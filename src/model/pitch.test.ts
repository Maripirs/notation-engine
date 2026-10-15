import { describe, expect, it } from 'vitest';
import {
	diatonicIndex,
	formatPitch,
	fromMidi,
	keyAlterForStep,
	parsePitch,
	toMidi,
	transpose
} from './pitch.js';

describe('pitch', () => {
	it('places middle C at MIDI 60', () => {
		expect(toMidi(parsePitch('C4'))).toBe(60);
		expect(toMidi(parsePitch('A4'))).toBe(69);
	});

	it('gives enharmonics the same sound but different staff positions', () => {
		// The whole reason the model stores a letter name rather than a MIDI
		// number: these two sit on different lines despite sounding identical.
		expect(toMidi(parsePitch('F#4'))).toBe(toMidi(parsePitch('Gb4')));
		expect(diatonicIndex(parsePitch('F#4'))).not.toBe(diatonicIndex(parsePitch('Gb4')));
	});

	it('round-trips through MIDI for natural pitches', () => {
		for (const name of ['C4', 'E4', 'G5', 'B3', 'F2']) {
			expect(formatPitch(fromMidi(toMidi(parsePitch(name))))).toBe(name);
		}
	});

	it.each([
		['C4', 1, 'C#4'],
		['C#4', 1, 'D4'],
		['C4', -1, 'B3'],
		['D4', -1, 'Db4'],
		['B4', 1, 'C5'],
		['C5', -1, 'B4']
	] as const)('transposes %s by %i to %s (sharps up, flats down, across octaves)', (from, by, to) => {
		expect(formatPitch(transpose(parsePitch(from), by))).toBe(to);
	});

	it('reads key signatures off the circle of fifths', () => {
		expect(keyAlterForStep(1, 'F')).toBe(1);
		expect(keyAlterForStep(1, 'C')).toBe(0);
		expect(keyAlterForStep(2, 'C')).toBe(1);
		expect(keyAlterForStep(-1, 'B')).toBe(-1);
		expect(keyAlterForStep(0, 'F')).toBe(0);
	});
});
