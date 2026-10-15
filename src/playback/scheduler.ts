/**
 * The minimal shape `LookaheadScheduler` needs from an event: just when it
 * starts. `OnsetEvent` (see `./timeline.js`) already satisfies this, so a
 * caller can pass `OnsetEvent[]` straight through, but the scheduler is
 * generic over `T extends SchedulableEvent` rather than hardcoding
 * `OnsetEvent` because scheduling "call this callback at the right time" has
 * nothing to do with pitches, note ids, or any other playback-specific field:
 * `onSchedule` receives the whole event back, so it can read `pitch` or
 * `noteId` off it as it pleases, but this file itself only ever looks at
 * `startSeconds`.
 */
export interface SchedulableEvent {
	readonly startSeconds: number;
}

export interface LookaheadSchedulerOptions<T extends SchedulableEvent> {
	readonly events: readonly T[];
	/** Returns the current audio-clock time in seconds, e.g.
	 *  `() => audioContext.currentTime` in real use, or a fake/injected function
	 *  in tests. Deliberately just a function, not an `AudioContext` itself:
	 *  this file must run in this repo's DOM-free, `AudioContext`-free Node
	 *  test environment (see `vite.config.ts`'s `test.environment: 'node'`
	 *  comment), so nothing here may reference a real audio clock type, only
	 *  whatever function a caller injects to stand in for one. */
	readonly getCurrentTime: () => number;
	/** Called exactly once per event, at or after its `startSeconds`, once that
	 *  event enters the lookahead window. Does not itself do any scheduling
	 *  timing work; by the time this fires the event is due. What it actually
	 *  does with the event (start an oscillator, log it, push it onto some
	 *  other queue) is entirely up to the caller: this class's only job is
	 *  calling it once, on time, per event. */
	readonly onSchedule: (event: T) => void;
	/** Called at the end of every pass, after any `onSchedule` calls. Lets
	 *  `PlaybackEngine` notice the piece has ended without a timer of its own. */
	readonly onTick?: () => void;
	/**
	 * How far ahead of `getCurrentTime()` to look when deciding an event is
	 * due, in seconds. Defaults to 0.1 (100ms), the value used by the classic
	 * Web Audio "lookahead" pattern this class implements (Chris Wilson's "A
	 * Tale of Two Clocks"): wide enough that a `tick()` firing a little late
	 * (a slow JS turn, a delayed timer) still catches an event before its true
	 * onset passes, but narrow enough that scheduling an event 100ms into the
	 * future rather than exactly on time is inaudible as separate from "on
	 * time" for anything this engine plays.
	 */
	readonly lookaheadSeconds?: number;
	/**
	 * How often the real driving timer fires, in milliseconds (only relevant
	 * to `start`/`stop`, not `tick`). Defaults to 25, again the value from the
	 * same "lookahead" pattern: comfortably smaller than the default
	 * `lookaheadSeconds` (100ms), so under normal conditions no event can ever
	 * cross an entire lookahead window between two consecutive ticks unnoticed,
	 * while still infrequent enough not to burn CPU polling a clock that barely
	 * moves between calls.
	 */
	readonly intervalMs?: number;
}

const DEFAULT_LOOKAHEAD_SECONDS = 0.1;
const DEFAULT_INTERVAL_MS = 25;

/**
 * Drift-free event scheduler using the standard Web Audio "lookahead"
 * pattern: rather than firing a `setTimeout` per event against the ordinary
 * JS clock (which drifts under GC pauses and tab throttling), a loop ticks
 * more often than strictly necessary and, on each tick, schedules every event
 * whose `startSeconds` has come within `lookaheadSeconds` of `getCurrentTime()`
 * against that same clock. This class only drives *when* `onSchedule` fires;
 * it creates or references no real audio API itself; see the file-level
 * comment on `SchedulableEvent` for why `getCurrentTime` and `onSchedule` are
 * both injected rather than this class reaching for a real `AudioContext`.
 *
 * "Already scheduled" bookkeeping is a `Set` of indices into the `events`
 * array supplied at construction, not a `Set` of the events themselves:
 * indices survive two structurally-identical events (say, two notes at the
 * same pitch and `startSeconds` in different voices) being treated as
 * distinct, where a `Set<T>` keyed on object identity would technically also
 * work (each element is its own array slot, hence its own reference) but
 * indices are simpler to reason about and cheaper to check. `tick()` scans
 * every event on every call rather than tracking a sorted cursor: this class
 * has no guarantee `events` arrives sorted by `startSeconds` (nothing in this
 * slice requires a caller to sort first), and a plain scan keeps `reset()`
 * trivial (clear the `Set`, nothing else to rewind) rather than needing to
 * also restore a cursor position. A future caller with a very large,
 * known-sorted event list could swap this for a cursor-based scan without
 * changing this class's public surface at all.
 */
