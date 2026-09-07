import type { OnsetEvent } from './timeline.js';
import { pitchToFrequency } from './pitch-to-frequency.js';

export interface SynthesisOptions {
	/** Real Web Audio context (or a test stub shaped like one, see
	 *  `synthesis.test.ts`). Only its `createOscillator`, `createGain` and
	 *  `destination` are used, the same "take the real DOM type, hand tests a
	 *  minimal stub cast via `as unknown as AudioContext`" precedent
	 *  `CanvasRenderer` sets with `CanvasRenderingContext2D` (see
	 *  `../render/renderer.ts` and `renderer.test.ts`'s `recordingContext()`). */
	readonly audioContext: AudioContext;
	/** Attack ramp, seconds: how long `gain` takes to rise from 0 to `gain` at
	 *  the start of the note. Defaults to 0.01 (10ms), short enough to be
	 *  inaudible as a fade rather than an instant onset, but long enough to
	 *  avoid the audible "click" a discontinuous jump from silence to full
	 *  volume produces (a step in a waveform is a burst of high-frequency
	 *  energy the ear hears as a tick). */
	readonly attackSeconds?: number;
	/** Release ramp, seconds: how long `gain` takes to fall from `gain` back
	 *  to 0, ending exactly at the note's own end. Defaults to 0.05 (50ms),
	 *  longer than the attack default: a fast attack reads as a clean onset,
	 *  but an equally fast release still clicks (the same discontinuity
	 *  problem at the other end), and a slightly longer fade there is easy to
	 *  spare since it eats into the tail of the note rather than delaying its
	 *  perceived start. */
	readonly releaseSeconds?: number;
	/** Peak gain per voice, 0..1. Defaults to 0.2. Kept well under 1 because
	 *  this milestone's own SATB use case sounds up to 4 simultaneous voices
	 *  through one shared `AudioContext` with no separate mixing/limiting
	 *  stage; 4 voices at 0.2 sum to 0.8 peak in the worst case (all four
	 *  attacking in phase), leaving headroom before clipping at 1.0. */
	readonly gain?: number;
}

const DEFAULT_ATTACK_SECONDS = 0.01;
const DEFAULT_RELEASE_SECONDS = 0.05;
const DEFAULT_GAIN = 0.2;

/**
 * Attack/release ramp lengths actually used for a note of `durationSeconds`,
 * given the requested `attackSeconds`/`releaseSeconds`.
 *
 * When `attackSeconds + releaseSeconds <= durationSeconds` (the ordinary
 * case) both are used unchanged, leaving a flat hold at peak gain between the
 * end of the attack ramp and the start of the release ramp.
 *
 * When the note is shorter than that (a very short note, e.g. a fast 64th at
 * a high tempo), using the requested ramps unchanged would try to schedule a
 * release ramp that starts *before* the attack ramp has finished rising,
 * which is incoherent automation (a negative-length hold) and would also
 * overshoot the note's own end. Instead both ramps are scaled down by the
 * same factor, `durationSeconds / (attackSeconds + releaseSeconds)`, so they
 * fit exactly into the note's duration with no hold and no overlap: the
 * envelope becomes a single rise-then-fall triangle spanning the whole note,
 * proportioned the same as the requested attack:release ratio (e.g. a note
 * asking for a 10ms attack and 50ms release, both scaled down for a very
 * short note, still rises for 1/6 of the note and falls for 5/6 of it, rather
 * than collapsing to some other, unrelated split).
 */
function effectiveEnvelope(
	attackSeconds: number,
	releaseSeconds: number,
	durationSeconds: number
): { attack: number; release: number } {
	const requestedTotal = attackSeconds + releaseSeconds;
	if (requestedTotal <= durationSeconds) {
		return { attack: attackSeconds, release: releaseSeconds };
	}
	const scale = requestedTotal > 0 ? durationSeconds / requestedTotal : 0;
	return { attack: attackSeconds * scale, release: releaseSeconds * scale };
}

/**
 * Play one `OnsetEvent` through a real (or stubbed) `AudioContext`: a single
 * `'triangle'`-wave oscillator, an attack/release gain envelope so the note
 * does not click on start or stop, connected oscillator -> gain ->
 * `audioContext.destination`, started and stopped at the event's own
 * `startSeconds`/`startSeconds + durationSeconds`.
 *
 * This function's signature is deliberately a direct fit for
 * `LookaheadScheduler`'s `onSchedule` option (see `./scheduler.js`): a
 * caller assembling actual playback (Slice 5's transport controls) wires
 * them together as
 *
 *   new LookaheadScheduler({
 *     events,
 *     getCurrentTime: () => audioContext.currentTime,
 *     onSchedule: (event) => playOnsetEvent(event, { audioContext })
 *   });
 *
 * `'triangle'` is the one timbre this milestone uses for every voice and
 * staff (per-part timbre is out of scope): it is a simple, concretely
 * buildable native `OscillatorType`, chosen over sampled or soundfont
 * playback per this milestone's client-side-only, no-server,
 * no-soundfont-library constraint.
 *
 * Frequency is set via `setValueAtTime` at `startSeconds` rather than a
 * plain `frequency.value =` assignment, for the same reason the gain
 * envelope below uses scheduled automation rather than immediate property
 * writes: it keeps every parameter of this note's sound expressed on the
 * same audio-clock timeline as its own start/stop, even though in practice
 * the oscillator has not started producing samples yet at this point, so a
 * plain assignment would have been equally correct here.
 *
 * Returns the `oscillator`/`gain` nodes it created. Nothing in this
 * milestone up through Slice 4 needs them back (a note is simply left to run
 * its own scheduled envelope to completion), but Slice 5's `PlaybackEngine`
 * does: its `stop()` has to silence notes that are already sounding, which
 * means holding onto a reference to their oscillators so it can call
 * `oscillator.stop()` on them early, ahead of the stop time this function
 * already scheduled.
 */
export function playOnsetEvent(
	event: OnsetEvent,
	options: SynthesisOptions
): { oscillator: OscillatorNode; gain: GainNode } {
	const { audioContext } = options;
	const attackSeconds = options.attackSeconds ?? DEFAULT_ATTACK_SECONDS;
	const releaseSeconds = options.releaseSeconds ?? DEFAULT_RELEASE_SECONDS;
	const peakGain = options.gain ?? DEFAULT_GAIN;

	const startSeconds = event.startSeconds;
	const endSeconds = event.startSeconds + event.durationSeconds;
	const { attack, release } = effectiveEnvelope(attackSeconds, releaseSeconds, event.durationSeconds);

	const oscillator = audioContext.createOscillator();
	oscillator.type = 'triangle';
	oscillator.frequency.setValueAtTime(pitchToFrequency(event.pitch), startSeconds);

	const gainNode = audioContext.createGain();
	// Silent at the note's own start, ramp up to peak over `attack`, hold at
	// peak (the flat stretch between this ramp's end and the next
	// `setValueAtTime` below, when `attack + release < durationSeconds`; zero
	// length otherwise, see `effectiveEnvelope`'s own comment), then ramp back
	// down to silent over `release`, ending exactly at the note's own end.
	gainNode.gain.setValueAtTime(0, startSeconds);
	gainNode.gain.linearRampToValueAtTime(peakGain, startSeconds + attack);
	gainNode.gain.setValueAtTime(peakGain, endSeconds - release);
	gainNode.gain.linearRampToValueAtTime(0, endSeconds);

	oscillator.connect(gainNode);
	gainNode.connect(audioContext.destination);

	oscillator.start(startSeconds);
	oscillator.stop(endSeconds);

	return { oscillator, gain: gainNode };
}
