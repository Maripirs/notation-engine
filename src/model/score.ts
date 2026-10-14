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
import { parsePitch, pitchesEqual, transpose } from './pitch.js';
import {
	NO_DYNAMICS,
	positionBefore,
	sortDynamics,
	type DynamicKind,
	type DynamicMark,
	type Placement,
	type Wedge,
	type WedgeKind
} from './directions.js';
import {
	NO_PASSTHROUGH,
	withoutNoteMarkup,
	withoutTieMarkup,
	type MeasurePassthrough,
	type OpaqueElement
} from './passthrough.js';

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

/** Every `NoteValue`, longest first. */
export const NOTE_VALUES: readonly NoteValue[] = Object.freeze(['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th']);

/** A written duration: a note value plus augmentation dots (no tuplet). */
export interface SpelledDuration {
	readonly value: NoteValue;
	readonly dots: 0 | 1 | 2;
}

/** `value` with `dots`, in wholes (no tuplet): the same arithmetic as
 *  `Note.durationWholes`. */
export function spelledWholes(value: NoteValue, dots: 0 | 1 | 2): number {
	return NOTE_VALUE_WHOLES[value] * (2 - 2 ** -dots);
}

/**
 * The single note value (plus dots) that lasts exactly `wholes`, or `null`
 * when none does (e.g. 5/8, or anything longer than a double-dotted whole).
 * `dotCandidates` are tried in order, fewest dots first by default, so a
 * plain value wins over an equal dotted spelling (there is none, but the
 * order is also the preference the importer wants). Matching is within 1e-6,
 * far below any real duration and far above float noise.
 *
 * Pure and model-level (M6 Slice 7) so both the importer's "no `<type>`"
 * fallback and `Score.restToNote` (a whole-measure rest becoming a note of
 * the measure's length) answer "which note value is this long" the same way.
 */
export function noteValueForWholes(
	wholes: number,
	dotCandidates: readonly (0 | 1 | 2)[] = [0, 1, 2]
): SpelledDuration | null {
	for (const dots of dotCandidates) {
		for (const value of NOTE_VALUES) {
			if (Math.abs(spelledWholes(value, dots) - wholes) < 1e-6) return { value, dots };
		}
	}
	return null;
}

/**
 * Spell `wholes` of silence starting `onset` wholes into a measure as a run
 * of undotted rest values (M6 Slice 7: the padding `Score.setDuration`
 * writes when a note gets shorter, or the remainder of a rest it partly
 * consumed). Each step takes the longest value that fits what is left *and*
 * starts on a multiple of its own length, the usual rule for rests (a rest
 * does not straddle a beat of its own size), so an eighth note shortened from
 * a half on beat 1 is followed by an eighth rest then a quarter rest, not a
 * quarter rest across the off-beat. An onset off the 64th grid (after a
 * tuplet) relaxes the alignment and simply takes the longest value that fits.
 * Dotted rests are never written: the aligned plain run is what an engraver
 * writes in simple time, and it is always correct, if not always the
 * shortest spelling in compound time.
 *
 * Returns `null` when `wholes` cannot be spelled at all (a remainder below a
 * 64th, i.e. a tuplet fraction), and `[]` for zero.
 */
export function restValuesFor(onset: number, wholes: number): NoteValue[] | null {
	const values: NoteValue[] = [];
	let at = onset;
	let left = wholes;
	const EPS = 1e-9;
	const onGrid = (position: number, size: number): boolean => {
		const ratio = position / size;
		return Math.abs(ratio - Math.round(ratio)) < 1e-6;
	};
	while (left > EPS) {
		const fits = NOTE_VALUES.filter((value) => NOTE_VALUE_WHOLES[value] <= left + EPS);
		if (fits.length === 0) return null;
		const value = fits.find((v) => onGrid(at, NOTE_VALUE_WHOLES[v])) ?? fits[0]!;
		values.push(value);
		at += NOTE_VALUE_WHOLES[value];
		left -= NOTE_VALUE_WHOLES[value];
	}
	return values;
}

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

/**
 * The shapes a barline can draw. `normal` is a single thin line (every
 * boundary's default); `double` is two thin lines close together, marking a
 * section boundary with no repeat or ending implied; `final` is thin-then-
 * thick, the score's own closing barline; `repeatStart`/`repeatEnd` are a
 * thick line plus two dots, opening or closing a repeated section (see
 * `Measure.startBarline`/`endBarline` for which measure owns which end of the
 * boundary, and why they are two separate fields rather than one).
 *
 * This slice draws each shape and nothing more: no repeat-playback semantics
 * (jumping back to a `repeatStart` when a `repeatEnd` is reached, counting
 * endings) exist anywhere in this model. That is real, but separate, work for
 * whichever later phase adds a player.
 */
export type BarlineType = 'normal' | 'double' | 'final' | 'repeatStart' | 'repeatEnd';

/**
 * The clefs this engine draws. `treble` and `bass` are the ordinary G and F
 * clefs. `treble8` is the "octave treble" (vocal tenor) clef: notated on
 * exactly the same lines and spaces as plain `treble` (only the small "8"
 * beneath the glyph differs), but *sounding* an octave lower than written.
 * This engine has no sounding-pitch/playback concept yet (that is M3's
 * job), so nothing here ever needs to shift a `treble8` note's pitch down an
 * octave; `treble8` and `treble` share every position table in `layout.ts`
 * and differ only in which clef glyph gets drawn.
 *
 * `alto` and `tenor` (M6 Slice 4) are the two C clefs choral and orchestral
 * music still uses: the same `cClef` glyph, centred on the line it names as
 * middle C, the third line for alto (viola) and the fourth for tenor (the
 * SFCC tenor parts alternate bass and tenor clef). The other C-clef lines
 * (soprano C1, mezzo-soprano C2, baritone C5) are obsolete in this repertoire
 * and stay unmodelled; the importer reads them as treble with a fallback.
 */
export type ClefType = 'treble' | 'bass' | 'treble8' | 'alto' | 'tenor';

/**
 * A clef change *inside* a measure (M6 Slice 4): from `onset` (wholes from the
 * measure's start, always > 0; a change at the downbeat is `Measure.clef`)
 * the staff reads in `clef`, until the next change. Engraving draws it as a
 * smaller clef right before the note at that onset, or before the barline
 * when it sits at the measure's very end (the usual spelling of a change
 * that takes effect at the next downbeat). Immutable, so a clone may share
 * one; an edit replaces `Measure.clefChanges` wholesale.
 */
export interface ClefChange {
	readonly onset: number;
	readonly clef: ClefType;
}

/** The empty `Measure.clefChanges`, shared (and frozen) so the common case
 *  costs no allocation per measure. */
export const NO_CLEF_CHANGES: readonly ClefChange[] = Object.freeze([]);

/**
 * An articulation mark on a note (M6 Slice 5), named as MusicXML's
 * `<articulations>` children are. `'strong-accent'` is the marcato (the
 * vertical wedge); `'detached-legato'` is the combined tenuto-over-staccato
 * mark (one Bravura glyph, and both meanings in playback). Other MusicXML
 * articulation kinds (`breath-mark`, `caesura`, `spiccato`, `stress`, ...)
 * are not modelled: import keeps them as passthrough.
 */
export type Articulation = 'staccato' | 'staccatissimo' | 'accent' | 'strong-accent' | 'tenuto' | 'detached-legato';

/** Every `Articulation`, in the order layout stacks them outward from the
 *  notehead (Gould, *Behind Bars*: the "short" marks staccato/tenuto sit
 *  nearest, accents outside them). Also the canonical order equivalence and
 *  export use, so a set of marks has one spelling. */
export const ARTICULATIONS: readonly Articulation[] = Object.freeze([
	'staccato',
	'staccatissimo',
	'tenuto',
	'detached-legato',
	'accent',
	'strong-accent'
]);

/**
 * A fermata (MusicXML `<fermata type="upright|inverted">`, normal shape
 * only). `'upright'` is the usual arch-over-dot drawn above the staff;
 * `'inverted'` is the same mark flipped, drawn below the staff (the way a
 * lower voice's fermata is engraved, and how OMR reports one read there).
 * Angled/square/other shapes are not modelled and stay passthrough.
 */
export type Fermata = 'upright' | 'inverted';

/** The empty `Note.articulations`, shared (and frozen) so the common case
 *  costs no allocation per note. */
export const NO_ARTICULATIONS: readonly Articulation[] = Object.freeze([]);

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
	/**
	 * Id of the *next* note this one is tied to: the two sound as one
	 * continuous note of the same pitch, drawn as a curve from this notehead to
	 * that one, rather than as a fresh attack. `null`/`undefined` means this
	 * note starts no tie.
	 *
	 * A direction had to be picked (source -> target, not a symmetric pair or a
	 * bare boolean) because layout has to know *which* note a tie's curve
	 * reaches, not just that a tie exists; a monophonic score only ever has one
	 * candidate to point at today, but a boolean flag would still leave that
	 * relationship for some other structure to reconstruct later, e.g. once
	 * slurs or an editor need to walk a tie from either end.
	 *
	 * This field is the low-level form, for a caller that already knows the
	 * target note's id (e.g. copying an existing note whose id is already
	 * assigned). `buildScore`'s compact literal syntax instead uses
	 * `MeasureSpec`'s `extra.tiedToNext`, which it resolves to an id itself
	 * once the whole score exists (see `buildScore`): a tie's target commonly
	 * lives in a measure not yet built when the source note is created.
	 */
	readonly tiedToId?: NoteId | null;
	/**
	 * Marks a whole-measure rest (MusicXML `<rest measure="yes"/>`): a rest
	 * that fills its measure whatever the time signature, drawn as the whole
	 * rest glyph centred in the measure (the standard engraving, so a 3/4 or
	 * 6/8 bar of silence still shows the semibreve rest, never a dotted half).
	 * The number is the duration it fills, in wholes, i.e. the capacity of the
	 * time signature in force at its measure (`measureCapacityWholes`).
	 *
	 * Stored as a number rather than a bare flag because a `Note` does not
	 * know which measure it is in, yet `durationWholes` (summed by validation,
	 * playback timing and layout spacing alike) has to report the right
	 * length without every one of those sites learning a special case. The
	 * cost is that the number is a snapshot: whoever creates the rest (the
	 * importer) computes it from `Score.timeAt`, and nothing re-derives it if
	 * the time signature later changes. No edit op changes a time signature
	 * yet; the one that does will have to refresh this.
	 *
	 * Only meaningful on a rest (`pitch: null`); `Note`'s constructor throws
	 * otherwise. `value` is still set (to `'whole'` by the importer) because
	 * glyph lookup, beaming and export all key off it, but `durationWholes`
	 * ignores `value`/`dots`/`tuplet` when this is set.
	 */
	readonly measureRestWholes?: number | null;
	/**
	 * Marks this note as a further head of a chord (M6 Slice 2): it sounds at
	 * the same onset as the most recent earlier note *of the same voice* in its
	 * measure (the chord's "anchor", which itself has this `false`), and is
	 * drawn on that anchor's stem. The MusicXML shape exactly: a chord is
	 * consecutive `<note>`s where every one after the first carries `<chord/>`.
	 *
	 * Why a marker on separate `Note`s rather than one `Note` holding
	 * `pitches[]`: every head keeps its own id, so hit-testing, selection,
	 * `transposeNote`, ties (each head ties to its own target) and the playback
	 * cursor keep working per head with no change (plan.md's M6 "Chord model"
	 * decision). The price is that anything walking a voice's timeline must
	 * count a chord once, not once per head: `noteEvents` does the grouping in
	 * one place, and `measureDurationWholes`/`validateMeasure` skip members.
	 *
	 * A member's own `value`/`dots`/`tuplet` only choose its notehead glyph;
	 * the chord's duration, stem, flag and beaming all come from the anchor.
	 * Only valid on a pitched note whose measure already holds an earlier
	 * pitched note in the same voice (`Score.appendNote` throws otherwise).
	 */
	readonly chordWithPrevious?: boolean;
	/**
	 * Articulation marks on this note (M6 Slice 5), in any order, without
	 * duplicates (the constructor normalizes both away into `ARTICULATIONS`
	 * order). Valid on a rest too (MusicXML allows it), though only a fermata
	 * is usual there.
	 *
	 * Chords: a mark belongs to the head it was written on (MusicXML puts it
	 * on one `<note>` of the chord, usually the first, but OMR and other
	 * encoders vary), and stays there so a round trip keeps it where it was.
	 * Everything that *interprets* marks reads the chord's union instead
	 * (`eventArticulations`): layout draws each mark once per chord, at the
	 * stem-opposite end, and playback shortens every head of a staccato chord.
	 */
	readonly articulations?: readonly Articulation[];
	/** A fermata over (or under) this note or rest; see `Fermata`. As with
	 *  `articulations`, it sits on the head it was written on, and layout and
	 *  playback read the chord's union (`eventFermata`). */
	readonly fermata?: Fermata | null;
	/** See `Note.passthrough`. */
	readonly passthrough?: readonly OpaqueElement[];
}

export class Note {
	readonly id: NoteId;
	pitch: Pitch | null;
	value: NoteValue;
	voice: number;
	dots: 0 | 1 | 2;
	tuplet: TupletRatio | null;
	/** See `NoteSpec.tiedToId`. Mutable so `Score.setTie` can wire, change or
	 *  clear it after construction; kept in sync with `Score`'s reverse index
	 *  only when changed through `Score.setTie` (or `Score.appendNote`'s own
	 *  spec-time wiring), never by assigning this field directly. */
	tiedToId: NoteId | null;
	/** See `NoteSpec.measureRestWholes`. `null` for every ordinary note or rest. */
	readonly measureRestWholes: number | null;
	/** See `NoteSpec.chordWithPrevious`. `false` for a chord's anchor and for
	 *  every ordinary note or rest. */
	readonly chordWithPrevious: boolean;
	/** See `NoteSpec.articulations`. Always in `ARTICULATIONS` order with no
	 *  duplicates; replaced wholesale (never mutated), so a clone may share it. */
	articulations: readonly Articulation[];
	/** See `NoteSpec.fermata`. `null` for none. */
	fermata: Fermata | null;
	/**
	 * Unmodelled children of this note's `<note>` (M6 Slice 3, see
	 * `passthrough.ts`), in source order: `<lyric>`, `<notehead>`, `<cue>`, a
	 * `<notations>` cut down to the children the model does not own, a
	 * `<tie>`/`<tied>`/`<slur>` end that never found its partner, ... Export
	 * slots each back into its schema position. It belongs to this note alone,
	 * so edits that keep the note (a transpose) keep it, and a chord member
	 * carries its own. Replaced wholesale, never mutated: the array and every
	 * element are immutable, which is what lets `Score.clone` share them.
	 */
	passthrough: readonly OpaqueElement[];

