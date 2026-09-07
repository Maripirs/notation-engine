import { LookaheadScheduler } from './scheduler.js';
import { playOnsetEvent, type SynthesisOptions } from './synthesis.js';
import type { OnsetEvent } from './timeline.js';

export interface PlaybackEngineOptions {
	readonly events: readonly OnsetEvent[];
	readonly audioContext: AudioContext;
	/** Passed through to every `playOnsetEvent` call (see `./synthesis.js`);
	 *  `audioContext` is supplied by this class itself, not repeated here. */
	readonly synthesisOptions?: Omit<SynthesisOptions, 'audioContext'>;
	/** Passed through to the internal `LookaheadScheduler` (see
	 *  `./scheduler.js`'s own doc comment for what this controls). */
	readonly lookaheadSeconds?: number;
	/** Passed through to the internal `LookaheadScheduler`. */
	readonly intervalMs?: number;
}

/**
 * Play/pause/stop/seek transport wrapping Slices 2-4 (tempo, timeline,
 * scheduler, synthesis) into a single stateful controller. Takes precomputed
 * `events` directly rather than a `Score`: a caller runs
 * `computePlaybackTimeline(score)` first, so this class (like every other
 * file in `src/playback`) has no dependency on the model layer at all.
 *
 * Position tracking: `basePosition` is the piece-time position, in seconds,
 * true at the moment `baseAudioTime` (the corresponding
 * `audioContext.currentTime`) was captured. While playing, the true elapsed
 * position is `basePosition + (audioContext.currentTime - baseAudioTime)`,
 * since `audioContext.currentTime` keeps advancing in real time; while
 * paused or stopped, `baseAudioTime` is `null` and the position is simply
 * `basePosition` itself, frozen. This is the mechanism that lets `pause()`
 * "record elapsed position against `AudioContext.currentTime` (which itself
 * never pauses)": the audio clock is never actually stopped, only the
 * mapping from it back to piece-time position is frozen at pause and
 * re-anchored at the next `play()`/`seek()`.
 */
export class PlaybackEngine {
	private readonly events: readonly OnsetEvent[];
	private readonly audioContext: AudioContext;
	private readonly synthesisOptions: Omit<SynthesisOptions, 'audioContext'>;
	private readonly lookaheadSeconds: number | undefined;
	private readonly intervalMs: number | undefined;

	private basePosition = 0;
	private baseAudioTime: number | null = null;
	private playing = false;
	private scheduler: LookaheadScheduler<OnsetEvent> | null = null;
	private readonly activeOscillators = new Set<OscillatorNode>();

	constructor(options: PlaybackEngineOptions) {
		this.events = options.events;
		this.audioContext = options.audioContext;
		this.synthesisOptions = options.synthesisOptions ?? {};
		this.lookaheadSeconds = options.lookaheadSeconds;
		this.intervalMs = options.intervalMs;
	}

	/** True while the engine is actively scheduling/sounding events. */
	get isPlaying(): boolean {
		return this.playing;
	}

	/** Elapsed position in the piece, in seconds. 0 at construction, frozen
	 *  while paused/stopped, advancing in real time while playing. Slice 6
	 *  (a later, separate task) builds a fuller position/onset-callback API on
	 *  top of this; this getter is the minimal piece this slice already needs
	 *  internally for pause() to work, exposed publicly since Slice 6 needs
	 *  exactly this same value and there is no reason to hide it until then. */
	get positionSeconds(): number {
		if (this.baseAudioTime === null) return this.basePosition;
		return this.basePosition + (this.audioContext.currentTime - this.baseAudioTime);
	}

	/**
	 * Starts (or resumes) playback from `positionSeconds` (0 initially, or
	 * wherever a prior `pause()`/`seek()` left it). A no-op if already
	 * playing.
	 *
	 * Builds a fresh `LookaheadScheduler` over the subset of `events` still
	 * ahead of the resume point (`startSeconds >= basePosition`), each
	 * remapped from piece-time to real audio-context time by shifting its
	 * `startSeconds` by the same offset that maps `basePosition` to
	 * `audioContext.currentTime`. See `seek()`'s own doc comment for why this
	 * same "drop anything already past" filter is also the correct behaviour
	 * for a seek into the middle of the timeline, not just an incidental
	 * consequence of reusing this method.
	 */
	play(): void {
		if (this.playing) return;

		const basePosition = this.basePosition;
		const baseAudioTime = this.audioContext.currentTime;
		this.baseAudioTime = baseAudioTime;

		const remainingEvents: OnsetEvent[] = this.events
			.filter((event) => event.startSeconds >= basePosition)
			.map((event) => ({
				...event,
				startSeconds: baseAudioTime + (event.startSeconds - basePosition)
			}));

		const scheduler = new LookaheadScheduler<OnsetEvent>({
			events: remainingEvents,
			getCurrentTime: () => this.audioContext.currentTime,
			onSchedule: (event) => {
				const { oscillator } = playOnsetEvent(event, {
					audioContext: this.audioContext,
					...this.synthesisOptions
				});
				this.activeOscillators.add(oscillator);
			},
			lookaheadSeconds: this.lookaheadSeconds,
			intervalMs: this.intervalMs
		});
		this.scheduler = scheduler;
		scheduler.start();
		this.playing = true;
	}

