import { describe, expect, it } from 'vitest';
import { LookaheadScheduler, type SchedulableEvent } from './scheduler.js';

/** A minimal `SchedulableEvent` carrying just enough to identify which event
 *  fired in assertions, without pulling in `OnsetEvent`'s pitch/noteId fields
 *  this file has no use for. */
interface TestEvent extends SchedulableEvent {
	readonly id: string;
}

describe('LookaheadScheduler', () => {
	it('schedules every event exactly once across a run spanning many lookahead windows', () => {
		// lookaheadSeconds is 1s, but events span 0..5s (5x one window), and the
		// fake clock is advanced by 0.3s per tick() call, so no single tick's
		// window can cover the whole run: this only passes if repeated tick()
		// calls, not a single one, are what accumulate full coverage.
		const lookaheadSeconds = 1;
		const events: TestEvent[] = [
			{ id: 'a', startSeconds: 0 },
			{ id: 'b', startSeconds: 1 },
			{ id: 'c', startSeconds: 2 },
			{ id: 'd', startSeconds: 3 },
			{ id: 'e', startSeconds: 4 },
			{ id: 'f', startSeconds: 5 }
		];
		const scheduledIds: string[] = [];
		let fakeNow = 0;

		const scheduler = new LookaheadScheduler<TestEvent>({
			events,
			getCurrentTime: () => fakeNow,
			onSchedule: (event) => scheduledIds.push(event.id),
			lookaheadSeconds
		});

		// Enough ticks to carry fakeNow from 0 well past the last event's
		// startSeconds (5) plus the lookahead window, at 0.3s per tick.
		for (let i = 0; i < 30; i++) {
			scheduler.tick();
			fakeNow += 0.3;
		}

		// Exactly once each, no duplicates, none missed, order irrelevant to the
		// guarantee so compare as sorted sets of ids.
		expect(scheduledIds.slice().sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
		expect(scheduledIds).toHaveLength(6);
	});

	it('schedules each event only once getCurrentTime() has reached startSeconds - lookaheadSeconds, and no later than one tick step beyond that', () => {
		// The class's own guarantee (see LookaheadScheduler.tick's doc comment)
		// is a one-sided bound: onSchedule only ever fires once
		// getCurrentTime() + lookaheadSeconds >= event.startSeconds, i.e. once
		// getCurrentTime() >= event.startSeconds - lookaheadSeconds. There is no
        // upper bound from the class alone (a caller could tick() rarely and
		// schedule arbitrarily "late"); the tighter upper bound asserted below
		// (within one tickStep of that threshold) is a property of *this test's*
		// fixed tick cadence, not a promise LookaheadScheduler itself makes.
		const lookaheadSeconds = 0.5;
		const tickStep = 0.05; // well under lookaheadSeconds, as intervalMs is under lookaheadSeconds by design
		const events: TestEvent[] = [
			{ id: 'a', startSeconds: 1 },
			{ id: 'b', startSeconds: 2.3 },
			{ id: 'c', startSeconds: 4 }
		];
		const scheduledAt = new Map<string, number>();
		let fakeNow = 0;

		const scheduler = new LookaheadScheduler<TestEvent>({
			events,
			getCurrentTime: () => fakeNow,
			onSchedule: (event) => scheduledAt.set(event.id, fakeNow),
			lookaheadSeconds
		});

		for (let i = 0; i < 200; i++) {
			scheduler.tick();
			fakeNow += tickStep;
		}

		expect(scheduledAt.size).toBe(3);
		for (const event of events) {
			const scheduledTime = scheduledAt.get(event.id)!;
			const threshold = event.startSeconds - lookaheadSeconds;
			// The universal guarantee: never scheduled before the threshold. The
			// scheduler itself checks `startSeconds <= getCurrentTime() +
			// lookaheadSeconds` (addition), while this assertion re-derives the
			// same threshold via subtraction; floating-point addition and its
			// "inverse" subtraction don't always round identically, so a tiny
			// epsilon absorbs that noise without weakening the actual guarantee
			// being checked.
			expect(scheduledTime).toBeGreaterThanOrEqual(threshold - 1e-9);
			// The cadence-specific tightness: never scheduled more than one
			// tickStep after the threshold either, since a tick fires every
			// tickStep and the threshold-crossing tick is the one that schedules it.
			expect(scheduledTime).toBeLessThan(threshold + tickStep + 1e-9);
		}
	});

	it('never re-schedules an event once it has fired, even as the clock keeps advancing past it', () => {
		const lookaheadSeconds = 0.2;
		const events: TestEvent[] = [{ id: 'only', startSeconds: 1 }];
		let callCount = 0;
		let fakeNow = 0;

		const scheduler = new LookaheadScheduler<TestEvent>({
			events,
			getCurrentTime: () => fakeNow,
			onSchedule: () => {
				callCount++;
			},
			lookaheadSeconds
		});

		// Advance well past the event's startSeconds, ticking repeatedly.
		for (let i = 0; i < 50; i++) {
			scheduler.tick();
			fakeNow += 0.1;
		}

		expect(callCount).toBe(1);

		// Keep going, far beyond, calling tick() many more times.
		for (let i = 0; i < 50; i++) {
			scheduler.tick();
			fakeNow += 1;
		}

		expect(callCount).toBe(1);
	});

	it('treats an event whose startSeconds is already in the past at construction the same as any other due event', () => {
		// The scheduler starts "late" relative to an event's onset (fakeNow is
		// already ahead of startSeconds on the very first tick()); the same
		// startSeconds <= horizon check covers this with no special-casing, so
		// it should still fire, on the first tick.
		const events: TestEvent[] = [{ id: 'late', startSeconds: -5 }];
		let callCount = 0;
		const fakeNow = 10;

		const scheduler = new LookaheadScheduler<TestEvent>({
			events,
			getCurrentTime: () => fakeNow,
			onSchedule: () => {
				callCount++;
			}
		});

		scheduler.tick();
		expect(callCount).toBe(1);
	});

	it('reset() clears scheduled bookkeeping so a later tick() re-fires already-scheduled events', () => {
		const events: TestEvent[] = [{ id: 'a', startSeconds: 0 }];
		let callCount = 0;
		const scheduler = new LookaheadScheduler<TestEvent>({
			events,
			getCurrentTime: () => 0,
			onSchedule: () => {
				callCount++;
			}
		});

		scheduler.tick();
		expect(callCount).toBe(1);
		scheduler.tick();
		expect(callCount).toBe(1); // not re-scheduled without a reset()

		scheduler.reset();
		scheduler.tick();
		expect(callCount).toBe(2); // reset() made it eligible again
	});
});