	constructor(id: NoteId, spec: NoteSpec) {
		this.id = id;
		this.pitch = spec.pitch;
		this.value = spec.value;
		this.voice = spec.voice ?? 1;
		this.dots = spec.dots ?? 0;
		this.tuplet = spec.tuplet ?? null;
		this.tiedToId = spec.tiedToId ?? null;
		this.measureRestWholes = spec.measureRestWholes ?? null;
		this.chordWithPrevious = spec.chordWithPrevious ?? false;
		this.articulations = normalizeArticulations(spec.articulations);
		this.fermata = spec.fermata ?? null;
		this.passthrough = spec.passthrough ?? NO_PASSTHROUGH;
		if (this.measureRestWholes !== null && this.pitch !== null) {
			throw new Error(`Note ${id}: measureRestWholes is only valid on a rest (pitch: null)`);
		}
		if (this.chordWithPrevious && this.pitch === null) {
			throw new Error(`Note ${id}: chordWithPrevious is only valid on a pitched note, not a rest`);
		}
	}

	/** Whether this is a whole-measure rest; see `NoteSpec.measureRestWholes`. */
	get isMeasureRest(): boolean {
		return this.measureRestWholes !== null;
	}

	get isRest(): boolean {
		return this.pitch === null;
	}

	/** Whether this note starts a tie into a following note. */
	get isTied(): boolean {
		return this.tiedToId !== null;
	}

	/**
	 * Duration as a fraction of a whole note, dots and tuplet ratio both folded
	 * in. Layout uses it for note spacing (so a dotted or tupleted note gets
	 * proportionally more or less room without spacing needing to know why);
	 * `measureDurationWholes` sums it to check a measure against its time
	 * signature's capacity.
	 */
	get durationWholes(): number {
		// A whole-measure rest fills its measure, not its notated value: a 3/4
		// bar's measure rest is drawn as a whole rest but lasts three quarters.
		if (this.measureRestWholes !== null) return this.measureRestWholes;
		// Each dot adds half of the previous augmentation: 2 - 2^-dots gives
		// 1 (no dots), 1.5 (one dot), 1.75 (two dots).
		const dotMultiplier = 2 - 2 ** -this.dots;
		const tupletMultiplier = this.tuplet ? this.tuplet.normalNotes / this.tuplet.actualNotes : 1;
		return NOTE_VALUE_WHOLES[this.value] * dotMultiplier * tupletMultiplier;
	}
}

/** `marks` deduplicated and in `ARTICULATIONS` order; the shared empty array
 *  when there are none. */
export function normalizeArticulations(marks: readonly Articulation[] | undefined): readonly Articulation[] {
	if (!marks || marks.length === 0) return NO_ARTICULATIONS;
	return Object.freeze(ARTICULATIONS.filter((kind) => marks.includes(kind)));
}

/**
 * The articulations of one event (a single note or rest, or every head of a
 * chord as `noteEvents` groups them): the union over its heads, in
 * `ARTICULATIONS` order. What layout draws once per chord and what playback
 * applies to every head, whichever head a mark was written on (see
 * `NoteSpec.articulations`).
 */
export function eventArticulations(event: readonly Note[]): readonly Articulation[] {
	if (event.length === 1) return event[0]!.articulations;
	let any = false;
	for (const note of event) if (note.articulations.length > 0) any = true;
	if (!any) return NO_ARTICULATIONS;
	return normalizeArticulations(event.flatMap((note) => note.articulations));
}

/** One event's fermata (see `eventArticulations`): the first head's that has
 *  one, upright winning if heads disagree (a chord has one fermata). */
export function eventFermata(event: readonly Note[]): Fermata | null {
	let found: Fermata | null = null;
	for (const note of event) {
		if (note.fermata === 'upright') return 'upright';
		if (note.fermata !== null) found = note.fermata;
	}
	return found;
}

export class Measure {
	/**
	 * Position within its own staff, 0-based. Kept in sync by `Score`/`Staff`.
	 *
	 * Before M2 Slice 3 this was a single score-wide flat address (every score
	 * had exactly one implicit staff, so "position in the score" and "position
	 * in the staff" were the same number). Now a measure is addressed by this
	 * *together with* `staffIndex`: `layout.ts`'s `LaidOutMeasure`,
	 * `relayoutMeasure` and `CanvasRenderer.redrawMeasure` all take the pair,
	 * not this field alone. A single-staff score (every score before this
	 * slice, and still the common case) is the `staffIndex`-always-0
	 * degenerate case, with this field's own meaning unchanged.
	 */
	index: number;
	/** Which staff (`Score.staves`) this measure belongs to. See `index`'s own
	 *  comment on the `(staffIndex, index)` addressing pair this slice
	 *  introduces. */
	readonly staffIndex: number;
	readonly notes: Note[] = [];
	/**
	 * A key signature change taking effect starting at this measure.
	 * `undefined` means "no change here": the key in force is whatever the
	 * nearest earlier measure with an explicit value set, or the score's
	 * initial `keyFifths` if none ever did. Callers should not walk that chain
	 * themselves; `Score.keyFifthsAt` does it once, in one place.
	 */
	keyFifths?: number;
	/** Same idea as `keyFifths`, for a time signature change. See `Score.timeAt`. */
	time?: TimeSignature;
	/**
	 * A clef change taking effect starting at this measure (M5 Slice 5), the
	 * same shape as `keyFifths`/`time`: `undefined` means "same clef as the
	 * previous measure", or, for measure 0, the staff's own `Staff.clef`.
	 * `Staff.clef` stays the staff's *initial* clef; an explicit value here on
	 * measure 0 is an override of it, not a replacement, so `Staff.clef` never
	 * has to be rewritten by an edit. Read through `Score.clefAt`, never this
	 * field directly: every clef-dependent position (notehead lines, ledgers,
	 * key signature octaves) needs the clef actually in force, and the
	 * walk-back that answers that lives in one place.
	 */
	clef?: ClefType;
	/**
	 * Clef changes inside this measure (M6 Slice 4; see `ClefChange`), sorted
	 * by onset, each onset > 0. Per staff like `clef`, and kept separate from
	 * it rather than folding `clef` in as an onset-0 entry, so every existing
	 * reader of the downbeat clef (`clefAt`, `setClefRange`, the system
	 * header) keeps its one-field shape. The last change's clef carries into
	 * the following measures through `Score.clefAt`'s walk-back, exactly as a
	 * `clef` set here would. Read through `Score.clefAtOnset`, never directly,
	 * for "which clef is this note in". Replaced wholesale, never mutated.
	 */
	clefChanges: readonly ClefChange[] = NO_CLEF_CHANGES;
	/**
	 * Dynamic marks drawn on this measure's staff (M6 Slice 6; see
	 * `DynamicMark`), sorted by onset. A hairpin spans measures, so it lives
	 * on the score instead (`Score.wedges`). Replaced wholesale, never
	 * mutated, like `clefChanges`.
	 */
	dynamics: readonly DynamicMark[] = NO_DYNAMICS;
	/**
	 * The barline at the boundary *after* this measure: `'normal'`, `'double'`,
	 * `'final'` or `'repeatEnd'`. `'repeatStart'` is deliberately not a valid
	 * value here; see `startBarline` for why that one belongs to the measure it
	 * opens instead. `undefined` means "no explicit choice": `Score.endBarlineAt`
	 * resolves that to `'normal'`, except for the score's true last measure,
	 * which resolves to `'final'` instead so every score still ends with a
	 * final barline with no annotation required (this is exactly what
	 * `ctx.isLast` hardcoded before `BarlineType` existed). Read through
	 * `Score.endBarlineAt`, never this field directly: a `repeatStart` on the
	 * *next* measure also overrides whatever this field says, and that walk
	 * lives in one place, the same discipline `keyFifthsAt`/`timeAt` already
	 * follow for key/time changes.
	 */
	endBarline?: BarlineType;
	/**
	 * A repeat-start barline (thick line, then two dots) at the *start* of
	 * this measure, opening a repeated section. The only barline type
	 * conventionally attached to the start of a measure rather than the end
	 * (mirroring MusicXML's `<barline location="left">` vs `"right">`), which
	 * is why it gets its own field instead of living in `endBarline`: a plain
	 * union field for "the barline here" would have to pick one measure to
	 * belong to, and `endBarline`'s owner (the measure just before the
	 * boundary) is wrong for a mark that engraving convention reads as
	 * belonging to what comes *after* it.
	 *
	 * Despite living on this measure's own model, the ink is still drawn by
	 * whichever measure's `layoutMeasure` call lays out *this* measure (i.e.
	 * this one, at its own start), not by the previous measure: that keeps the
	 * "a measure's ops are everything a repaint of it needs to put back"
	 * invariant intact without a second draw pass or a lookahead into a
	 * neighbour's ops. The previous measure still needs a one-field lookahead
	 * of its own, into *this* field, to know to skip drawing its own default
	 * end barline at the same boundary; see `Score.endBarlineAt`.
	 */
	startBarline?: 'repeatStart';
	/**
	 * `<measure>` children the model does not hold, each anchored at the onset
	 * and voice stream it was read at (M6 Slice 3; see `MeasurePassthrough`).
	 * Held by the staff the stream belongs to. Replaced wholesale, never
	 * mutated, like `Note.passthrough`.
	 */
	passthrough: readonly MeasurePassthrough[] = NO_PASSTHROUGH;
	/**
	 * Children of this measure's `<attributes>` the model does not own
	 * (`<staff-details>`, `<transpose>`, `<measure-style>`, ...), which export
	 * merges, in schema order, into the `<attributes>` it writes for the
	 * measure (writing one just for them if the model has nothing to state).
	 * Kept on the part's first staff, the one export reads a part's
	 * attributes from. An `<attributes>` with nothing owned in it at all is
	 * positional `passthrough` instead, so a mid-measure one stays mid-measure.
	 */
	attributesPassthrough: readonly OpaqueElement[] = NO_PASSTHROUGH;
	/**
	 * `<barline>` elements, minus whatever the model read out of them into
	 * `startBarline`/`endBarline` (`bar-style`, and `repeat` when the model
	 * holds the repeat), each still carrying its `location`: an `<ending>`, a
	 * `<fermata>`, a `bar-style` the model has no shape for (`dashed`,
	 * `heavy`, ...). Export merges each into the barline it writes at that
	 * location, or writes it alone. Kept on the part's first staff, like
	 * `attributesPassthrough`.
	 */
	barlinePassthrough: readonly OpaqueElement[] = NO_PASSTHROUGH;

	constructor(index: number, staffIndex: number) {
		this.index = index;
		this.staffIndex = staffIndex;
	}
}

/**
 * One staff (a five-line stave): its own clef and its own sequence of
 * `Measure`s. A `Part` (below) groups one or more staves belonging to the
 * same instrument or voice (e.g. a piano's two staves, or one SATB voice's
 * single staff).
 *
 * Introduced whole by M2 Slice 3: before it, `Score` had exactly one
 * implicit staff (a fixed, always-treble `clef` field, and `measures` as one
 * flat array), which is now `staves[0]`, created by `Score`'s own
 * constructor so every score before this slice, and the still-common
 * single-staff case, needs no code change to keep working. Multiple staves
 * rendering together as one *visually joined* system (staves stacked
 * tightly, sharing barlines) is M2 Slice 4's job ("Multi-staff system
 * layout"), not this one: `layout.ts`'s `layoutScore` lays each staff out
 * independently and merely stacks the results, a deliberately naive
 * placeholder (see its own comment) that exists only so this slice's
 * `(staffIndex, measureIndex)` addressing has something real, multi-staff,
 * to prove region-scoped redraw against.
 */
export class Staff {
	readonly index: number;
	clef: ClefType;
	readonly measures: Measure[] = [];

	constructor(index: number, clef: ClefType = 'treble') {
		this.index = index;
		this.clef = clef;
	}
}

/**
 * A group of one or more staves belonging to the same instrument or voice
 * part, e.g. one SATB voice's single staff or a piano's two staves.
 *
 * Only the grouping itself is modelled here. The brace/bracket glyph and
 * vertical span a real score draws at a system's start for a multi-staff
 * part, plus the part-name label, is M2 Slice 5's own scope ("Part grouping
 * + braces/brackets"); nothing here draws either one yet. This slice needs
 * `Part` to exist as a real, constructible grouping so `Score` can express
 * "these staves belong together" at all, which is the foundation Slice 5
 * draws on, not a rendering feature in its own right yet.
 */
export interface Part {
	readonly name?: string;
	readonly staffIndices: readonly number[];
	/**
	 * Unowned children of the `<score-part>` this part came from
	 * (`<score-instrument>`, `<midi-instrument>`, `<part-abbreviation>`, ...),
	 * or, for a part that records a bracket/brace group, of its `<part-group
	 * type="start">` (`<group-name>`, `<group-barline>`, ...). M6 Slice 3;
	 * export merges them back in schema order.
	 */
	readonly passthrough?: readonly OpaqueElement[];
}

export interface TimeSignature {
	readonly beats: number;
	readonly beatType: number;
}

/**
 * A measure's notes' total duration, as a fraction of a whole note.
 *
 * Deliberately does *not* merge a tied pair into one duration. A tie is a
 * sounding/perceptual construct: the two notes are heard as one continuous
 * note, but each is still a written note occupying its own measure's own
 * capacity, exactly as MusicXML (this model's spiritual reference) counts it:
 * `<tie>` is a separate, playback-facing element layered on top of two
 * ordinarily-durationed `<note>`s, not a way to make one of them free. A
 * quarter note tied to a quarter note across a barline still costs a quarter
 * of each measure's capacity, the same as if there were no tie at all; only
 * layout and playback treat the pair as one continuous sound. Getting this
 * backwards (subtracting a tied note's duration from its own measure, on the
 * theory that "it's really one long note") would let an under-full measure
 * validate as full, which is exactly the bug this function exists to catch.
 */
