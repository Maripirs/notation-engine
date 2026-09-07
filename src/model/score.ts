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
 */
export type ClefType = 'treble' | 'bass' | 'treble8';

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

	constructor(id: NoteId, spec: NoteSpec) {
		this.id = id;
		this.pitch = spec.pitch;
		this.value = spec.value;
		this.voice = spec.voice ?? 1;
		this.dots = spec.dots ?? 0;
		this.tuplet = spec.tuplet ?? null;
		this.tiedToId = spec.tiedToId ?? null;
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
		// Each dot adds half of the previous augmentation: 2 - 2^-dots gives
		// 1 (no dots), 1.5 (one dot), 1.75 (two dots).
		const dotMultiplier = 2 - 2 ** -this.dots;
		const tupletMultiplier = this.tuplet ? this.tuplet.normalNotes / this.tuplet.actualNotes : 1;
		return NOTE_VALUE_WHOLES[this.value] * dotMultiplier * tupletMultiplier;
	}
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
	return measure.notes.reduce((sum, note) => sum + note.durationWholes, 0);
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
	 *  score should read `staves[i].clef` directly instead. */
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
	addPart(staffIndices: readonly number[], name?: string): Part {
		const part: Part = { name, staffIndices };
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
	 * or the note is a rest). That return value is the contract the
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
		if (!measure || !note || note.pitch === null) return null;
		note.pitch = transpose(note.pitch, semitones);
		return measure.index;
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
 *  interleave two voices' notes token-for-token to read naturally). */
export type MeasureSpec = readonly (readonly [
	pitch: string | null,
	value: NoteValue,
	extra?: { dots?: 0 | 1 | 2; tuplet?: TupletRatio; tiedToNext?: boolean; voice?: number }
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
	/** See `Measure.endBarline`. Omit for the default (`'normal'`, or `'final'` at the score's last measure). */
	readonly endBarline?: BarlineType;
	/** See `Measure.startBarline`. Omit for no repeat-start mark at this measure's own start. */
	readonly startBarline?: 'repeatStart';
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
 * Build a score from a compact literal, so demo scores and test fixtures read
 * like music rather than like constructor calls. Phase 0 has no importer, so
 * every score in this repo is written by hand and this is how. Phase 5's
 * MusicXML import replaces it as the real entry point, not this.
 */
export function buildScore(
	measures: readonly (MeasureSpec | MeasureBuildSpec)[],
	options: ScoreOptions = {},
	slurs: readonly SlurSpec[] = []
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
			measure.endBarline = spec.endBarline;
			measure.startBarline = spec.startBarline;
		}
		const notes = isMeasureBuildSpec(spec) ? spec.notes : spec;
		for (const [pitch, value, extra] of notes) {
			const note = score.appendNote(measure, {
				pitch: pitch === null ? null : parsePitch(pitch),
				value,
				dots: extra?.dots,
				tuplet: extra?.tuplet,
				voice: extra?.voice
			});
			builtNotes.push(note);
			if (extra?.tiedToNext) tieRequests.push(note);
		}
	}
	for (const source of tieRequests) {
		// The next note in score order sharing this note's voice: score order
		// already matches playback order within a voice, since Phase 0/1 only
		// ever lays a score out left to right, top to bottom.
		const startAt = builtNotes.indexOf(source) + 1;
		const target = builtNotes.slice(startAt).find((candidate) => candidate.voice === source.voice);
		if (!target) {
			throw new Error(
				`tiedToNext on a note with no following note in voice ${source.voice} to tie to`
			);
		}
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
	return score;
}