export class LookaheadScheduler<T extends SchedulableEvent> {
	private readonly events: readonly T[];
	private readonly getCurrentTime: () => number;
	private readonly onSchedule: (event: T) => void;
	private readonly onTick: (() => void) | undefined;
	private readonly lookaheadSeconds: number;
	private readonly intervalMs: number;
	private readonly scheduledIndices = new Set<number>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: LookaheadSchedulerOptions<T>) {
		this.events = options.events;
		this.getCurrentTime = options.getCurrentTime;
		this.onSchedule = options.onSchedule;
		this.onTick = options.onTick;
		this.lookaheadSeconds = options.lookaheadSeconds ?? DEFAULT_LOOKAHEAD_SECONDS;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	}

	/**
	 * One pass: call `onSchedule` for every not-yet-scheduled event whose
	 * `startSeconds` falls at or before `getCurrentTime() + lookaheadSeconds`.
	 * Exposed directly (rather than only reachable through `start()`'s
	 * `setInterval` loop) so tests can drive the scheduler deterministically
	 * with a fake clock and explicit `tick()` calls, with no real timer
	 * involved at all.
	 *
	 * This makes no distinction between an event that just became due and one
	 * that was already due before this `tick()` (e.g. the scheduler was
	 * constructed, or `start()` was called, after playback had logically
	 * already begun): the same `startSeconds <= horizon` check covers both, so
	 * an event with a past `startSeconds` is scheduled on the very next
	 * `tick()` exactly like one just entering the window, never skipped or
	 * specially deferred.
	 */
	tick(): void {
		const horizon = this.getCurrentTime() + this.lookaheadSeconds;
		for (let index = 0; index < this.events.length; index++) {
			if (this.scheduledIndices.has(index)) continue;
			const event = this.events[index]!;
			if (event.startSeconds <= horizon) {
				this.scheduledIndices.add(index);
				this.onSchedule(event);
			}
		}
		this.onTick?.();
	}

	/**
	 * Starts a real `setInterval`-driven loop calling `tick()` every
	 * `intervalMs`. Plain Node/browser `setInterval`, nothing DOM-specific:
	 * this repo's test suite runs with no jsdom (see `vite.config.ts`), so this
	 * method deliberately needs nothing beyond the global `setInterval`/
	 * `clearInterval` every JS runtime, browser or Node, already provides.
	 * Idempotent: calling `start()` again while already running is a no-op
	 * rather than layering a second interval on top.
	 */
	start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => this.tick(), this.intervalMs);
	}

	/** Stops the driving loop started by `start()`. Idempotent (safe to call
	 *  when not started). */
	stop(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * Clears the "already scheduled" bookkeeping so the next `tick()` treats
	 * every event as not-yet-scheduled again, without affecting `start()`'s
	 * running timer (if any) or the `events` list itself. Not used by this
	 * slice, but deliberately present for a later slice's benefit: Slice 5's
	 * transport controls will want a seek to re-evaluate a fresh "not yet
	 * scheduled" set from an arbitrary clock position, and `reset()` is the
	 * hook that lets a future caller do that without reworking this class's
	 * internals (the "already scheduled" state is already isolated to exactly
	 * this one `Set`, so clearing it is the whole operation).
	 */
	reset(): void {
		this.scheduledIndices.clear();
	}
}