export function measureDurationWholes(measure: Measure): number {
	// A chord member (`Note.chordWithPrevious`) shares its anchor's onset and
	// takes no time of its own, so only anchors and plain notes count.
	return measure.notes.reduce((sum, note) => (note.chordWithPrevious ? sum : sum + note.durationWholes), 0);
}

/**
 * A measure's notes grouped into *events* (M6 Slice 2): one entry per onset
 * in one voice, i.e. a plain note or rest alone, or a chord's anchor followed
 * by its members (`Note.chordWithPrevious`) in their `measure.notes` order.
 * Events come out in their anchors' order of appearance, so one voice's
 * events are in time order and two interleaved voices stay interleaved
 * exactly as `notes` had them; a caller wanting one voice filters by
 * `event[0].voice`.
 *
 * The single place chord membership is resolved, so every duration walk
 * (layout's onsets and beaming, playback's timeline, export) counts a chord
 * once by walking events and advancing by `event[0].durationWholes`, rather
 * than each re-implementing "skip members, but remember which anchor they
 * belong to". A member joins the most recent earlier event *of its own
 * voice*, which is what lets a literal or an import interleave two voices'
 * notes freely; one with no such event (only reachable by bypassing
 * `Score.appendNote`'s check) starts an event of its own rather than being
 * lost.
 */
export function noteEvents(notes: readonly Note[]): Note[][] {
	const events: Note[][] = [];
	const lastEventOfVoice = new Map<number, Note[]>();
	for (const note of notes) {
		const open = note.chordWithPrevious ? lastEventOfVoice.get(note.voice) : undefined;
		if (open) {
			open.push(note);
			continue;
		}
		const event = [note];
		events.push(event);
		lastEventOfVoice.set(note.voice, event);
	}
	return events;
}

/** How much duration a time signature's measure holds, as a fraction of a whole note. */
export function measureCapacityWholes(time: TimeSignature): number {
	return time.beats / time.beatType;
}

export interface MeasureValidation {
	/** True iff every voice present in the measure independently fills the
	 *  time signature's capacity; see `perVoice` and this function's own
	 *  comment for why "every voice independently" is the right rule, not
	 *  "the sum across voices". */
	readonly valid: boolean;
	/** The measure's actual total *summed across every voice sharing it*, as a
	 *  fraction of a whole note. Kept for backward compatibility and because
	 *  it is a real, useful number in its own right (e.g. a total-ink-width
	 *  estimate that wants "how much duration is in this measure" regardless
	 *  of how many voices it took to fill it) - it is deliberately *not* what
	 *  `valid` is computed from any more; see `perVoice`. */
	readonly actualWholes: number;
	/** What the time signature says the measure should hold, i.e. what *each*
	 *  voice present should individually sum to. */
	readonly expectedWholes: number;
	/** One entry per distinct `Note.voice` present in the measure, each
	 *  reporting that voice's own total against `expectedWholes`. A measure
	 *  with no notes at all has no voices present, hence an empty array here,
	 *  which in turn makes `valid` false against any nonzero-capacity time
	 *  signature (there is no voice that filled it) - consistent with this
	 *  function's pre-existing behaviour of flagging an empty measure as
	 *  invalid, just now reached through the per-voice rule instead of a
	 *  vacuously-zero sum. */
	readonly perVoice: readonly { readonly voice: number; readonly actualWholes: number; readonly valid: boolean }[];
}

/**
 * Check that a measure's notes fill its time signature's capacity, one voice
 * at a time.
 *
 * Deliberately just reports: an under- or over-full measure is a modelling
 * error the caller (an importer, an edit op, a hand-built test fixture) needs
 * to know about, not something layout should silently pad or truncate to fix.
 *
 * `time` is taken as a plain parameter, not read off `measure` itself, because
 * a measure only ever *changes* a time signature (`Measure.time`); the one
 * actually in force at a given measure is `Score.timeAt(measure.index)`, which
 * a caller in a score with any mid-score time changes needs to pass here
 * rather than the score's single initial `time`.
 *
 * A single voice filling a measure is the easy case: its own notes' durations
 * simply have to sum to the time signature's capacity, which is exactly what
 * `measureDurationWholes` computes when there is only one voice to sum.
 * Two or more voices sharing a measure is not "the sum of every voice's notes
 * fills the measure once" (that formula makes a fully-valid two-voice 4/4
 * measure, each voice independently a full bar of its own, sum to *2* wholes
 * and incorrectly fail); it is "*each* voice independently fills the measure
 * on its own timeline", the same way a real two-voice staff has voice 1's
 * quarter notes and voice 2's quarter notes each separately accounting for
 * all four beats, not jointly accounting for four beats between them. This
 * function therefore groups the measure's notes by `note.voice`, checks each
 * group's own sum against `expectedWholes` independently (`perVoice`), and
 * only calls the whole measure `valid` when every one of those groups passes.
 * `actualWholes` (the old, single total) is kept for backward compatibility
 * and its own documented uses, but is no longer what `valid` is computed
 * from once more than one voice is present.
 */
export function validateMeasure(measure: Measure, time: TimeSignature): MeasureValidation {
	const actualWholes = measureDurationWholes(measure);
	const expectedWholes = measureCapacityWholes(time);
	// Grouping by voice, in first-seen order, mirrors `notesByVoice` in
	// layout.ts (this file does not import from layout.ts, so it is not reused
	// directly, but the grouping rule - a plain Map keyed by `note.voice` - is
	// deliberately the same one, so a measure's voices are counted identically
	// by both the model's own validation and layout's rendering).
	const wholesByVoice = new Map<number, number>();
	for (const note of measure.notes) {
		// A chord counts once: its members ride on the anchor's duration.
		if (note.chordWithPrevious) continue;
		wholesByVoice.set(note.voice, (wholesByVoice.get(note.voice) ?? 0) + note.durationWholes);
	}
	// Tuplets land on repeating fractions like 1/3, which do not terminate in
	// binary, so an exact `===` would reject a perfectly valid triplet measure
	// on float noise. The tolerance is far tighter than any audible or visible
	// difference, so it cannot mask a genuinely wrong duration count.
	const perVoice = [...wholesByVoice.entries()].map(([voice, voiceWholes]) => ({
		voice,
		actualWholes: voiceWholes,
		valid: Math.abs(voiceWholes - expectedWholes) < 1e-9
	}));
	// An empty measure (no notes, hence no voices present in `perVoice`) has
	// nothing that filled it, so `every` over zero entries would vacuously be
	// `true` if left unchecked; the explicit `length > 0` keeps that case
	// invalid against any nonzero-capacity time signature, matching what this
	// function already did before the per-voice rewrite (a 0-vs-expected
	// mismatch also failed the old single-sum check).
	const valid = perVoice.length > 0 && perVoice.every((entry) => entry.valid);
	return { valid, actualWholes, expectedWholes, perVoice };
}

export interface ScoreOptions {
	/** MusicXML `fifths`: positive counts sharps, negative flats. */
	readonly keyFifths?: number;
	readonly time?: TimeSignature;
	/** Clef of `Score`'s own first staff (`staves[0]`), created by the
	 *  constructor. Defaults to `'treble'`, matching every score built before
	 *  M2 Slice 3. Add further staves (with their own clefs) via
	 *  `appendStaff`. */
	readonly clef?: ClefType;
	/** Score-wide tempo in quarter-note beats per minute (the MIDI/MusicXML
	 *  convention, independent of the prevailing time signature's beat unit).
	 *  Defaults to 120. Like `keyFifths`/`time`, this is a single score-wide
	 *  starting value with no per-measure change tracked yet: a future phase
	 *  would add a mid-score tempo change following the same `keyFifthsAt`-style
	 *  walk-back accessor, if that's ever needed. */
	readonly tempoBpm?: number;
}

/**
 * A phrase mark spanning a run of notes: everything from `startNoteId` to
 * `endNoteId`, inclusive, in score order. Unlike a tie, a slur is a pure
 * notation marking with no sounding/duration meaning, so it needs no field on
 * `Note` at all; it only needs its two ends, since layout can always walk
 * `Score.notesInOrder()` between them to find what it spans. That is also why
 * this is not modelled as a per-note flag the way `Note.tiedToId` is: a
 * per-note field only ever names its *own* neighbour, and a slur's two ends
 * are typically many notes apart.
 */
export interface Slur {
	readonly startNoteId: NoteId;
	readonly endNoteId: NoteId;
}

/**
 * An explicit beam grouping notes across exactly two staves (e.g. a piano
 * passage crossing hands): a treble-clef note and a bass-clef note, each
 * already correctly notated in its own staff's own Measure, sharing one
 * visual beam. Unlike ordinary same-staff beaming (`computeBeamGroups` in
 * layout.ts, fully automatic from onset/beat position), this can never be
 * inferred: two different Measure objects in two different Staffs have no
 * shared onset timeline for layout to detect automatically, so a composer
 * or importer has to state the grouping explicitly, the same reason a Slur
 * needs to be stated rather than inferred.
 *
 * `staffIndices` (ascending, e.g. `[0, 1]`) is computed once by
 * `addCrossStaffBeam` and cached here rather than re-derived by every
 * reader, mirroring `BeamGroup.direction` (M2 Slice 4's own refactor, see
 * layout.ts) being decided once rather than recomputed by each consumer.
 */
export interface CrossStaffBeam {
	readonly noteIds: readonly NoteId[];
	readonly staffIndices: readonly [number, number];
}

/**
 * One measure, addressed the way layout and the renderer address it: by its
 * staff and its staff-local index. What the M6 Slice 7 correction ops return
 * (a list of them, deduplicated, in staff then measure order) so a caller can
 * re-lay-out and repaint exactly what an edit touched: usually the edited
 * note's own measure, plus a tie partner's or slur end's measure across a
 * barline.
 */
export interface MeasureRef {
	readonly staffIndex: number;
	readonly measureIndex: number;
}

export class Score {
	/**
	 * Every staff in the score (M2 Slice 3). The constructor always creates
	 * `staves[0]`, so a single-staff score (every score before this slice, and
	 * still the common case) never has to think about this array at all;
	 * `appendStaff` adds more.
	 */
	readonly staves: Staff[];
	/**
	 * Every part in the score, each grouping one or more `staves` indices. The
	 * constructor creates one default part holding just `staves[0]`, mirroring
	 * `staves` itself: a single-staff, single-part score (every score before
	 * this slice) needs no code change to keep that shape. See `Part`'s own
	 * comment for what this does and does not do yet.
	 */
	readonly parts: Part[];
	/** `staves[0]`'s own clef, kept as a convenience accessor so code (and any
	 *  external reader) written against "the score's clef" from before M2
	 *  Slice 3 still resolves to something sensible; a genuinely multi-staff
	 *  score should read `staves[i].clef` directly instead. Either way this
	 *  is only the *initial* clef: since M5 Slice 5 a measure can change it
	 *  mid-staff, so "the clef at measure N" is `clefAt`'s question. */
	get clef(): ClefType {
		return this.staves[0]!.clef;
	}
	/** The key in force before any measure states its own change; equivalent to
	 *  a change "at measure -1". Read this directly only when literally asking
	 *  about the score's starting point; `keyFifthsAt` is what answers "what
	 *  key is measure N actually in", which is what layout and validation need. */
	keyFifths: number;
	/** Same idea as `keyFifths`, for the time signature. See `timeAt`. */
	time: TimeSignature;
	/** Score-wide tempo in quarter-note beats per minute. See `ScoreOptions
	 *  .tempoBpm`: like `keyFifths`/`time` this is a single starting value with
	 *  no mid-score change tracked yet, so playback (`src/playback`) reads this
	 *  field directly rather than through a walk-back accessor. */
	tempoBpm: number;
	/**
	 * `staves[0]`'s own measures, kept as a convenience accessor for the same
	 * reason `clef` is: every score built before M2 Slice 3 (and `buildScore`'s
	 * own compact literal, still single-staff-only) reads/writes this directly,
	 * and it stays the exact degenerate case of `staves[0].measures` for a
	 * single-staff score. A genuinely multi-staff caller reads `staves[i]
	 * .measures` instead.
	 */
	get measures(): Measure[] {
		return this.staves[0]!.measures;
	}
	/** Every slur in the score, in the order `addSlur` was called. Layout reads
	 *  this directly (not through some per-measure index) since a slur's own
	 *  measure range has to be worked out fresh from its two note ids anyway,
	 *  the same reason a tie's crossing-a-barline case reads `Note.tiedToId`
	 *  and `tiedFromNote` rather than a precomputed span.
	 *
	 * A slur's two ends are validated against `notesInOrder(staffIndex)`
	 * (that method's own comment explains the per-staff parameter): both ends
	 * must land on the same staff, and `addSlur` resolves and passes that
	 * staff's index in itself, so a slur can anchor on any single staff, not
	 * just `staves[0]`. A slur straddling *two different* staves is still
	 * rejected (`addSlur` throws), since a slur's curve is drawn within one
	 * staff's own band and there is no single cross-staff "score order" for
	 * two ends on different staves to be checked against in the first place. */
	readonly slurs: Slur[] = [];
	/** Every cross-staff beam in the score (M2 Slice 6), in the order
	 *  `addCrossStaffBeam` was called. See `CrossStaffBeam`'s own comment for
	 *  what this does and does not model. */
	readonly crossStaffBeams: CrossStaffBeam[] = [];
	/**
	 * Every crescendo/diminuendo hairpin (M6 Slice 6; see `Wedge`), in the
	 * order they were added. A score-level list like `slurs`, since a hairpin
	 * spans measures; layout and playback find the ones crossing a measure by
	 * scanning it, which is cheap at the hundreds a real score has. Entries are
	 * immutable: an edit replaces one.
	 */
	readonly wedges: Wedge[] = [];
	/**
	 * The score header the model does not hold (M6 Slice 3): every
	 * `<score-partwise>` child before `<part-list>` (`<work>`,
	 * `<movement-title>`, `<identification>`, `<defaults>`, `<credit>`), in
	 * source order, written back ahead of the part list.
	 */
	headerPassthrough: readonly OpaqueElement[] = NO_PASSTHROUGH;

