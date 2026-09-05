// The editable score model.
//
// The whole point of this engine over OSMD is that *this* is the thing an
// editor mutates, not a MusicXML string. OSMD's edit loop is
// serialize -> `load()` (reparse) -> `render()` (re-lay-out everything), which
// is why a single keystroke costs ~1.1-1.3s on a 124-measure piece. Here an
// edit is a field assignment on a `Note`, and the edit method reports which
// measure it touched so the caller can re-lay-out and redraw that measure
// alone.
//
// Phase 0 scope: one staff, one voice, no MusicXML. `voice` is carried on the
// note anyway because retrofitting it once layout assumes a single voice is
// exactly the kind of rework a spike is supposed to avoid.

import type { Pitch } from './pitch.js';
import { parsePitch, transpose } from './pitch.js';

/** Note values Divisi draws, whole down to 64th. */
export type NoteValue = 'whole' | 'half' | 'quarter' | 'eighth' | '16th' | '32nd' | '64th';

/** Duration of each note value as a fraction of a whole note. */
export const NOTE_VALUE_WHOLES: Readonly<Record<NoteValue, number>> = {
	whole: 1,
	half: 1 / 2,
	quarter: 1 / 4,
	eighth: 1 / 8,
	'16th': 1 / 16,
	'32nd': 1 / 32,
	'64th': 1 / 64
};

/**
 * A tuplet ratio: `actualNotes` notes are written to fill the time normally
 * taken by `normalNotes` notes of the same value. A triplet is 3-in-the-
 * time-of-2 (`{ actualNotes: 3, normalNotes: 2 }`); a quintuplet would be
 * `{ actualNotes: 5, normalNotes: 4 }`. Modelling it as a ratio rather than a
 * `'triplet'` enum means any other ratio is already representable by the same
 * field; this slice only ever constructs `TRIPLET`, and rendering the bracket
 * and number over a tuplet group is left to whichever later slice needs it.
 */
export interface TupletRatio {
	readonly actualNotes: number;
	readonly normalNotes: number;
}

/** The one tuplet ratio this slice implements: 3 notes in the time of 2. */
export const TRIPLET: TupletRatio = { actualNotes: 3, normalNotes: 2 };

/** Opaque, stable identifier for a note. Hit-testing and edits address notes by id. */
export type NoteId = string;

export interface NoteSpec {
	/** `null` means a rest. Rests are notes with no pitch rather than a separate type,
	 *  because every other property (duration, voice, position in the measure, being
	 *  selectable and editable) is shared, and splitting them doubles the layout code. */
	readonly pitch: Pitch | null;
	readonly value: NoteValue;
	/** 1-based, matching MusicXML. Phase 0 only ever lays out voice 1. */
	readonly voice?: number;
	/** Augmentation dots. Each dot adds half of what the previous one added: one
	 *  dot multiplies the base duration by 1.5, two dots by 1.75. Every
	 *  engraving convention Divisi targets stops at two, so this is not an
	 *  open-ended count. */
	readonly dots?: 0 | 1 | 2;
	/** Tuplet ratio, e.g. `TRIPLET`. `undefined` means the note is not part of one. */
	readonly tuplet?: TupletRatio;
}

export class Note {
	readonly id: NoteId;
	pitch: Pitch | null;
	value: NoteValue;
	voice: number;
	dots: 0 | 1 | 2;
	tuplet: TupletRatio | null;

	constructor(id: NoteId, spec: NoteSpec) {
		this.id = id;
		this.pitch = spec.pitch;
		this.value = spec.value;
		this.voice = spec.voice ?? 1;
		this.dots = spec.dots ?? 0;
		this.tuplet = spec.tuplet ?? null;
	}

	get isRest(): boolean {
		return this.pitch === null;
	}

	/**
	 * Duration as a fraction of a whole note, dots and tuplet ratio both folded
	 * in. Layout uses it for note spacing (so a dotted or tupleted note gets
	 * proportionally more or less room without spacing needing to know why);
	 * `measureDurationWholes` sums it to check a measure against its time
	 * signature's capacity.
	 */
	get durationWholes(): number {
		// Each dot adds half of the previous augmentation: 2 - 2^-dots gives
		// 1 (no dots), 1.5 (one dot), 1.75 (two dots).
		const dotMultiplier = 2 - 2 ** -this.dots;
		const tupletMultiplier = this.tuplet ? this.tuplet.normalNotes / this.tuplet.actualNotes : 1;
		return NOTE_VALUE_WHOLES[this.value] * dotMultiplier * tupletMultiplier;
	}
}

export class Measure {
	/** Position in the score, 0-based. Kept in sync by `Score`. */
	index: number;
	readonly notes: Note[] = [];

	constructor(index: number) {
		this.index = index;
	}
}

export interface TimeSignature {
	readonly beats: number;
	readonly beatType: number;
}

