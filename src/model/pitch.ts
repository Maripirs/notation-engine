// Pitch: how a note's sound *and its spelling* are represented.
//
// The representation deliberately mirrors MusicXML's `<pitch>` (step / alter /
// octave) rather than storing a bare MIDI number. Spelling is not recoverable
// from a MIDI number, and this engine has to round-trip MusicXML eventually
// (Phase 5) as well as decide, right now, whether to draw a sharp or a flat.
// Keeping the letter name in the model means a G-flat stays a G-flat through
// an edit instead of silently becoming an F-sharp.

/** Diatonic letter name. */
export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

export interface Pitch {
	readonly step: Step;
	/** Chromatic alteration in semitones: -1 flat, 0 natural, +1 sharp. */
	readonly alter: number;
	/** Scientific pitch notation octave, so middle C is C4. */
	readonly octave: number;
}

const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** Semitones above C for each diatonic step, i.e. the white keys. */
const STEP_SEMITONES: Readonly<Record<Step, number>> = {
	C: 0,
	D: 2,
	E: 4,
	F: 5,
	G: 7,
	A: 9,
	B: 11
};

/**
 * The staff position of a pitch, counted in diatonic steps from C0. Notehead
 * placement depends only on this: two notes that differ by an accidental sit
 * on the same line or space. Layout turns it into a y coordinate; nothing else
 * needs to know how it is derived.
 */
export function diatonicIndex(pitch: Pitch): number {
	return pitch.octave * 7 + STEPS.indexOf(pitch.step);
}

/** MIDI note number, where middle C (C4) is 60. */
export function toMidi(pitch: Pitch): number {
	return (pitch.octave + 1) * 12 + STEP_SEMITONES[pitch.step] + pitch.alter;
}

// Two spellings of the chromatic scale. Which one a transposition picks is the
// only "musical judgement" Phase 0 makes about spelling, and it is a crude one:
// see `transpose` below.
const SHARP_SPELLING: readonly (readonly [Step, number])[] = [
	['C', 0],
	['C', 1],
	['D', 0],
	['D', 1],
	['E', 0],
	['F', 0],
	['F', 1],
	['G', 0],
	['G', 1],
	['A', 0],
	['A', 1],
	['B', 0]
];

const FLAT_SPELLING: readonly (readonly [Step, number])[] = [
	['C', 0],
	['D', -1],
	['D', 0],
	['E', -1],
	['E', 0],
	['F', 0],
	['G', -1],
	['G', 0],
	['A', -1],
	['A', 0],
	['B', -1],
	['B', 0]
];

/** Spell a MIDI number as a pitch, choosing sharps or flats explicitly. */
export function fromMidi(midi: number, prefer: 'sharp' | 'flat' = 'sharp'): Pitch {
	const table = prefer === 'sharp' ? SHARP_SPELLING : FLAT_SPELLING;
	const octave = Math.floor(midi / 12) - 1;
	const entry = table[((midi % 12) + 12) % 12];
	// `table` is a fixed 12-entry array indexed by a value already reduced mod
	// 12, so this cannot miss. The guard exists only for noUncheckedIndexedAccess.
	if (!entry) throw new Error(`unreachable: no spelling for midi ${midi}`);
	const [step, alter] = entry;
	return { step, alter, octave };
}

/**
 * Transpose by whole semitones.
 *
 * Spelling rule: ascending picks sharps, descending picks flats, which is what
 * a musician does by default when nudging a note chromatically and is enough
 * for the one edit op Phase 0 has. It is *not* key-aware. In A-flat major a
 * D-flat nudged up becomes a D-natural here, where an engraver would want
 * D-natural too, but in B major an A-sharp nudged up becomes a B-natural where
 * the correct answer is also B: the rule happens to be right often and wrong
 * quietly. Key-aware respelling belongs with the rest of accidental handling in
 * Phase 1, not bolted onto a spike's single edit op.
 */
export function transpose(pitch: Pitch, semitones: number): Pitch {
	if (semitones === 0) return pitch;
	return fromMidi(toMidi(pitch) + semitones, semitones > 0 ? 'sharp' : 'flat');
}

/**
 * Parse scientific pitch notation: `C4`, `F#5`, `Bb3`. Exists so demo scores
 * and tests read like music instead of like object literals. Not part of any
 * file format, and not a substitute for the MusicXML parser Phase 5 needs.
 */
export function parsePitch(text: string): Pitch {
	const match = /^([A-Ga-g])(#|b|)(-?\d+)$/.exec(text.trim());
	if (!match) throw new Error(`not a pitch name: "${text}"`);
	const [, letter = '', accidental = '', octave = ''] = match;
	return {
		step: letter.toUpperCase() as Step,
		alter: accidental === '#' ? 1 : accidental === 'b' ? -1 : 0,
		octave: Number.parseInt(octave, 10)
	};
}

/** Render a pitch back to scientific pitch notation. Mostly for test failures. */
export function formatPitch(pitch: Pitch): string {
	const accidental = pitch.alter > 0 ? '#'.repeat(pitch.alter) : 'b'.repeat(-pitch.alter);
	return `${pitch.step}${accidental}${pitch.octave}`;
}

/**
 * The alteration a key signature imposes on a given letter name.
 *
 * `fifths` is MusicXML's encoding: positive counts sharps, negative counts
 * flats, and both follow the circle of fifths, so 2 means F-sharp and C-sharp.
 * Layout uses this to decide whether a note's accidental is already implied by
 * the key signature and can be left undrawn.
 */
export function keyAlterForStep(fifths: number, step: Step): number {
	const SHARP_ORDER: readonly Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
	const FLAT_ORDER: readonly Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
	if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
	if (fifths < 0) return FLAT_ORDER.slice(0, -fifths).includes(step) ? -1 : 0;
	return 0;
}