	// Note id -> owning measure. Maintained on insert so an edit can answer
	// "which measure did I just touch" in O(1) instead of scanning the score.
	// On a 124-measure piece a scan would still be fast, but the index is the
	// honest shape for the incremental-edit architecture this spike is testing.
	readonly #measureOfNote = new Map<NoteId, Measure>();
	// Reverse index for ties: target note id -> the note whose `tiedToId`
	// names it. `Note.tiedToId` alone answers "what does this note tie into";
	// layout also needs the opposite question ("does some earlier note tie
	// into this one") when it lays out the *receiving* end of a tie that
	// crosses a barline, and that end has no field of its own to answer it
	// from. Kept as a separate map rather than a second field on `Note`
	// because at most one note ties into any given note (a target has one
	// source), so it is naturally a map, not a per-note list.
	readonly #tieSourceOfTarget = new Map<NoteId, NoteId>();
	// Note id -> the CrossStaffBeam containing it, mirroring
	// `#tieSourceOfTarget`: layout looks this up once per note it lays out
	// (`crossStaffBeamContaining`), so an index beats scanning
	// `crossStaffBeams` on every note.
	readonly #crossStaffBeamOfNote = new Map<NoteId, CrossStaffBeam>();
	#nextNoteId = 1;

	constructor(options: ScoreOptions = {}) {
		this.keyFifths = options.keyFifths ?? 0;
		this.time = options.time ?? { beats: 4, beatType: 4 };
		this.tempoBpm = options.tempoBpm ?? 120;
		this.staves = [new Staff(0, options.clef ?? 'treble')];
		this.parts = [{ staffIndices: [0] }];
	}

	/** Add a new staff (default clef `'treble'`) and return it. The score's
	 *  constructor always creates `staves[0]`; this is how a score grows a
	 *  second or later staff, e.g. a piano's two staves or an additional SATB
	 *  voice. Does not add the new staff to any `Part`: a caller wanting a
	 *  multi-staff part (a piano's brace, a choir's bracket) still has to add
	 *  or edit a `Part` itself, since a bare `appendStaff` call has no way to
	 *  guess whether the new staff joins an existing part or starts its own. */
	appendStaff(clef: ClefType = 'treble'): Staff {
		const staff = new Staff(this.staves.length, clef);
		this.staves.push(staff);
		return staff;
	}

	/** Add a new `Part` grouping `staffIndices`, returning it. See `Part`'s own
	 *  comment: this only records the grouping, it draws no brace/bracket
	 *  (Slice 5's job). */
	addPart(staffIndices: readonly number[], name?: string, passthrough?: readonly OpaqueElement[]): Part {
		const part: Part = passthrough && passthrough.length > 0 ? { name, staffIndices, passthrough } : { name, staffIndices };
		this.parts.push(part);
		return part;
	}

	/** Append a measure to a staff (`staves[0]` by default, preserving every
	 *  single-staff call site from before M2 Slice 3 unchanged) and return it. */
	appendMeasure(staffIndex = 0): Measure {
		const staff = this.staves[staffIndex];
		if (!staff) throw new Error(`appendMeasure: no staff at index ${staffIndex}`);
		const measure = new Measure(staff.measures.length, staffIndex);
		staff.measures.push(measure);
		return measure;
	}

	/**
	 * The key signature in force at `measureIndex`: that measure's own
	 * `keyFifths` if it set one, otherwise the nearest earlier measure's,
	 * otherwise the score's initial `keyFifths`. Every reader that needs "the
	 * key right now" (layout's key-aware accidental suppression, the courtesy
	 * key signature at a change) calls this rather than walking `measures`
	 * itself, so the walk-back rule lives in exactly one place.
	 *
	 * `staffIndex` (M2 Slice 3, default 0) walks back through *that staff's
	 * own* measures: every score before this slice only ever had staff 0, so
	 * the default reproduces the exact old single-argument behaviour.
	 */
	keyFifthsAt(measureIndex: number, staffIndex = 0): number {
		const measures = this.staves[staffIndex]?.measures ?? [];
		for (let i = measureIndex; i >= 0; i--) {
			const explicit = measures[i]?.keyFifths;
			if (explicit !== undefined) return explicit;
		}
		return this.keyFifths;
	}

	/** Same walk-back as `keyFifthsAt`, for the time signature in force at
	 *  `measureIndex` (of `staffIndex`, default 0). Layout uses this for beat
	 *  grouping and the courtesy time signature at a change; `validateMeasure`
	 *  uses it to check a measure against the capacity that actually applies to
	 *  it, not the score's initial one, once a measure has changed it. */
	timeAt(measureIndex: number, staffIndex = 0): TimeSignature {
		const measures = this.staves[staffIndex]?.measures ?? [];
		for (let i = measureIndex; i >= 0; i--) {
			const explicit = measures[i]?.time;
			if (explicit !== undefined) return explicit;
		}
		return this.time;
	}

	/**
	 * The clef in force at `measureIndex` of `staffIndex` (M5 Slice 5): that
	 * measure's own `clef` if it set one, otherwise the nearest earlier
	 * measure's, otherwise the staff's own initial `Staff.clef`. The same
	 * walk-back `keyFifthsAt`/`timeAt` already do, with the per-staff fallback
	 * in place of a score-wide one, since a clef has always been per staff
	 * (M2 Slice 3). Argument order matches those siblings (measure first,
	 * staff defaulting to 0) rather than the plan's `(staffIndex,
	 * measureIndex)` sketch, so every walk-back accessor reads the same way.
	 */
	clefAt(measureIndex: number, staffIndex = 0): ClefType {
		const staff = this.staves[staffIndex];
		const measures = staff?.measures ?? [];
		for (let i = measureIndex; i >= 0; i--) {
			const measure = measures[i];
			// An earlier measure's mid-measure changes (M6 Slice 4) come after
			// its downbeat clef in time, so its last change wins over its
			// `clef`; this measure's own changes are later than its downbeat
			// and so are not "in force at" it.
			if (measure && i < measureIndex && measure.clefChanges.length > 0) {
				return measure.clefChanges[measure.clefChanges.length - 1]!.clef;
			}
			const explicit = measure?.clef;
			if (explicit !== undefined) return explicit;
		}
		return staff?.clef ?? 'treble';
	}

	/**
	 * The clef in force at `onsetWholes` (wholes from the start) inside
	 * `measureIndex` (M6 Slice 4): the last `Measure.clefChanges` entry at or
	 * before that onset, else the downbeat clef `clefAt` resolves. A change is
	 * in force *at* its own onset, so the note it sits before reads it. Onsets
	 * are compared with a tolerance far below any real duration, for the same
	 * float-summation reason layout buckets its column onsets.
	 */
	clefAtOnset(measureIndex: number, onsetWholes: number, staffIndex = 0): ClefType {
		const changes = this.staves[staffIndex]?.measures[measureIndex]?.clefChanges ?? NO_CLEF_CHANGES;
		for (let i = changes.length - 1; i >= 0; i--) {
			if (changes[i]!.onset <= onsetWholes + 1e-9) return changes[i]!.clef;
		}
		return this.clefAt(measureIndex, staffIndex);
	}

	/** The clef in force at the end of `measureIndex` (M6 Slice 4): its last
	 *  mid-measure change, else its downbeat clef. What the next measure
	 *  inherits when it states no clef of its own. */
	clefAtEnd(measureIndex: number, staffIndex = 0): ClefType {
		return this.clefAtOnset(measureIndex, Number.POSITIVE_INFINITY, staffIndex);
	}

	/**
	 * The barline actually drawn at the boundary after `measureIndex`.
	 *
	 * Unlike `keyFifthsAt`/`timeAt`, a barline never *inherits* forward from an
	 * earlier measure: each boundary is decided fresh from just the two
	 * measures touching it. Two rules apply, in order. First, if the
	 * *following* measure opens with `startBarline: 'repeatStart'`, that wins
	 * regardless of what this measure's own `endBarline` says: a repeat start
	 * is conventionally attached to the measure it opens (see
	 * `Measure.startBarline`'s own comment), and the two fields could
	 * otherwise disagree about who draws a boundary that only ever has one
	 * physical barline. Second, an unset `endBarline` resolves to `'normal'`,
	 * except at the score's true last measure, where it resolves to `'final'`
	 * instead, preserving the behaviour `ctx.isLast` hardcoded before
	 * `BarlineType` existed: every score still ends with a final barline with
	 * no explicit annotation required, but a score that *does* annotate its
	 * last measure (e.g. `endBarline: 'double'`) is honoured over the
	 * automatic default.
	 *
	 * `staffIndex` (M2 Slice 3, default 0) resolves the boundary within *that
	 * staff's own* measures, the same additive default every other staff-aware
	 * method here uses.
	 */
	endBarlineAt(measureIndex: number, staffIndex = 0): BarlineType {
		const measures = this.staves[staffIndex]?.measures ?? [];
		if (measures[measureIndex + 1]?.startBarline === 'repeatStart') return 'repeatStart';
		const explicit = measures[measureIndex]?.endBarline;
		if (explicit !== undefined) return explicit;
		return measureIndex === measures.length - 1 ? 'final' : 'normal';
	}

	/** Append a note (or rest) to a measure, returning it so callers can keep its id. */
	appendNote(measure: Measure, spec: NoteSpec): Note {
		if (spec.chordWithPrevious) {
			// A chord member needs a pitched anchor in its own voice to stand on:
			// `noteEvents` joins it to the most recent earlier event of that
			// voice, and a rest has no notehead column or stem to share.
			const voice = spec.voice ?? 1;
			let anchorCandidate: Note | undefined;
			for (let i = measure.notes.length - 1; i >= 0 && !anchorCandidate; i--) {
				if (measure.notes[i]!.voice === voice) anchorCandidate = measure.notes[i];
			}
			if (!anchorCandidate || anchorCandidate.pitch === null) {
				throw new Error(
					`appendNote: a chord member (chordWithPrevious) needs an earlier pitched note in voice ${voice} of the same measure`
				);
			}
		}
		const note = new Note(`n${this.#nextNoteId++}`, spec);
		measure.notes.push(note);
		this.#measureOfNote.set(note.id, measure);
		if (note.tiedToId !== null) this.#linkTie(note.id, note.tiedToId);
		return note;
	}

	findNote(id: NoteId): Note | undefined {
		return this.measureOfNote(id)?.notes.find((note) => note.id === id);
	}

	measureOfNote(id: NoteId): Measure | undefined {
		return this.#measureOfNote.get(id);
	}

	/**
	 * Every note in the score, flattened in playback order (measure order, then
	 * position within a measure). Layout's slur pass uses this to walk the run
	 * of notes a slur spans, and `addSlur` uses it to check that a slur's start
	 * genuinely comes before its end; a tie never needed this because its
	 * target is always a single note named directly, never "whatever comes
	 * between two others."
	 *
	 * Takes a `staffIndex` (M2 Slice 3, default 0) because multiple staves each
	 * have their own independent note sequence: there is no single flat "score
	 * order" spanning every staff at once (a question M3's own scoping notes
	 * flag again for playback, unanswered for the same reason here), only one
	 * order *per staff*. Defaulting to 0 reproduces this method's original
	 * pre-Slice-3 no-argument behaviour for every existing caller that never
	 * needed anything but `staves[0]`.
	 *
	 * This used to be a real bug, not just a documented scope cut: reading
	 * `this.measures` (`staves[0]` alone) unconditionally meant `addSlur`'s
	 * order check on any staff other than 0 always compared two `-1` indices
	 * from `Array.indexOf` finding nothing, which always satisfied
	 * `startIndex >= endIndex` and made `addSlur` throw "must come before" for
	 * every non-staff-0 slur regardless of the actual notes involved. The
	 * `staffIndex` parameter is the fix: `addSlur` now resolves the slur's
	 * actual staff and passes it through here instead of always reading
	 * staff 0.
	 */
	notesInOrder(staffIndex = 0): readonly Note[] {
		return this.staves[staffIndex]?.measures.flatMap((measure) => measure.notes) ?? [];
	}

	/**
	 * Add a slur (phrase mark) spanning every note from `startNoteId` to
	 * `endNoteId`, inclusive, in score order.
	 *
	 * Unlike `setTie`, there is no pitch-equality constraint: a slur marks a
	 * phrase, not a sounding continuation, so any two notes at any two pitches
	 * qualify. Both ends must already be notes (not rests: a slur has to
	 * anchor its curve to an actual notehead), both ends must live on the
	 * *same* staff (a slur's curve is drawn within one staff's own band; see
	 * `notesInOrder`'s own comment on why there is no single cross-staff
	 * "score order" to check a straddling slur against in the first place),
	 * and `startNoteId` must come before `endNoteId` in that staff's own
	 * `notesInOrder()`, since layout walks forward from one to the other to
	 * find what the slur spans; a backwards or same-note span would have
	 * nothing to walk.
	 */
	addSlur(startNoteId: NoteId, endNoteId: NoteId): Slur {
		const start = this.findNote(startNoteId);
		if (!start) throw new Error(`addSlur: unknown start note id "${startNoteId}"`);
		const end = this.findNote(endNoteId);
		if (!end) throw new Error(`addSlur: unknown end note id "${endNoteId}"`);
		if (start.pitch === null) {
			throw new Error(`addSlur: start note "${startNoteId}" is a rest, which cannot anchor a slur`);
		}
		if (end.pitch === null) {
			throw new Error(`addSlur: end note "${endNoteId}" is a rest, which cannot anchor a slur`);
		}
		// Both notes are already confirmed to exist above (`findNote` returned
		// something for each), so `measureOfNote` is guaranteed to find their
		// owning measures too; the non-null assertions here just say that out
		// loud rather than re-deriving a possibility that has already been
		// ruled out, the same convention `#linkTie` below uses for its own
		// already-validated source note.
		const startStaffIndex = this.measureOfNote(startNoteId)!.staffIndex;
		const endStaffIndex = this.measureOfNote(endNoteId)!.staffIndex;
		if (startStaffIndex !== endStaffIndex) {
			throw new Error(
				`addSlur: start note "${startNoteId}" (staff ${startStaffIndex}) and end note "${endNoteId}" (staff ${endStaffIndex}) must be on the same staff`
			);
		}
		const order = this.notesInOrder(startStaffIndex);
		const startIndex = order.indexOf(start);
		const endIndex = order.indexOf(end);
		if (startIndex >= endIndex) {
			throw new Error(
				`addSlur: start note "${startNoteId}" must come before end note "${endNoteId}" in score order`
			);
		}
		const slur: Slur = { startNoteId, endNoteId };
		this.slurs.push(slur);
		return slur;
	}

