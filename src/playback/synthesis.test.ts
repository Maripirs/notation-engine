// `playOnsetEvent` asserted against a mock `AudioContext`, not real audio
// hardware, following the same "record the calls a stub receives" precedent
// as `renderer.test.ts`'s `recordingContext()` for `CanvasRenderingContext2D`.

import { describe, expect, it } from 'vitest';
import { midiToFrequency } from './pitch-to-frequency.js';
import { playOnsetEvent } from './synthesis.js';
import type { OnsetEvent } from './timeline.js';

interface RecordedAutomation {
	readonly call: 'setValueAtTime' | 'linearRampToValueAtTime';
	readonly value: number;
	readonly time: number;
}

interface StubOscillator {
	type: string;
	frequency: {
		value: number;
		readonly setValueAtTime: (value: number, time: number) => void;
		readonly calls: RecordedAutomation[];
	};
	readonly connect: (destination: unknown) => void;
	readonly start: (when: number) => void;
	readonly stop: (when: number) => void;
	readonly connectedTo: unknown[];
	readonly startedAt: number[];
	readonly stoppedAt: number[];
}

interface StubGain {
	gain: {
		readonly setValueAtTime: (value: number, time: number) => void;
		readonly linearRampToValueAtTime: (value: number, time: number) => void;
		readonly calls: RecordedAutomation[];
	};
	readonly connect: (destination: unknown) => void;
	readonly connectedTo: unknown[];
}

/** A minimal `AudioContext` stub implementing just the surface
 *  `playOnsetEvent` calls: `createOscillator`, `createGain`, `destination`.
 *  Every oscillator/gain node it creates is also pushed onto `oscillators`/
 *  `gains` so a test can assert exactly one of each was made. */
function mockAudioContext() {
	const oscillators: StubOscillator[] = [];
	const gains: StubGain[] = [];
	const destination = { marker: 'destination' };

	const audioContext = {
		destination,
		createOscillator(): StubOscillator {
			const osc: StubOscillator = {
				type: '',
				frequency: {
					value: 0,
					calls: [],
					setValueAtTime(value: number, time: number) {
						this.value = value;
						this.calls.push({ call: 'setValueAtTime', value, time });
					}
				},
				connectedTo: [],
				startedAt: [],
				stoppedAt: [],
				connect(destination: unknown) {
					this.connectedTo.push(destination);
				},
				start(when: number) {
					this.startedAt.push(when);
				},
				stop(when: number) {
					this.stoppedAt.push(when);
				}
			};
			oscillators.push(osc);
			return osc;
		},
		createGain(): StubGain {
			const gainNode: StubGain = {
				gain: {
					calls: [],
					setValueAtTime(value: number, time: number) {
						this.calls.push({ call: 'setValueAtTime', value, time });
					},
					linearRampToValueAtTime(value: number, time: number) {
						this.calls.push({ call: 'linearRampToValueAtTime', value, time });
					}
				},
				connectedTo: [],
				connect(destination: unknown) {
					this.connectedTo.push(destination);
				}
			};
			gains.push(gainNode);
			return gainNode;
		}
	};

	return { audioContext: audioContext as unknown as AudioContext, oscillators, gains, destination };
}

const A4: OnsetEvent['pitch'] = { step: 'A', alter: 0, octave: 4 };

