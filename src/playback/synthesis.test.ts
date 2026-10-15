// `playOnsetEvent` asserted against a mock `AudioContext` that records the
// calls each node receives, not real audio hardware.

import { describe, expect, it } from 'vitest';
import { playOnsetEvent } from './synthesis.js';
import type { OnsetEvent } from './timeline.js';

type Automation = { call: 'setValueAtTime' | 'linearRampToValueAtTime'; value: number; time: number };

function recordingParam() {
	const calls: Automation[] = [];
	return {
		value: 0,
		calls,
		setValueAtTime(value: number, time: number) {
			calls.push({ call: 'setValueAtTime', value, time });
		},
		linearRampToValueAtTime(value: number, time: number) {
			calls.push({ call: 'linearRampToValueAtTime', value, time });
		}
	};
}

/** Just the surface `playOnsetEvent` calls, recording every node it makes. */
function mockAudioContext() {
	const destination = {};
	const oscillators: { type: string; frequency: ReturnType<typeof recordingParam>; connectedTo: unknown[]; startedAt: number[]; stoppedAt: number[] }[] = [];
	const gains: { gain: ReturnType<typeof recordingParam>; connectedTo: unknown[] }[] = [];
	const audioContext = {
		destination,
		createOscillator() {
			const osc = {
				type: '',
				frequency: recordingParam(),
				connectedTo: [] as unknown[],
				startedAt: [] as number[],
				stoppedAt: [] as number[],
				connect: (to: unknown) => osc.connectedTo.push(to),
				start: (when: number) => osc.startedAt.push(when),
				stop: (when: number) => osc.stoppedAt.push(when)
			};
			oscillators.push(osc);
			return osc;
		},
		createGain() {
			const node = { gain: recordingParam(), connectedTo: [] as unknown[], connect: (to: unknown) => node.connectedTo.push(to) };
			gains.push(node);
			return node;
		}
	};
	return { audioContext: audioContext as unknown as AudioContext, oscillators, gains, destination };
}

const A4: OnsetEvent['pitch'] = { step: 'A', alter: 0, octave: 4 };

const play = (event: Partial<OnsetEvent>, options: { attackSeconds?: number; releaseSeconds?: number; gain?: number } = {}) => {
	const mock = mockAudioContext();
	playOnsetEvent(
		{ noteId: 'n1' as OnsetEvent['noteId'], pitch: A4, startSeconds: 1, durationSeconds: 0.5, ...event },
		{ audioContext: mock.audioContext, ...options }
	);
	return mock;
};

describe('playOnsetEvent', () => {
	it('wires one triangle oscillator through one gain node to the destination, started and stopped on the event', () => {
		const { oscillators, gains, destination } = play({ startSeconds: 3.25, durationSeconds: 0.75 });
		expect(oscillators).toHaveLength(1);
		expect(gains).toHaveLength(1);
		const [osc] = oscillators;
		expect(osc!.type).toBe('triangle');
		expect(osc!.connectedTo).toEqual([gains[0]]);
		expect(gains[0]!.connectedTo).toEqual([destination]);
		expect(osc!.startedAt).toEqual([3.25]);
		expect(osc!.stoppedAt).toEqual([4]);
	});

	it.each([
		{ pitch: A4, hz: 440 },
		// Middle C, MIDI 60: 440 * 2^((60-69)/12).
		{ pitch: { step: 'C', alter: 0, octave: 4 } as const, hz: 261.6255653005986 }
	])('sets the oscillator to the pitch frequency at the event start ($hz Hz)', ({ pitch, hz }) => {
		const calls = play({ pitch, startSeconds: 2 }).oscillators[0]!.frequency.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0]!.time).toBe(2);
		expect(calls[0]!.value).toBeCloseTo(hz, 10);
	});

	it('ramps up over attackSeconds, holds, and releases to 0 at the note end', () => {
		const { gains } = play({ startSeconds: 10, durationSeconds: 2 }, { attackSeconds: 0.01, releaseSeconds: 0.05, gain: 0.3 });
		expect(gains[0]!.gain.calls).toEqual([
			{ call: 'setValueAtTime', value: 0, time: 10 },
			{ call: 'linearRampToValueAtTime', value: 0.3, time: 10.01 },
			{ call: 'setValueAtTime', value: 0.3, time: 11.95 },
			{ call: 'linearRampToValueAtTime', value: 0, time: 12 }
		]);
	});

	it('scales attack and release down proportionally, with no hold, for a note shorter than both', () => {
		// 0.06s of envelope requested on a 0.03s note: both ramps halve, and
		// attack's end and release's start coincide.
		const { gains } = play({ startSeconds: 5, durationSeconds: 0.03 }, { attackSeconds: 0.01, releaseSeconds: 0.05, gain: 0.2 });
		const calls = gains[0]!.gain.calls;
		expect(calls.map((c) => c.call)).toEqual(['setValueAtTime', 'linearRampToValueAtTime', 'setValueAtTime', 'linearRampToValueAtTime']);
		expect(calls[0]).toEqual({ call: 'setValueAtTime', value: 0, time: 5 });
		for (const c of [calls[1]!, calls[2]!]) {
			expect(c.value).toBeCloseTo(0.2, 10);
			expect(c.time).toBeCloseTo(5.005, 10);
		}
		expect(calls[3]).toEqual({ call: 'linearRampToValueAtTime', value: 0, time: 5.03 });
	});

	it("scales the peak gain by the event's velocity", () => {
		const { gains } = play({ velocity: 1.5 }, { gain: 0.2 });
		expect(gains[0]!.gain.calls[1]!.value).toBeCloseTo(0.3, 10);
	});
});