	/**
	 * Add a dynamic mark (M6 Slice 6) at `onset` wholes into measure
	 * `measureIndex` of staff `staffIndex`, keeping `Measure.dynamics` sorted.
	 * For a score built in code; import reads marks with their source attached
	 * (`DynamicMark.source`) and sets the list directly. `voice` defaults to
	 * the measure's first voice, the stream export writes the mark in.
	 */
	addDynamic(
		staffIndex: number,
		measureIndex: number,
		spec: { readonly kind: DynamicKind; readonly onset?: number; readonly placement?: Placement; readonly voice?: number }
	): DynamicMark {
		const measure = this.staves[staffIndex]?.measures[measureIndex];
		if (!measure) throw new Error(`addDynamic: no measure ${measureIndex} on staff ${staffIndex}`);
		const onset = spec.onset ?? 0;
		if (onset < 0) throw new Error(`addDynamic: onset ${onset} is before the measure's downbeat`);
		const mark: DynamicMark = {
			kind: spec.kind,
			onset,
			placement: spec.placement ?? null,
			voice: spec.voice ?? measure.notes[0]?.voice ?? 1,
			source: null
		};
		measure.dynamics = sortDynamics([...measure.dynamics, mark]);
		return mark;
	}

	/**
	 * Add a crescendo/diminuendo hairpin (M6 Slice 6) on staff `staffIndex`
	 * from `start` to `stop`, each a measure index plus an onset in wholes
	 * from that measure's downbeat (default 0; a stop "at the barline" is the
	 * measure's own length). Throws for a missing staff or measure, or a stop
	 * before its start. For a score built in code, like `addDynamic`.
	 */
	addWedge(spec: {
		readonly kind: WedgeKind;
		readonly staffIndex?: number;
		readonly placement?: Placement;
		readonly start: { readonly measureIndex: number; readonly onset?: number };
		readonly stop: { readonly measureIndex: number; readonly onset?: number };
	}): Wedge {
		const staffIndex = spec.staffIndex ?? 0;
		const staff = this.staves[staffIndex];
		if (!staff) throw new Error(`addWedge: no staff at index ${staffIndex}`);
		const end = (position: { readonly measureIndex: number; readonly onset?: number }, which: string) => {
			const measure = staff.measures[position.measureIndex];
			if (!measure) throw new Error(`addWedge: ${which} measure ${position.measureIndex} is not on staff ${staffIndex}`);
			return {
				measureIndex: position.measureIndex,
				onset: position.onset ?? 0,
				voice: measure.notes[0]?.voice ?? 1,
				source: null
			};
		};
		const start = end(spec.start, 'start');
		const stop = end(spec.stop, 'stop');
		if (positionBefore(stop, start)) throw new Error('addWedge: the stop comes before the start');
		const wedge: Wedge = { kind: spec.kind, staffIndex, placement: spec.placement ?? null, start, stop };
		this.wedges.push(wedge);
		return wedge;
	}

	/**
	 * Add an explicit cross-staff beam (M2 Slice 6) linking `noteIds`, each
	 * already a note in its own staff's own Measure. See `CrossStaffBeam`'s own
	 * comment for what this does and does not model.
	 *
	 * Validated tightly since nothing later can sensibly render a malformed
	 * group: every id must be a real, pitched note (a rest has no stem to
	 * extend across the gap) whose own duration is beam-eligible (eighth note
	 * or shorter, the same threshold `layout.ts`'s FLAG_GLYPHS keys on, checked
	 * here via NOTE_VALUE_WHOLES so this file does not need to import anything
	 * from layout.ts to know it); every note must land in the exact same
	 * measure column (the same Measure.index) across staves, since this slice
	 * does not attempt to coordinate x-position across a measure *and* a staff
	 * boundary at once (documented scope cut, see layout.ts); the notes'
	 * owning measures must span exactly two distinct, adjacent staffIndices
	 * (this slice only ever splits one shared gap, the same scope barlineSpan
	 * itself already narrowed to "spanning the full staff-group height" rather
	 * than an arbitrary non-adjacent pair); and each staff side needs at least
	 * two of its own notes, since layoutBeamGroup's ordinary machinery draws a
	 * real beam segment only for two or more members. A cross-staff beam with
	 * only one note on one side would need real engraving's "beamlet stub
	 * toward the gap" convention for that side, which this slice does not
	 * build (documented scope cut).
	 */
	addCrossStaffBeam(noteIds: readonly NoteId[]): CrossStaffBeam {
		if (noteIds.length < 2) {
			throw new Error('addCrossStaffBeam: needs at least 2 note ids');
		}
		const notes = noteIds.map((id) => {
			const note = this.findNote(id);
			if (!note) throw new Error(`addCrossStaffBeam: unknown note id "${id}"`);
			return note;
		});
		for (const note of notes) {
			if (note.pitch === null) {
				throw new Error(`addCrossStaffBeam: note "${note.id}" is a rest, which cannot join a beam`);
			}
			if (NOTE_VALUE_WHOLES[note.value] > NOTE_VALUE_WHOLES.eighth) {
				throw new Error(
					`addCrossStaffBeam: note "${note.id}" has value "${note.value}", too long to beam (needs eighth or shorter)`
				);
			}
		}
		const owningMeasures = notes.map((note) => this.measureOfNote(note.id)!);
		const firstIndex = owningMeasures[0]!.index;
		if (owningMeasures.some((measure) => measure.index !== firstIndex)) {
			throw new Error('addCrossStaffBeam: every note must land in the same measure column across staves');
		}
		const distinctStaffIndices = [...new Set(owningMeasures.map((measure) => measure.staffIndex))];
		if (distinctStaffIndices.length !== 2) {
			throw new Error(
				`addCrossStaffBeam: notes must span exactly two distinct staves, found ${distinctStaffIndices.length}`
			);
		}
		const [a, b] = distinctStaffIndices.sort((x, y) => x - y) as [number, number];
		if (b - a !== 1) {
			throw new Error(`addCrossStaffBeam: the two staves must be adjacent, got ${a} and ${b}`);
		}
		const countByStaff = new Map<number, number>();
		for (const measure of owningMeasures) {
			countByStaff.set(measure.staffIndex, (countByStaff.get(measure.staffIndex) ?? 0) + 1);
		}
		for (const staffIndex of [a, b]) {
			if ((countByStaff.get(staffIndex) ?? 0) < 2) {
				throw new Error(`addCrossStaffBeam: staff ${staffIndex} needs at least 2 notes of its own in the beam`);
			}
		}
		const beam: CrossStaffBeam = { noteIds: [...noteIds], staffIndices: [a, b] };
		this.crossStaffBeams.push(beam);
		for (const id of noteIds) this.#crossStaffBeamOfNote.set(id, beam);
		return beam;
	}

	/** The CrossStaffBeam containing `id`, if any. Layout uses this once per
	 *  note it lays out, exactly like `tiedFromNote`. */
	crossStaffBeamContaining(id: NoteId): CrossStaffBeam | undefined {
		return this.#crossStaffBeamOfNote.get(id);
	}

	/**
	 * Wire, change or clear a tie starting at `sourceId`.
	 *
	 * `targetId: null` unties `sourceId` from whatever it pointed at. A
	 * non-null target must already be a note in this score (both notes must
	 * exist for the pitch check below to run), which is exactly the
	 * chicken-and-egg problem `buildScore`'s `extra.tiedToNext` sugar exists to
	 * route around: a literal that reads top-to-bottom names a tie's source
	 * before its target is ever built, so `buildScore` calls this only in a
	 * second pass, once every note has an id.
	 */
	setTie(sourceId: NoteId, targetId: NoteId | null): void {
		const source = this.findNote(sourceId);
		if (!source) throw new Error(`setTie: unknown note id "${sourceId}"`);
		if (source.tiedToId !== null) this.#tieSourceOfTarget.delete(source.tiedToId);
		if (targetId !== null) this.#linkTie(sourceId, targetId);
		source.tiedToId = targetId;
	}

	/**
	 * The note (if any) whose tie lands on `id`, i.e. `id`'s note is the
	 * *receiving* end of a tie started elsewhere. Layout uses this to draw the
	 * incoming half of a tie crossing into a measure from an earlier one,
	 * without scanning every note in the score to find who ties into it.
	 */
	tiedFromNote(id: NoteId): Note | undefined {
		const sourceId = this.#tieSourceOfTarget.get(id);
		return sourceId ? this.findNote(sourceId) : undefined;
	}