/** A measure's notes' total duration, as a fraction of a whole note. */
export function measureDurationWholes(measure: Measure): number {
	return measure.notes.reduce((sum, note) => sum + note.durationWholes, 0);
}

/** How much duration a time signature's measure holds, as a fraction of a whole note. */
export function measureCapacityWholes(time: TimeSignature): number {
	return time.beats / time.beatType;
}

export interface MeasureValidation {
	readonly valid: boolean;
	/** The measure's actual total, as a fraction of a whole note. */
	readonly actualWholes: number;
	/** What the time signature says the measure should hold. */
	readonly expectedWholes: number;
}

/**
 * Check that a measure's notes sum to exactly its time signature's capacity.
 *
 * Deliberately just reports: an under- or over-full measure is a modelling
 * error the caller (an importer, an edit op, a hand-built test fixture) needs
 * to know about, not something layout should silently pad or truncate to fix.
 */
export function validateMeasure(measure: Measure, time: TimeSignature): MeasureValidation {
	const actualWholes = measureDurationWholes(measure);
	const expectedWholes = measureCapacityWholes(time);
	// Tuplets land on repeating fractions like 1/3, which do not terminate in
	// binary, so an exact `===` would reject a perfectly valid triplet measure
	// on float noise. The tolerance is far tighter than any audible or visible
	// difference, so it cannot mask a genuinely wrong duration count.
	const valid = Math.abs(actualWholes - expectedWholes) < 1e-9;
	return { valid, actualWholes, expectedWholes };
}

export interface ScoreOptions {
	/** MusicXML `fifths`: positive counts sharps, negative flats. */
	readonly keyFifths?: number;
	readonly time?: TimeSignature;
}

export class Score {
	/** One clef for the whole score in Phase 0. Other clefs are Phase 1. */
	readonly clef = 'treble' as const;
	keyFifths: number;
	time: TimeSignature;
	readonly measures: Measure[] = [];

	// Note id -> owning measure. Maintained on insert so an edit can answer
	// "which measure did I just touch" in O(1) instead of scanning the score.
	// On a 124-measure piece a scan would still be fast, but the index is the
	// honest shape for the incremental-edit architecture this spike is testing.
	readonly #measureOfNote = new Map<NoteId, Measure>();
	#nextNoteId = 1;

	constructor(options: ScoreOptions = {}) {
		this.keyFifths = options.keyFifths ?? 0;
		this.time = options.time ?? { beats: 4, beatType: 4 };
	}

	appendMeasure(): Measure {
		const measure = new Measure(this.measures.length);
		this.measures.push(measure);
		return measure;
	}

	/** Append a note (or rest) to a measure, returning it so callers can keep its id. */
	appendNote(measure: Measure, spec: NoteSpec): Note {
		const note = new Note(`n${this.#nextNoteId++}`, spec);
		measure.notes.push(note);
		this.#measureOfNote.set(note.id, measure);
		return note;
	}

	findNote(id: NoteId): Note | undefined {
		return this.measureOfNote(id)?.notes.find((note) => note.id === id);
	}

	measureOfNote(id: NoteId): Measure | undefined {
		return this.#measureOfNote.get(id);
	}

	/**
	 * The one edit op Phase 0 implements: move a note by whole semitones.
	 *
	 * Returns the index of the measure that changed, or `null` if nothing did
	 * (unknown id, or the note is a rest). That return value is the contract the
	 * incremental redraw hangs off: the caller re-lays-out and repaints exactly
	 * the measures an edit reports, and no others.
	 */
	transposeNote(id: NoteId, semitones: number): number | null {
		const measure = this.#measureOfNote.get(id);
		const note = measure?.notes.find((candidate) => candidate.id === id);
		if (!measure || !note || note.pitch === null) return null;
		note.pitch = transpose(note.pitch, semitones);
		return measure.index;
	}
}

/** One measure written as `[pitchName | null, value, extra?]` triples; `null` is
 *  a rest. `extra` carries dots and/or a tuplet ratio for the notes that need
 *  them, so a plain literal can stay a 2-tuple. */
export type MeasureSpec = readonly (readonly [
	pitch: string | null,
	value: NoteValue,
	extra?: { dots?: 0 | 1 | 2; tuplet?: TupletRatio }
])[];

/**
 * Build a score from a compact literal, so demo scores and test fixtures read
 * like music rather than like constructor calls. Phase 0 has no importer, so
 * every score in this repo is written by hand and this is how. Phase 5's
 * MusicXML import replaces it as the real entry point, not this.
 */
export function buildScore(measures: readonly MeasureSpec[], options: ScoreOptions = {}): Score {
	const score = new Score(options);
	for (const spec of measures) {
		const measure = score.appendMeasure();
		for (const [pitch, value, extra] of spec) {
			score.appendNote(measure, {
				pitch: pitch === null ? null : parsePitch(pitch),
				value,
				dots: extra?.dots,
				tuplet: extra?.tuplet
			});
		}
	}
	return score;
}