describe('playOnsetEvent', () => {
	it('creates exactly one oscillator and one gain node, connected oscillator -> gain -> destination', () => {
		const { audioContext, oscillators, gains, destination } = mockAudioContext();
		const event: OnsetEvent = { noteId: 'n1' as OnsetEvent['noteId'], pitch: A4, startSeconds: 1, durationSeconds: 0.5 };

		playOnsetEvent(event, { audioContext });

		expect(oscillators).toHaveLength(1);
		expect(gains).toHaveLength(1);
		const [oscillator] = oscillators;
		const [gainNode] = gains;
		expect(oscillator!.connectedTo).toEqual([gainNode]);
		expect(gainNode!.connectedTo).toEqual([destination]);
	});

	it('uses a triangle oscillator at the frequency for the event pitch', () => {
		const { audioContext, oscillators } = mockAudioContext();
		const event: OnsetEvent = { noteId: 'n1' as OnsetEvent['noteId'], pitch: A4, startSeconds: 1, durationSeconds: 0.5 };

		playOnsetEvent(event, { audioContext });

		const [oscillator] = oscillators;
		expect(oscillator!.type).toBe('triangle');
		// Independently recomputed from the raw formula rather than trusting
		// pitchToFrequency, per the same reasoning pitch-to-frequency.test.ts
		// uses: A4 is MIDI 69, the formula's own anchor, so this is exactly 440.
		expect(oscillator!.frequency.calls).toEqual([{ call: 'setValueAtTime', value: 440, time: 1 }]);
	});

	it('computes frequency correctly for a non-A4 pitch, matching an independent formula computation', () => {
		const { audioContext, oscillators } = mockAudioContext();
		// C4 (middle C), MIDI 60: 440 * 2^((60-69)/12).
		const pitch: OnsetEvent['pitch'] = { step: 'C', alter: 0, octave: 4 };
		const event: OnsetEvent = { noteId: 'n1' as OnsetEvent['noteId'], pitch, startSeconds: 2, durationSeconds: 1 };

		playOnsetEvent(event, { audioContext });

		const expectedFrequency = 440 * 2 ** ((60 - 69) / 12);
		expect(expectedFrequency).toBeCloseTo(midiToFrequency(60), 10);
		const [oscillator] = oscillators;
		expect(oscillator!.frequency.calls).toHaveLength(1);
		const call = oscillator!.frequency.calls[0]!;
		expect(call.call).toBe('setValueAtTime');
		expect(call.time).toBe(2);
		expect(call.value).toBeCloseTo(expectedFrequency, 10);
	});

	it('starts and stops the oscillator at exactly startSeconds and startSeconds + durationSeconds', () => {
		const { audioContext, oscillators } = mockAudioContext();
		const event: OnsetEvent = { noteId: 'n1' as OnsetEvent['noteId'], pitch: A4, startSeconds: 3.25, durationSeconds: 0.75 };

		playOnsetEvent(event, { audioContext });

		const [oscillator] = oscillators;
		expect(oscillator!.startedAt).toEqual([3.25]);
		expect(oscillator!.stoppedAt).toEqual([4]);
	});

	it('ramps the gain envelope from 0 up to peak over attackSeconds, holds, then back to 0 over releaseSeconds ending at the note end, for a note comfortably longer than attack + release', () => {
		const { audioContext, gains } = mockAudioContext();
		const event: OnsetEvent = { noteId: 'n1' as OnsetEvent['noteId'], pitch: A4, startSeconds: 10, durationSeconds: 2 };

		playOnsetEvent(event, { audioContext, attackSeconds: 0.01, releaseSeconds: 0.05, gain: 0.3 });

		const [gainNode] = gains;
		expect(gainNode!.gain.calls).toEqual([
			{ call: 'setValueAtTime', value: 0, time: 10 },
			{ call: 'linearRampToValueAtTime', value: 0.3, time: 10.01 },
			{ call: 'setValueAtTime', value: 0.3, time: 11.95 },
			{ call: 'linearRampToValueAtTime', value: 0, time: 12 }
		]);
	});

	it('scales attack and release down proportionally, with no hold, for a note shorter than attackSeconds + releaseSeconds', () => {
		const { audioContext, gains } = mockAudioContext();
		// attack 0.01 + release 0.05 = 0.06s requested, but the note is only
		// 0.03s long (half the requested total), so both ramps scale by 0.5:
		// effective attack 0.005s, effective release 0.025s, summing to exactly
		// the note's own 0.03s duration with no flat hold in between.
		const event: OnsetEvent = { noteId: 'n1' as OnsetEvent['noteId'], pitch: A4, startSeconds: 5, durationSeconds: 0.03 };

		playOnsetEvent(event, { audioContext, attackSeconds: 0.01, releaseSeconds: 0.05, gain: 0.2 });

		const [gainNode] = gains;
		const calls = gainNode!.gain.calls;
		expect(calls).toHaveLength(4);
		expect(calls[0]).toEqual({ call: 'setValueAtTime', value: 0, time: 5 });
		expect(calls[1]!.call).toBe('linearRampToValueAtTime');
		expect(calls[1]!.value).toBeCloseTo(0.2, 10);
		expect(calls[1]!.time).toBeCloseTo(5.005, 10);
		// The hold-pin and the attack ramp's end land at the same instant: no
		// flat plateau, attack flows straight into release.
		expect(calls[2]!.call).toBe('setValueAtTime');
		expect(calls[2]!.value).toBeCloseTo(0.2, 10);
		expect(calls[2]!.time).toBeCloseTo(5.005, 10);
		expect(calls[3]).toEqual({ call: 'linearRampToValueAtTime', value: 0, time: 5.03 });
	});
});