	/**
	 * Validate a tie and record it in the reverse index. Shared by
	 * `appendNote` (a spec that already names its target's id) and `setTie`
	 * (an existing note gaining or changing a tie later); both end up with the
	 * same invariant enforced regardless of which path set `tiedToId`.
	 */
	#linkTie(sourceId: NoteId, targetId: NoteId): void {
		const source = this.findNote(sourceId)!;
		const target = this.findNote(targetId);
		if (!target) throw new Error(`tie target "${targetId}" is not a note in this score`);
		if (source.pitch === null || target.pitch === null || !pitchesEqual(source.pitch, target.pitch)) {
			throw new Error(
				`a tie must connect two notes of the same pitch (source "${sourceId}", target "${targetId}")`
			);
		}
		this.#tieSourceOfTarget.set(targetId, sourceId);
	}

	/**
	 * The one edit op Phase 0 implements: move a note by whole semitones.
	 *
	 * Returns the index of the measure that changed (within *its own staff*;
	 * see `Measure.index`'s own comment), or `null` if nothing did (unknown id,
	 * the note is a rest, or `semitones` is 0). That return value is the contract the
	 * incremental redraw hangs off: the caller re-lays-out and repaints exactly
	 * the measures an edit reports, and no others.
	 *
	 * Scope cut (M2 Slice 3): still returns a bare measure index, not a
	 * `{staffIndex, measureIndex}` pair, even though `relayoutMeasure`/
	 * `CanvasRenderer.redrawMeasure` now both need the pair to fully address a
	 * measure. Every existing caller only ever edits staff 0, where the bare
	 * index is already the whole answer; a caller editing a non-zero staff can
	 * recover its `staffIndex` from `measureOfNote(id)?.staffIndex` (new this
	 * slice) before calling `transposeNote`, so widening this return type is
	 * not needed to make multi-staff edits addressable, only to make them
	 * marginally more convenient. Left as its own follow-up rather than done
	 * here, since it would touch every existing call site for no behaviour
	 * change on the staff-0 case they all still are.
	 */
	transposeNote(id: NoteId, semitones: number): number | null {
		const measure = this.#measureOfNote.get(id);
		const note = measure?.notes.find((candidate) => candidate.id === id);
		if (!measure || !note || note.pitch === null || semitones === 0) return null;
		note.pitch = transpose(note.pitch, semitones);
		return measure.index;
	}

	/**
	 * Change the clef of measures `from..to` (inclusive, either order) of
	 * `staffIndex` to `clef` (M5 Slice 5, the second real edit op after
	 * `transposeNote`).
	 *
	 * The range is made uniform: `from` gets an explicit `clef`, and any
	 * explicit clef already set inside `from + 1..to` is cleared, so the whole
	 * range reads `clef` through `clefAt`'s walk-back. The clef that was in
	 * force at `to + 1` *before* the edit is captured first and, if that
	 * measure exists, pinned there explicitly, so the change is scoped to the
	 * range rather than leaking forward through the walk-back into every later
	 * measure. A range running to the staff's end has no `to + 1` and simply
	 * keeps the new clef to the end.
	 *
	 * Returns the `{ from, to }` measure range (normalized) that was changed,
	 * or `null` if nothing did: an unknown staff, an out-of-range index, or a
	 * range already entirely in `clef`. The `null` is what lets
	 * `EditHistory.record` skip recording a no-op, the same signal
	 * `transposeNote` gives. Unlike `transposeNote`, a caller cannot repaint
	 * just the returned measures: a clef change moves every notehead in the
	 * range and changes widths (a courtesy clef glyph at the change), so the
	 * caller should re-run a full `layoutScore`.
	 *
	 * Mid-measure clef changes (M6 Slice 4) inside the range are cleared too
	 * (the range is made uniform), so a range holding one is never a no-op.
	 * The restore at `to + 1` reads `clefAt`, which already accounts for a
	 * change the range's last measure ended in, so the music after the range
	 * keeps the clef it had.
	 */
	setClefRange(staffIndex: number, from: number, to: number, clef: ClefType): { from: number; to: number } | null {
		const measures = this.staves[staffIndex]?.measures;
		if (!measures) return null;
		const lo = Math.min(from, to);
		const hi = Math.max(from, to);
		if (lo < 0 || hi >= measures.length) return null;

		let unchanged = true;
		for (let i = lo; i <= hi; i++) {
			if (this.clefAt(i, staffIndex) !== clef || measures[i]!.clefChanges.length > 0) {
				unchanged = false;
				break;
			}
		}
		if (unchanged) return null;

		const following = measures[hi + 1];
		const prior = following ? this.clefAt(hi + 1, staffIndex) : undefined;
		measures[lo]!.clef = clef;
		for (let i = lo + 1; i <= hi; i++) delete measures[i]!.clef;
		for (let i = lo; i <= hi; i++) measures[i]!.clefChanges = NO_CLEF_CHANGES;
		if (following && prior !== undefined) following.clef = prior;
		return { from: lo, to: hi };
	}

	// --- Correction ops (M6 Slice 7) -----------------------------------------
	//
	// The ops an admin needs to fix rough OMR output by hand, reaching parity
	// with Divisi's old OSMD editor (E2: transpose, delete-to-rest, planned
	// duration edits) plus what the SFCC board's "British rests all over page
	// 1" complaint asks for (rests misread from old-style glyphs have to be
	// cheap to turn back into notes, and wrong values cheap to fix).
	//
	// Shared contract, the same one `transposeNote`/`setClefRange` set:
	//
	//  - Each op validates its input and returns `null` when it refuses or
	//    when nothing would change. Refusal and no-op are deliberately the same
	//    signal: `EditHistory.record` keeps a snapshot only for a non-null
	//    result, so a refused edit leaves the undo stack and the dirty flag
	//    alone. The caller (the demo) records the pre-edit snapshot by running
	//    the op inside `history.record`, exactly as it does for a transpose.
	//  - Otherwise each returns the measures it touched (`MeasureRef`s,
	//    deduplicated, sorted), so the caller can `relayoutMeasure` and
	//    repaint just those, falling back to a full `layoutScore` when one of
	//    them declines (a width change, a moved dynamics baseline). A tie
	//    partner's or slur end's measure across a barline is included, since
	//    its curve is drawn in that measure's own ops too.
	//  - Nothing outside the edited voice of the edited measure moves in time:
	//    every op keeps the voice's total duration (padding with rests, or
	//    consuming them), so the next measure never shifts and positional
	//    anchors (dynamics, hairpins, `Measure.passthrough` at an onset) keep
	//    meaning the same moment.
	//  - A note keeps its id through every op that keeps the note (a
	//    selection survives), and the private indexes (`#measureOfNote`,
	//    `#tieSourceOfTarget`, `#crossStaffBeamOfNote`) are kept in step with
	//    every removal, so `findNote`, `tiedFromNote` and layout stay correct
	//    without a rebuild.

	/**
	 * Turn a note into a rest of the same written duration (E2's "delete":
	 * nothing after it shifts). Returns `null` for an unknown id or a rest.
	 *
	 * On a chord head with other heads beside it this removes that head from
	 * the chord instead (`removeChordMember`'s rules): deleting one misread
	 * head of a divisi third should leave the other note, not silence the
	 * whole chord.
	 *
	 * What goes with the pitch: any tie into or out of the note (the partner's
	 * `tiedToId` too), its articulations (a staccato rest means nothing), and
	 * its own passthrough payload (M6 Slice 3's promise: deleting a note drops
	 * exactly its own payload, including any unmatched `<tie>`/`<tied>`/
	 * `<slur>` ends and lyrics). A fermata stays: a fermata over a rest is
	 * ordinary notation, and dropping it would lose a real hold. A slur that
	 * starts or ends on the note moves to the nearest pitched event inside the
	 * slur (same voice preferred), so a phrase mark survives deleting a stray
	 * note at its end; a slur with nothing left inside to land on is dropped.
	 * A cross-staff beam loses the note (a rest has no stem), and is dropped
	 * when a side is left with fewer than two notes.
	 */
	noteToRest(id: NoteId): readonly MeasureRef[] | null {
		const found = this.#locate(id);
		if (!found || found.note.pitch === null) return null;
		const { measure, note } = found;
		const event = this.#eventOf(measure, note);
		if (event.length > 1) return this.#removeHead(measure, event, note);
		const touched = new TouchedMeasures();
		touched.addMeasure(measure);
		this.#untie(note, touched);
		note.pitch = null;
		note.articulations = NO_ARTICULATIONS;
		note.passthrough = NO_PASSTHROUGH;
		this.#reanchorSlurs(id, measure, null, touched);
		this.#detachFromCrossStaffBeam(id, measure, null, touched);
		return touched.list();
	}

	/**
	 * Turn a rest into a note at `pitch`, keeping its duration (the inverse of
	 * `noteToRest`, and the fix for an OMR "rest" that was really a note).
	 * Returns `null` for an unknown id or a pitched note.
	 *
	 * A whole-measure rest (`Note.isMeasureRest`) becomes a note lasting the
	 * whole measure, which needs a single note value (plus dots) of exactly
	 * the measure's length: 4/4 and 2/2 give a whole note, 3/4 and 6/8 a dotted
	 * half, 7/8 a double-dotted half. A measure no single note value fills
	 * (5/4, 5/8, ...) is refused (`null`): writing tied notes is the user's
	 * call, not something to guess. The rest's fermata and articulations stay
	 * on the note; its passthrough payload (typically a `<rest>`'s
	 * display-step/octave, meaningless on a note) is dropped, as `noteToRest`
	 * drops the note's.
	 */
	restToNote(id: NoteId, pitch: Pitch): readonly MeasureRef[] | null {
		const found = this.#locate(id);
		if (!found || found.note.pitch !== null) return null;
		const { measure, note } = found;
		if (note.measureRestWholes !== null) {
			const spelled = noteValueForWholes(note.measureRestWholes);
			if (!spelled) return null;
			this.#replaceNote(
				measure,
				note,
				new Note(note.id, {
					...specOf(note),
					pitch: { ...pitch },
					value: spelled.value,
					dots: spelled.dots,
					measureRestWholes: null,
					passthrough: NO_PASSTHROUGH
				})
			);
		} else {
			note.pitch = { ...pitch };
			note.passthrough = NO_PASSTHROUGH;
		}
		return [{ staffIndex: measure.staffIndex, measureIndex: measure.index }];
	}

	/**
	 * Change the written value (and dots) of a note's whole event: a single
	 * note or rest, or every head of a chord (a chord has one duration).
	 * Returns `null` when refused or when the value is unchanged.
	 *
	 * Measure capacity is never broken and the next measure never shifts:
	 *
	 *  - Shorter: the freed time is padded with rests right after the event
	 *    (`restValuesFor`: undotted values, each aligned to its own length),
	 *    so everything later in the voice keeps its onset.
	 *  - Longer: the extra time is taken from the rests that directly follow
	 *    in the same voice, consuming whole rests and re-spelling any
	 *    leftover as rests (OMR often reads one note's worth of time as a
	 *    note plus a spurious rest, so this is the friendly answer rather than
	 *    a flat refusal). If every following event is a rest and they still do
	 *    not cover it, an under-full voice's own slack before the barline may
	 *    make up the difference. A pitched note in the way, or a total that
	 *    would pass the time signature's capacity, refuses the edit: pushing
	 *    the following notes later is a re-barring decision this op will not
	 *    make silently. Consumed rests go with their fermatas and payloads.
	 *  - Tuplets are refused for now (the event's anchor has a `tuplet`, or a
	 *    rest it would consume does): changing one member's value breaks the
	 *    run's ratio arithmetic, and an editor for tuplets is its own job.
	 *    Since no tupleted note is ever changed, the passthrough `<tuplet>`
	 *    brackets Slice 3 keeps for a run stay valid; any stray `<tuplet>` on
	 *    a changed (non-tuplet) head is stripped so export cannot write a
	 *    bracket for a run that no longer exists.
	 *
	 * A whole-measure rest is a valid target: it becomes an ordinary rest of
	 * `value` plus padding (how a misread measure rest is cut down to a beat).
	 * Ties into and out of the event stay (the pitch is unchanged, so they are
	 * still valid). A head that becomes longer than an eighth leaves any
	 * cross-staff beam (it has no beam to join). Chord members' own
	 * `value`/`dots` follow the anchor, since they choose the head glyph.
	 */
	setDuration(id: NoteId, value: NoteValue, dots: 0 | 1 | 2 = 0): readonly MeasureRef[] | null {
		const found = this.#locate(id);
		if (!found) return null;
		const { measure, note } = found;
		const events = this.#voiceEvents(measure, note.voice);
		const k = events.findIndex((event) => event.includes(note));
		const event = events[k]!;
		const anchor = event[0]!;
		if (anchor.tuplet !== null) return null;
		if (!anchor.isMeasureRest && anchor.value === value && anchor.dots === dots) return null;

		const EPS = 1e-9;
		const oldWholes = anchor.durationWholes;
		const newWholes = spelledWholes(value, dots);
		let onset = 0;
		for (let i = 0; i < k; i++) onset += events[i]![0]!.durationWholes;

		const consumed: Note[] = [];
		let padWholes: number;
		if (newWholes > oldWholes + EPS) {
			const extra = newWholes - oldWholes;
			let covered = 0;
			for (let j = k + 1; j < events.length && covered < extra - EPS; j++) {
				const next = events[j]![0]!;
				if (next.pitch !== null || next.tuplet !== null) return null;
				consumed.push(next);
				covered += next.durationWholes;
			}
			if (covered < extra - EPS) {
				// Every following event was a rest and all are consumed, so what
				// is left must fit in the voice's slack before the barline.
				const voiceWholes = events.reduce((sum, e) => sum + e[0]!.durationWholes, 0);
				const capacity = measureCapacityWholes(this.timeAt(measure.index, measure.staffIndex));
				if (voiceWholes - covered + extra > capacity + EPS) return null;
			}
			padWholes = Math.max(0, covered - extra);
		} else {
			padWholes = oldWholes - newWholes;
		}
		const padValues = restValuesFor(onset + newWholes, padWholes);
		if (padValues === null) return null;

		const touched = new TouchedMeasures();
		touched.addMeasure(measure);
		for (const rest of consumed) {
			measure.notes.splice(measure.notes.indexOf(rest), 1);
			this.#measureOfNote.delete(rest.id);
		}
		let last: Note;
		if (anchor.isMeasureRest) {
			last = new Note(anchor.id, { ...specOf(anchor), value, dots, measureRestWholes: null });
			this.#replaceNote(measure, anchor, last);
		} else {
			for (const head of event) {
				head.value = value;
				head.dots = dots;
				head.passthrough = withoutNoteMarkup(head.passthrough, (el, inNotations) => inNotations && el.name === 'tuplet');
			}
			last = event.reduce((a, b) => (measure.notes.indexOf(b) > measure.notes.indexOf(a) ? b : a));
			if (NOTE_VALUE_WHOLES[value] > NOTE_VALUE_WHOLES.eighth) {
				for (const head of event) this.#detachFromCrossStaffBeam(head.id, measure, null, touched);
			}
		}
		let at = measure.notes.indexOf(last) + 1;
		for (const restValue of padValues) {
			const rest = new Note(`n${this.#nextNoteId++}`, { pitch: null, value: restValue, voice: anchor.voice });
			measure.notes.splice(at++, 0, rest);
			this.#measureOfNote.set(rest.id, measure);
		}
		return touched.list();
	}

	/**
	 * Add a head at `pitch` to the event `id` belongs to: a chord member
	 * (`chordWithPrevious`) with the anchor's value, dots, tuplet and voice,
	 * placed after the event's last head so `noteEvents` joins it there.
	 * Returns `null` for an unknown id, a rest (a rest has no stem to share),
	 * or a pitch the event already has (a unison head is not a correction
	 * anyone needs, and layout draws one over the other). Use `findNote` on
	 * the event afterwards to reach the new head; its id is fresh.
	 */
	addChordMember(id: NoteId, pitch: Pitch): readonly MeasureRef[] | null {
		const found = this.#locate(id);
		if (!found || found.note.pitch === null) return null;
		const { measure, note } = found;
		const event = this.#eventOf(measure, note);
		if (event.some((head) => head.pitch !== null && pitchesEqual(head.pitch, pitch))) return null;
		const anchor = event[0]!;
		const last = event.reduce((a, b) => (measure.notes.indexOf(b) > measure.notes.indexOf(a) ? b : a));
		const head = new Note(`n${this.#nextNoteId++}`, {
			pitch: { ...pitch },
			value: anchor.value,
			dots: anchor.dots,
			tuplet: anchor.tuplet ?? undefined,
			voice: anchor.voice,
			chordWithPrevious: true
		});
		measure.notes.splice(measure.notes.indexOf(last) + 1, 0, head);
		this.#measureOfNote.set(head.id, measure);
		return [{ staffIndex: measure.staffIndex, measureIndex: measure.index }];
	}

	/**
	 * Remove one head from a chord. Returns `null` for an unknown id, a rest,
	 * or a note that is its event's only head (that is `noteToRest`'s job:
	 * removing the last head would leave no event at all and shift the
	 * voice).
	 *
	 * Removing the anchor (the first head, the one without
	 * `chordWithPrevious`) promotes the next head to anchor, in the removed
	 * anchor's place in `measure.notes`: the rough edge E2's spike hit, where
	 * the remaining heads were left as members joined to nothing. The promoted
	 * head keeps its id, pitch, ties and payload, and takes the chord's
	 * value/dots/tuplet and any passthrough `<tuplet>` bracket the old anchor
	 * carried (export writes a run's brackets on its anchors). The removed
	 * head's articulations and fermata move to the remaining anchor (they
	 * belong to the chord, whichever head they were written on), its ties are
	 * cleared at both ends, its own payload is dropped, and a slur or
	 * cross-staff beam anchored on it moves to the remaining anchor.
	 */
	removeChordMember(id: NoteId): readonly MeasureRef[] | null {
		const found = this.#locate(id);
		if (!found || found.note.pitch === null) return null;
		const event = this.#eventOf(found.measure, found.note);
		if (event.length < 2) return null;
		return this.#removeHead(found.measure, event, found.note);
	}

	/**
	 * Tie `sourceId` to `targetId`, or untie it (`targetId: null`), as an
	 * undoable correction (so a tie lost at a page join can be re-added).
	 * Stricter than the low-level `setTie`, which import and `buildScore` use
	 * to wire ties they already resolved: the target must be a head of the
	 * *next event in the source's voice* (later in the same measure, or the
	 * voice's first event in the next measure of the staff) with the same
	 * pitch, and no other note may already tie into it. `tieTargetFor` finds
	 * that head. Returns `null` when refused or when nothing changes.
	 *
	 * Passthrough tie markup is kept consistent with the model: the model's
	 * tie is what export writes, so a stray unmatched `<tie>`/`<tied>` start
	 * on the source and stop on the target (OMR's half of a tie whose partner
	 * was on the other page) are stripped when linking, or export would write
	 * each end twice. Untying strips the source's stray start too, so "untie"
	 * also removes a dangling OMR tie start the model never linked (and is
	 * not a no-op when that is all there is).
	 */
	editTie(sourceId: NoteId, targetId: NoteId | null): readonly MeasureRef[] | null {
		const found = this.#locate(sourceId);
		if (!found || found.note.pitch === null) return null;
		const { measure, note: source } = found;
		const touched = new TouchedMeasures();
		touched.addMeasure(measure);
		const sourcePayload = withoutTieMarkup(source.passthrough, 'start');
		if (targetId === null) {
			if (source.tiedToId === null && sourcePayload === source.passthrough) return null;
			if (source.tiedToId !== null) {
				const oldTarget = this.#measureOfNote.get(source.tiedToId);
				if (oldTarget) touched.addMeasure(oldTarget);
				this.setTie(sourceId, null);
			}
			source.passthrough = sourcePayload;
			return touched.list();
		}
		const target = this.#nextEventInVoice(measure, source)?.find((head) => head.id === targetId);
		if (!target || target.pitch === null || source.pitch === null || !pitchesEqual(target.pitch, source.pitch)) return null;
		const existing = this.tiedFromNote(targetId);
		if (existing && existing !== source) return null;
		const targetPayload = withoutTieMarkup(target.passthrough, 'stop');
		if (source.tiedToId === targetId && sourcePayload === source.passthrough && targetPayload === target.passthrough) {
			return null;
		}
		if (source.tiedToId !== null && source.tiedToId !== targetId) {
			const oldTarget = this.#measureOfNote.get(source.tiedToId);
			if (oldTarget) touched.addMeasure(oldTarget);
		}
		this.setTie(sourceId, targetId);
		source.passthrough = sourcePayload;
		target.passthrough = targetPayload;
		touched.addMeasure(this.#measureOfNote.get(targetId)!);
		return touched.list();
	}

	/**
	 * The head `editTie(sourceId, ...)` would accept as a target: the head of
	 * the same pitch in the next event of the source's voice (see `editTie`),
	 * or `null` if there is none (a rest, a different pitch, no next event).
	 */
	tieTargetFor(sourceId: NoteId): NoteId | null {
		const found = this.#locate(sourceId);
		const pitch = found?.note.pitch;
		if (!found || !pitch) return null;
		const next = this.#nextEventInVoice(found.measure, found.note);
		return next?.find((head) => head.pitch !== null && pitchesEqual(head.pitch, pitch))?.id ?? null;
	}

	#locate(id: NoteId): { measure: Measure; note: Note } | undefined {
		const measure = this.#measureOfNote.get(id);
		const note = measure?.notes.find((candidate) => candidate.id === id);
		return measure && note ? { measure, note } : undefined;
	}

	/** One voice's events in `measure`, in time order. */
	#voiceEvents(measure: Measure, voice: number): Note[][] {
		return noteEvents(measure.notes).filter((event) => event[0]!.voice === voice);
	}

	/** The event (`noteEvents`) holding `note`. */
	#eventOf(measure: Measure, note: Note): Note[] {
		return noteEvents(measure.notes).find((event) => event.includes(note))!;
	}

	/** The event after `note`'s in its voice: later in `measure`, else the
	 *  voice's first event in the staff's next measure. */
	#nextEventInVoice(measure: Measure, note: Note): Note[] | undefined {
		const events = this.#voiceEvents(measure, note.voice);
		const k = events.findIndex((event) => event.includes(note));
		if (k + 1 < events.length) return events[k + 1];
		const next = this.staves[measure.staffIndex]!.measures[measure.index + 1];
		return next ? this.#voiceEvents(next, note.voice)[0] : undefined;
	}

	/** Swap `replacement` (same id) in for `note` at its place in
	 *  `measure.notes`, for the fields `Note` keeps readonly
	 *  (`chordWithPrevious`, `measureRestWholes`). The id indexes need no
	 *  update, since they key by id; the tie is carried over directly. */
	#replaceNote(measure: Measure, note: Note, replacement: Note): void {
		replacement.tiedToId = note.tiedToId;
		measure.notes[measure.notes.indexOf(note)] = replacement;
	}

	/** Clear every tie into and out of `note`, at both ends. */
	#untie(note: Note, touched: TouchedMeasures): void {
		if (note.tiedToId !== null) {
			const target = this.#measureOfNote.get(note.tiedToId);
			if (target) touched.addMeasure(target);
			this.#tieSourceOfTarget.delete(note.tiedToId);
			note.tiedToId = null;
		}
		const source = this.tiedFromNote(note.id);
		if (source) {
			touched.addMeasure(this.#measureOfNote.get(source.id)!);
			this.#tieSourceOfTarget.delete(note.id);
			source.tiedToId = null;
		}
	}

	/** `noteToRest`/`removeChordMember` on a head of a chord with others. */
	#removeHead(measure: Measure, event: readonly Note[], note: Note): readonly MeasureRef[] {
		const touched = new TouchedMeasures();
		touched.addMeasure(measure);
		this.#untie(note, touched);
		let anchor: Note;
		if (note === event[0]) {
			const successor = event[1]!;
			// The old anchor's tuplet brackets (if the source wrote any) mark
			// where its run starts or stops; they move with the anchor role.
			const brackets = note.passthrough.flatMap((el) =>
				el.name === 'notations' ? el.children.filter((c) => c.name === 'tuplet') : []
			);
			const passthrough =
				brackets.length === 0
					? successor.passthrough
					: Object.freeze([
							...successor.passthrough,
							Object.freeze({ name: 'notations', attrs: Object.freeze({}), children: Object.freeze(brackets), text: '' })
						]);
			anchor = new Note(successor.id, {
				...specOf(successor),
				value: note.value,
				dots: note.dots,
				tuplet: note.tuplet ?? undefined,
				chordWithPrevious: false,
				articulations: [...successor.articulations, ...note.articulations],
				fermata: successor.fermata ?? note.fermata,
				passthrough
			});
			anchor.tiedToId = successor.tiedToId;
			measure.notes.splice(measure.notes.indexOf(successor), 1);
			measure.notes[measure.notes.indexOf(note)] = anchor;
		} else {
			anchor = event[0]!;
			anchor.articulations = normalizeArticulations([...anchor.articulations, ...note.articulations]);
			if (anchor.fermata === null) anchor.fermata = note.fermata;
			measure.notes.splice(measure.notes.indexOf(note), 1);
		}
		this.#measureOfNote.delete(note.id);
		this.#reanchorSlurs(note.id, measure, anchor.id, touched);
		this.#detachFromCrossStaffBeam(note.id, measure, anchor.id, touched);
		return touched.list();
	}

	/**
	 * Move every slur end on `removedId` (in `removedMeasure`) to
	 * `replacementId`, or, when that is `null`, to the nearest pitched event
	 * inside the slur (its first for a start, its last for an end; same voice
	 * as the removed note preferred). A slur left with no distinct, correctly
	 * ordered pair of ends is dropped. Every measure the slur spanned is
	 * touched, since its curve is redrawn in each.
	 */
	#reanchorSlurs(removedId: NoteId, removedMeasure: Measure, replacementId: NoteId | null, touched: TouchedMeasures): void {
		const staffIndex = removedMeasure.staffIndex;
		for (let i = this.slurs.length - 1; i >= 0; i--) {
			const slur = this.slurs[i]!;
			const isStart = slur.startNoteId === removedId;
			if (!isStart && slur.endNoteId !== removedId) continue;
			const otherId = isStart ? slur.endNoteId : slur.startNoteId;
			const other = this.#measureOfNote.get(otherId);
			const lo = Math.min(removedMeasure.index, other?.index ?? removedMeasure.index);
			const hi = Math.max(removedMeasure.index, other?.index ?? removedMeasure.index);
			for (let m = lo; m <= hi; m++) touched.add(staffIndex, m);

			const order = this.notesInOrder(staffIndex);
			const indexOf = (id: NoteId) => order.findIndex((n) => n.id === id);
			let replacement = replacementId;
			if (replacement === null) {
				const removedNote = order.find((n) => n.id === removedId);
				const inner = order
					.slice(indexOf(slur.startNoteId) + 1, indexOf(slur.endNoteId))
					.filter((n) => n.pitch !== null && !n.chordWithPrevious);
				const sameVoice = inner.filter((n) => n.voice === removedNote?.voice);
				const pool = sameVoice.length > 0 ? sameVoice : inner;
				replacement = (isStart ? pool[0] : pool[pool.length - 1])?.id ?? null;
			}
			const next: Slur | null =
				replacement === null
					? null
					: isStart
						? { startNoteId: replacement, endNoteId: slur.endNoteId }
						: { startNoteId: slur.startNoteId, endNoteId: replacement };
			if (next === null || indexOf(next.startNoteId) < 0 || indexOf(next.startNoteId) >= indexOf(next.endNoteId)) {
				this.slurs.splice(i, 1);
			} else {
				this.slurs[i] = next;
			}
		}
	}

	/**
	 * Take `id` out of its cross-staff beam (if any), putting `replacementId`
	 * in its place when given and not already a member. A beam left with
	 * fewer than two notes on a staff (`addCrossStaffBeam`'s own rule) is
	 * dropped. Every measure the beam spans is touched.
	 */
	#detachFromCrossStaffBeam(
		id: NoteId,
		removedMeasure: Measure,
		replacementId: NoteId | null,
		touched: TouchedMeasures
	): void {
		const beam = this.#crossStaffBeamOfNote.get(id);
		if (!beam) return;
		this.#crossStaffBeamOfNote.delete(id);
		for (const staffIndex of beam.staffIndices) touched.add(staffIndex, removedMeasure.index);
		const noteIds =
			replacementId !== null && !beam.noteIds.includes(replacementId)
				? beam.noteIds.map((x) => (x === id ? replacementId : x))
				: beam.noteIds.filter((x) => x !== id);
		const perStaff = new Map<number, number>();
		for (const x of noteIds) {
			const s = this.#measureOfNote.get(x)?.staffIndex;
			if (s !== undefined) perStaff.set(s, (perStaff.get(s) ?? 0) + 1);
		}
		const at = this.crossStaffBeams.indexOf(beam);
		if (beam.staffIndices.every((s) => (perStaff.get(s) ?? 0) >= 2)) {
			const kept: CrossStaffBeam = { noteIds, staffIndices: beam.staffIndices };
			this.crossStaffBeams[at] = kept;
			for (const x of noteIds) this.#crossStaffBeamOfNote.set(x, kept);
		} else {
			this.crossStaffBeams.splice(at, 1);
			for (const x of noteIds) this.#crossStaffBeamOfNote.delete(x);
		}
	}

	/**
	 * A deep, **id-preserving** copy of this score.
	 *
	 * "Id-preserving": every cloned `Note` keeps its exact `id`, and the private
	 * `#nextNoteId` counter is carried over verbatim, so the clone keeps minting
	 * fresh, non-colliding ids from where the source left off. This is what lets
	 * `EditHistory` compare a before/after snapshot note-for-note (via
	 * `assertScoresEquivalent`, which still ignores id *values*) and lets a
	 * restored snapshot be addressed by the same ids a caller already holds.
	 *
	 * "Deep": no mutable node is shared with the source. Every `Staff`,
	 * `Measure`, `Note`, `Pitch`, `TupletRatio`, `Part`, `Slur` and
	 * `CrossStaffBeam` is a fresh object, and every array is fresh, so mutating
	 * anything in the clone (a note's pitch, a measure's barline, a staff's
	 * clef, a part's staff list, a `tiedToId`) cannot reach back into the
	 * source, or vice versa. Passthrough payloads (M6 Slice 3) are the one
	 * thing shared, and only because they are immutable: an edit replaces a
	 * payload list, it never mutates one.
	 *
	 * The three private indexes (`#measureOfNote`, `#tieSourceOfTarget`,
	 * `#crossStaffBeamOfNote`) are rebuilt against the freshly created objects
	 * rather than copied, since they hold references into the node graph. Ties
	 * are reproduced by assigning `Note.tiedToId` directly and rebuilding
	 * `#tieSourceOfTarget` from those values: routing through `setTie` would
	 * re-run `#linkTie`'s pitch-equality validation, which can spuriously reject
	 * a tie chain while it is only half-rebuilt.
	 */
	clone(): Score {
		const copy = new Score({
			keyFifths: this.keyFifths,
			time: { beats: this.time.beats, beatType: this.time.beatType },
			tempoBpm: this.tempoBpm,
			clef: this.staves[0]!.clef
		});
		// The constructor always seeds `staves[0]` and one default part. Empty
		// both arrays and rebuild them from the source, so a cloned multi-staff
		// (e.g. SATB) score does not keep that seed as a stray extra staff or a
		// wrong `parts[0]`.
		copy.staves.length = 0;
		copy.parts.length = 0;

		for (const staff of this.staves) {
			const staffCopy = new Staff(staff.index, staff.clef);
			for (const measure of staff.measures) {
				const measureCopy = new Measure(measure.index, measure.staffIndex);
				if (measure.keyFifths !== undefined) measureCopy.keyFifths = measure.keyFifths;
				if (measure.clef !== undefined) measureCopy.clef = measure.clef;
				// Each `ClefChange` is immutable, so only the array is fresh.
				if (measure.clefChanges.length > 0) measureCopy.clefChanges = [...measure.clefChanges];
				// Dynamic marks are immutable too (their `source` included).
				if (measure.dynamics.length > 0) measureCopy.dynamics = [...measure.dynamics];
				if (measure.time !== undefined) {
					measureCopy.time = { beats: measure.time.beats, beatType: measure.time.beatType };
				}
				if (measure.endBarline !== undefined) measureCopy.endBarline = measure.endBarline;
				if (measure.startBarline !== undefined) measureCopy.startBarline = measure.startBarline;
				// Passthrough payloads are immutable (see `passthrough.ts`), so the
				// copy shares them; only reassigning the field can change one.
				measureCopy.passthrough = measure.passthrough;
				measureCopy.attributesPassthrough = measure.attributesPassthrough;
				measureCopy.barlinePassthrough = measure.barlinePassthrough;
				for (const note of measure.notes) {
					const noteCopy = new Note(note.id, {
						pitch: note.pitch === null ? null : { ...note.pitch },
						value: note.value,
						voice: note.voice,
						dots: note.dots,
						tuplet: note.tuplet === null ? undefined : { ...note.tuplet },
						measureRestWholes: note.measureRestWholes,
						chordWithPrevious: note.chordWithPrevious,
						articulations: note.articulations,
						fermata: note.fermata,
						passthrough: note.passthrough
					});
					// Set directly, not through the spec's `tiedToId` (which would
					// run `#linkTie`): see this method's own doc comment.
					noteCopy.tiedToId = note.tiedToId;
					measureCopy.notes.push(noteCopy);
					copy.#measureOfNote.set(noteCopy.id, measureCopy);
					if (noteCopy.tiedToId !== null) {
						copy.#tieSourceOfTarget.set(noteCopy.tiedToId, noteCopy.id);
					}
				}
				staffCopy.measures.push(measureCopy);
			}
			copy.staves.push(staffCopy);
		}

		for (const part of this.parts) {
			const partCopy: { name?: string; staffIndices: number[]; passthrough?: readonly OpaqueElement[] } = {
				staffIndices: [...part.staffIndices]
			};
			if (part.name !== undefined) partCopy.name = part.name;
			if (part.passthrough !== undefined) partCopy.passthrough = part.passthrough;
			copy.parts.push(partCopy);
		}
		copy.headerPassthrough = this.headerPassthrough;

		for (const slur of this.slurs) {
			copy.slurs.push({ startNoteId: slur.startNoteId, endNoteId: slur.endNoteId });
		}

		// Immutable entries, shared; only the list is fresh.
		copy.wedges.push(...this.wedges);

		for (const beam of this.crossStaffBeams) {
			const beamCopy: CrossStaffBeam = {
				noteIds: [...beam.noteIds],
				staffIndices: [beam.staffIndices[0], beam.staffIndices[1]]
			};
			copy.crossStaffBeams.push(beamCopy);
			for (const id of beamCopy.noteIds) copy.#crossStaffBeamOfNote.set(id, beamCopy);
		}

		// Carry the id counter over verbatim so the clone keeps minting ids that
		// cannot collide with the ones just copied in.
		copy.#nextNoteId = this.#nextNoteId;
		return copy;
	}
}

