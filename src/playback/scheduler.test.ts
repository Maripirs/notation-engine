import { describe, expect, it } from 'vitest';
import { LookaheadScheduler, type SchedulableEvent } from './scheduler.js';

interface TestEvent extends SchedulableEvent {
	readonly id: string;
}

/** A scheduler over a fake clock. `advance(ticks, step)` ticks, then moves
 *  the clock by `step`, `ticks` times. `log` holds each fired event's id and
 *  the clock time it fired at. */
function setup(starts: Record<string, number>, lookaheadSeconds?: number, now = 0) {
	const log: { id: string; at: number }[] = [];
	const scheduler = new LookaheadScheduler<TestEvent>({
		events: Object.entries(starts).map(([id, startSeconds]) => ({ id, startSeconds })),
		getCurrentTime: () => now,
		onSchedule: (event) => log.push({ id: event.id, at: now }),
		...(lookaheadSeconds === undefined ? {} : { lookaheadSeconds })
	});
	const advance = (ticks: number, step: number) => {
		for (let i = 0; i < ticks; i++) {
			scheduler.tick();
			now += step;
		}
	};
	return { scheduler, log, advance };
}

describe('LookaheadScheduler', () => {
	it('schedules every event exactly once across a run spanning many lookahead windows', () => {
		// Events span five 1s windows and the clock moves 0.3s per tick, so
		// only repeated ticks can cover the run. Ticking far past the end
		// must never re-fire anything.
		const { log, advance } = setup({ a: 0, b: 1, c: 2, d: 3, e: 4, f: 5 }, 1);
		advance(30, 0.3);
		advance(50, 1);
		expect(log.map((entry) => entry.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
	});

	it('schedules each event once the clock reaches startSeconds - lookaheadSeconds, not before', () => {
		// The upper bound (within one tick of the threshold) is this test's
		// cadence, not a promise the class makes. The epsilon absorbs float
		// noise between the scheduler's addition and this subtraction.
		const lookahead = 0.5;
		const step = 0.05;
		const starts = { a: 1, b: 2.3, c: 4 };
		const { log, advance } = setup(starts, lookahead);
		advance(200, step);
		expect(log).toHaveLength(3);
		for (const { id, at } of log) {
			const threshold = starts[id as keyof typeof starts] - lookahead;
			expect(at).toBeGreaterThanOrEqual(threshold - 1e-9);
			expect(at).toBeLessThan(threshold + step + 1e-9);
		}
	});

	it('fires an event already in the past at construction on the first tick', () => {
		const { log, advance } = setup({ late: -5 }, undefined, 10);
		advance(1, 0);
		expect(log).toHaveLength(1);
	});

	it('reset() makes already-scheduled events fire again on the next tick', () => {
		const { scheduler, log, advance } = setup({ a: 0 });
		advance(2, 0);
		expect(log).toHaveLength(1);
		scheduler.reset();
		advance(1, 0);
		expect(log).toHaveLength(2);
	});
});
