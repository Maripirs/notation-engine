// PlaybackEngine asserted against a mock AudioContext with a controllable
// currentTime, never a real timer: every test drives scheduling via the
// engine's own tick() after manually advancing the mock clock.

import { describe, expect, it } from 'vitest';
import { PlaybackEngine } from './playback-engine.js';
import type { OnsetEvent } from './timeline.js';

/** A minimal `AudioContext` stub with a settable `currentTime`. Every
 *  oscillator created is recorded, with the times its `stop()` was called. */
function mockAudioContext() {
	let currentTime = 0;
	const oscillators: { stoppedAt: number[] }[] = [];
	const param = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} };
	const audioContext = {
		get currentTime() {
			return currentTime;
		},
		destination: {},
		createOscillator() {
			const osc = {
				type: '',
				frequency: { ...param },
				stoppedAt: [] as number[],
				connect() {},
				start() {},
				stop(when: number) {
					osc.stoppedAt.push(when);
				}
			};
			oscillators.push(osc);
			return osc;
		},
		createGain() {
			return { gain: { ...param }, connect() {} };
		}
	};
	return {
		audioContext: audioContext as unknown as AudioContext,
		setCurrentTime: (value: number) => (currentTime = value),
		oscillators
	};
}

const A4: OnsetEvent['pitch'] = { step: 'A', alter: 0, octave: 4 };

const event = (noteId: string, startSeconds: number, durationSeconds: number): OnsetEvent => ({
	noteId: noteId as OnsetEvent['noteId'],
	pitch: A4,
	startSeconds,
	durationSeconds
});

/** An engine over `events` with a 0.1s lookahead, plus its mock clock and a
 *  log of every onOnset call. `run()` ticks through 4s of clock time. */
function setup(events: OnsetEvent[]) {
	const mock = mockAudioContext();
	const onsets: OnsetEvent[] = [];
	const engine = new PlaybackEngine({
		events,
		audioContext: mock.audioContext,
		lookaheadSeconds: 0.1,
		onOnset: (onset) => onsets.push(onset)
	});
	const run = () => {
		for (let i = 0; i < 20; i++) {
			mock.setCurrentTime(mock.audioContext.currentTime + 0.2);
			engine.tick();
		}
	};
	return { ...mock, engine, onsets, run };
}

describe('PlaybackEngine', () => {
	it('pause/resume preserves elapsed position across a real time gap', () => {
		const { engine, setCurrentTime } = setup([event('a', 0, 1), event('b', 2, 1)]);
		engine.play();
		setCurrentTime(0.5);
		engine.tick();
		engine.pause();
		expect(engine.positionSeconds).toBeCloseTo(0.5, 10);

		setCurrentTime(100);
		expect(engine.positionSeconds).toBeCloseTo(0.5, 10);
		engine.play();
		expect(engine.positionSeconds).toBeCloseTo(0.5, 10);
		engine.stop();
	});

	it.each([
		{ name: 'schedules only events at or after the seek point', events: [event('a', 0, 0.5), event('b', 1, 0.5), event('c', 2, 0.5)], seek: 1.5, scheduled: ['c'] },
		// The documented scope cut: a note sounding across the seek point is not restarted.
		{ name: 'excludes a note active across the seek point', events: [event('straddle', 0, 2)], seek: 1, scheduled: [] }
	])('a seek $name', ({ events, seek, scheduled }) => {
		const { engine, oscillators, onsets, run } = setup(events);
		engine.seek(seek);
		engine.play();
		run();
		expect(oscillators).toHaveLength(scheduled.length);
		expect(onsets.map((e) => e.noteId)).toEqual(scheduled);
		engine.stop();
	});

	it('stop() cuts every scheduled oscillator off at the current time', () => {
		const { engine, oscillators, setCurrentTime } = setup([event('a', 0, 5), event('b', 0.05, 5)]);
		engine.play();
		engine.tick();
		expect(oscillators).toHaveLength(2);
		// Each already has its own end-of-note stop.
		for (const osc of oscillators) expect(osc.stoppedAt).toHaveLength(1);

		setCurrentTime(0.02);
		engine.stop();
		for (const osc of oscillators) {
			expect(osc.stoppedAt).toHaveLength(2);
			expect(osc.stoppedAt[1]).toBeCloseTo(0.02, 10);
		}
	});

	it('positionSeconds reads back the seek target immediately, both while stopped and while playing', () => {
		const { engine, setCurrentTime } = setup([event('a', 0, 1), event('b', 5, 1)]);
		engine.seek(3);
		expect(engine.positionSeconds).toBeCloseTo(3, 10);
		setCurrentTime(10);
		expect(engine.positionSeconds).toBeCloseTo(3, 10);

		engine.play();
		setCurrentTime(10.5);
		expect(engine.positionSeconds).toBeCloseTo(3.5, 10);
		engine.seek(8);
		expect(engine.positionSeconds).toBeCloseTo(8, 10);
		setCurrentTime(11);
		expect(engine.positionSeconds).toBeCloseTo(8.5, 10);
		engine.stop();
	});

	it('onOnset fires once per event, in order, with its noteId', () => {
		const { engine, onsets, run } = setup([event('a', 0, 0.5), event('b', 1, 0.5), event('c', 2, 0.5)]);
		engine.play();
		run();
		expect(onsets.map((e) => [e.noteId, e.startSeconds])).toEqual([
			['a', 0],
			['b', 1],
			['c', 2]
		]);
		engine.stop();
	});

	it('onOnset receives piece-time startSeconds, not the remapped audio-clock time', () => {
		// play() at clock 10 remaps the piece-time 2s onset to clock 12s.
		const { engine, onsets, setCurrentTime } = setup([event('a', 2, 0.5)]);
		setCurrentTime(10);
		engine.play();
		setCurrentTime(12.05);
		engine.tick();
		expect(onsets.map((e) => e.startSeconds)).toEqual([2]);
		engine.stop();
	});
});