/** A note's construction spec, for rebuilding it with a readonly field
 *  changed (`Score.#replaceNote`). Leaves out `tiedToId`, which the caller
 *  sets directly so the tie index is not re-validated. */
function specOf(note: Note): NoteSpec {
	return {
		pitch: note.pitch === null ? null : { ...note.pitch },
		value: note.value,
		voice: note.voice,
		dots: note.dots,
		tuplet: note.tuplet ?? undefined,
		measureRestWholes: note.measureRestWholes,
		chordWithPrevious: note.chordWithPrevious,
		articulations: note.articulations,
		fermata: note.fermata,
		passthrough: note.passthrough
	};
}

/** The measures one correction op touched, deduplicated; `list()` sorts
 *  them by staff, then measure. */
class TouchedMeasures {
	readonly #refs = new Map<string, MeasureRef>();

	add(staffIndex: number, measureIndex: number): void {
		this.#refs.set(`${staffIndex}:${measureIndex}`, { staffIndex, measureIndex });
	}

	addMeasure(measure: Measure): void {
		this.add(measure.staffIndex, measure.index);
	}

	list(): readonly MeasureRef[] {
		return [...this.#refs.values()].sort((a, b) => a.staffIndex - b.staffIndex || a.measureIndex - b.measureIndex);
	}
}

/** One measure written as `[pitchName | null, value, extra?]` triples; `null` is
 *  a rest. `extra` carries dots, a tuplet ratio, a tie and/or a voice for the
 *  notes that need them, so a plain literal can stay a 2-tuple. `tiedToNext:
 *  true` marks this note as tied into the *next* note in the same voice,
 *  wherever it ends up (the same measure, or a later one across a barline);
 *  see `buildScore` for how that gets resolved to an actual note id.
 *  `voice` (1-based, matching MusicXML and `Note.voice`'s own default of 1)
 *  is omitted for every ordinary single-voice literal; a two-voice measure
 *  (M2 Slice 1) sets it explicitly on the notes that share the measure with
 *  another voice's notes, in whatever order the literal happens to write
 *  them in (layout groups by voice itself; a compact literal never needs to
 *  interleave two voices' notes token-for-token to read naturally).
 *
 *  A chord (M6 Slice 2) is written as an array of pitch names in the pitch
 *  slot, e.g. `[['C4', 'E4', 'G4'], 'quarter']`: it becomes one `Note` per
 *  name, the first the anchor and the rest `chordWithPrevious` members, all
 *  sharing `value` and `extra`. `tiedToNext` on a chord ties *each* head to
 *  the head of the same pitch in the voice's next event (see `buildScore`).
 *  Every head is its own entry in `measure.notes`, so a `SlurSpec`'s note
 *  index counts heads, not events. */
export type MeasureSpec = readonly (readonly [
	pitch: string | readonly string[] | null,
	value: NoteValue,
	extra?: {
		dots?: 0 | 1 | 2;
		tuplet?: TupletRatio;
		tiedToNext?: boolean;
		voice?: number;
		/** M6 Slice 5; on a chord, set on the anchor only (see `NoteSpec.articulations`). */
		articulations?: readonly Articulation[];
		/** M6 Slice 5; on a chord, set on the anchor only. */
		fermata?: Fermata;
	}
])[];

/**
 * A measure literal that also changes the key and/or time signature starting
 * at this measure, for `buildScore`'s `measures` array wherever a plain
 * `MeasureSpec` (a bare array) needs a key or time change alongside it.
 *
 * A separate wrapper object rather than a third element tacked onto
 * `MeasureSpec` itself: a key or time change is a property of the *measure*,
 * not of any one note in it, so bolting it onto the per-note tuple the way
 * `tiedToNext` fits a single note would not have a sensible home there.
 * `buildScore` tells the two apart with `isMeasureBuildSpec`, since a bare
 * `MeasureSpec` is always an array and this is always a plain object.
 */
export interface MeasureBuildSpec {
	readonly notes: MeasureSpec;
	/** See `Measure.keyFifths`. Omit to keep whatever key was in force before this measure. */
	readonly keyFifths?: number;
	/** See `Measure.time`. Omit to keep whatever time signature was in force before this measure. */
	readonly time?: TimeSignature;
	/** See `Measure.clef` (M5 Slice 5). Omit to keep whatever clef was in force before this measure. */
	readonly clef?: ClefType;
	/** See `Measure.clefChanges` (M6 Slice 4): clef changes inside the measure, by onset in wholes. */
	readonly clefChanges?: readonly ClefChange[];
	/** See `Measure.endBarline`. Omit for the default (`'normal'`, or `'final'` at the score's last measure). */
	readonly endBarline?: BarlineType;
	/** See `Measure.startBarline`. Omit for no repeat-start mark at this measure's own start. */
	readonly startBarline?: 'repeatStart';
	/** See `Measure.dynamics` (M6 Slice 6): dynamic marks by onset in wholes (default 0). */
	readonly dynamics?: readonly { readonly kind: DynamicKind; readonly onset?: number; readonly placement?: Placement }[];
}

/** `spec is MeasureBuildSpec`, distinguishing it from a bare `MeasureSpec` by
 *  the one shape difference between them: a `MeasureBuildSpec` is a plain
 *  object, a `MeasureSpec` is always an array. A hand-written guard rather
 *  than an inline `Array.isArray(spec)` check at each call site, because
 *  TypeScript's built-in narrowing for `Array.isArray` cannot exclude a
 *  *readonly* array type from a union (a readonly array is not assignable to
 *  the mutable `any[]` the guard checks against, so the non-array branch
 *  would otherwise stay unnarrowed), and `MeasureSpec` is deliberately
 *  readonly like every other spec type in this file. */
function isMeasureBuildSpec(spec: MeasureSpec | MeasureBuildSpec): spec is MeasureBuildSpec {
	return !Array.isArray(spec);
}

/**
 * One slur, addressed by the position of its two end notes rather than by an
 * id (a slur literal is built before any note has one). Each position is
 * `[measureIndex, noteIndex]`, both 0-based into the `measures` array passed
 * to `buildScore` alongside this spec.
 *
 * A per-note `extra` flag (the way `tiedToNext` works) does not fit a slur the
 * way it fits a tie: a tie only ever names its *own* next note, but a slur's
 * other end can be arbitrarily far away and is not naturally a property of
 * either endpoint alone. Addressing by position keeps `MeasureSpec`'s compact
 * per-note literal untouched, and reads almost as directly as an id would
 * once the measures above it are visible to count from.
 */
export interface SlurSpec {
	readonly start: readonly [measureIndex: number, noteIndex: number];
	readonly end: readonly [measureIndex: number, noteIndex: number];
}

/**
 * One hairpin (M6 Slice 6) for `buildScore`: `start`/`stop` are `[measureIndex,
 * onsetWholes]` into the `measures` array, the shape `Score.addWedge` takes.
 */
export interface WedgeSpec {
	readonly kind: WedgeKind;
	readonly start: readonly [measureIndex: number, onset: number];
	readonly stop: readonly [measureIndex: number, onset: number];
	readonly placement?: Placement;
}

/**
 * Build a score from a compact literal, so demo scores and test fixtures read
 * like music rather than like constructor calls. Phase 0 has no importer, so
 * every score in this repo is written by hand and this is how. Phase 5's
 * MusicXML import replaces it as the real entry point, not this.
 */
export function buildScore(
	measures: readonly (MeasureSpec | MeasureBuildSpec)[],
	options: ScoreOptions = {},
	slurs: readonly SlurSpec[] = [],
	wedges: readonly WedgeSpec[] = []
): Score {
	const score = new Score(options);
	// Notes requesting `extra.tiedToNext`, and every note built so far in
	// score order: resolved into actual ties only after every measure exists,
	// in a second pass below. A tie's target is commonly the very next note in
	// a *different* (later) measure, which is exactly why this can't be
	// resolved inline: while the measure containing the tied-from note is
	// still being built, a following measure's notes don't have ids yet.
	const tieRequests: Note[] = [];
	const builtNotes: Note[] = [];
	for (const spec of measures) {
		const measure = score.appendMeasure();
		// A plain-object spec carries a key/time change alongside its notes;
		// see `isMeasureBuildSpec`'s own comment for why this check is a
		// hand-written guard rather than an inline `Array.isArray(spec)`.
		if (isMeasureBuildSpec(spec)) {
			measure.keyFifths = spec.keyFifths;
			measure.time = spec.time;
			measure.clef = spec.clef;
			if (spec.clefChanges) {
				measure.clefChanges = [...spec.clefChanges].sort((a, b) => a.onset - b.onset);
			}
			measure.endBarline = spec.endBarline;
			measure.startBarline = spec.startBarline;
		}
		const notes = isMeasureBuildSpec(spec) ? spec.notes : spec;
		for (const [pitch, value, extra] of notes) {
			const pitches = pitch === null ? [null] : typeof pitch === 'string' ? [pitch] : pitch;
			pitches.forEach((name, i) => {
				const note = score.appendNote(measure, {
					pitch: name === null ? null : parsePitch(name),
					value,
					dots: extra?.dots,
					tuplet: extra?.tuplet,
					voice: extra?.voice,
					chordWithPrevious: i > 0,
					// Marks are the chord's, so only the anchor carries them:
					// the shape an exporter (and MuseScore) writes.
					articulations: i === 0 ? extra?.articulations : undefined,
					fermata: i === 0 ? extra?.fermata : undefined
				});
				builtNotes.push(note);
				if (extra?.tiedToNext) tieRequests.push(note);
			});
		}
	}
	for (const source of tieRequests) {
		// The voice's next *event* in score order (score order already matches
		// playback order within a voice, since Phase 0/1 only ever lays a
		// score out left to right, top to bottom): its first note after
		// skipping this note's own chord-mates, i.e. the next same-voice note
		// that is not a `chordWithPrevious` member. Within that event, the head
		// of the same pitch is the target, so a tied chord ties head to head;
		// with no same-pitch head the event's anchor is named anyway and
		// `setTie` reports the pitch mismatch, as it always has.
		const startAt = builtNotes.indexOf(source) + 1;
		const rest = builtNotes.slice(startAt).filter((candidate) => candidate.voice === source.voice);
		const anchorAt = rest.findIndex((candidate) => !candidate.chordWithPrevious);
		if (anchorAt === -1) {
			throw new Error(
				`tiedToNext on a note with no following note in voice ${source.voice} to tie to`
			);
		}
		const nextEvent = [rest[anchorAt]!];
		for (let i = anchorAt + 1; i < rest.length && rest[i]!.chordWithPrevious; i++) nextEvent.push(rest[i]!);
		const target =
			nextEvent.find(
				(candidate) => source.pitch !== null && candidate.pitch !== null && pitchesEqual(candidate.pitch, source.pitch)
			) ?? nextEvent[0]!;
		score.setTie(source.id, target.id);
	}
	for (const spec of slurs) {
		const [startMeasureIndex, startNoteIndex] = spec.start;
		const [endMeasureIndex, endNoteIndex] = spec.end;
		const startNote = score.measures[startMeasureIndex]?.notes[startNoteIndex];
		const endNote = score.measures[endMeasureIndex]?.notes[endNoteIndex];
		if (!startNote) {
			throw new Error(`slur start [${startMeasureIndex}, ${startNoteIndex}] is not a note in this score`);
		}
		if (!endNote) {
			throw new Error(`slur end [${endMeasureIndex}, ${endNoteIndex}] is not a note in this score`);
		}
		score.addSlur(startNote.id, endNote.id);
	}
	// Dynamics after the notes, so each defaults to its measure's first voice.
	measures.forEach((spec, measureIndex) => {
		if (!isMeasureBuildSpec(spec) || !spec.dynamics) return;
		for (const dynamic of spec.dynamics) score.addDynamic(0, measureIndex, dynamic);
	});
	for (const spec of wedges) {
		score.addWedge({
			kind: spec.kind,
			placement: spec.placement,
			start: { measureIndex: spec.start[0], onset: spec.start[1] },
			stop: { measureIndex: spec.stop[0], onset: spec.stop[1] }
		});
	}
	return score;
}
