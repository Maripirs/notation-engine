import type { Pitch } from '../model/pitch.js';
import { toMidi } from '../model/pitch.js';

/**
 * Convert a MIDI note number to a frequency in Hz, via the standard
 * twelve-tone equal temperament formula anchored on A4 = 440Hz (MIDI 69):
 *
 *   frequency = 440 * 2^((midi - 69) / 12)
 *
 * Takes a plain number in, returns a plain number out, with no dependency on
 * `Pitch` or any other model type, the same way `durationToSeconds` (see
 * `./tempo.js`) takes plain numbers so the actually-interesting formula is
 * testable against known reference values without needing a model object at
 * all. `pitchToFrequency`, below, is the model-aware convenience most
 * playback callers actually want.
 */
export function midiToFrequency(midi: number): number {
	return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Convert a model `Pitch` to a frequency in Hz, via `toMidi` (see
 * `../model/pitch.js`) followed by `midiToFrequency`.
 *
 * This conversion deliberately lives in `playback`, not `model`: `model`
 * knows how a pitch is spelled and how it compares diatonically
 * (`diatonicIndex`) or chromatically (`toMidi`), but nothing about audio, the
 * same layering reason `model` knows nothing about canvas drawing either. A
 * caller scheduling an `OnsetEvent` (see `./timeline.js`) has a `Pitch`, not
 * a raw MIDI number, so this is the function most playback code actually
 * calls; `midiToFrequency` is exposed separately because the formula itself
 * is worth testing on its own, against known reference numbers, with no
 * `Pitch` object required.
 */
export function pitchToFrequency(pitch: Pitch): number {
	return midiToFrequency(toMidi(pitch));
}