	/**
	 * Freezes playback at its current position, without touching any note
	 * already sounding: a note that has already been scheduled and started
	 * keeps ringing to whatever stop time it was already given, since
	 * `AudioContext.currentTime` itself never pauses (there is no real Web
	 * Audio operation that "pauses" an already-started oscillator's
	 * envelope). This is a deliberate consequence of that fact, not a bug:
	 * only `stop()` performs the harder reset of silencing already-sounding
	 * notes early. A no-op if not currently playing.
	 */
	pause(): void {
		if (!this.playing) return;

		this.basePosition = this.positionSeconds;
		this.baseAudioTime = null;
		this.scheduler?.stop();
		this.scheduler = null;
		this.playing = false;
	}

	/**
	 * Hard stop: halts the internal scheduler (no further events will be
	 * scheduled) and silences every note already scheduled/sounding by
	 * calling `oscillator.stop(audioContext.currentTime)` on each one (the
	 * Web Audio spec allows re-calling `stop()` with an earlier time before a
	 * node's originally scheduled stop fires), then resets position back to
	 * the very start. Leaves no dangling scheduled or sounding nodes.
	 */
	stop(): void {
		this.haltAndSilence();
		this.basePosition = 0;
		this.baseAudioTime = null;
	}

	/**
	 * Jumps playback position to `seconds`. Always performs the same hard
	 * cleanup as `stop()` for any currently active/pending nodes and the
	 * internal scheduler first (a stale sounding note from before the seek
	 * would otherwise ring on at a position unrelated to the new one, which
	 * seeking should eliminate), then resumes playing from `seconds` only if
	 * the engine was already playing before this call; a `seek()` while
	 * paused/stopped just updates where a later `play()` will resume from.
	 *
	 * A note that was already sounding *across* the seek target (its
	 * `startSeconds` before `seconds`, but `startSeconds + durationSeconds`
	 * after it, i.e. genuinely "in progress" at that instant) is not
	 * rescheduled at the seek point: `play()`'s own event filter
	 * (`startSeconds >= basePosition`) drops it, since its `startSeconds` is
	 * before the new `basePosition`. This is deliberate, not a gap: this
	 * engine has no mechanism to resume a note mid-envelope (Slice 4's
	 * attack/release envelope always starts fresh from silence), so naively
	 * rescheduling such a note at the seek point would restart its attack
	 * envelope and pitch onset as though it began right there, audibly wrong
	 * versus its real, earlier onset. Not sounding that note again after the
	 * seek is the honest choice, and the one this design makes, over
	 * falsifying its onset.
	 */
	seek(seconds: number): void {
		const wasPlaying = this.playing;
		this.haltAndSilence();
		this.basePosition = seconds;
		this.baseAudioTime = null;
		if (wasPlaying) this.play();
	}

	/**
	 * Forces one scheduling pass on the internal scheduler, bypassing its
	 * real `setInterval`-driven loop. Exists purely for deterministic tests:
	 * a real unit test cannot wait on a real timer, so it drives scheduling
	 * by calling `play()` then `tick()` directly with a controllable
	 * `AudioContext.currentTime`, the same "expose the single-pass primitive
	 * a real loop wraps" precedent `LookaheadScheduler.tick()` already sets
	 * for exactly the same reason. A no-op when not currently playing.
	 */
	tick(): void {
		this.scheduler?.tick();
	}

	/**
	 * Shared cleanup between `stop()` and `seek()`: halts the internal
	 * scheduler (discarding it so no further events get scheduled) and
	 * silences every currently tracked oscillator by calling `stop()` on it
	 * at the current audio-clock time, then clears the tracking set and marks
	 * the engine not-playing. Deliberately does not touch `basePosition`/
	 * `baseAudioTime`: `stop()` and `seek()` each set those to their own
	 * different targets right after calling this.
	 */
	private haltAndSilence(): void {
		this.scheduler?.stop();
		this.scheduler = null;
		this.playing = false;

		const now = this.audioContext.currentTime;
		for (const oscillator of this.activeOscillators) {
			oscillator.stop(now);
		}
		this.activeOscillators.clear();
	}
}
