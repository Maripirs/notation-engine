// PlaybackEngine asserted against a mock AudioContext with a controllable
// currentTime, never a real timer: every test drives scheduling via the
// engine's own tick() after manually advancing the mock clock, mirroring
// scheduler.test.ts's own discipline of never calling start().

import { describe, expect, it } from 'vitest';
import { PlaybackEngine } from './playback-engine.js';
import type { OnsetEvent } from './timeline.js';

interface StubOscillator {
	type: string;
	frequency: { value: number; setValueAtTime: (value: number, time: number) => void };
	connect: (destination: unknown) => void;
	start: (when: number) => void;
	stop: (when: number) => void;
	readonly stoppedAt: number[];
}

interface StubGain {
	gain: {
		setValueAtTime: (value: number, time: number) => void;
		linearRampToValueAtTime: (value: number, time: number) => void;
	};
	connect: (destination: unknown) => void;
}

/** A minimal `AudioContext` stub with a mutable `currentTime` a test can set
 *  directly (not a real clock), plus enough of `createOscillator`/
 *  `createGain` for `playOnsetEvent` to run against it. Every oscillator
 *  created is pushed onto `oscillators` so a test can inspect how many notes
 *  were actually scheduled and assert on each one's `.stop()` calls. */
function mockAudioContext() {
	let currentTime = 0;
	const oscillators: StubOscillator[] = [];

	const audioContext = {
		get currentTime() {
			return currentTime;
		},
		setCurrentTime(value: number) {
			currentTime = value;
		},
		destination: { marker: 'destination' },
		createOscillator(): StubOscillator {
			const osc: StubOscillator = {
				type: '',
				frequency: {
					value: 0,
					setValueAtTime(value: number) {
						this.value = value;
					}
				},
				stoppedAt: [],
				connect() {
					/* no-op */
				},
				start() {
					/* no-op */
				},
				stop(when: number) {
					this.stoppedAt.push(when);
				}
			};
			oscillators.push(osc);
			return osc;
		},
		createGain(): StubGain {
			return {
				gain: {
					setValueAtTime() {
						/* no-op */
					},
					linearRampToValueAtTime() {
						/* no-op */
					}
				},
				connect() {
					/* no-op */
				}
			};
		}
	};

	return {
		audioContext: audioContext as unknown as AudioContext,
		setCurrentTime: (value: number) => audioContext.setCurrentTime(value),
		oscillators
	};
}

const A4: OnsetEvent['pitch'] = { step: 'A', alter: 0, octave: 4 };
const B4: OnsetEvent['pitch'] = { step: 'B', alter: 0, octave: 4 };
const C5: OnsetEvent['pitch'] = { step: 'C', alter: 0, octave: 5 };

function event(noteId: string, pitch: OnsetEvent['pitch'], startSeconds: number, durationSeconds: number): OnsetEvent {
	return { noteId: noteId as OnsetEvent['noteId'], pitch, startSeconds, durationSeconds };
}

describe('PlaybackEngine', () => {
	it('pause/resume preserves elapsed position across a real time gap', () => {
		const { audioContext, setCurrentTime } = mockAudioContext();
		const events = [event('a', A4, 0, 1), event('b', B4, 2, 1)];
		const engine = new PlaybackEngine({ events, audioContext, lookaheadSeconds: 0.1 });

		setCurrentTime(0);
		engine.play();
		setCurrentTime(0.5);
		engine.tick();

		expect(engine.positionSeconds).toBeCloseTo(0.5, 10);

		engine.pause();
		const positionAtPause = engine.positionSeconds;
		expect(positionAtPause).toBeCloseTo(0.5, 10);

		// Simulate a long real-world gap while paused: no tick() calls, so
		// nothing should be scheduled, and position must not advance.
		setCurrentTime(100);
		expect(engine.positionSeconds).toBeCloseTo(positionAtPause, 10);

		engine.play();
		expect(engine.positionSeconds).toBeCloseTo(positionAtPause, 10);

		engine.stop();
	});

	it('a seek into the middle of the timeline schedules only the correct remaining events', () => {
		const { audioContext, setCurrentTime, oscillators } = mockAudioContext();
		const events = [
			event('a', A4, 0, 0.5),
			event('b', B4, 1, 0.5),
			event('c', C5, 2, 0.5)
		];
		const engine = new PlaybackEngine({ events, audioContext, lookaheadSeconds: 0.1 });

		setCurrentTime(0);
		engine.seek(1.5);
		engine.play();

		// Advance and tick enough times to cover the remainder of the timeline.
		for (let i = 0; i < 20; i++) {
			setCurrentTime(audioContext.currentTime + 0.2);
			engine.tick();
		}

		// Only event 'c' (startSeconds 2, at or after the seek point 1.5) should
		// ever have been scheduled; 'a' and 'b' are both before it.
		expect(oscillators).toHaveLength(1);

		engine.stop();
	});

	it('a note active across the seek point is excluded, not restarted, per the documented scope cut', () => {
		const { audioContext, setCurrentTime, oscillators } = mockAudioContext();
		// Straddles the seek point: starts before 1, ends (1 + 2 = 3) well after it.
		const straddling = event('straddle', A4, 0, 2);
		const events = [straddling];
		const engine = new PlaybackEngine({ events, audioContext, lookaheadSeconds: 0.1 });

		setCurrentTime(0);
		engine.seek(1);
		engine.play();

		for (let i = 0; i < 20; i++) {
			setCurrentTime(audioContext.currentTime + 0.2);
			engine.tick();
		}

		expect(oscillators).toHaveLength(0);

		engine.stop();
	});

	it('stop() leaves no dangling scheduled nodes: every created oscillator gets an additional stop() call', () => {
		const { audioContext, setCurrentTime, oscillators } = mockAudioContext();
		const events = [event('a', A4, 0, 5), event('b', B4, 0.05, 5)];
		const engine = new PlaybackEngine({ events, audioContext, lookaheadSeconds: 0.1 });

		setCurrentTime(0);
		engine.play();
		engine.tick();

		expect(oscillators.length).toBeGreaterThan(0);
		const stopCallCountsBeforeStop = oscillators.map((osc) => osc.stoppedAt.length);
		// Each oscillator already got exactly one stop() call from
		// playOnsetEvent itself (its scheduled end-of-note stop).
		for (const count of stopCallCountsBeforeStop) {
			expect(count).toBe(1);
		}

		setCurrentTime(0.02);
		engine.stop();

		for (const osc of oscillators) {
			expect(osc.stoppedAt.length).toBe(2);
			expect(osc.stoppedAt[1]).toBeCloseTo(0.02, 10);
		}
	});
});
