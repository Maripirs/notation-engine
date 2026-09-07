/**
 * Convert a note (or rest, or any span) duration to wall-clock seconds at a
 * given tempo. `durationWholes` is a fraction of a whole note with dots and
 * tuplet ratio already folded in (see `Note.durationWholes` in
 * `src/model/score.ts`), and `bpm` is quarter-note beats per minute (the
 * MIDI/MusicXML convention, matching `Score.tempoBpm`).
 *
 * A whole note is 4 quarter notes, and each quarter note takes `60 / bpm`
 * seconds, so:
 *
 *   seconds = durationWholes * 4 * (60 / bpm)
 *
 * This function knows nothing about `Note`, `Score`, or any other model
 * type: it takes plain numbers in, returns a plain number out, so it has no
 * dependency on the model layer at all.
 */
export function durationToSeconds(durationWholes: number, bpm: number): number {
	return durationWholes * 4 * (60 / bpm);
}
