// Turning the model into positioned glyphs: one staff, one system, one voice.
//
// Everything here is measured in *staff spaces* and multiplied out to pixels at
// the end of each calculation, because that is the unit the font's own metrics
// use and the unit engraving rules are written in. `ss` below is always the
// pixel size of one staff space.
//
// Note spacing (Phase 1, Slice 9) is optical: each note's horizontal advance
// grows with the *log* of its duration, not its duration itself, so a whole
// note does not claim anywhere near 8x an eighth note's room the way a linear
// model would (see `noteAdvanceSpaces`). A system also gets justified: once
// `planSystems` has decided which measures land in it, their combined natural
// width is stretched (or, rarely, very mildly compressed) to fill
// `systemWidthPx` exactly, distributing the slack across notes in proportion
// to each one's own natural space (see `systemSpacingScale`) rather than
// padding only at measure ends. What Phase 0 needed from spacing was only that
// measures have stable, non-overlapping horizontal bands, which is what makes
// region-scoped redraw possible at all; that property still holds; it just no
// longer comes from a naive fixed-plus-linear formula.

import type {
	Articulation,
	ClefType,
	CrossStaffBeam,
	Measure,
	Note,
	NoteId,
	NoteValue,
	Part,
	Score,
	Slur,
	TimeSignature
} from '../model/score.js';
import { eventArticulations, eventFermata, measureDurationWholes, noteEvents } from '../model/score.js';
import type { DynamicKind, DynamicMark, Placement, Wedge } from '../model/directions.js';
import { diatonicIndex, keyAlterForStep, type Step } from '../model/pitch.js';
import {
	ENGRAVING_DEFAULTS as ED,
	GLYPH_METRICS,
	glyphMetrics,
	STAFF_SPACES_PER_EM,
	type GlyphName
} from '../render/glyph-metrics.js';
import type { DrawOp, LaidOutMeasure, LaidOutNote, LaidOutScore, Rect } from './types.js';

export interface LayoutOptions {
	/** Pixels between two staff lines. The single knob that scales the whole render. */
	readonly staffSpacePx?: number;
	/** Blank margin around the system, pixels. */
	readonly paddingPx?: number;
	/**
	 * Maximum pixel width a system's measures may run to before the rest cast
	 * off onto a new system, stacked below. Omit it and layout keeps Phase 0's
	 * original behaviour: one system, forever, however wide the score gets.
	 *
	 * Casting-off here is greedy (fill a system until the next measure would
	 * overflow, then start a new one), not the balanced/optimal algorithm real
	 * engraving software uses to even out how full each line looks. Greedy is
	 * the naive-but-correct choice consistent with the rest of this file's
	 * spacing: it produces a system per line and a ragged right edge, which is
	 * exactly the trade real optical justification (Phase 1+) exists to fix.
	 */
	readonly systemWidthPx?: number;
}

const DEFAULTS = {
	staffSpacePx: 9,
	paddingPx: 16
} as const;

// Spacing constants, in staff spaces. Named because a reader should be able to
// see what would change if this were replaced by real optical spacing.
const SPACING = {
	/**
	 * Horizontal advance given to a note at exactly `noteSpaceReferenceWholes`'s
	 * own duration (this model's shortest plain note value, the 64th), staff
	 * spaces: `noteAdvanceSpaces`'s curve reads `+0` from this at that duration.
	 * Not a hard floor: a tupleted note shorter than the reference (only ever
	 * reachable via the one implemented tuplet ratio, a triplet, e.g. a
	 * tripleted 64th) gets a small *negative* log term and lands a little
	 * below this, on purpose, so tripleting the shortest notated value still
	 * visibly shortens its room the same way it does for every longer value
	 * (see `noteSpaceReferenceWholes`'s own comment on why this stays safely
	 * positive rather than needing a clamp).
	 */
	noteSpaceBase: 2,
	/**
	 * Extra advance added per *doubling* of a note's duration relative to
	 * `noteSpaceReferenceWholes`, staff spaces. This is what makes the curve
	 * logarithmic rather than linear: a note twice as long as another gets
	 * exactly this much more room, not twice as much. See `noteAdvanceSpaces`.
	 */
	noteSpacePerDoubling: 1,
	/**
	 * The duration (as a fraction of a whole note) `noteAdvanceSpaces` treats
	 * as its zero point: this model's shortest plain `NoteValue`, the 64th.
	 * Every plain duration this model can express is at or above this, so its
	 * log term is at or above zero; the only way to go below the reference at
	 * all is the one tuplet ratio this model implements, a triplet (see
	 * `model/score.ts`'s own `TupletRatio` comment), whose shallowest possible
	 * cut is 2/3, giving a worst-case log term of `log2(2/3) ≈ -0.585`. With
	 * this file's chosen `noteSpaceBase`/`noteSpacePerDoubling` (2 and 1), that
	 * bottoms out around 1.4 staff spaces, comfortably positive, which is why
	 * `noteAdvanceSpaces` clamps only a defensive epsilon against `durationWholes`
	 * ever reaching exactly zero, not this reference value: a real per-tuplet
	 * clamp would have hidden the very ordering (tripleting a 64th still
	 * shortens it) the duration-rendering test suite checks for.
	 */
	noteSpaceReferenceWholes: 1 / 64,
	/** Gap between an accidental and the notehead it belongs to. */
	accidentalGap: 0.3,
	/** Gap between two columns of a chord's stacked accidentals (M6 Slice 2;
	 *  see `stackAccidentals`): tighter than `accidentalGap`, since the two
	 *  glyphs belong together, but enough that their ink never touches. */
	accidentalColumnGap: 0.15,
	/**
	 * Minimum blank required between the previous note's rightmost ink (its
	 * stem, a ledger line, or just its notehead) and an accidental this note
	 * must draw. Below this, the accidental would print on top of that ink;
	 * `layoutNote` pushes the whole note right by however much clearance is
	 * missing rather than let that happen. Independent of `accidentalGap`,
	 * which is the gap on the *other* side, between the accidental and its
	 * own notehead. Deliberately never scaled by a system's justification
	 * factor (`MeasureContext.spacingScale`): it is a minimum-ink guarantee,
	 * not decorative spacing, so it has to hold even in the rare system that
	 * ends up mildly compressed rather than stretched.
	 *
	 * Re-checked against Slice 9's new curve, not just carried over: a 64th
	 * note only ever gets `noteSpaceBase` (2 staff spaces) of natural room,
	 * less than the old naive formula's ~2.34, so this remains (if anything
	 * more often than before) the case real engraving actually worries about:
	 * the shortest durations (32nd/64th) landing right after a note with a
	 * ledger line. 0.9 still sits just above that specific gap (re-verified
	 * against this file's own constants; see the geometry test next to this
	 * comment's use).
	 */
	minAccidentalClearance: 0.9,
	/** Gap between a notehead (or rest) and its first augmentation dot. */
	dotGap: 0.2,
	/** Gap between two augmentation dots on the same note. */
	dotSpacing: 0.3,
	/** Blank at the start of a measure's note area, after the clef or barline.
	 *  Wide enough that a down-stem first note, whose stem is the leftmost ink
	 *  it draws, does not crowd the barline. */
	measureLeadIn: 1.7,
	/** Blank between the last note and the barline. */
	measureTrailOut: 1.4,
	/** Gap between the clef, key signature and time signature in the first measure. */
	headerGap: 0.9,
	/**
	 * Blank between one system's lowest ink and the next system's staff top,
	 * staff spaces. A fixed multiple of `ss` rather than a measured clearance:
	 * real engraving reserves space per system based on the tallest thing that
	 * actually lands there (a high ledger line, a beam, a dynamic). Phase 0 has
	 * none of that yet, so a constant generous enough for stems and a few
	 * ledger lines on either side is the naive-but-correct stand-in.
	 */
	systemGap: 6,
	/**
	 * Blank between one staff and the next, staff spaces, when two or more
	 * staves are stacked *within one system* (M2 Slice 4). A fixed, generous
	 * gap, the same naive-but-correct spirit as `systemGap`: real engraving
	 * would size this per system based on the tallest ink actually landing in
	 * it (a deep ledger line, a beam); this file has no such measurement yet,
	 * so a constant wide enough for a couple of ledger lines on either side
	 * (e.g. middle C sitting between a piano's two staves) is the stand-in.
	 * Deliberately *not* ink-aware: `layoutScore` fixes every staff's own top
	 * at a constant offset from the previous staff's nominal (not actual)
	 * bottom, precisely so the shared barline's own split point (see
	 * `layoutScore`'s own comment on `barlineTop`/`barlineBottom`) can be
	 * computed up front, before any measure's content is laid out, with no
	 * circular dependency between "how tall is this staff's ink" and "where
	 * does the next staff start".
	 *
	 * Replaces Slice 3's `staffBlockGap`, which separated two whole
	 * independent per-staff *blocks* (every one of a staff's own systems,
	 * stacked below the previous staff's own last system); this slice
	 * interleaves staves *within* a system instead, so the gap that matters
	 * now is staff-to-staff, not block-to-block, and `systemGap` alone
	 * separates one system's whole staff group from the next.
	 */
	staffGap: 6
} as const;

/**
 * Constants for M2 Slice 5's part-grouping decorations (brace/bracket, part
 * name label). Kept in their own block rather than folded into `SPACING`
 * since none of these are engraving-standard optical spacing the way
 * `SPACING`'s own values mostly are; several are this slice's own documented
 * heuristics (see `estimateTextWidthPx`'s comment in particular).
 */
const PART_DECORATION = {
	/** Gap after a brace/bracket's own ink: between two qualifying groups
	 *  stacked left to right, and between the last one and the label column
	 *  (or, with no groups at all, between the left margin and the label
	 *  column). */
	columnGap: 0.6,
	/** Gap between the label column's own reserved width and the clef. */
	labelGap: 0.6,
	/** A part-name label's font size, staff spaces: ordinary text, not a
	 *  SMuFL glyph, sized relative to the staff the same way every other
	 *  measurement in this file is, rather than a fixed point size. */
	labelFontSizeSpaces: 2,
	/**
	 * Heuristic average glyph width, as a fraction of font size, used to
	 * estimate a text label's pixel width. Layout has no canvas to measure
	 * real text metrics with (`glyph-metrics.ts` only publishes SMuFL glyph
	 * metrics, not an arbitrary text font's), so this is a documented
	 * approximation, not a real measurement: 0.55 is a reasonable average
	 * character width for a normal sans-serif font, good enough to reserve a
	 * header column that comfortably fits a typical instrument name and to
	 * roughly right-align each label against its own clef. A label whose
	 * actual rendered width differs noticeably from this estimate (an
	 * unusually wide or narrow font, a very short or very long name) could
	 * end up a little more loosely or tightly spaced than intended; nothing
	 * in this slice's own acceptance criteria needs pixel-exact text layout.
	 */
	labelAvgCharWidthRatio: 0.55
} as const;

/**
 * A note's (or rest's) natural horizontal advance, staff spaces, before any
 * system-level justification scale is applied: the amount `layoutNote` and
 * `probeMeasureWidth`/`systemSpacingScale`'s casting-off and stretch-factor
 * arithmetic agree is this note's own "natural" width.
 *
 * Roughly logarithmic in duration, the real-engraving convention this file's
 * own top-of-file comment used to flag as future work: `noteSpacePerDoubling`
 * staff spaces are added each time the duration *doubles* relative to
 * `noteSpaceReferenceWholes`, rather than the naive old model's space scaling
 * linearly with duration itself. Concretely, with this file's chosen
 * constants (base 2, per-doubling 1, reference the 64th), every plain
 * `NoteValue` lands on a clean integer number of staff spaces one apart:
 * 64th=2, 32nd=3, 16th=4, eighth=5, quarter=6, half=7, whole=8 (a dotted or
 * tupleted duration falls continuously between two of these, since
 * `durationWholes` already folds dots and tuplet ratios in). A whole note
 * therefore gets 8/5 = 1.6x an eighth note's room, comfortably sub-linear
 * (nowhere near the 8x a naive per-whole-note-of-duration model would give),
 * while the shortest notes still get enough room (`noteSpaceBase`) not to
 * visually collide with a neighbour's ink at ordinary spacing (tight cases
 * still handled by `SPACING.minAccidentalClearance`'s separate collision
 * check, which layers on top of this rather than folding into it).
 *
 * `durationWholes` is only ever clamped up from a defensive epsilon (guarding
 * `Math.log2` against `-Infinity` should a duration ever reach exactly zero),
 * not up to `noteSpaceReferenceWholes` itself: see that constant's own
 * comment on why a tripleted note shorter than the reference is deliberately
 * left to compute a small negative log term rather than being floored to the
 * reference's own space.
 */
function noteAdvanceSpaces(note: Note): number {
	const EPS = 1e-9;
	const wholes = Math.max(note.durationWholes, EPS);
	return (
		SPACING.noteSpaceBase +
		SPACING.noteSpacePerDoubling * Math.log2(wholes / SPACING.noteSpaceReferenceWholes)
	);
}

/**
 * Per-voice cumulative-duration onset for every note in a measure, keyed by
 * note id: this note's position, as a fraction of a whole note, measured
 * from the start of *its own voice's* timeline within this measure.
 *
 * Two voices interleaved in `measure.notes` never share one timeline the way
 * Phase 0/1's single voice did, so this groups by `note.voice` first and
 * runs an independent cumulative-duration cursor per voice, rather than the
 * one running position a flat walk of the array would corrupt across voices
 * (the same reason `computeBeamGroups` needs the same per-voice split; see
 * its own comment). Order within a voice is assumed already chronological:
 * every score this repo builds (`buildScore`, `appendMeasures`) appends a
 * voice's own notes in playback order even when a literal interleaves two
 * voices' tuples, so filtering by voice and walking in array order
 * reproduces that voice's real time sequence with no extra sorting.
 */
function noteOnsets(notes: readonly Note[]): Map<NoteId, number> {
	const onsets = new Map<NoteId, number>();
	// Walked per event (`noteEvents`, M6 Slice 2), not per note: every head of
	// a chord gets the anchor's onset, and the voice's cursor advances once,
	// by the anchor's duration, rather than once per head.
	for (const voiceEvents of eventsByVoice(notes).values()) {
		let position = 0;
		for (const chord of voiceEvents) {
			for (const note of chord) onsets.set(note.id, position);
			position += chord[0]!.durationWholes;
		}
	}
	return onsets;
}

/**
 * Whether any two heads of a chord sit a second apart (adjacent diatonic
 * positions), which forces one of them onto the "wrong" side of the stem
 * (see `chordHeadOffsets`). Needed by `measureColumns`, before any stem
 * direction is known: a displaced head costs one extra notehead width on
 * whichever side it lands, so the column reserves that width either way.
 */
function chordHasSecond(chord: readonly Note[]): boolean {
	if (chord.length < 2) return false;
	const ds = chord.flatMap((note) => (note.pitch ? [diatonicIndex(note.pitch)] : [])).sort((a, b) => a - b);
	for (let i = 1; i < ds.length; i++) if (ds[i]! - ds[i - 1]! === 1) return true;
	return false;
}

/**
 * Buckets a cumulative-duration onset (a fraction of a whole note) to a fixed
 * precision, so two voices that independently sum to the "same" musical
 * onset land in the same shared column even if their two running totals
 * picked up different float rounding along the way (e.g. a tripleted
 * duration's repeating binary fraction, summed via a different sequence of
 * additions in each voice). Tighter than any duration difference this model
 * can express (the shortest, a tripleted 64th, is still on the order of
 * 1e-3 wholes), the same kind of tolerance `computeBeamGroups`'s own `EPS`
 * uses for the same reason: comparing a computed position against another
 * without one occasionally misfires on accumulated rounding noise no
 * musical difference actually justifies.
 */
function onsetKey(onset: number): number {
	return Math.round(onset * 1e9) / 1e9;
}

/**
 * A measure's shared onset columns across every voice it holds ("onset-
 * aligned columns"): one entry per distinct onset (bucketed via `onsetKey`)
 * where *any* voice starts a note, sorted left to right, whose `width` is
 * the largest `noteAdvanceSpaces` among whichever voice(s) actually start a
 * note there.
 *
 * This is the merge step two independent rhythms need to land on the same x
 * wherever they share a beat, and to not collide where they don't. Two
 * voices with different rhythms (a half note against four running eighths,
 * say) do not share every onset; wherever they *do* both start a note at the
 * same position, that shared column's width is whichever voice's note needs
 * more room, so neither voice's ink collides with the other's at that x.
 * Wherever only one voice has a note (the eighths' interior onsets, while
 * the half note is still sounding), that voice alone decides the column's
 * width, and the *other* voice's next note still lands correctly further
 * along the shared timeline, past however many of the first voice's columns
 * came before it, because the running offset (`layoutMeasure`'s
 * `columnOffsetPx`) sums every column in between regardless of which voice
 * contributed it.
 *
 * Single voice is the degenerate case: every column is just that voice's own
 * next note, in its own order, with the column's width its own advance —
 * exactly the flat linear cursor `layoutMeasure` always used before this
 * slice, just expressed as a precomputed sum of columns rather than a
 * running total threaded note to note. `systemSpacingScale` also reads this
 * (summing `width` across columns, not summing every voice's every note's
 * own advance) so a two-voice measure's justification denominator matches
 * the same shared timeline the layout pass itself uses, rather than
 * double-counting whatever beat both voices happen to have a note on.
 */
function measureColumns(
	notes: readonly Note[]
): readonly { readonly onset: number; readonly width: number }[] {
	const onsets = noteOnsets(notes);
	const columns = new Map<number, { onset: number; width: number }>();
	// One candidate width per event (M6 Slice 2): a chord's anchor decides its
	// advance, plus one notehead width when a second forces a head across the
	// stem, so the displaced head never eats into the next column's room.
	for (const chord of noteEvents(notes)) {
		const anchor = chord[0]!;
		const onset = onsets.get(anchor.id)!;
		const key = onsetKey(onset);
		const width =
			noteAdvanceSpaces(anchor) +
			(chordHasSecond(chord) ? GLYPH_METRICS[NOTEHEAD_GLYPHS[anchor.value]].advance : 0);
		const existing = columns.get(key);
		if (!existing || width > existing.width) columns.set(key, { onset, width });
	}
	return [...columns.values()].sort((a, b) => a.onset - b.onset);
}

/**
 * Groups a measure's notes by `note.voice`, preserving each voice's own
 * relative order (the order the notes already appear in `measure.notes`).
 * Shared by the beam-grouping pass and the note-layout pass in
 * `layoutMeasure`, both of which need to walk one voice's own notes in
 * isolation from any other voice interleaved in the same flat array; a
 * single voice (today's default) is the one-entry degenerate case, which is
 * what keeps every single-voice code path this feeds identical to before
 * this slice.
 */
function notesByVoice(notes: readonly Note[]): Map<number, Note[]> {
	const byVoice = new Map<number, Note[]>();
	for (const note of notes) {
		const list = byVoice.get(note.voice);
		if (list) list.push(note);
		else byVoice.set(note.voice, [note]);
	}
	return byVoice;
}

/**
 * `notesByVoice`, one level up (M6 Slice 2): each voice's own *events*
 * (`noteEvents`: a plain note or rest alone, or a chord's anchor plus its
 * members), in time order. The column walk in `layoutMeasure` and the onset
 * computation step through these rather than raw notes, so a chord occupies
 * one onset and is laid out as one unit (shared stem, stacked accidentals).
 */
function eventsByVoice(notes: readonly Note[]): Map<number, Note[][]> {
	const byVoice = new Map<number, Note[][]>();
	for (const chord of noteEvents(notes)) {
		const voice = chord[0]!.voice;
		const list = byVoice.get(voice);
		if (list) list.push(chord);
		else byVoice.set(voice, [chord]);
	}
	return byVoice;
}

/** Stem length measured from the notehead centre, staff spaces. Phase 1 shortens
 *  and lengthens this for notes far from the middle line; Phase 0 does not. */
const STEM_LENGTH = 3.5;

/** How far a tie's curve bulges away from the straight line between its two
 *  ends, staff spaces. A tie's span is always short (one notehead to the
 *  next), so a constant bulge reads as the shallow arc real engraving uses. A
 *  slur's much longer, variable-length span uses a different scheme entirely
 *  (see `slurRoofY`), since a fixed bulge could not clear whatever the
 *  farthest note in a long run reaches. */
const TIE_BULGE = 0.65;
/** Horizontal clearance between a tied notehead and where its curve actually
 *  starts or ends, staff spaces: enough that the curve visibly detaches from
 *  the notehead rather than touching its ink. */
const TIE_NOTE_GAP = 0.25;

/** Horizontal clearance between a slur's anchor notehead and where its curve
 *  actually starts or ends, staff spaces. Bigger than a tie's `TIE_NOTE_GAP`:
 *  a tie's two ends share a pitch and read naturally as touching almost the
 *  same spot, but a slur is not saying "this is the same note again", so
 *  giving it a little more daylight from the notehead keeps the two marks
 *  visually distinct. */
const SLUR_NOTE_GAP = 0.4;
/** How far clear of the most extreme note a slur spans, staff spaces, its
 *  curve cruises on the side it bulges toward (see `slurRoofY`). Bigger than
 *  `TIE_BULGE` for the same reason `SLUR_NOTE_GAP` is bigger than
 *  `TIE_NOTE_GAP`: a slur has to arch clear over however many notes fall
 *  between its two ends, not just connect two adjacent noteheads. */
const SLUR_ROOF_CLEARANCE = 1.3;

/**
 * The three diatonic staff positions everything clef-aware in this file
 * hangs off: the bottom line, the middle line (which decides stem direction
 * and ties/slurs' fallback direction), and the top line.
 *
 * Generalizes what were, before M2 Slice 3, three fixed treble-only module
 * constants (`TREBLE_BOTTOM_LINE`/`_MIDDLE_LINE`/`_TOP_LINE`); every function
 * that used to close over one of those directly now reads it off a
 * `MeasureContext`'s own `lines` field (`ctx.lines.bottomLine`, etc.) or
 * takes it as an explicit parameter where no `ctx` is in scope, so the same
 * ledger-line, stem-direction and tie/slur-direction math already proven
 * correct for treble applies unchanged to any clef, just against different
 * reference lines.
 */
interface ClefLines {
	readonly bottomLine: number;
	readonly middleLine: number;
	readonly topLine: number;
}

/**
 * `ClefLines` for each supported clef. `treble8` (the vocal-tenor "octave
 * treble" clef) shares plain `treble`'s table exactly: it is notated on the
 * very same lines and spaces (only the small "8" beneath the clef glyph
 * differs; see `ClefType`'s own comment in `model/score.ts`), so nothing
 * about note/ledger-line placement changes for it, only `layoutClef`'s own
 * glyph choice.
 */
const CLEF_LINES: Readonly<Record<ClefType, ClefLines>> = {
	treble: {
		bottomLine: diatonicIndex({ step: 'E', alter: 0, octave: 4 }),
		middleLine: diatonicIndex({ step: 'B', alter: 0, octave: 4 }),
		topLine: diatonicIndex({ step: 'F', alter: 0, octave: 5 })
	},
	treble8: {
		bottomLine: diatonicIndex({ step: 'E', alter: 0, octave: 4 }),
		middleLine: diatonicIndex({ step: 'B', alter: 0, octave: 4 }),
		topLine: diatonicIndex({ step: 'F', alter: 0, octave: 5 })
	},
	bass: {
		bottomLine: diatonicIndex({ step: 'G', alter: 0, octave: 2 }),
		middleLine: diatonicIndex({ step: 'D', alter: 0, octave: 3 }),
		topLine: diatonicIndex({ step: 'A', alter: 0, octave: 3 })
	},
	// The C clefs (M6 Slice 4) name middle C by the line the glyph centres
	// on: the middle (third) line for alto, the fourth line for tenor. So a
	// tenor staff reads a third lower than an alto one: its lines are D3 F3
	// A3 C4 E4 against alto's F3 A3 C4 E4 G4.
	alto: {
		bottomLine: diatonicIndex({ step: 'F', alter: 0, octave: 3 }),
		middleLine: diatonicIndex({ step: 'C', alter: 0, octave: 4 }),
		topLine: diatonicIndex({ step: 'G', alter: 0, octave: 4 })
	},
	tenor: {
		bottomLine: diatonicIndex({ step: 'D', alter: 0, octave: 3 }),
		middleLine: diatonicIndex({ step: 'A', alter: 0, octave: 3 }),
		topLine: diatonicIndex({ step: 'E', alter: 0, octave: 4 })
	}
};

/** The diatonic index of a clef's middle staff line, for callers outside
 *  layout that need the same middle-line reference `computeBeamGroups` and
 *  `stemDirectionForNotes` take. `src/io` uses it to derive stem direction
 *  and beam grouping for MusicXML `<stem>`/`<beam>` without importing layout's
 *  geometry. */
export function middleLineForClef(clef: ClefType): number {
	return CLEF_LINES[clef].middleLine;
}

/** Staff positions of key-signature accidentals, in the order they are
 *  written. The *step* order is universal (every clef writes a sharp key
 *  signature as F, C, G, D, A, E, B and a flat one as B, E, A, D, G, C, F);
 *  which line or space each one actually lands on is clef-specific, hence
 *  `KEY_SIGNATURE_OCTAVES` below rather than a single octave list here. */
const KEY_SIGNATURE_POSITIONS: Readonly<Record<'sharp' | 'flat', readonly Step[]>> = {
	sharp: ['F', 'C', 'G', 'D', 'A', 'E', 'B'],
	flat: ['B', 'E', 'A', 'D', 'G', 'C', 'F']
};
/**
 * Per-clef octave for each step in `KEY_SIGNATURE_POSITIONS`, i.e. which
 * actual line/space that accidental lands on for that clef, standard
 * engraving convention. `treble8` shares `treble`'s own table for the same
 * reason `CLEF_LINES` does: identical notated positions, only the clef glyph
 * differs.
 *
 * The C clefs (M6 Slice 4) are checked against MuseScore's `clefTable`
 * (`src/engraving/dom/clef.cpp`, the per-clef "lines for sharps / lines for
 * flats" columns, in half-spaces down from the top line), which matches the
 * patterns in Gould, *Behind Bars*, "Key signatures". Alto keeps the same
 * zigzag treble and bass use (the first sharp on the F nearest the top of the
 * staff, its top space). Tenor is the one exception: its first sharp, F, would sit in the space above the top line,
 * so the whole sharp pattern starts low instead (F3 on the second line, then
 * up to C4, down to G3, and so on), giving the same octave list as its flats.
 */
const KEY_SIGNATURE_OCTAVES: Readonly<Record<ClefType, Record<'sharp' | 'flat', readonly number[]>>> = {
	treble: {
		// F5 C5 G5 D5 A4 E5 B4
		sharp: [5, 5, 5, 5, 4, 5, 4],
		// B4 E5 A4 D5 G4 C5 F4
		flat: [4, 5, 4, 5, 4, 5, 4]
	},
	treble8: {
		sharp: [5, 5, 5, 5, 4, 5, 4],
		flat: [4, 5, 4, 5, 4, 5, 4]
	},
	bass: {
		// F3 C3 G3 D3 A2 E3 B2
		sharp: [3, 3, 3, 3, 2, 3, 2],
		// B2 E3 A2 D3 G2 C3 F2 (M6 Slice 4 fix: this read B3 E3 A3 ..., which
		// put the first flat above the staff and the third on the top line)
		flat: [2, 3, 2, 3, 2, 3, 2]
	},
	alto: {
		// F4 C4 G4 D4 A3 E4 B3
		sharp: [4, 4, 4, 4, 3, 4, 3],
		// B3 E4 A3 D4 G3 C4 F3
		flat: [3, 4, 3, 4, 3, 4, 3]
	},
	tenor: {
		// F3 C4 G3 D4 A3 E4 B3: the low-starting tenor sharp pattern
		sharp: [3, 4, 3, 4, 3, 4, 3],
		// B3 E4 A3 D4 G3 C4 F3
		flat: [3, 4, 3, 4, 3, 4, 3]
	}
};

const NOTEHEAD_GLYPHS = {
	whole: 'noteheadWhole',
	half: 'noteheadHalf',
	quarter: 'noteheadBlack',
	eighth: 'noteheadBlack',
	'16th': 'noteheadBlack',
	'32nd': 'noteheadBlack',
	'64th': 'noteheadBlack'
} as const satisfies Record<NoteValue, GlyphName>;

const REST_GLYPHS = {
	whole: 'restWhole',
	half: 'restHalf',
	quarter: 'restQuarter',
	eighth: 'rest8th',
	'16th': 'rest16th',
	'32nd': 'rest32nd',
	'64th': 'rest64th'
} as const satisfies Record<NoteValue, GlyphName>;

/**
 * Flag glyphs for the durations that need one. Whole, half and quarter notes
 * never carry a flag. A note eligible for beaming (see `computeBeamGroups`)
 * only draws its flag glyph when it ends up alone, with no beamable
 * neighbour in its beat; grouped with at least one neighbour, it gets a
 * shared beam instead (`layoutBeamGroup`). This map's keys double as the
 * membership test for "eligible for beaming at all".
 */
const FLAG_GLYPHS: Readonly<Partial<Record<NoteValue, { up: GlyphName; down: GlyphName }>>> = {
	eighth: { up: 'flag8thUp', down: 'flag8thDown' },
	'16th': { up: 'flag16thUp', down: 'flag16thDown' },
	'32nd': { up: 'flag32ndUp', down: 'flag32ndDown' },
	'64th': { up: 'flag64thUp', down: 'flag64thDown' }
};

/**
 * How many beams (or, unbeamed, flags) each duration draws: one for an
 * eighth, two for a 16th, and so on. A beamed group's primary beam spans
 * every member; its secondary and tertiary beams span only the sub-runs of
 * consecutive notes whose own level reaches that high, same as this table
 * says a single 16th needs two flags where a single eighth needs one.
 */
const BEAM_LEVELS: Readonly<Partial<Record<NoteValue, number>>> = {
	eighth: 1,
	'16th': 2,
	'32nd': 3,
	'64th': 4
};

const ACCIDENTAL_GLYPHS = {
	'-1': 'accidentalFlat',
	'0': 'accidentalNatural',
	'1': 'accidentalSharp'
} as const satisfies Record<string, GlyphName>;

const TIME_SIG_DIGITS = [
	'timeSig0',
	'timeSig1',
	'timeSig2',
	'timeSig3',
	'timeSig4',
	'timeSig5',
	'timeSig6',
	'timeSig7',
	'timeSig8',
	'timeSig9'
] as const satisfies readonly GlyphName[];

/**
 * Antialiasing slack `measureRegion` pads every measure's region by, on both
 * the top and the bottom, pixels: see its own comment. Hoisted to a named
 * module constant (rather than a literal local to `measureRegion`) because
 * `barlineSpan` (M2 Slice 4, below) also has to know this exact value: a
 * shared barline's two segments, if split at the raw geometric midpoint of
 * the staff gap, would each still get its own `REGION_BLEED_PX` of region
 * padding *toward* the other staff once `measureRegion` runs, and since both
 * segments' ink already reaches that same midpoint, the two staves' regions
 * would overlap by `2 * REGION_BLEED_PX`, not just touch. `barlineSpan`
 * shortens each segment's own ink by exactly this much on the side facing its
 * neighbour to cancel that out; see its own comment for the full reasoning.
 */
const REGION_BLEED_PX = 1;

/**
 * The vertical band, in the same provisional (pre-`shiftY`) frame as
 * everything else `layoutScore` computes, one staff's own portion of a
 * *shared* barline occupies within its system's staff group (M2 Slice 4).
 *
 * A real multi-staff barline is one continuous line from the top staff's top
 * line to the bottom staff's bottom line, running straight through the gaps
 * between staves with no visible break. Splitting it into one segment per
 * staff (rather than one staff drawing the whole tall line, or every staff
 * drawing a duplicate copy of it) is what keeps this compatible with
 * region-scoped redraw: each staff's own `LaidOutMeasure.region` bounds
 * exactly the pixels that staff's own redraw is allowed to touch, so a
 * barline segment two staves both needed to draw would make their regions
 * overlap, and redrawing one would clear (and never restore) part of the
 * other's ink. This is the same "split a run into independent halves at a
 * neutral boundary" shape M1 Slices 5-6 already used for a tie or slur
 * crossing a *measure* boundary; here the boundary being split is a *staff*
 * boundary instead.
 *
 * Every staff strictly between the first and last extends both upward (to
 * meet the staff above) and downward (to meet the staff below); the group's
 * first staff only extends downward, and its last only upward, since there is
 * nothing on the other side to meet.
 *
 * Naively splitting exactly at the gap's midpoint (using `SPACING.staffGap`'s
 * own fixed value on both sides) would make the two ink segments touch
 * exactly there, which sounds right but is not quite: `measureRegion` pads
 * *every* measure's computed ink extent by `REGION_BLEED_PX` on every side,
 * for antialiasing slack, with no awareness that one particular edge happens
 * to border another staff's own measure rather than blank margin. Two ink
 * segments touching at the same y would each then bleed `REGION_BLEED_PX`
 * *past* that shared point into the neighbour's own territory, so redrawing
 * one measure would clear (and never restore) a strip of the other's ink,
 * exactly the region conflict this whole function exists to avoid.
 *
 * The fix is to stop each segment's own ink `REGION_BLEED_PX` short of the
 * true midpoint on the side facing a neighbour, leaving a `2 *
 * REGION_BLEED_PX`-wide neutral strip that belongs to neither staff's ink.
 * Once `measureRegion` bleeds each side back out by that same amount, the two
 * regions land exactly flush (touching, not overlapping) at the true
 * midpoint, with neither drawing into the other's pixels. This is
 * deterministic from the same three inputs `relayoutMeasure` already has
 * (`staffIndex`, `staffCount`, this staff's own cached `staffTopY`) with no
 * need to also know what the *neighbouring* staff's content did, exactly
 * like the naive midpoint split it replaces.
 *
 * A repeat-start barline (`Measure.startBarline`, drawn by
 * `layoutRepeatStartBarline`) is deliberately excluded from this treatment:
 * it is rare enough, and this slice's own acceptance criteria narrow enough
 * (a shared *end* barline, not every barline shape), that leaving it a
 * per-staff, non-spanning line is a reasonable, documented scope cut rather
 * than doubling this function's own complexity for a shape nothing here
 * currently exercises.
 */
function barlineSpan(staffIndex: number, staffCount: number, staffTopY: number, ss: number): { top: number; bottom: number } {
	// Clamped at 0 defensively: only reachable at a `staffSpacePx` far smaller
	// than any real engraving use (`SPACING.staffGap` is 6 staff spaces, so
	// this would need `ss` under roughly a third of a pixel), where the two
	// ink segments would already be visually meaningless; better to have them
	// touch with zero neutral strip than to have this go negative and overlap
	// the wrong way.
	const halfGap = Math.max(0, (SPACING.staffGap * ss) / 2 - REGION_BLEED_PX);
	return {
		top: staffTopY - (staffIndex > 0 ? halfGap : 0),
		bottom: staffTopY + 4 * ss + (staffIndex < staffCount - 1 ? halfGap : 0)
	};
}

/** One `Part` (see `model/score.ts`) that draws a brace or bracket: a
 *  grouping of two or more staves, sorted ascending, plus which glyph shape
 *  it draws. See `computePartGroupDecorations`. */
interface PartGroupDecoration {
	readonly staffIndices: readonly number[];
	readonly glyph: 'brace' | 'bracket';
}

function isContiguous(indices: readonly number[]): boolean {
	for (let i = 1; i < indices.length; i++) {
		if (indices[i] !== indices[i - 1]! + 1) return false;
	}
	return true;
}

/**
 * Which of `score.parts` actually draw a brace or bracket at all, and which
 * shape each one gets (M2 Slice 5).
 *
 * A part grouping exactly one staff draws neither: real engraving never
 * brackets a solo staff, which is why `Part.staffIndices.length < 2` is
 * filtered out here rather than, say, drawing a zero-height glyph. A part
 * grouping staves that are not *contiguous* (e.g. `[0, 2]`, skipping a staff
 * that belongs to some other part) is also skipped: a brace/bracket is one
 * connecting shape, and there is no sensible single shape to draw across a
 * gap it does not actually span. This is a deliberate, documented scope cut,
 * not an oversight; nothing in this slice's own acceptance criteria
 * exercises a non-contiguous grouping.
 *
 * The glyph choice is this slice's own convention, spelled out in its own
 * scoping text: exactly two staves reads as a keyboard-style pair (a piano's
 * two staves) and gets the curly `brace`; three or more reads as a
 * choir/ensemble group (this slice's own SATB demo, four staves) and gets
 * the square `bracket`. Real engraving occasionally brackets a two-staff
 * *vocal* pair too, rather than bracing it, but nothing in this slice's own
 * acceptance criteria exercises that case, so the simpler staff-count-only
 * rule is what is built; see `layoutBrace`'s own comment for why a brace, not
 * a bracket, is specifically the right choice for a keyboard-style pair (a
 * bracket assembles from fixed-size pieces at any span; a brace is a single
 * glyph stretched to fit, which only stays a reasonable shape at the modest,
 * fixed span a two-staff group always has).
 *
 * Sorted broadest-group-first (most staves first): `layoutSystemPartDecorations`
 * lays multiple qualifying groups out left to right, and a wider, outer
 * grouping conventionally sits to the left of a narrower one nested inside
 * it (an orchestral family bracket outside its own sections' individual
 * ones). This slice's own demo only ever exercises one qualifying group, but
 * costs nothing to get right for more.
 */
function computePartGroupDecorations(score: Score): PartGroupDecoration[] {
	const groups: PartGroupDecoration[] = [];
	for (const part of score.parts) {
		if (part.staffIndices.length < 2) continue;
		const sorted = [...part.staffIndices].sort((a, b) => a - b);
		if (!isContiguous(sorted)) continue;
		groups.push({ staffIndices: sorted, glyph: sorted.length === 2 ? 'brace' : 'bracket' });
	}
	groups.sort((a, b) => b.staffIndices.length - a.staffIndices.length);
	return groups;
}

/**
 * The *solo* (single-staff) named `Part` that labels `staffIndex` on its own
 * row, if any, ties broken by whichever comes first in `score.parts`.
 *
 * Only ever a single-staff part: a part grouping two or more staves gets its
 * own name drawn once, centred on the whole group's span (see
 * `layoutSystemPartDecorations`'s own group-label pass below), never
 * repeated at every row it spans, which is what real engraving does for a
 * named keyboard/ensemble part (a piano's name is not printed twice, once
 * beside each of its own two staves). This split is what lets a choral score
 * give each voice its own label (Soprano, Alto, Tenor, Bass) even though
 * every one of those staves also belongs to one broader, typically unnamed,
 * bracket-only grouping `Part` spanning all four: the group's own pass and
 * this per-staff one never compete for the same row.
 */
function soloLabelForStaff(score: Score, staffIndex: number): Part | undefined {
	let best: Part | undefined;
	for (const part of score.parts) {
		if (!part.name || part.staffIndices.length !== 1) continue;
		if (!part.staffIndices.includes(staffIndex)) continue;
		if (!best) best = part;
	}
	return best;
}

/** Every label this score's part decorations draw: one entry per solo
 *  (single-staff) named `Part`, plus one per named multi-staff `Part`
 *  (drawn once, centred on its own group, never per staff; see
 *  `soloLabelForStaff`'s own comment). Shared by `computePartDecorationPlan`
 *  (which only needs the strings, to size the reserved label column) and
 *  `layoutSystemPartDecorations` (which also needs each one's own row). */
function collectPartLabels(
	score: Score
): readonly { readonly name: string; readonly staffIndices: readonly number[] }[] {
	const labels: { readonly name: string; readonly staffIndices: readonly number[] }[] = [];
	for (let staffIndex = 0; staffIndex < score.staves.length; staffIndex++) {
		const part = soloLabelForStaff(score, staffIndex);
		if (part?.name) labels.push({ name: part.name, staffIndices: [staffIndex] });
	}
	for (const part of score.parts) {
		if (part.name && part.staffIndices.length >= 2) labels.push({ name: part.name, staffIndices: part.staffIndices });
	}
	return labels;
}

/** See `PART_DECORATION.labelAvgCharWidthRatio`'s own comment on why this is
 *  an estimate, not a real measurement. */
function estimateTextWidthPx(text: string, fontSizePx: number): number {
	return text.length * fontSizePx * PART_DECORATION.labelAvgCharWidthRatio;
}

/**
 * The full, unsegmented vertical span, staff spaces, `staffCount` contiguous
 * staves occupy: every staff's own 4-space height, plus `SPACING.staffGap`
 * for every gap between them. Unlike `barlineSpan` (which deliberately
 * *splits* this same span into one segment per staff, for the region-safety
 * reasons spelled out in its own comment), a brace/bracket draws this whole
 * span as one shape from a single dedicated x-band no staff's own measure
 * ever touches (see `LaidOutScore.partDecorations`'s own comment), so it
 * never needs splitting at all.
 */
function groupSpanSpaces(staffCount: number): number {
	return staffCount * 4 + (staffCount - 1) * SPACING.staffGap;
}

/** The horizontal pixel width one part-grouping decoration's own column
 *  needs, at its own required span. See `layoutBracket`/`layoutBrace` for how
 *  each shape is actually drawn at that same width. */
function partGroupColumnWidth(group: PartGroupDecoration, ss: number): number {
	if (group.glyph === 'bracket') {
		// Fixed regardless of span: `layoutBracket` assembles a bracket from
		// fixed-size `bracketTop`/`bracketBottom` pieces plus a plain vertical
		// rect between them, so only the rect's *height* grows with the span,
		// never its width, and the hook pieces' own native width (their widest
		// point) is this column's constant footprint.
		return GLYPH_METRICS.bracketTop.bBoxNE[0] * ss;
	}
	// A brace is a single glyph, uniformly scaled (see `layoutBrace`'s own
	// comment on why not non-uniformly) to whatever height its own span needs;
	// its width scales by that exact same factor.
	const nativeHeight = GLYPH_METRICS.brace.bBoxNE[1] - GLYPH_METRICS.brace.bBoxSW[1];
	const scale = groupSpanSpaces(group.staffIndices.length) / nativeHeight;
	return GLYPH_METRICS.brace.advance * ss * scale;
}

/**
 * Draw a keyboard-style curly brace spanning canvas y `top`..`bottom`
 * (a two-staff group's full outer height) at horizontal offset `x`,
 * returning the x just past its own ink.
 *
 * Bravura's `brace` glyph is a single scalable shape, SMuFL's own
 * recommendation for exactly this case: rather than assembling it from
 * pieces the way `layoutBracket` does (a bracket's flat corners tolerate
 * that; a brace's continuous curve does not), it is meant to be stretched to
 * fit whatever span it needs to cover. This engine's glyphs are ordinary
 * font text drawn at one shared font size per redraw (`ctx.font`, set once
 * in `CanvasRenderer`), so stretching one glyph needs its own, one-off font
 * size instead of the shared one: `DrawOp`'s `glyph` variant carries an
 * optional `fontSizePx` override for exactly this, applied and restored by
 * the renderer around this one op.
 *
 * Real engraving scales a brace *non-uniformly* (vertically only, keeping
 * its width closer to natural) so a very tall brace does not also become
 * very wide. Scaling both axes together via plain font size, as this does,
 * is a deliberate, documented simplification: it is only ever used for a
 * *two*-staff group (see `computePartGroupDecorations`'s own comment on why
 * a 3+-staff group draws a `bracket` instead), whose span is always the same
 * fixed `groupSpanSpaces(2)` regardless of which two adjacent staves it
 * covers, so the resulting width is a known, modest constant rather than
 * something that could grow unboundedly on an arbitrarily large group.
 */
function layoutBrace(ops: DrawOp[], x: number, top: number, bottom: number, ss: number): number {
	const native = GLYPH_METRICS.brace;
	const nativeHeight = native.bBoxNE[1] - native.bBoxSW[1];
	const scale = (bottom - top) / (nativeHeight * ss);
	const fontSizePx = ss * STAFF_SPACES_PER_EM * scale;
	// The glyph's own bottom edge sits `bBoxSW[1]` above its origin (see
	// `glyphBounds`'s own convention: canvas bottom = origin - bBoxSW[1] *
	// scaled-ss); solving for the origin that lands that edge exactly on
	// `bottom` is what makes the stretched glyph's ink span `top`..`bottom`
	// exactly, not merely approximately.
	const originY = bottom + native.bBoxSW[1] * ss * scale;
	ops.push({ kind: 'glyph', glyph: 'brace', x, y: originY, fontSizePx });
	return x + native.advance * ss * scale;
}

/**
 * Draw a choir/ensemble square bracket spanning canvas y `top`..`bottom` at
 * horizontal offset `x`, returning the x just past its own ink.
 *
 * Assembled from three pieces, not one scaled glyph (contrast `layoutBrace`):
 * Bravura's `bracketTop`/`bracketBottom` hooks are fixed-size end pieces
 * (their own native metrics never change), joined by a plain vertical rect
 * whose *height* grows to whatever the span needs, the same
 * hand-drawn-rect-at-the-font's-own-thickness approach every other straight
 * line in this file (staff lines, stems, barlines, beams) already uses. This
 * keeps the hooks' own corners crisp at any span, where scaling a single
 * `bracket` glyph (which Bravura also publishes) would stretch and distort
 * them for anything but that glyph's one native size.
 *
 * `bracketTop`'s own origin sits at its *bottom* edge (`bBoxSW = [0, 0]`) and
 * `bracketBottom`'s at its *top* edge (`bBoxNE = [.., 0]`): placing each
 * origin at the spine's own top/bottom end, inset from `top`/`bottom` by the
 * hook's own height, makes the hook curl outward from there, its outer edge
 * landing exactly on `top`/`bottom`.
 */
function layoutBracket(ops: DrawOp[], x: number, top: number, bottom: number, ss: number): number {
	const hookHeight = GLYPH_METRICS.bracketTop.bBoxNE[1] * ss;
	const spineTop = top + hookHeight;
	const spineBottom = bottom - hookHeight;
	const spineWidth = ED.bracketThickness * ss;
	ops.push({ kind: 'glyph', glyph: 'bracketTop', x, y: spineTop });
	ops.push({ kind: 'rect', x, y: spineTop, width: spineWidth, height: Math.max(0, spineBottom - spineTop) });
	ops.push({ kind: 'glyph', glyph: 'bracketBottom', x, y: spineBottom });
	return x + GLYPH_METRICS.bracketTop.bBoxNE[0] * ss;
}

/**
 * How much horizontal room, and which groups/labels, this score's part
 * decorations need: computed once for the whole score (not per system), so
 * every system reserves the identical left margin whether or not it actually
 * draws the label at that system (see `layoutSystemPartDecorations`'s own
 * comment on the system-1-only label rule). Real engraving keeps a
 * bracketed score's systems visually aligned the same way.
 *
 * Zero (`headerWidth` reducing to 0) when the score has no multi-staff `Part`
 * and no named `Part` at all, which is every score before this slice (and
 * still the common case): `layoutScore`'s own `x = padding + headerWidth`
 * then reduces to plain `padding`, reproducing the exact layout this
 * function's caller always produced.
 */
interface PartDecorationPlan {
	readonly groups: readonly PartGroupDecoration[];
	readonly bracketAreaWidth: number;
	readonly labelColumnWidth: number;
	readonly labelFontSizePx: number;
	readonly headerWidth: number;
}

function computePartDecorationPlan(score: Score, ss: number): PartDecorationPlan {
	const groups = computePartGroupDecorations(score);
	let bracketAreaWidth = 0;
	for (const group of groups) {
		bracketAreaWidth += partGroupColumnWidth(group, ss) + PART_DECORATION.columnGap * ss;
	}
	const labelFontSizePx = PART_DECORATION.labelFontSizeSpaces * ss;
	let maxLabelWidth = 0;
	for (const label of collectPartLabels(score)) {
		maxLabelWidth = Math.max(maxLabelWidth, estimateTextWidthPx(label.name, labelFontSizePx));
	}
	const labelColumnWidth = maxLabelWidth > 0 ? maxLabelWidth + PART_DECORATION.labelGap * ss : 0;
	return { groups, bracketAreaWidth, labelColumnWidth, labelFontSizePx, headerWidth: bracketAreaWidth + labelColumnWidth };
}

/**
 * Build one system's own part-decoration ops: every qualifying group's
 * brace/bracket (drawn at *every* system, real engraving's own convention),
 * plus, only when `isFirstSystem`, each labelled staff's own name.
 *
 * The label's system-1-only rule is the one place this function's own
 * behaviour actually varies by system; everything about *where* things sit
 * (`plan`'s own widths, computed once for the whole score) stays identical
 * across every system, which is what keeps a bracketed score's systems
 * visually aligned down the page even though only the first one carries
 * text.
 *
 * `staffTopYs` is this system's own pre-`shiftY` top-line y per staff index
 * (captured by `layoutScore` during its own per-staff loop, before it moves
 * on to the next staff's `staffTopY`); the returned ops are in that same
 * provisional frame and get the same final `shiftY` translation every
 * measure op already does.
 */
function layoutSystemPartDecorations(
	score: Score,
	ss: number,
	plan: PartDecorationPlan,
	staffTopYs: readonly number[],
	leftX: number,
	isFirstSystem: boolean
): DrawOp[] {
	const ops: DrawOp[] = [];
	let x = leftX;
	for (const group of plan.groups) {
		const top = staffTopYs[group.staffIndices[0]!]!;
		const bottom = staffTopYs[group.staffIndices[group.staffIndices.length - 1]!]! + 4 * ss;
		x = (group.glyph === 'brace' ? layoutBrace : layoutBracket)(ops, x, top, bottom, ss);
		x += PART_DECORATION.columnGap * ss;
	}
	if (isFirstSystem) {
		const labelRightEdge = leftX + plan.bracketAreaWidth + plan.labelColumnWidth - PART_DECORATION.labelGap * ss;
		for (const label of collectPartLabels(score)) {
			const width = estimateTextWidthPx(label.name, plan.labelFontSizePx);
			// A solo (single-staff) label's row is that one staff's own top; a
			// multi-staff label (see `collectPartLabels`'s own comment on why it
			// is drawn once, not per staff) instead uses the *centre* of its
			// whole group's outer span, so the name reads as belonging to the
			// group as a whole rather than favouring whichever staff happens to
			// be first.
			const groupTop = staffTopYs[Math.min(...label.staffIndices)]!;
			const groupBottom = staffTopYs[Math.max(...label.staffIndices)]! + 4 * ss;
			const rowTop = label.staffIndices.length === 1 ? groupTop : (groupTop + groupBottom) / 2 - 2 * ss;
			ops.push({
				kind: 'text',
				text: label.name,
				x: labelRightEdge - width,
				// Roughly vertically centred on the row: a baseline a little below
				// its own middle line, nudged down further by a fraction of the
				// font size to visually balance the ascenders and descenders a
				// real instrument name mixes (capital initial letter, no
				// descenders, in most names this slice's own demo uses).
				y: rowTop + 2 * ss + plan.labelFontSizePx * 0.35,
				fontSizePx: plan.labelFontSizePx
			});
		}
	}
	return ops;
}

/**
 * Lay a whole score out: every system a horizontal row of every staff's own
 * measures, tightly stacked (M2 Slice 4), cast off into as many systems as
 * `options.systemWidthPx` demands (`planSystems`).
 *
 * Real multi-staff engraving interleaves staves *within* a system rather
 * than laying each staff out as its own independent, self-contained block
 * (M2 Slice 3's own placeholder, which this replaces): every staff's own
 * portion of the *same* set of measures stacks directly below the previous
 * staff's, sharing one barline per measure boundary, and the whole stacked
 * group repeats below for the next system. A single-staff score (every score
 * before this slice, and still the common case) is the one-staff-per-group
 * degenerate case of all of this: no staff to stack against, no barline
 * segment to split (`barlineSpan` returns exactly `staffTopY`/`staffTopY +
 * 4 * ss`, unchanged from before this slice), reproducing the exact same
 * result `layoutScore` always produced.
 *
 * System membership (which measures land in which system) is decided *once*
 * for the whole score, off staff 0 alone, not independently per staff: a
 * shared system only makes sense if every staff agrees on where it starts
 * and ends, and `planSystems`'s own width-probing already assumes one
 * measure count and one score-wide key/time/barline sequence (M1 Slices
 * 7-8), which every staff in practice shares. This is also why every staff
 * in a `Score` is required to have the same number of measures (checked
 * below, not silently assumed): a staff with a different measure count would
 * have no coherent claim to be "in system 3" at all. Flagged as a real scope
 * boundary, not an oversight: a future divisi split with genuinely different
 * measure counts per staff is out of this slice's scope.
 *
 * Within one system, every measure column's *width* is also shared across
 * every staff, not decided independently per staff: a single barline spanning
 * the group (`barlineSpan`, above) is only geometrically meaningful if every
 * staff's version of that boundary sits at the same x. Each staff still lays
 * its own notes out at its own natural spacing (`layoutMeasure`, unchanged);
 * the *narrower* staff at a given column (e.g. a bass clef's smaller header,
 * or simply fewer/shorter notes) then has its own trailing space padded out
 * to match the widest staff's natural width for that same column
 * (`columnWidth` below), rather than every staff's notes being re-scaled to
 * force identical column widths. This is a deliberate, simpler choice than a
 * true cross-staff justification pass: it keeps each staff's own optical
 * spacing exactly what `layoutMeasure` would have produced alone, at the
 * cost of not forcing note-for-note x-alignment between two staves whose own
 * content genuinely differs (which nothing in this slice's own acceptance
 * criteria asks for).
 */
export function layoutScore(score: Score, options: LayoutOptions = {}): LaidOutScore {
	const ss = options.staffSpacePx ?? DEFAULTS.staffSpacePx;
	const padding = options.paddingPx ?? DEFAULTS.paddingPx;
	const fontSizePx = ss * STAFF_SPACES_PER_EM;
	const staffCount = score.staves.length;

	if (staffCount === 0) {
		return {
			width: 0,
			height: 0,
			staffSpacePx: ss,
			staffTopY: padding,
			fontSizePx,
			measures: [],
			systems: [],
			partDecorations: []
		};
	}

	const measureCount = score.staves[0]!.measures.length;
	for (let s = 1; s < staffCount; s++) {
		if (score.staves[s]!.measures.length !== measureCount) {
			throw new Error(
				`layoutScore: staff ${s} has ${score.staves[s]!.measures.length} measures, staff 0 has ` +
					`${measureCount}. M2 Slice 4's interleaved multi-staff layout decides system membership ` +
					`once for the whole score (see this function's own doc comment), which needs every staff ` +
					`to agree on how many measures it has; a score with genuinely different per-staff measure ` +
					`counts is out of this slice's scope.`
			);
		}
	}

	// Decided once, off staff 0, for the reason explained in this function's
	// own doc comment: every staff shares one system membership.
	const systemPlans = planSystems(score, 0, ss, padding, options.systemWidthPx);

	// M2 Slice 5: how much left margin every system reserves for a
	// brace/bracket plus part-name labels, decided once for the whole score
	// (see `computePartDecorationPlan`'s own comment). Not fed into
	// `planSystems`/`probeMeasureWidth`/`systemSpacingScale`'s own width
	// budgeting above, which still assumes a system's note content starts at
	// plain `padding`: a documented scope cut, not an oversight. A score that
	// combines `systemWidthPx` casting-off with a bracketed/labelled part
	// therefore renders `decorationPlan.headerWidth` pixels wider than
	// `systemWidthPx` asks for, rather than the header eating into the note
	// content's own budget; nothing in this slice's own acceptance criteria
	// exercises that combination, and getting it exactly right would mean
	// threading a second, asymmetric margin through three functions whose
	// signatures nothing else in this slice needs touched.
	const decorationPlan = computePartDecorationPlan(score, ss);

	const measures: LaidOutMeasure[] = [];
	const systems: { measureIndices: number[]; topY: number; spacingScale: number; staffIndex: number }[] = [];
	const partDecorationOps: DrawOp[] = [];
	// Which system each measure lands in (M6 Slice 6): a hairpin crossing a
	// system break is drawn one segment per system.
	const systemOf: number[] = [];
	systemPlans.forEach((plan, i) => {
		for (const m of plan) systemOf[m] = i;
	});

	// Provisional frame: the very first staff's own nominal top is 0, and the
	// whole score is shifted down by `shiftY` at the very end, the same
	// "lay out at 0, then translate" trick Slice 3 used per staff, now done
	// once for the whole interleaved score (ledger lines/stems/a beam can
	// reach above the top staff's own top line by an amount not known until
	// after laying it out).
	let groupTopY = 0;

	for (let systemIndex = 0; systemIndex < systemPlans.length; systemIndex++) {
		const plan = systemPlans[systemIndex]!;
		const isLastSystem = systemIndex === systemPlans.length - 1;

		// Each staff's own justification scale for this system, independent
		// per staff (unchanged from Slice 3/9): a sparser staff stretches more
		// than a denser one to reach the same `systemWidthPx` target.
		const scales = score.staves.map((_, staffIndex) =>
			systemSpacingScale(score, staffIndex, plan, ss, padding, options.systemWidthPx, isLastSystem)
		);

		// Every staff's own natural (pre-column-sharing) width for every
		// measure in this system, at that staff's own decided scale: what
		// `layoutMeasure` would produce completely on its own, before the
		// cross-staff column-width sharing below pads a narrower staff out.
		const naturalWidths = score.staves.map((staff, staffIndex) =>
			plan.map((measureIndex) => {
				const measure = staff.measures[measureIndex]!;
				return probeMeasureWidth(
					score,
					staffIndex,
					measure,
					ss,
					{
						isSystemFirst: measureIndex === plan[0],
						isScoreFirst: measureIndex === 0,
						isLast: measureIndex === staff.measures.length - 1
					},
					scales[staffIndex]
				);
			})
		);
		// The shared width every staff's own version of a given measure column
		// renders at (see this function's own doc comment on why padding, not
		// re-scaling, closes the gap for whichever staff was narrower here).
		const columnWidths = plan.map((_measureIndex, col) => Math.max(...naturalWidths.map((row) => row[col]!)));

		let staffTopY = groupTopY;
		let groupBottom = groupTopY;
		// This system's own pre-shift `staffTopY` per staff index, captured as
		// each staff is laid out: `layoutSystemPartDecorations` (below, once
		// this loop finishes) needs every staff's top in one place to work out
		// a group's own outer span.
		const staffTopYs: number[] = [];
		for (let staffIndex = 0; staffIndex < staffCount; staffIndex++) {
			const staff = score.staves[staffIndex]!;
			const span = barlineSpan(staffIndex, staffCount, staffTopY, ss);
			staffTopYs.push(staffTopY);

			let x = padding + decorationPlan.headerWidth;
			const rowMeasures: LaidOutMeasure[] = [];
			for (let col = 0; col < plan.length; col++) {
				const measureIndex = plan[col]!;
				const measure = staff.measures[measureIndex]!;
				// Per measure, not per staff row (M5 Slice 5): a clef change can
				// land anywhere in a system, so each measure resolves its own.
				const clef = score.clefAt(measureIndex, staffIndex);
				const laid = layoutMeasure(score, measure, {
					ss,
					staffTopY,
					startX: x,
					isSystemFirst: measureIndex === plan[0],
					isScoreFirst: measureIndex === 0,
					isLast: measureIndex === staff.measures.length - 1,
					spacingScale: scales[staffIndex],
					staffIndex,
					clef,
					lines: CLEF_LINES[clef],
					columnWidth: columnWidths[col],
					barlineTop: span.top,
					barlineBottom: span.bottom
				});
				rowMeasures.push(laid);
				x = laid.region.x + laid.region.width;
			}
			// Dynamics and hairpins (M6 Slice 6), once the row's measures exist:
			// they line up across the row and a hairpin spans measures.
			const directed = layoutDirectionRow(score, { staffIndex, measures: rowMeasures, staffTopY, ss, systemOf });
			rowMeasures.splice(0, rowMeasures.length, ...directed);
			measures.push(...rowMeasures);
			systems.push({ measureIndices: [...plan], topY: staffTopY, spacingScale: scales[staffIndex]!, staffIndex });

			const rowBottom = Math.max(staffTopY + 4 * ss, ...rowMeasures.map((m) => m.region.y + m.region.height));
			groupBottom = Math.max(groupBottom, rowBottom);
			// Next staff's own top is a fixed offset from *this* staff's own
			// nominal bottom (not `rowBottom`'s ink-aware one): see
			// `SPACING.staffGap`'s own comment on why this has to stay
			// deterministic, computable before any staff's content is laid
			// out, for `barlineSpan`'s split point to have no circular
			// dependency on it.
			if (staffIndex < staffCount - 1) staffTopY = staffTopY + 4 * ss + SPACING.staffGap * ss;
		}

		partDecorationOps.push(
			...layoutSystemPartDecorations(score, ss, decorationPlan, staffTopYs, padding, systemIndex === 0)
		);

		groupTopY = groupBottom + SPACING.systemGap * ss;
	}

	const top = Math.min(0, ...measures.map((m) => m.region.y));
	const shiftY = padding - top;
	const shiftedMeasures = measures.map((m) => translateMeasure(m, shiftY));
	const shiftedSystems = systems.map((s) => ({ ...s, topY: s.topY + shiftY }));
	// Part decorations never reach above the topmost measure's own region (a
	// brace/bracket's ink is bounded exactly to its own staves' span by
	// construction, and a label sits well inside its own staff's band; see
	// `layoutBrace`/`layoutBracket`/`layoutSystemPartDecorations`'s own
	// comments), so they need only the same `shiftY` every measure op already
	// gets, never a second pass over `top`.
	const shiftedPartDecorationOps = translateOps(partDecorationOps, shiftY);

	const width = Math.max(padding * 2, ...shiftedMeasures.map((m) => m.region.x + m.region.width + padding));
	// Already in shifted (final) coordinates, so the shifted top sits at
	// exactly `padding` (that is what `shiftY` was chosen to guarantee: the
	// unshifted `top` moves to `top + shiftY === padding`); `bottom + padding`
	// therefore reproduces the same "content height plus a margin on each
	// side" `bottom - top + padding * 2` always computed, just read directly
	// off values already in the frame the caller sees.
	const bottom = Math.max(
		...shiftedSystems.map((s) => s.topY + 4 * ss),
		...shiftedMeasures.map((m) => m.region.y + m.region.height)
	);

	return {
		width,
		height: bottom + padding,
		staffSpacePx: ss,
		staffTopY: shiftedSystems[0]!.topY,
		fontSizePx,
		measures: shiftedMeasures,
		systems: shiftedSystems,
		partDecorations: shiftedPartDecorationOps
	};
}

/**
 * The justification factor a system's notes get stretched (or, rarely, very
 * mildly compressed) by, so the system's measures collectively fill
 * `systemWidthPx` exactly instead of leaving a ragged right edge at whatever
 * width natural spacing happens to produce.
 *
 * Real engraving justifies every system except the last: a piece's final
 * line, like the final line of justified prose, is left at its own natural
 * width rather than stretched thin to fill a margin it was never going to
 * reach. That convention is reproduced here by simply always returning `1`
 * (natural, unscaled spacing) for `isLastSystem`, which also means a score
 * laid out with no `systemWidthPx` at all (`planSystems` then reports exactly
 * one system, and it is always "last") needs no separate case: it already
 * falls out of this same rule, matching Phase 0's original single-system,
 * naturally-spaced behaviour with no extra branch.
 *
 * The factor is meant to multiply every note's own natural advance (see
 * `noteAdvanceSpaces`), not a measure's fixed margins (lead-in, trail-out,
 * header spacing): stretching only the note-to-note space is what makes a
 * whole note absorb proportionally more of the slack than an eighth note
 * (its natural advance is already bigger, so the same factor adds more to
 * it), and is also why this never pads a measure's edges to make up a
 * shortfall.
 *
 * Solved with a single linear estimate, not iteratively: true final width at
 * a given scale can differ very slightly from this estimate whenever a
 * note's accidental-collision clearance (`layoutNote`'s `collisionShift`)
 * would or would not trigger at that scale. Stretching only ever *removes*
 * the need for that clearance (more natural room between notes), never adds
 * it, so the estimate is safe in the direction that matters; real engraving
 * software solves this properly with iterative passes, out of scope here.
 * Collision shifts are already the rare exception this file's own spacing
 * constants are tuned around (see `SPACING.minAccidentalClearance`), so in
 * practice the estimate lands within the "small tolerance" this slice's
 * acceptance criteria ask for.
 */
function systemSpacingScale(
	score: Score,
	staffIndex: number,
	plan: readonly number[],
	ss: number,
	padding: number,
	systemWidthPx: number | undefined,
	isLastSystem: boolean
): number {
	if (systemWidthPx === undefined || isLastSystem) return 1;

	const staffMeasures = score.staves[staffIndex]!.measures;
	let naturalWidth = 0;
	let advanceSpaces = 0;
	for (const measureIndex of plan) {
		const measure = staffMeasures[measureIndex]!;
		naturalWidth += probeMeasureWidth(score, staffIndex, measure, ss, {
			isSystemFirst: measureIndex === plan[0],
			isScoreFirst: measureIndex === 0,
			isLast: measureIndex === staffMeasures.length - 1
		});
		// Sum the shared *columns'* widths (M2 Slice 1), not every voice's
		// every note's own advance: a two-voice measure's notes no longer form
		// one timeline, and summing per note across both voices would
		// double-count whatever beat they share, inflating this denominator
		// and under-stretching the system relative to what `naturalWidth`
		// (computed by `probeMeasureWidth`, which already lays the measure out
		// through the same column logic) actually needs filled.
		for (const column of measureColumns(measure.notes)) advanceSpaces += column.width;
	}
	// An entirely note-free plan (nothing to stretch) has no sensible scale;
	// natural spacing is already whatever this system is going to look like.
	if (advanceSpaces <= 0) return 1;

	const availableWidth = systemWidthPx - 2 * padding;
	const rawScale = 1 + (availableWidth - naturalWidth) / (advanceSpaces * ss);
	// Guards the one case `planSystems` allows to exceed `availableWidth`: a
	// single measure too wide to fit even alone, which cannot be split across
	// systems. Compressing it by more than half would start visibly crowding
	// noteheads together, well past the "very mildly compressed" this slice's
	// own scope asks for; not expected to be hit by an ordinary casting-off.
	return Math.max(rawScale, 0.5);
}

/**
 * Decide which measures belong to which system, without doing the real
 * layout pass yet.
 *
 * Greedy casting-off: keep adding measures to the current system while they
 * fit, start a new one the moment the next measure would overflow. A system
 * always gets at least one measure, even an oversized one, because a measure
 * cannot be split.
 *
 * The width a measure needs depends on whether it opens a system (clef + key,
 * see `layoutMeasure`), which is exactly the thing being decided, so each
 * candidate measure's width is computed twice, once for each case, and the
 * one matching where it actually lands is used. Reusing `layoutMeasure` at a
 * throwaway `startX` of 0 keeps this in one place rather than duplicating the
 * width arithmetic.
 */
function planSystems(
	score: Score,
	staffIndex: number,
	ss: number,
	padding: number,
	systemWidthPx: number | undefined
): number[][] {
	const staffMeasures = score.staves[staffIndex]!.measures;
	if (systemWidthPx === undefined) return [staffMeasures.map((m) => m.index)];

	const availableWidth = systemWidthPx - 2 * padding;
	const systems: number[][] = [];
	let current: number[] = [];
	let currentWidth = 0;

	for (const measure of staffMeasures) {
		const isScoreFirst = measure.index === 0;
		const isLast = measure.index === staffMeasures.length - 1;
		const widthAsSystemFirst = probeMeasureWidth(score, staffIndex, measure, ss, {
			isSystemFirst: true,
			isScoreFirst,
			isLast
		});

		if (current.length === 0) {
			current.push(measure.index);
			currentWidth = widthAsSystemFirst;
			continue;
		}

		const widthAsMidSystem = probeMeasureWidth(score, staffIndex, measure, ss, {
			isSystemFirst: false,
			isScoreFirst: false,
			isLast
		});

		if (currentWidth + widthAsMidSystem > availableWidth) {
			systems.push(current);
			current = [measure.index];
			currentWidth = widthAsSystemFirst;
		} else {
			current.push(measure.index);
			currentWidth += widthAsMidSystem;
		}
	}
	if (current.length > 0) systems.push(current);
	return systems;
}

/**
 * A measure's width in isolation, for the casting-off decision in
 * `planSystems`. Delegates entirely to `layoutMeasure`, so a two-voice
 * measure's width automatically reflects the shared onset columns
 * `layoutMeasure` itself now lays notes out against (see `measureColumns`)
 * rather than this function needing its own separate note-summing logic to
 * keep in sync.
 *
 * `spacingScale` (M2 Slice 4) is only ever passed by `layoutScore`'s own
 * `naturalWidths` probe, which needs each staff's *natural* width at its
 * already-decided justification scale, to feed `columnWidth`'s cross-staff
 * max; `planSystems`'s own casting-off probes (below) always omit it, since
 * a system's scale is not yet decided at the point casting-off runs.
 */
function probeMeasureWidth(
	score: Score,
	staffIndex: number,
	measure: Measure,
	ss: number,
	flags: { isSystemFirst: boolean; isScoreFirst: boolean; isLast: boolean },
	spacingScale?: number
): number {
	const clef = score.clefAt(measure.index, staffIndex);
	return layoutMeasure(score, measure, {
		ss,
		staffTopY: 0,
		startX: 0,
		...flags,
		spacingScale,
		staffIndex,
		clef,
		lines: CLEF_LINES[clef]
	}).region.width;
}

/**
 * The vertical band a system's own content may occupy without a re-laid-out
 * measure spilling into a neighbouring system.
 *
 * Bounded by the neighbouring systems' *actual* laid-out extent (not their
 * nominal staff band), so a neighbour with tall ledger lines still leaves the
 * right amount of room. The score's first and last systems are bounded by the
 * canvas itself, which is exactly the single-system check this replaces.
 *
 * `staffSystems`/`systemIndex` (M2 Slice 3) are already scoped to one staff's
 * own systems (see `relayoutMeasure`, the only caller): `layout.systems` is
 * now a merge of every staff's own systems concatenated together, so walking
 * neighbours in that flat array directly would, at a staff's own first or
 * last system, incorrectly treat an unrelated *other* staff's adjacent system
 * as this one's neighbour. `layout.measures` itself has no such problem
 * (every lookup below names an exact `(staffIndex, i)` pair), only the
 * system-neighbour walk does.
 */
function systemBounds(
	layout: LaidOutScore,
	staffIndex: number,
	staffSystems: readonly { readonly measureIndices: readonly number[] }[],
	systemIndex: number
): { top: number; bottom: number } {
	const extent = (measureIndices: readonly number[], pick: 'top' | 'bottom') =>
		measureIndices.map((i) => {
			const m = layout.measures.find((mm) => mm.staffIndex === staffIndex && mm.index === i)!;
			return pick === 'top' ? m.region.y : m.region.y + m.region.height;
		});

	const prev = staffSystems[systemIndex - 1];
	const next = staffSystems[systemIndex + 1];
	// A staff's own last system falls back to the canvas edge, not the *next
	// staff's* own first system, when one exists: known gap, flagged in
	// `layoutScore`'s own comment on the naive block-stacking this slice
	// builds (real per-staff overflow bounding across a staff boundary is
	// M2 Slice 4 territory, once staves are actually interleaved per system).
	return {
		top: prev ? Math.max(...extent(prev.measureIndices, 'bottom')) : 0,
		bottom: next ? Math.min(...extent(next.measureIndices, 'top')) : layout.height
	};
}

/**
 * Re-lay-out a single measure in place, the layout half of an incremental edit.
 *
 * Redrawing one measure is only a win if working out *what* to redraw is also
 * cheap. Calling `layoutScore` after every keystroke would put the whole score
 * back on the critical path and leave the engine with OSMD's cost curve, just
 * with a smaller constant.
 *
 * Returns `null` when the edit changed the measure's geometry (its width, or
 * how far it reaches above or below the system) rather than only its contents.
 * That is the honest boundary of a single-measure update: a wider measure moves
 * every measure after it, and a taller one resizes the canvas, so the caller
 * has to fall back to `layoutScore` and a full repaint. Phase 0's one edit op
 * never changes a measure's width, because note spacing depends on duration and
 * an accidental is drawn inside the note's own horizontal cell. A duration
 * edit, which Phase 1 will have, hits this path constantly, and reflowing a
 * system incrementally is the real work behind it.
 *
 * Slice 9's justification does not change this shape. This measure is re-laid
 * out at its system's already-decided `spacingScale` (read off the cached
 * `LaidOutScore.systems` entry, not recomputed), so an edit that leaves this
 * measure's own natural width unchanged (a transpose, say: it can add or
 * remove an accidental, but not this measure's note-to-note advances) still
 * reproduces the exact same width and takes the fast, single-measure path,
 * exactly as before justification existed. An edit that *does* change this
 * measure's natural width (a duration change, not built until a later slice)
 * changes its width even measured with the stale scale, so `widthChanged`
 * still catches it honestly and falls back to a full `layoutScore`, which
 * recomputes fresh, correct scale factors for every system. That fallback is
 * the whole score, not just the one system this measure lives in, the same
 * as it always was: no new "relayout one system" fast path exists yet, so a
 * width-changing edit's cost is unchanged by this slice, not narrowed.
 *
 * `staffIndex` (M2 Slice 3, default 0) says *which staff's* `measureIndex`
 * to re-lay-out, completing the `(staffIndex, measureIndex)` addressing pair
 * `LaidOutMeasure` now carries; every call site from before this slice omits
 * it and keeps editing staff 0, exactly as before.
 */
export function relayoutMeasure(
	score: Score,
	layout: LaidOutScore,
	measureIndex: number,
	options: LayoutOptions = {},
	staffIndex = 0
): LaidOutScore | null {
	const staff = score.staves[staffIndex];
	const measure = staff?.measures[measureIndex];
	const previous = layout.measures.find((m) => m.staffIndex === staffIndex && m.index === measureIndex);
	const staffSystems = layout.systems.filter((s) => s.staffIndex === staffIndex);
	const systemIndex = staffSystems.findIndex((s) => s.measureIndices.includes(measureIndex));
	const system = staffSystems[systemIndex];
	if (!staff || !measure || !previous || !system) return null;

	const clef = score.clefAt(measureIndex, staffIndex);
	const ss = options.staffSpacePx ?? DEFAULTS.staffSpacePx;
	// M2 Slice 6 fix: a shared end barline's own span (see `barlineSpan`) is a
	// pure function of (staffIndex, staffCount, staffTopY, ss), exactly the
	// inputs already available here, so it costs nothing to recompute and
	// pass through. Before this fix, a scoped redraw of any measure in a
	// multi-staff score silently reverted that measure's shared end-barline
	// ink back to the single-staff band (staffTopY to staffTopY + 4*ss)
	// instead of its correct shared span, a latent bug from M2 Slice 4 that
	// nothing caught because no existing test exercised `relayoutMeasure` on
	// a measure whose barline is actually shared across staves. `columnWidth`
	// is left alone: fixing it would need probing every other staff's own
	// natural width at this column, which is out of this slice's scope; that
	// remains a separate, documented, pre-existing gap.
	const span = barlineSpan(staffIndex, score.staves.length, system.topY, ss);
	const base = layoutMeasure(score, measure, {
		ss,
		staffTopY: system.topY,
		startX: previous.region.x,
		isSystemFirst: system.measureIndices[0] === measureIndex,
		isScoreFirst: measureIndex === 0,
		isLast: measureIndex === staff.measures.length - 1,
		spacingScale: system.spacingScale,
		staffIndex,
		clef,
		lines: CLEF_LINES[clef],
		barlineTop: span.top,
		barlineBottom: span.bottom
	});

	// Dynamics and hairpins (M6 Slice 6), redone for this measure against its
	// cached neighbours in the system. Their shared baseline depends on every
	// marked measure's ink, so if this edit moved it, every other marked
	// measure in the system is stale too: that is a full relayout, not a
	// single-measure one.
	let laid = base;
	const first = system.measureIndices[0]!;
	const last = system.measureIndices[system.measureIndices.length - 1]!;
	if (rowHasDirections(score, staffIndex, first, last)) {
		const systemOf: number[] = [];
		staffSystems.forEach((s, i) => {
			for (const m of s.measureIndices) systemOf[m] = i;
		});
		const cached = (i: number) => layout.measures.find((m) => m.staffIndex === staffIndex && m.index === i)!;
		const before: DirectionRow = { staffIndex, measures: system.measureIndices.map(cached), staffTopY: system.topY, ss, systemOf };
		const after: DirectionRow = {
			...before,
			measures: system.measureIndices.map((i) => (i === measureIndex ? base : cached(i)))
		};
		const old = directionBaselines(score, before);
		const baselines = directionBaselines(score, after);
		// Sub-pixel tolerance, as for the width below: the cached extents went
		// through `layoutScore`'s final translation, this one did not.
		const moved = (a: number | null, b: number | null): boolean =>
			a === null || b === null ? a !== b : Math.abs(a - b) > 0.001;
		if (moved(old.above, baselines.above) || moved(old.below, baselines.below)) return null;
		laid = withDirectionOps(base, directionOpsForMeasure(score, after, baselines, base), system.topY, ss);
	}

	// Sub-pixel tolerance: the same arithmetic run twice should agree exactly,
	// but a width comparison is not worth making brittle over a float.
	const widthChanged = Math.abs(laid.region.width - previous.region.width) > 0.001;
	// The band this measure's system may use without spilling into a
	// neighbouring system. For a single-system score this is exactly the
	// canvas itself, i.e. the original single-system check.
	const bounds = systemBounds(layout, staffIndex, staffSystems, systemIndex);
	const overflows = laid.region.y < bounds.top || laid.region.y + laid.region.height > bounds.bottom;
	if (widthChanged || overflows) return null;

	return {
		...layout,
		measures: layout.measures.map((m) =>
			m.staffIndex === staffIndex && m.index === measureIndex ? laid : m
		)
	};
}

interface MeasureContext {
	readonly ss: number;
	readonly staffTopY: number;
	readonly startX: number;
	/** Does this measure open its system, so it must draw the clef and key signature. */
	readonly isSystemFirst: boolean;
	/** Is this the score's true first measure, so it must also draw the time signature. */
	readonly isScoreFirst: boolean;
	readonly isLast: boolean;
	/**
	 * The justification factor `layoutNote` multiplies every note's natural
	 * advance by (see `noteAdvanceSpaces`), decided once per system by
	 * `systemSpacingScale` so a system's measures collectively fill
	 * `systemWidthPx` instead of leaving a ragged right edge. Omitted (or 1)
	 * for natural, unjustified spacing: `probeMeasureWidth`'s casting-off
	 * probes always want the natural width, never a guessed-at scale, and a
	 * caller laying out a single measure in isolation (tests, mostly) gets
	 * the same natural spacing it always has.
	 */
	readonly spacingScale?: number;
	/** Which staff (`Score.staves`) this measure belongs to (M2 Slice 3's
	 *  `(staffIndex, measureIndex)` addressing scheme): 0 for a single-staff
	 *  score, the default and still-common case. Every `score.keyFifthsAt`/
	 *  `timeAt`/`endBarlineAt` call in this file reads this rather than the
	 *  implicit-staff-0 default those methods otherwise fall back to. */
	readonly staffIndex: number;
	/** The clef in force at *this measure* (`Score.clefAt`, M5 Slice 5; it
	 *  was `staves[staffIndex]`'s single clef before a measure could change
	 *  it): drives `layoutClef`'s glyph and the key-signature octave table
	 *  (`KEY_SIGNATURE_OCTAVES`); see `lines` for the derived line/ledger
	 *  positions it also determines. */
	readonly clef: ClefType;
	/** `CLEF_LINES[clef]`, precomputed once per measure rather than looked up
	 *  repeatedly: every note/ledger/stem-direction calculation below reads
	 *  this instead of a treble-only constant. */
	readonly lines: ClefLines;
	/**
	 * The pixel width this measure's *column* is laid out at, when it is part
	 * of a multi-staff system whose staves share one barline per column (M2
	 * Slice 4; see `layoutScore`'s own doc comment on `columnWidth`). Omitted
	 * for a single-staff score (or any standalone probe, e.g. `planSystems`'s
	 * own width-probing, or a test laying out one measure in isolation), which
	 * keeps this measure's own natural width, exactly as before this slice.
	 *
	 * When given and this measure's own natural width falls short of it (this
	 * staff was the narrower one at this column), the shortfall is added as
	 * extra trailing space *after* the last note, pushing this measure's own
	 * barline right until it lines up with every other staff's barline in the
	 * same column. Notes themselves are never rescaled to close the gap (see
	 * `layoutScore`'s own comment on why padding, not a true cross-staff
	 * justification pass, is this slice's chosen trade-off).
	 */
	readonly columnWidth?: number;
	/**
	 * This measure's own portion of a *shared* end barline spanning a
	 * multi-staff group (M2 Slice 4; see `barlineSpan`), overriding the
	 * ordinary single-staff barline band of `staffTopY` to `staffTopY + 4 *
	 * ss`. Both omitted (the default) for a single-staff score, or any staff
	 * with nothing above or below it to share a barline with, which draws the
	 * exact same barline it always has. Affects only the end-barline draw ops
	 * (the main line, `'double'`/`'final'`'s extra thin line): the five staff
	 * lines themselves, and a repeat-end's dots, stay within this staff's own
	 * band regardless, since neither is the continuous vertical stroke a
	 * shared barline is about.
	 */
	readonly barlineTop?: number;
	/** See `barlineTop`. */
	readonly barlineBottom?: number;
}

function layoutMeasure(score: Score, measure: Measure, ctx: MeasureContext): LaidOutMeasure {
	const { ss, staffTopY, startX } = ctx;
	const ops: DrawOp[] = [];
	const notes: LaidOutNote[] = [];

	// The key and time signature actually in force at this measure, walking
	// back through any earlier measure's explicit change (`Score.keyFifthsAt`/
	// `timeAt`); every use of "the key" or "the time" below reads these local
	// values, never `score.keyFifths`/`score.time` directly, since those two
	// name only the score's *starting* values and ignore anything a measure
	// changed since.
	const keyFifths = score.keyFifthsAt(measure.index, ctx.staffIndex);
	const time = score.timeAt(measure.index, ctx.staffIndex);
	// Whether *this* measure is the one where the key (or time) actually
	// changes, as opposed to merely being in whatever key an earlier measure
	// set. Measure 0 never "changes" anything, since there is no earlier
	// measure to differ from; its key/time come from the score's initial
	// values instead, drawn unconditionally below via `isScoreFirst`/
	// `isSystemFirst`.
	const keyChangedHere = measure.index > 0 && keyFifths !== score.keyFifthsAt(measure.index - 1, ctx.staffIndex);
	const timeChangedHere =
		measure.index > 0 && !timeSignaturesEqual(time, score.timeAt(measure.index - 1, ctx.staffIndex));
	// Same idea for a clef change (M5 Slice 5). `ctx.clef` is already this
	// measure's own resolved clef (`Score.clefAt`), so only the comparison
	// against the previous measure is new here. Against the clef the previous
	// measure *ended* in (M6 Slice 4): a change inside it, typically one right
	// before its barline, already announced this clef there.
	const clefChangedHere = measure.index > 0 && ctx.clef !== score.clefAtEnd(measure.index - 1, ctx.staffIndex);

	// The clef, key signature and (for the score's true first measure, or any
	// later measure whose time signature just changed) time signature belong
	// to the *system-opening measure's* ops, not to some separate header
	// object. That is what makes redrawing that measure self-contained:
	// clearing its region wipes the clef, and drawing its ops puts the clef
	// back. A header owned by nobody would be erased by the first edit in
	// that measure and never repainted.
	//
	// Every system's first measure repeats the clef and key signature, real
	// engraving's rule for a new staff line; using `keyFifths` (the walked-
	// back value) here rather than `score.keyFifths` is what makes a later
	// system correctly show a key that changed since the score's start. The
	// time signature is different: it is not repeated at each system, only
	// stated once at the score's true first measure, and again wherever it
	// actually changes.
	//
	// A key or time change that falls at a measure which is *not* its
	// system's first also needs its own courtesy signature, announced right
	// where it takes effect: this is the "mid-system" branch below. Real
	// engraving convention also anticipates a change one system early, at the
	// end of the system just before it, when the change would otherwise land
	// exactly at a system break; this deliberately does not do that (it would
	// need `layoutMeasure` to know about a *different* measure's system
	// membership, which none of its inputs currently carry), so a change
	// landing at a system's first measure is announced only there, not also
	// trailed at the previous system's end. Flagged here as the scope this
	// slice punts on; every change still lands with the right glyphs at the
	// right measure, which is what the acceptance criteria ask for.
	//
	// A clef change (M5 Slice 5) follows exactly the same two-branch shape. At
	// a system's first measure the ordinary header clef already reads
	// `ctx.clef`, this measure's own resolved clef, so a change landing on a
	// system break (or any later system after a change) shows the new clef
	// with nothing extra. A change landing mid-system draws its own clef glyph
	// first in the mid-system branch, ahead of any key/time courtesy (the
	// clef has to come first: the key signature's accidental positions read
	// that same clef), at `CHANGE_CLEF_SCALE` of full size, the conventional
	// smaller "change clef". The same anticipatory-courtesy punt applies: no
	// clef is trailed at the end of the previous system.
	let cursor = startX;
	if (ctx.isSystemFirst) {
		cursor += SPACING.headerGap * ss;
		cursor = layoutClef(ops, cursor, ctx);
		cursor = layoutKeySignature(
			ops,
			cursor,
			keyFifths,
			ctx,
			keyChangedHere ? score.keyFifthsAt(measure.index - 1, ctx.staffIndex) : undefined
		);
		if (ctx.isScoreFirst || timeChangedHere) {
			cursor = layoutTimeSignature(ops, cursor, time.beats, time.beatType, ctx);
		}
	} else if (clefChangedHere || keyChangedHere || timeChangedHere) {
		cursor += SPACING.headerGap * ss;
		if (clefChangedHere) {
			cursor = layoutClef(ops, cursor, ctx, CHANGE_CLEF_SCALE);
		}
		if (keyChangedHere) {
			cursor = layoutKeySignature(ops, cursor, keyFifths, ctx, score.keyFifthsAt(measure.index - 1, ctx.staffIndex));
		}
		if (timeChangedHere) {
			cursor = layoutTimeSignature(ops, cursor, time.beats, time.beatType, ctx);
		}
	}
	// A repeat-start barline belongs to *this* measure's own start (see
	// `Measure.startBarline`'s comment on why it is not the previous measure's
	// end barline), so it draws here, inside this measure's own ops, before
	// the ordinary lead-in space a first note's stem needs.
	if (measure.startBarline === 'repeatStart') {
		cursor = layoutRepeatStartBarline(ops, cursor, staffTopY, ctx);
	}
	// Where this measure's own music may begin, past any clef/key/time/repeat
	// header: the left edge a whole-measure rest is centred against (see
	// `centreMeasureRests`).
	const contentStartX = cursor;
	cursor += SPACING.measureLeadIn * ss;

	// Two voices in one staff (M2 Slice 1): a measure's notes no longer form
	// one flat sequential stream to walk with a single cursor. `notesByVoice`
	// is computed once and reused below for both the beam-grouping pass and
	// the note-layout pass, since both need to see one voice's own notes in
	// isolation from any other voice sharing this measure. A single voice
	// (this engine's only case before this slice) is the one-entry
	// degenerate case, which is what keeps every code path below identical to
	// before this slice whenever only voice 1 is present.
	const notesByVoiceGroups = notesByVoice(measure.notes);
	// The same grouping one level up (M6 Slice 2): each voice's events, so a
	// chord is laid out as one unit at one onset (see `eventsByVoice`).
	const eventsByVoiceGroups = eventsByVoice(measure.notes);
	// Whether this measure genuinely holds more than one voice, gating the
	// multi-voice stem-direction override and rest offset (see
	// `voiceStemOverride`/`restVoiceOffsetSpaces`): a single-voice measure
	// must render byte-for-byte the same as it always has, so both
	// conventions only engage once a second voice actually shares the staff.
	const multiVoice = notesByVoiceGroups.size > 1;

	// Mid-measure clef changes (M6 Slice 4). Every clef-dependent position
	// below reads a `MeasureContext`'s `clef`/`lines`, so a note after a change
	// is simply laid out against a context carrying the new clef (one context
	// per clef, built once); the measure's own `ctx` stays the downbeat clef,
	// which is what the header, key signature and barline-side marks need.
	// `middleLineOf` gives each note its own clef's middle line for the stem,
	// beam and tie directions, which are decided by distance from it.
	const onsets = noteOnsets(measure.notes);
	const clefChanges = measure.clefChanges;
	const ctxByClef = new Map<ClefType, MeasureContext>([[ctx.clef, ctx]]);
	const ctxForClef = (clef: ClefType): MeasureContext => {
		let found = ctxByClef.get(clef);
		if (!found) {
			found = { ...ctx, clef, lines: CLEF_LINES[clef] };
			ctxByClef.set(clef, found);
		}
		return found;
	};
	const clefAtOnset = (onset: number): ClefType => {
		for (let i = clefChanges.length - 1; i >= 0; i--) {
			if (onsetKey(clefChanges[i]!.onset) <= onsetKey(onset)) return clefChanges[i]!.clef;
		}
		return ctx.clef;
	};
	const middleLineOf = (note: Note): number =>
		clefChanges.length === 0
			? ctx.lines.middleLine
			: CLEF_LINES[clefAtOnset(onsets.get(note.id) ?? 0)].middleLine;

	// Cross-staff beams (M2 Slice 6): notes in *this* measure that are part of
	// an explicit Score.CrossStaffBeam, grouped by which beam they belong to.
	// Excluded from this measure's own automatic per-voice grouping below
	// (they belong to their cross-staff beam instead), and given a synthetic
	// BeamGroup of their own further down, once every ordinary group exists.
	const crossStaffNoteIds = new Set<NoteId>();
	const crossGroupsByBeam = new Map<CrossStaffBeam, Note[]>();
	for (const note of measure.notes) {
		const beam = score.crossStaffBeamContaining(note.id);
		if (!beam) continue;
		crossStaffNoteIds.add(note.id);
		const list = crossGroupsByBeam.get(beam) ?? [];
		list.push(note);
		crossGroupsByBeam.set(beam, list);
	}

	// Deciding beam groups is a pass over each voice's own notes (a group
	// cannot be known note-by-note: whether the third eighth joins the first
	// two depends on the beat it falls in), run independently per voice so an
	// interleaved second voice's durations can never corrupt the first
	// voice's beat-position tracking, or vice versa (`computeBeamGroups`'s
	// own single running position would otherwise misgroup across voices). A
	// note that lands in a group of two or more skips its individual
	// stem-and-flag in the main loop below and instead has its notehead
	// position recorded in `placements`; `layoutBeamGroup` draws the shared
	// stems and beam afterwards, once every member's position is known. A
	// note with no beamable neighbour is not in any group here and falls
	// straight through to its ordinary single-flag stem.
	const beamGroups: BeamGroup[] = [];
	for (const [voice, voiceNotes] of notesByVoiceGroups) {
		beamGroups.push(
			...computeBeamGroups(
				voiceNotes,
				time,
				clefChanges.length === 0 ? ctx.lines.middleLine : middleLineOf,
				voiceStemOverride(voice, multiVoice),
				crossStaffNoteIds
			)
		);
	}

	// This measure's own half of every cross-staff beam it participates in:
	// a synthetic BeamGroup (direction decided by which side of the pair this
	// staff is, not by pitch) plus the fixed join-y both halves independently
	// derive from pure staff geometry (see barlineSpan; this reuses its own
	// already bleed-safe boundary rather than inventing new region math). Kept
	// in a separate list from the ordinary per-voice `beamGroups` because it
	// needs `layoutBeamGroup`'s fixedBeamY override, not that function's
	// ordinary "clear the group's most extreme member" height.
	const crossStaffGroups: { readonly group: BeamGroup; readonly beamY: number }[] = [];
	for (const [beam, notesHere] of crossGroupsByBeam) {
		const isUpperStaff = ctx.staffIndex === beam.staffIndices[0];
		const direction: 'up' | 'down' = isUpperStaff ? 'down' : 'up';
		const span = barlineSpan(ctx.staffIndex, score.staves.length, ctx.staffTopY, ctx.ss);
		const beamY = isUpperStaff ? span.bottom : span.top;
		crossStaffGroups.push({ group: { notes: notesHere, direction }, beamY });
	}

	const beamGroupOfNote = new Map<NoteId, BeamGroup>();
	for (const group of beamGroups) {
		for (const note of group.notes) beamGroupOfNote.set(note.id, group);
	}
	for (const { group } of crossStaffGroups) {
		for (const note of group.notes) beamGroupOfNote.set(note.id, group);
	}
	const placements = new Map<NoteId, NotePlacement>();
	// Each event's stem geometry, keyed by its anchor's id (M6 Slice 2): one
	// stem per chord, so a beamed chord's stem is looked up by the anchor
	// `BeamGroup.notes` lists, never by a member.
	const stems = new Map<NoteId, ChordStem>();
	// Where each beamed event's stem ends (its beam's y), keyed like `stems`,
	// filled in by `layoutBeamGroup`; an unbeamed stem's tip is derived from
	// its `ChordStem` instead. Read by the articulation pass, which stacks a
	// stem-side mark beyond the tip.
	const stemTips = new Map<NoteId, number>();
	// Events carrying an articulation or fermata (M6 Slice 5), laid out at the
	// very end (`layoutEventMarks`), once stems, beams, measure-rest centring,
	// ties and slurs have all settled the ink a mark has to clear.
	const markedEvents: MarkedEvent[] = [];

	// Onset-aligned columns (see `measureColumns`): every voice's notes land
	// on a shared x wherever they share a beat. `columnOffsetPx` turns each
	// column's own natural width into a running pixel offset from `cursor`
	// (the position right after the measure's lead-in space), scaled by this
	// system's justification factor the same way a single-voice note's own
	// advance always was.
	const scale = ctx.spacingScale ?? 1;
	const columns = measureColumns(measure.notes);
	const columnOffsetPx = new Map<number, number>();
	let columnsWidthPx = 0;
	for (const column of columns) {
		columnOffsetPx.set(onsetKey(column.onset), columnsWidthPx);
		columnsWidthPx += column.width * ss * scale;
	}

	// M2 Slice 2 restructures this pass from Slice 1's "finish voice 1
	// entirely, then voice 2" order into "walk columns left to right, and
	// within a column, voices in ascending voice-number order". That
	// restructuring is what gives natural, no-lookahead cross-voice
	// awareness at all: by the time voice 2's note at a shared onset is laid
	// out, voice 1's note at that same onset (if it has one) has already
	// been drawn and its ink extent is already known, which is exactly what
	// both the cross-voice accidental-clearance check and the notehead
	// clash-avoidance below need. Per-voice running state (accidental
	// carry-over, each voice's own previous-ink tracking, each voice's own
	// collision-shift accumulator) still has to persist *across* columns,
	// not reset at each one, so every one of these is a map keyed by voice,
	// initialized once here rather than once per voice's own outer loop
	// iteration the way Slice 1 had it.
	const voiceNumbers = [...notesByVoiceGroups.keys()].sort((a, b) => a - b);
	const voiceNoteIndex = new Map<number, number>();
	const lastStatedAlterForStepByVoice = new Map<number, Map<Step, number>>();
	const previousInkRightByVoice = new Map<number, number | null>();
	// Also serves as `finalShiftByVoice` once every column is processed: each
	// voice's own accumulated shift after its last note, so the measure's
	// total width (below) can widen for whichever voice's collision
	// avoidance (accidental or notehead) drifted it furthest right; for a
	// single voice this is just that voice's own final value, reproducing
	// the flat cursor's old behaviour exactly.
	const shiftAccumByVoice = new Map<number, number>();
	for (const voice of voiceNumbers) {
		voiceNoteIndex.set(voice, 0);
		lastStatedAlterForStepByVoice.set(voice, new Map());
		previousInkRightByVoice.set(voice, null);
		shiftAccumByVoice.set(voice, 0);
	}

	// Every earlier-numbered voice's own notehead position at the current
	// column and the one immediately before it, for `secondIntervalClashShift`'s
	// same-onset and adjacent-onset checks. Keyed by voice number (not a
	// single fixed "voice 1" slot) so the clash-avoidance convention below
	// generalizes to any voice yielding to any earlier one, not just voice 2
	// yielding to voice 1; see that function's own comment on why the
	// direction of yielding stays one-way even though the tracking itself is
	// now N-way.
	let atPrevColumnByVoice = new Map<number, readonly { d: number; noteX: number }[]>();
	let atThisColumnByVoice = new Map<number, readonly { d: number; noteX: number }[]>();
	// Mid-measure clef changes (M6 Slice 4) still to draw, in onset order;
	// the context every note is currently laid out against; and the fixed
	// (unjustified, like a header's) width the change clefs drawn so far have
	// pushed every later column right by.
	let nextClefChange = 0;
	let noteCtx = ctx;
	let clefInsertPx = 0;
	/**
	 * Draw every not-yet-drawn change at or before `onset` at `x`, as one
	 * change clef: only the last one is in force there, and a change to the
	 * clef already in force (an OMR restatement) draws nothing. The clef's
	 * ink becomes every voice's "previous ink", so an accidental on the next
	 * note is pushed clear of it by the ordinary collision shift.
	 */
	const drawClefChangesUpTo = (onset: number, x: number): void => {
		let target: ClefType | null = null;
		while (nextClefChange < clefChanges.length && onsetKey(clefChanges[nextClefChange]!.onset) <= onsetKey(onset)) {
			target = clefChanges[nextClefChange++]!.clef;
		}
		if (target === null || target === noteCtx.clef) return;
		noteCtx = ctxForClef(target);
		const clefX = x + MID_MEASURE_CLEF_GAP * ss;
		const after = layoutClef(ops, clefX, noteCtx, CHANGE_CLEF_SCALE);
		// `layoutClef` returns past its own header gap; a change clef inside
		// the music only needs the smaller lead-in a note gets.
		const clefRight = after - SPACING.headerGap * ss;
		clefInsertPx += clefRight + MID_MEASURE_CLEF_GAP * ss - x;
		for (const voice of voiceNumbers) {
			const own = previousInkRightByVoice.get(voice)!;
			previousInkRightByVoice.set(voice, own === null ? clefRight : Math.max(own, clefRight));
		}
	};
	// Whole-measure rests are laid out in their column like any rest, then
	// moved to the measure's centre once the barline's x is known; this
	// remembers which ops and hit box each one produced.
	const measureRestSpans: MeasureRestSpan[] = [];

	for (const column of columns) {
		const key = onsetKey(column.onset);
		if (nextClefChange < clefChanges.length) {
			drawClefChangesUpTo(
				column.onset,
				cursor + columnOffsetPx.get(key)! + clefInsertPx + Math.max(0, ...shiftAccumByVoice.values())
			);
		}
		atThisColumnByVoice = new Map();
		// Ink deposited so far *in this column* by an earlier-processed
		// voice: what lets an accidental in one voice check the other
		// voice's ink at this same x, not just its own voice's last note
		// (which could be several columns back, or nonexistent yet).
		let columnInkRightSoFar: number | null = null;

		for (const voice of voiceNumbers) {
			const voiceEvents = eventsByVoiceGroups.get(voice)!;
			const index = voiceNoteIndex.get(voice)!;
			// One event per voice per column (M6 Slice 2): a chord's members
			// share its anchor's onset, so the whole chord is taken here at once.
			const chord = voiceEvents[index];
			const note = chord?.[0];
			if (!chord || !note || onsetKey(onsets.get(note.id)!) !== key) continue;
			voiceNoteIndex.set(voice, index + 1);

			const shiftAccum = shiftAccumByVoice.get(voice)!;
			const baseCellX = cursor + columnOffsetPx.get(key)! + clefInsertPx + shiftAccum;

			// Voice-to-voice notehead offset: a second-interval clash against
			// any earlier-numbered voice already placed at this same column
			// or the immediately preceding one nudges this voice's note
			// right by whatever shortfall closes the gap to a full
			// notehead's width. Folded straight into the same `cellX` the
			// accidental-collision check below already adjusts, rather than
			// a new parameter threaded into `layoutNote`, so that function's
			// signature and single-voice behaviour stay untouched.
			// Every head of a chord is checked (M6 Slice 2), against every head
			// an earlier voice placed, taking the largest shift any pair needs.
			const earlierThisColumn = [...atThisColumnByVoice.values()].flat();
			const earlierPrevColumn = [...atPrevColumnByVoice.values()].flat();
			let clashShift = 0;
			for (const head of chord) {
				if (head.pitch === null) continue;
				clashShift = Math.max(
					clashShift,
					secondIntervalClashShift(
						diatonicIndex(head.pitch),
						NOTEHEAD_GLYPHS[note.value],
						baseCellX,
						earlierThisColumn,
						earlierPrevColumn,
						ss
					)
				);
			}
			const cellX = baseCellX + clashShift;

			const beamDirection = beamGroupOfNote.get(note.id)?.direction ?? null;
			// This voice's own previous-ink-right (from whatever it last
			// drew, possibly several columns back) combined with whatever
			// ink an earlier-processed voice already deposited in *this*
			// column: an accidental needs to clear both, not just its own
			// voice's, and falls back to `null` only when neither exists
			// (the measure's true first note, exactly as before this
			// slice).
			const ownPreviousInkRight = previousInkRightByVoice.get(voice)!;
			const previousInkRight =
				ownPreviousInkRight === null
					? columnInkRightSoFar
					: columnInkRightSoFar === null
						? ownPreviousInkRight
						: Math.max(ownPreviousInkRight, columnInkRightSoFar);

			const opStart = ops.length;
			const noteIndex = notes.length;
			const laid = layoutNote(
				ops,
				notes,
				cellX,
				chord,
				keyFifths,
				noteCtx,
				beamDirection,
				lastStatedAlterForStepByVoice.get(voice)!,
				previousInkRight,
				multiVoice
			);

			if (note.isMeasureRest) measureRestSpans.push({ opStart, opEnd: ops.length, noteIndex });
			if (eventArticulations(chord).length > 0 || eventFermata(chord) !== null) {
				markedEvents.push({
					chord,
					heads: laid.heads.map(([, placement]) => placement),
					stem: laid.stem,
					ctx: noteCtx,
					restOp: note.pitch === null ? opStart : null
				});
			}
			shiftAccumByVoice.set(voice, shiftAccum + clashShift + laid.collisionShift);
			previousInkRightByVoice.set(voice, laid.inkRight);
			columnInkRightSoFar =
				columnInkRightSoFar === null ? laid.inkRight : Math.max(columnInkRightSoFar, laid.inkRight);
			if (laid.heads.length > 0) {
				for (const [id, placement] of laid.heads) placements.set(id, placement);
				atThisColumnByVoice.set(
					voice,
					laid.heads.map(([, placement]) => ({ d: placement.d, noteX: placement.noteX }))
				);
			}
			if (laid.stem) stems.set(note.id, laid.stem);
		}

		atPrevColumnByVoice = atThisColumnByVoice;
	}
	const finalShiftByVoice = shiftAccumByVoice;
	// A change after the last onset (most often right at the measure's end,
	// the usual spelling of a change for the next downbeat) is drawn after
	// the last column, before the barline, where engraving puts it.
	if (nextClefChange < clefChanges.length) {
		drawClefChangesUpTo(
			Number.POSITIVE_INFINITY,
			cursor + columnsWidthPx + clefInsertPx + Math.max(0, ...finalShiftByVoice.values())
		);
	}
	for (const group of beamGroups) layoutBeamGroup(ops, group, stems, ctx, undefined, stemTips);
	for (const { group, beamY } of crossStaffGroups) layoutBeamGroup(ops, group, stems, ctx, beamY, stemTips);
	// The measure's note area ends at the shared columns' own total width,
	// plus whichever voice's own collision-avoidance shift (above) reached
	// furthest past it. A single voice's shift is the only one that can ever
	// be nonzero, so this reduces to exactly the same total the old flat
	// cursor always produced.
	cursor += columnsWidthPx + clefInsertPx + Math.max(0, ...finalShiftByVoice.values());
	cursor += SPACING.measureTrailOut * ss;

	// Staff lines are per measure, spanning exactly this measure's band, for the
	// same reason the header is: a region-scoped repaint has to be able to put
	// back every pixel it cleared, and a staff line drawn once across the whole
	// system could not be.
	//
	// `Score.endBarlineAt` is what used to be the bare `ctx.isLast` check: it
	// resolves this measure's own `endBarline` (defaulting to `'final'` at the
	// score's true last measure, `'normal'` everywhere else), unless the
	// *following* measure opens with its own `startBarline: 'repeatStart'`, in
	// which case that wins and this measure draws no end barline at all (the
	// next measure's own start already drew the boundary's only barline; see
	// `Measure.startBarline`). `'repeatStart'` therefore never actually reaches
	// the switch below as *this* measure's resolved type in the normal case,
	// but the branch exists anyway so a boundary genuinely resolving to it
	// (which only happens via that lookahead) draws nothing, not a stray line.
	const endBarline = score.endBarlineAt(measure.index, ctx.staffIndex);
	const thin = ED.thinBarlineThickness * ss;
	const thick = ED.thickBarlineThickness * ss;
	const mainThickness =
		endBarline === 'repeatStart' ? 0 : endBarline === 'final' || endBarline === 'repeatEnd' ? thick : thin;
	// Column-width sharing (M2 Slice 4, see `MeasureContext.columnWidth`'s own
	// comment): only ever adds trailing space, never removes it, so a staff
	// that is already the widest one at this column (the one whose own
	// natural width *is* `columnWidth`) is untouched.
	if (ctx.columnWidth !== undefined) {
		const naturalWidth = cursor + mainThickness - startX;
		if (naturalWidth < ctx.columnWidth) cursor += ctx.columnWidth - naturalWidth;
	}
	const barlineX = cursor;
	const measureWidth = barlineX + mainThickness - startX;
	// Before the staff lines below are `unshift`ed in, which would shift the
	// op indices `measureRestSpans` recorded.
	centreMeasureRests(ops, notes, measureRestSpans, contentStartX, barlineX, ss);
	// A marked rest's glyph box, read now: the staff lines `unshift`ed below
	// would shift the op index recorded for it, and centring has just moved a
	// measure rest to where its fermata must be centred.
	const restBoxes = new Map<MarkedEvent, Rect>();
	for (const event of markedEvents) {
		const op = event.restOp === null ? undefined : ops[event.restOp];
		if (op && op.kind === 'glyph') restBoxes.set(event, glyphBounds(op.glyph, op.x, op.y, ss));
	}
	// This measure's own portion of a shared multi-staff barline (M2 Slice 4),
	// falling back to the ordinary single-staff band when this staff has
	// nothing above or below it to share a barline with (`barlineTop`/
	// `barlineBottom` both undefined): see `MeasureContext.barlineTop`'s own
	// comment on exactly which draws below this reads it for.
	const barlineTop = ctx.barlineTop ?? staffTopY;
	const barlineBottom = ctx.barlineBottom ?? staffTopY + 4 * ss;
	// The end barline's ops, left out of `inkExtent` (see `LaidOutMeasure`).
	const barlineOpsFrom = ops.length;
	const lineThickness = ED.staffLineThickness * ss;
	for (let line = 0; line < 5; line++) {
		ops.unshift({
			kind: 'rect',
			x: startX,
			y: staffTopY + line * ss - lineThickness / 2,
			width: measureWidth,
			height: lineThickness
		});
	}

	// Every shape but `'repeatStart'` ends in one "main" line at `barlineX`
	// itself (thin for `'normal'`/`'double'`, thick for `'final'`/`'repeatEnd'`,
	// computed above as `mainThickness`); `'double'` and `'final'` additionally
	// draw a second thin line just to its left, and `'repeatEnd'` draws its two
	// dots there instead. Both extras fit inside the blank space
	// `SPACING.measureTrailOut` already reserves after the last note (checked
	// against this file's own constants: `ED.barlineSeparation` plus either a
	// thin line's or a dot's width is well under `measureTrailOut`), so neither
	// changes `measureWidth` the way `'repeatStart'`'s own leading ink does at
	// this measure's start: only the shapes that grow *forward*, past
	// `barlineX`, need the width formula above to know about them.
	if (endBarline === 'final' || endBarline === 'double') {
		ops.push({
			kind: 'rect',
			x: barlineX - ED.barlineSeparation * ss - thin,
			y: barlineTop,
			width: thin,
			height: barlineBottom - barlineTop
		});
	}
	if (endBarline === 'repeatEnd') {
		const dotAdvance = GLYPH_METRICS.repeatDot.advance * ss;
		pushRepeatDots(ops, barlineX - ED.barlineSeparation * ss - dotAdvance, ctx);
	}
	if (endBarline !== 'repeatStart') {
		ops.push({
			kind: 'rect',
			x: barlineX,
			y: barlineTop,
			width: mainThickness,
			height: barlineBottom - barlineTop
		});
	}
	// Five staff lines were `unshift`ed in since `barlineOpsFrom` was taken.
	const barlineOps = new Set(ops.slice(barlineOpsFrom + 5));

	// Ties: two same-pitch notes sounding as one continuous note, connected by
	// a curve from the first notehead to the second. A tie fully contained in
	// this measure (both notes already have a recorded position, above) draws
	// one curve directly; a tie crossing into a *different* measure is drawn
	// as two independent halves, one per measure, each using only its own
	// note's position and never the other end's.
	//
	// That split is what keeps a tie compatible with region-scoped redraw:
	// this measure's ops have to be everything a repaint of just this measure
	// needs to put back, and a curve reaching into a neighbour's pixels would
	// break that on either measure's next redraw (see `measureRegion`'s own
	// comment on the same constraint). It also means a tie crossing a
	// *system* break (not modelled by anything here; Phase 3 owns
	// system-aware layout) gets a reasonable result for free, with no special
	// case needed: the outgoing half simply stops at this system's own
	// barline and the resuming half starts at whichever system the target
	// note lands in, exactly like the same-system case.
	//
	// Curve direction follows the standard engraving convention: away from
	// the stem, so a tie curves below the notehead when its stem points up
	// and above it when the stem points down (the stem would otherwise run
	// straight through the curve). A whole note has no real stem to read;
	// `tieCurvesBelow` falls back to the same distance-from-the-middle-line
	// rule a stem's direction would have used, so the tie still leans the way
	// a virtual stem would have pointed.
	//
	// Known limitation, left for a later pass: each half decides its own
	// curve direction from only its own note's stem. The two ends of a tie
	// share a pitch, and Phase 1's single-voice stem rule is pitch-based, so
	// this agrees in the overwhelming common case; it can disagree only when
	// one end sits in a beamed group whose *shared* direction (decided by the
	// group's farthest member, see `stemDirectionForNotes`) differs from what
	// that note's own pitch alone would have picked, in which case the two
	// halves could bulge opposite ways at the barline.
	for (const note of measure.notes) {
		const point = placements.get(note.id);
		if (!point) continue; // a rest, which can never be tied

		if (note.tiedToId !== null) {
			const curvesBelow = tieCurvesBelow(point, middleLineOf(note));
			const x0 = point.noteX + GLYPH_METRICS[point.headGlyph].bBoxNE[0] * ss + TIE_NOTE_GAP * ss;
			const target =
				score.measureOfNote(note.tiedToId) === measure ? placements.get(note.tiedToId) : undefined;
			if (target) {
				const x1 = target.noteX + GLYPH_METRICS[target.headGlyph].bBoxSW[0] * ss - TIE_NOTE_GAP * ss;
				pushTieCurve(ops, x0, point.y, x1, target.y, curvesBelow, note.id, ctx);
			} else {
				// Target lands in a later measure: draw only the outgoing half,
				// stopping at this measure's own barline. The resuming half is
				// drawn independently below, by whichever measure lays out the
				// target note, from its own left edge.
				pushTieCurve(ops, x0, point.y, barlineX, point.y, curvesBelow, note.id, ctx);
			}
		}

		const tiedFrom = score.tiedFromNote(note.id);
		if (tiedFrom && score.measureOfNote(tiedFrom.id) !== measure) {
			// This note is the receiving end of a tie begun in an earlier
			// measure: draw only the incoming half, starting from this
			// measure's own left edge.
			const curvesBelow = tieCurvesBelow(point, middleLineOf(note));
			const x1 = point.noteX + GLYPH_METRICS[point.headGlyph].bBoxSW[0] * ss - TIE_NOTE_GAP * ss;
			pushTieCurve(ops, startX, point.y, x1, point.y, curvesBelow, tiedFrom.id, ctx);
		}
	}

	// Slurs: a phrase mark spanning an arbitrary run of notes, split into one
	// curve segment per measure it passes through for exactly the reason a tie
	// crossing a barline is split into two independent halves above: a curve
	// reaching into a neighbouring measure's pixels would break region-scoped
	// redraw on either measure's next repaint. A slur fully contained in one
	// measure (its start and end measure are the same) is just the one-segment
	// case, arching directly from its start note to its end note over however
	// many notes fall between them.
	//
	// Every measure the slur passes through recomputes the same `spanNotes`,
	// `curvesBelow` and `roofY` from the score model alone (`slurSpanNotes`
	// walks `Score.notesInOrder()`, not anything this or a neighbouring
	// measure's layout already produced), so whichever measure `layoutMeasure`
	// is asked to redraw always agrees with its neighbours about where the
	// slur's "roof" sits, the same property that lets `relayoutMeasure`
	// recompute a tie's half correctly with no extra plumbing.
	for (const slur of score.slurs) {
		const startMeasure = score.measureOfNote(slur.startNoteId);
		const endMeasure = score.measureOfNote(slur.endNoteId);
		if (!startMeasure || !endMeasure) continue;
		// M2 Slice 3: `index` alone is only unique *within* a staff (see
		// `Measure.index`'s own comment), so this measure's own `staffIndex`
		// has to agree with the slur's before its numeric `index` range check
		// means anything; without this, a staff whose own measures happen to
		// number into the same range as another staff's slurred measures
		// could incorrectly draw part of that slur, leaking ink outside the
		// region a redraw of *this* measure is allowed to touch. A slur can
		// anchor on any single staff (`Score.addSlur` validates both its ends
		// land on the same one), so `startMeasure`/`endMeasure` always agree
		// with each other on `staffIndex`; checking against `startMeasure`'s
		// is enough.
		if (measure.staffIndex !== startMeasure.staffIndex) continue;
		if (measure.index < startMeasure.index || measure.index > endMeasure.index) continue;

		const spanNotes = slurSpanNotes(score, slur, startMeasure.staffIndex);
		const curvesBelow =
			stemDirectionForNotes(
				spanNotes.flatMap((spanNote) => (spanNote.pitch ? [diatonicIndex(spanNote.pitch)] : [])),
				ctx.lines.middleLine
			) === 'up';
		const roofY = slurRoofY(spanNotes, curvesBelow, ctx);

		// A true endpoint only has a recorded position when it belongs to
		// *this* measure (`placements` only ever holds this measure's own
		// notes); otherwise this measure only sees the slur passing through,
		// so its end of the segment is a "roof" point rather than a notehead.
		const startPoint = measure.index === startMeasure.index ? placements.get(slur.startNoteId) : undefined;
		const endPoint = measure.index === endMeasure.index ? placements.get(slur.endNoteId) : undefined;

		const x0 = startPoint
			? startPoint.noteX + GLYPH_METRICS[startPoint.headGlyph].bBoxNE[0] * ss + SLUR_NOTE_GAP * ss
			: startX;
		const y0 = startPoint ? startPoint.y : roofY;
		const x1 = endPoint
			? endPoint.noteX + GLYPH_METRICS[endPoint.headGlyph].bBoxSW[0] * ss - SLUR_NOTE_GAP * ss
			: barlineX;
		const y1 = endPoint ? endPoint.y : roofY;

		pushSlurSegment(ops, x0, y0, x1, y1, roofY, slur.startNoteId, ctx);
	}

	// Articulations and fermatas (M6 Slice 5), last, so every obstacle they
	// stack beyond already exists. Their glyph ops land in this measure's own
	// `ops`, so `measureRegion` below grows to cover them and a region-scoped
	// redraw repaints them like any other ink.
	if (markedEvents.length > 0) {
		const curves = ops.filter((op): op is Extract<DrawOp, { kind: 'curve' }> => op.kind === 'curve');
		for (const event of markedEvents) {
			const anchor = event.chord[0]!;
			const tip =
				event.stem === null
					? null
					: (stemTips.get(anchor.id) ??
						event.stem.nearY + (event.heads[0]!.up ? -STEM_LENGTH * ss : STEM_LENGTH * ss));
			layoutEventMarks(ops, event, restBoxes.get(event) ?? null, tip, curves, multiVoice);
		}
	}

	const ink = measureRegion(
		ops.filter((op) => !barlineOps.has(op)),
		startX,
		measureWidth,
		staffTopY,
		ss
	);
	return {
		index: measure.index,
		staffIndex: ctx.staffIndex,
		region: measureRegion(ops, startX, measureWidth, staffTopY, ss),
		ops,
		notes,
		inkExtent: { top: ink.y + REGION_BLEED_PX, bottom: ink.y + ink.height - REGION_BLEED_PX }
	};
}

/**
 * A repeat-start barline: a thick line, then (moving further into the measure
 * it opens) two dots. Drawn at `x` (the cursor right after this measure's own
 * header, before its ordinary lead-in space), returning the cursor position
 * past it.
 *
 * Deliberately just the thick line plus dots, not the thin-then-thick pair
 * some engravings additionally draw before a repeat sign's dots: this
 * slice's own scope (see `Measure.startBarline`'s comment) is a single,
 * unambiguous shape per `BarlineType`, and this is the shape the acceptance
 * criteria describe. `ED.barlineSeparation` (already the gap between a
 * `'final'`/`'double'` boundary's two lines) is reused here too, for the gap
 * both after the thick line and after the dots, rather than inventing a
 * second spacing constant for what is the same kind of "barline-adjacent
 * clearance".
 */
function layoutRepeatStartBarline(ops: DrawOp[], x: number, staffTopY: number, ctx: MeasureContext): number {
	const { ss } = ctx;
	const thick = ED.thickBarlineThickness * ss;
	const sep = ED.barlineSeparation * ss;
	ops.push({ kind: 'rect', x, y: staffTopY, width: thick, height: 4 * ss });
	const dotsX = x + thick + sep;
	pushRepeatDots(ops, dotsX, ctx);
	return dotsX + GLYPH_METRICS.repeatDot.advance * ss + sep;
}

/**
 * The two dots of a repeat barline (`repeatStart`/`repeatEnd`), stacked at
 * the same x, one in the staff space just above the middle line and one in
 * the space just below it: standard engraving position, independent of
 * whichever notes happen to be nearby. `repeatDot`'s bounding box is centred
 * on its own origin (like `augmentationDot`'s), so placing it at exactly
 * `staffY(...)` centres the dot there with no extra offset math, the same
 * property `layoutAugmentationDots` relies on for a note's own dots.
 */
function pushRepeatDots(ops: DrawOp[], x: number, ctx: MeasureContext): void {
	ops.push({ kind: 'glyph', glyph: 'repeatDot', x, y: staffY(ctx.lines.middleLine + 1, ctx) });
	ops.push({ kind: 'glyph', glyph: 'repeatDot', x, y: staffY(ctx.lines.middleLine - 1, ctx) });
}

/**
 * The clef glyph itself (M2 Slice 3 generalizes this from a single
 * always-`gClef` draw): a G clef sitting on G4's line for `treble`, the same
 * G clef with SMuFL's own `gClef8vb` shape (the small "8" below) for
 * `treble8`, an F clef sitting on F3's line for `bass`, or a C clef centred
 * on middle C's line for `alto`/`tenor` (M6 Slice 4). `treble8`'s
 * notehead/ledger/key-signature math is otherwise identical to `treble`'s
 * (see `CLEF_LINES`'s own comment); this is the one place that difference
 * actually shows up.
 */
function layoutClef(ops: DrawOp[], x: number, ctx: MeasureContext, scale = 1): number {
	// Only a mid-system change clef (M5 Slice 5) passes a `scale`; a
	// full-size header clef keeps the shared font size, with no `fontSizePx`
	// override on its op at all, exactly as before. Scaling about the glyph's
	// own origin keeps it anchored on the line its clef names.
	const sized = scale === 1 ? {} : { fontSizePx: ctx.ss * STAFF_SPACES_PER_EM * scale };
	if (ctx.clef === 'bass') {
		// The F clef's origin sits on the line of the F it names, the second
		// line from the top of a bass staff, with its two dots straddling it.
		const y = staffY(diatonicIndex({ step: 'F', alter: 0, octave: 3 }), ctx);
		ops.push({ kind: 'glyph', glyph: 'fClef', x, y, ...sized });
		return x + (GLYPH_METRICS.fClef.advance * scale + SPACING.headerGap) * ctx.ss;
	}
	if (ctx.clef === 'alto' || ctx.clef === 'tenor') {
		// The C clef (M6 Slice 4) is drawn centred on its own origin, so the
		// origin goes on the line it names as middle C: `CLEF_LINES` already
		// puts C4 on the third line for alto and the fourth for tenor.
		const y = staffY(diatonicIndex({ step: 'C', alter: 0, octave: 4 }), ctx);
		ops.push({ kind: 'glyph', glyph: 'cClef', x, y, ...sized });
		return x + (GLYPH_METRICS.cClef.advance * scale + SPACING.headerGap) * ctx.ss;
	}
	const glyph: GlyphName = ctx.clef === 'treble8' ? 'gClef8vb' : 'gClef';
	// The G clef's origin sits on the line of the G it names, the second line
	// from the bottom of a treble staff, for both plain treble and treble8
	// (they share the same staff position, see `CLEF_LINES`).
	const y = staffY(diatonicIndex({ step: 'G', alter: 0, octave: 4 }), ctx);
	ops.push({ kind: 'glyph', glyph, x, y, ...sized });
	return x + (GLYPH_METRICS[glyph].advance * scale + SPACING.headerGap) * ctx.ss;
}

/** How large a mid-system change clef draws relative to a full header clef
 *  (M5 Slice 5). Engraving convention draws a clef change smaller than the
 *  clef opening a system, typically two-thirds to three-quarters size; the
 *  upper end keeps the "8" of a `gClef8vb` legible. */
const CHANGE_CLEF_SCALE = 0.75;

/** Clearance on each side of a clef change inside a measure (M6 Slice 4),
 *  staff spaces: between the previous column's room and the clef, and between
 *  the clef and the note it precedes. */
const MID_MEASURE_CLEF_GAP = 0.4;

/**
 * Draw a key signature's accidentals, optionally preceded by whichever
 * cancellation naturals a change from `previousFifths` needs (see
 * `layoutKeyCancellation`). `previousFifths` is only ever passed when this
 * call is drawing an actual change (`layoutMeasure`'s `keyChangedHere`); the
 * ordinary "restate the current key" calls (every system's own first measure,
 * whether or not the key ever changed) omit it, since restating a key that
 * was already in force cancels nothing.
 */
function layoutKeySignature(
	ops: DrawOp[],
	x: number,
	fifths: number,
	ctx: MeasureContext,
	previousFifths?: number
): number {
	let cursor = x;
	if (previousFifths !== undefined && previousFifths !== fifths) {
		cursor = layoutKeyCancellation(ops, cursor, previousFifths, fifths, ctx);
	}
	if (fifths === 0) return cursor;
	const kind = fifths > 0 ? 'sharp' : 'flat';
	const glyph: GlyphName = kind === 'sharp' ? 'accidentalSharp' : 'accidentalFlat';
	const steps = KEY_SIGNATURE_POSITIONS[kind];
	const octaves = KEY_SIGNATURE_OCTAVES[ctx.clef][kind];
	for (let i = 0; i < Math.min(Math.abs(fifths), 7); i++) {
		const step = steps[i];
		const octave = octaves[i];
		if (step === undefined || octave === undefined) break;
		cursor = pushGlyph(ops, glyph, cursor, staffY(diatonicIndex({ step, alter: 0, octave }), ctx), ctx);
	}
	return cursor + SPACING.headerGap * ctx.ss;
}

/**
 * Draw the natural signs cancelling whichever of `previousFifths`'s
 * accidentals `fifths`'s key does not also carry, standard convention for a
 * key change: e.g. D major (F#, C#) to G major (F#) cancels only the C#, since
 * the F# carries straight over unchanged; D major to C major cancels both; a
 * change from a sharp key to a flat key (or vice versa) cancels every one of
 * the old key's accidentals, since the two signatures never share a step's
 * sign. Drawn in the old signature's own written order, immediately before
 * the new signature's own accidentals (or alone, if the new key is C major
 * and has none of its own to follow).
 */
function layoutKeyCancellation(
	ops: DrawOp[],
	x: number,
	previousFifths: number,
	fifths: number,
	ctx: MeasureContext
): number {
	const oldKind = previousFifths > 0 ? 'sharp' : 'flat';
	const oldSteps = KEY_SIGNATURE_POSITIONS[oldKind].slice(0, Math.min(Math.abs(previousFifths), 7));
	const oldOctaves = KEY_SIGNATURE_OCTAVES[ctx.clef][oldKind];
	const newKind = fifths > 0 ? 'sharp' : 'flat';
	const newSteps: ReadonlySet<Step> =
		fifths === 0
			? new Set()
			: new Set(KEY_SIGNATURE_POSITIONS[newKind].slice(0, Math.min(Math.abs(fifths), 7)));

	let cursor = x;
	for (let i = 0; i < oldSteps.length; i++) {
		const step = oldSteps[i]!;
		// This step needs no natural when the new key alters it the same way:
		// same sign (both sharp or both flat) and still within the new key's own
		// accidental count.
		if (newKind === oldKind && newSteps.has(step)) continue;
		const octave = oldOctaves[i]!;
		cursor = pushGlyph(
			ops,
			'accidentalNatural',
			cursor,
			staffY(diatonicIndex({ step, alter: 0, octave }), ctx),
			ctx
		);
	}
	return cursor > x ? cursor + SPACING.headerGap * ctx.ss : cursor;
}

/** Whether two time signatures name the same meter, for deciding whether a
 *  measure's effective time signature actually *changed* from the previous
 *  measure's (`layoutMeasure`'s `timeChangedHere`), not just whether the two
 *  object references differ. */
function timeSignaturesEqual(a: TimeSignature, b: TimeSignature): boolean {
	return a.beats === b.beats && a.beatType === b.beatType;
}

function layoutTimeSignature(
	ops: DrawOp[],
	x: number,
	beats: number,
	beatType: number,
	ctx: MeasureContext
): number {
	const { ss, staffTopY } = ctx;
	const numerator = digitGlyphs(beats);
	const denominator = digitGlyphs(beatType);
	const widthOf = (glyphs: readonly GlyphName[]) =>
		glyphs.reduce((sum, glyph) => sum + GLYPH_METRICS[glyph].advance * ss, 0);
	const width = Math.max(widthOf(numerator), widthOf(denominator));

	// SMuFL time-signature digits are drawn centred on their origin, so putting
	// the origin one staff space below the top line centres the numerator in the
	// upper half of the staff and the denominator in the lower half.
	for (const [glyphs, y] of [
		[numerator, staffTopY + ss],
		[denominator, staffTopY + 3 * ss]
	] as const) {
		let cursor = x + (width - widthOf(glyphs)) / 2;
		for (const glyph of glyphs) {
			ops.push({ kind: 'glyph', glyph, x: cursor, y });
			cursor += GLYPH_METRICS[glyph].advance * ss;
		}
	}
	return x + width + SPACING.headerGap * ss;
}

function digitGlyphs(value: number): readonly GlyphName[] {
	return String(Math.max(0, Math.trunc(value)))
		.split('')
		.map((digit) => TIME_SIG_DIGITS[Number(digit)] ?? 'timeSig0');
}

/**
 * Where a note's notehead landed, recorded so a later pass can act on its
 * position without redoing notehead placement itself. Originally just for a
 * beamed note (`layoutBeamGroup` draws every member's stem and the connecting
 * beam(s) once the whole group's positions are known); Slice 5 (ties) widened
 * it to every pitched note, beamed or not, since the tie pass at the end of
 * `layoutMeasure` needs an unbeamed or whole note's position too.
 */
interface NotePlacement {
	readonly noteX: number;
	readonly y: number;
	readonly headGlyph: GlyphName;
	readonly d: number;
	/** This note's own stem direction, or `null` for a whole note (no stem).
	 *  Unused by `layoutBeamGroup` (a group's shared direction lives on
	 *  `BeamGroup.direction` instead); read by the tie pass to decide which
	 *  side of the notehead a tie curve leans toward. */
	readonly up: boolean | null;
	/** Which side a tie from this head curves toward, when it is one head of a
	 *  multi-head chord (M6 Slice 2; see `layoutNote`): `true` below, `false`
	 *  above. `undefined` for a lone note, whose tie follows `up` as always. */
	readonly tieBelow?: boolean;
}

/**
 * Multi-voice stem-direction convention (M2 Slice 1, generalized during the
 * M2 scoping recheck before M3 to cover voices 3+): odd-numbered voices stem
 * up and even-numbered voices stem down, regardless of which side of the
 * middle line a note actually sits on, the standard way real engraving tells
 * multiple voices sharing one staff apart at a glance. Only engages when
 * `multiVoice` is true (this measure genuinely holds more than one voice); a
 * single-voice measure, this engine's only case before M2 Slice 1, must keep
 * the ordinary pitch-based rule (`stemDirectionForNotes` with no override
 * here) so every existing single-voice test keeps its exact expected output.
 *
 * Parity (odd/even) rather than "voice 1/2 only, everything else falls back
 * to pitch" is what actually earns the name "a multi-voice convention": the
 * whole point of a fixed-by-voice-number stem rule is that a reader can tell
 * voices apart by stem direction alone, without having to also know each
 * note's pitch; leaving voice 3+ on the pitch-based rule would silently
 * un-do that guarantee for every score with more than two voices on a staff,
 * which is exactly the gap this generalization closes. Choosing parity
 * specifically (not, say, "voices 1-2 up, 3-4 down") is deliberate too: it
 * is the smallest possible extension of the existing voice-1-up/voice-2-down
 * rule that a third voice can be added to without changing what voice 1 or
 * voice 2 already do, and it reproduces both of their exact existing
 * directions by construction (`1 % 2 === 1` -> up, `2 % 2 === 0` -> down).
 */
function voiceStemOverride(voice: number, multiVoice: boolean): 'up' | 'down' | undefined {
	if (!multiVoice) return undefined;
	return voice % 2 === 1 ? 'up' : 'down';
}

/**
 * Vertical nudge, in staff spaces, applied to a rest's ordinary default y
 * (below) once its measure holds more than one voice: odd-numbered voices'
 * rests shift up and even-numbered voices' shift down, growing further from
 * the staff the higher the voice number climbs, so no two voices' rests at a
 * shared onset print on top of each other. This is the standard convention
 * for voices sharing a staff (an upper voice's rests sit higher than usual,
 * a lower voice's lower), gated on `multiVoice` for exactly the reason
 * `voiceStemOverride` is: a single-voice measure gets no offset at all,
 * keeping today's fixed rest position exactly as it was before M2 Slice 1.
 *
 * Generalized during the M2 scoping recheck before M3 from the original
 * voice-1/voice-2-only rule to every voice, by the same odd-up/even-down
 * parity `voiceStemOverride` uses (mirroring, not replacing, that existing
 * two-voice convention): each successive same-parity voice steps one further
 * `REST_VOICE_OFFSET_SPACES` away from the staff than the last, so voice 3's
 * rest clears voice 1's the same way voice 1's clears the staff's own
 * default, rather than every odd voice colliding on the identical offset
 * voice 1 alone used to get. `Math.ceil(voice / 2)` counts "how many voices
 * of this parity, including this one, are at or below this voice number"
 * (1 -> 1, 3 -> 2, 5 -> 3, ...), and `voice / 2` does the same for the even
 * side directly since every even voice number is already a whole step count
 * (2 -> 1, 4 -> 2, ...); both reduce to exactly voice 1's `-1` step and
 * voice 2's `+1` step (i.e. today's `-2`/`+2` once multiplied by
 * `REST_VOICE_OFFSET_SPACES`) when there are only two voices, so this is a
 * pure extension, not a change, of the existing two-voice behaviour.
 *
 * This is deliberately computed from the voice number alone, with no
 * awareness of which *other* voices actually share this measure (e.g. a
 * score using voices 1 and 3 but never 2 still gives voice 3 the "third
 * step out" offset, not "second", even though only two voices are present).
 * Reaching for the true set of present voices would need a signature change
 * (this function would have to take the measure's other voices as a
 * parameter, not just its own), which is not worth the extra plumbing for a
 * convention whose only real-world case is voices numbered 1..N with no
 * gaps; a caller with gappy voice numbers still gets a correct, merely more
 * spread out, layout, never a collision.
 */
const REST_VOICE_OFFSET_SPACES = 2;
function restVoiceOffsetSpaces(voice: number, multiVoice: boolean): number {
	if (!multiVoice) return 0;
	return voice % 2 === 1
		? -REST_VOICE_OFFSET_SPACES * Math.ceil(voice / 2)
		: REST_VOICE_OFFSET_SPACES * (voice / 2);
}

/** The ops (`[opStart, opEnd)`) and `notes` entry one whole-measure rest
 *  produced in `layoutMeasure`, so `centreMeasureRests` can move them. */
interface MeasureRestSpan {
	readonly opStart: number;
	readonly opEnd: number;
	readonly noteIndex: number;
}

/**
 * Move each whole-measure rest (`Note.isMeasureRest`) so its glyph sits
 * centred between the end of the measure's header and its barline, the
 * standard engraving for a bar of silence (Gould, "Behind Bars": the
 * semibreve rest is centred in the bar whatever the time signature).
 *
 * Done as a translation after the fact rather than by giving the rest a
 * special x up front: its column still has to take part in the ordinary
 * onset-column spacing (so the measure gets its natural width and any other
 * voice's notes keep their positions), and the barline's final x is only
 * known once column-width sharing has run, after every note is placed.
 */
function centreMeasureRests(
	ops: DrawOp[],
	notes: LaidOutNote[],
	spans: readonly MeasureRestSpan[],
	leftX: number,
	rightX: number,
	ss: number
): void {
	const { bBoxSW, bBoxNE } = GLYPH_METRICS.restWhole;
	for (const span of spans) {
		const glyphOp = ops[span.opStart];
		if (!glyphOp || glyphOp.kind !== 'glyph') continue;
		const inkCentreX = glyphOp.x + ((bBoxSW[0] + bBoxNE[0]) / 2) * ss;
		const dx = (leftX + rightX) / 2 - inkCentreX;
		for (let i = span.opStart; i < span.opEnd; i++) {
			const op = ops[i]!;
			ops[i] =
				op.kind === 'curve'
					? { ...op, x0: op.x0 + dx, cx0: op.cx0 + dx, cx1: op.cx1 + dx, x1: op.x1 + dx }
					: { ...op, x: op.x + dx };
		}
		const laidOut = notes[span.noteIndex];
		if (laidOut) notes[span.noteIndex] = { ...laidOut, bounds: { ...laidOut.bounds, x: laidOut.bounds.x + dx } };
	}
}

/**
 * One stem's geometry, decided once per event (a lone note or a whole chord)
 * by `layoutNote` and drawn either there (unbeamed) or by `layoutBeamGroup`
 * (beamed, once the group's beam height is known). `left` is the stem's
 * outer-left x (see `stemXEdges`); `attachY` is where it meets the head
 * farthest from its tip (for a chord, the outermost head on the non-stem
 * side, so the one stem visibly joins every head); `nearY` is the head
 * nearest its tip, from which the ordinary `STEM_LENGTH` is measured. For a
 * single note `attachY` and `nearY` are the same head, which reproduces the
 * pre-chord stem exactly.
 */
interface ChordStem {
	readonly left: number;
	readonly attachY: number;
	readonly nearY: number;
}

/**
 * Lay out one event in its column: a rest, a single note, or a chord (M6
 * Slice 2; a single note is the one-head chord, and every rule below reduces
 * to the pre-chord behaviour for it).
 *
 * `chord` is the event as `noteEvents` returns it, anchor first. Returns each
 * head's `NotePlacement` (keyed by its own note id, since ties, slurs and
 * hit-testing stay per head), the event's one stem (`null` for a rest, a whole
 * note, or a stem `layoutBeamGroup` will draw from the returned geometry), the
 * rightmost ink for the next note's accidental check, and how far this event
 * pushed the rest of its voice right.
 */
function layoutNote(
	ops: DrawOp[],
	notes: LaidOutNote[],
	cellX: number,
	chord: readonly Note[],
	keyFifths: number,
	ctx: MeasureContext,
	beamDirection: 'up' | 'down' | null,
	lastStatedAlterForStep: Map<Step, number>,
	previousInkRight: number | null,
	multiVoice: boolean
): {
	heads: readonly (readonly [NoteId, NotePlacement])[];
	stem: ChordStem | null;
	inkRight: number;
	collisionShift: number;
} {
	const { ss } = ctx;
	const anchor = chord[0]!;
	const beamed = beamDirection !== null;

	if (anchor.pitch === null) {
		const note = anchor;
		const glyph = REST_GLYPHS[note.value];
		// Every rest hangs from, sits on, or centres about the middle of the
		// staff; the glyph origins encode which, so one y works for all four.
		// `restVoiceOffsetSpaces` nudges that shared default apart for a
		// second voice sharing this measure (M2 Slice 1); it is always 0 for a
		// single-voice measure, so this is exactly the old fixed y then.
		const y =
			ctx.staffTopY +
			(note.value === 'whole' ? 1 : 2) * ss +
			restVoiceOffsetSpaces(note.voice, multiVoice) * ss;
		ops.push({ kind: 'glyph', glyph, x: cellX, y, noteId: note.id });
		// A rest has no line/space of its own to nudge a dot off of, so its dot
		// sits at the rest's own y with no vertical adjustment.
		layoutAugmentationDots(ops, cellX + GLYPH_METRICS[glyph].advance * ss, y, false, note.dots, ctx);
		notes.push({ id: note.id, bounds: glyphBounds(glyph, cellX, y, ss, 0.25) });
		return {
			heads: [],
			stem: null,
			inkRight: cellX + GLYPH_METRICS[glyph].bBoxNE[0] * ss,
			collisionShift: 0
		};
	}

	// Every head, low to high. `appendNote` guarantees a chord member is
	// pitched; the filter only narrows the type.
	const heads = chord
		.flatMap((note) => (note.pitch ? [{ note, pitch: note.pitch, d: diatonicIndex(note.pitch) }] : []))
		.sort((a, b) => a.d - b.d);
	const ds = heads.map((head) => head.d);
	const lowest = heads[0]!;
	const highest = heads[heads.length - 1]!;
	// The chord's one notehead shape: its duration is the anchor's, so a
	// member whose own `value` disagrees (only reachable from odd imports)
	// still draws the chord's head, and every width below is that head's.
	const headGlyph = NOTEHEAD_GLYPHS[anchor.value];
	const headWidth = GLYPH_METRICS[headGlyph].advance * ss;
	const hasStem = anchor.value !== 'whole';

	// One direction for the whole chord: a beamed chord takes its group's, an
	// unbeamed one the farthest-from-the-middle-line rule over *every* head
	// (`stemDirectionForNotes` already decides a beam group the same way, so
	// a chord is just a group whose members share an x). A whole-note chord
	// has no stem, but its seconds still need a side to displace to, so it
	// computes the same virtual direction.
	const up = beamed
		? beamDirection === 'up'
		: stemDirectionForNotes(ds, ctx.lines.middleLine, voiceStemOverride(anchor.voice, multiVoice)) === 'up';

	const displaced = chordHeadDisplacement(ds, up);
	const anyDisplaced = displaced.some(Boolean);
	// How far a displaced head sits from the normal column: one head width
	// less one stem thickness, so the two heads straddle the stem and each
	// touches it, the standard engraving for a second.
	const displacement = headWidth - ED.stemThickness * ss;

	// Draw an accidental when this note's alter disagrees with what is
	// currently "in force" for its step: the key signature, unless some
	// earlier note in this measure already stated a different alter for the
	// same step, in which case that stated alter is what carries forward
	// instead (the MusicXML/engraving convention that a stated accidental
	// holds for the rest of the measure, reset at the next barline). A second
	// F-sharp in a measure that already stated one therefore draws nothing;
	// an F-natural in between draws its natural and itself becomes what the
	// next F needs to match, so a third F-sharp after that draws its sharp
	// again rather than staying suppressed.
	//
	// Tracked per step only, not per (step, octave): a stricter reading of the
	// convention scopes the carry-over to the same octave too, so an F#5
	// followed later by a plain F4 would, under that reading, still need its
	// own natural. This does not yet draw that natural; multi-octave
	// same-step interaction is left for whichever later slice first needs to
	// tell two octaves of the same step apart; nothing in this slice's scope
	// exercises it.
	//
	// A chord's heads (M6 Slice 2) are all judged against the state *before*
	// the chord, then the state is updated once for all of them: two heads of
	// one step (F#4 and F#5) both show their sharp, rather than the second
	// being suppressed by the first a moment earlier at the same onset. When
	// two heads of one step disagree (F#4 with F5), the highest head's alter
	// is what carries forward, an arbitrary but deterministic pick for a case
	// the per-step model cannot express exactly anyway.
	const accidentals: { readonly d: number; readonly glyph: GlyphName; readonly noteId: NoteId }[] = [];
	for (const head of heads) {
		const impliedAlter = lastStatedAlterForStep.get(head.pitch.step) ?? keyAlterForStep(keyFifths, head.pitch.step);
		if (head.pitch.alter === impliedAlter) continue;
		accidentals.push({
			d: head.d,
			glyph: ACCIDENTAL_GLYPHS[String(clampAlter(head.pitch.alter)) as keyof typeof ACCIDENTAL_GLYPHS],
			noteId: head.note.id
		});
	}
	for (const accidental of accidentals) {
		const head = heads.find((candidate) => candidate.note.id === accidental.noteId)!;
		lastStatedAlterForStep.set(head.pitch.step, head.pitch.alter);
	}
	const accidentalColumns = stackAccidentals(accidentals);
	const columnWidths = accidentalColumns.map((column) =>
		Math.max(...column.map((accidental) => GLYPH_METRICS[accidental.glyph].advance * ss))
	);
	const accidentalsWidth =
		accidentalColumns.length === 0
			? 0
			: columnWidths.reduce((sum, width) => sum + width, 0) +
				(accidentalColumns.length - 1) * SPACING.accidentalColumnGap * ss +
				SPACING.accidentalGap * ss;

	// A tight previous note can leave less than a clean gap before this
	// accidental: push the whole note (accidental, head, stem, everything
	// after it) right by however much clearance is missing, rather than let
	// the accidental print on top of the previous note's stem or ledger line.
	// Only an accidental triggers this, since it is the one thing drawn to the
	// *left* of the note's own cell; the notehead itself already gets its own
	// room from `noteAdvanceSpaces` (and a displaced head from the extra width
	// `measureColumns` reserves for a chord with a second). The shift has to
	// widen this voice's later notes too (`layoutMeasure` accumulates it), or
	// the next note's cell would start back where this one would have landed
	// without it, undoing the very clearance just added.
	let collisionShift = 0;
	if (accidentals.length > 0 && previousInkRight !== null) {
		const shortfall = SPACING.minAccidentalClearance * ss - (cellX - previousInkRight);
		if (shortfall > 0) collisionShift = shortfall;
	}
	const accidentalsX = cellX + collisionShift;
	// The leftmost head's x, then the normal (stem-side) column's: a down-stem
	// chord's displaced heads sit *left* of the stem, so the normal column
	// moves right by one displacement to make room for them.
	const leftHeadX = accidentalsX + accidentalsWidth;
	const noteX = leftHeadX + (anyDisplaced && !up ? displacement : 0);
	const headX = (i: number): number => (displaced[i] ? (up ? noteX + displacement : noteX - displacement) : noteX);

	// Accidental columns, nearest the heads first (column 0), each glyph
	// right-aligned in its column so differently wide glyphs still line up
	// against the heads. A single accidental is column 0 alone, at exactly the
	// x the pre-chord layout gave it (`cellX`, head after it plus the gap).
	let columnRight = leftHeadX - SPACING.accidentalGap * ss;
	accidentalColumns.forEach((column, c) => {
		for (const accidental of column) {
			const x = columnRight - GLYPH_METRICS[accidental.glyph].advance * ss;
			ops.push({ kind: 'glyph', glyph: accidental.glyph, x, y: staffY(accidental.d, ctx), noteId: accidental.noteId });
		}
		columnRight -= columnWidths[c]! + SPACING.accidentalColumnGap * ss;
	});
	// Accidental columns beyond the first are wider than anything the column
	// spacing budgeted (a lone accidental has always eaten into its own
	// note's advance instead), so they push the rest of this voice right.
	const extraAccidentalWidth = accidentalColumns.length > 1 ? accidentalsWidth - columnWidths[0]! - SPACING.accidentalGap * ss : 0;

	heads.forEach((head, i) => {
		ops.push({ kind: 'glyph', glyph: headGlyph, x: headX(i), y: staffY(head.d, ctx), noteId: head.note.id });
	});
	layoutChordLedgerLines(
		ops,
		heads.map((head, i) => ({ d: head.d, x: headX(i), noteId: head.note.id })),
		headWidth,
		ctx
	);

	// Dots line up in one column right of the chord's rightmost head.
	const headsRight = Math.max(...heads.map((_, i) => headX(i))) + headWidth;
	layoutChordDots(ops, headsRight, ds, anchor.dots, ctx);

	// A beamed chord's stem is drawn later, by `layoutBeamGroup`, once every
	// member of its group has a recorded position: its length depends on the
	// whole group, not on this chord alone. An unbeamed chord (whole, or
	// eighth-and-shorter with no beamable neighbour) draws its own here.
	// Either way the geometry is decided once, here: the stem stands on the
	// normal column, joins the far head (lowest for an up stem, highest for a
	// down one) and is measured from the near head, so it spans the chord.
	let stem: ChordStem | null = null;
	if (hasStem) {
		const anchors = glyphMetrics(headGlyph).anchors;
		const stemAnchor = up ? anchors.stemUpSE : anchors.stemDownNW;
		const edges = stemXEdges(headGlyph, noteX, up, ss);
		if (stemAnchor && edges) {
			const far = up ? lowest : highest;
			const near = up ? highest : lowest;
			stem = {
				left: edges.left,
				attachY: staffY(far.d, ctx) - stemAnchor[1] * ss,
				nearY: staffY(near.d, ctx)
			};
			if (!beamed) layoutStemAndFlag(ops, stem, anchor.value, anchor.id, ctx, up);
		}
	}

	// Every head's final position is recorded, not just a beamed anchor's:
	// the tie pass in `layoutMeasure` needs each tied head's own position,
	// and `layoutBeamGroup` reads `stem` instead. A chord's ties split by
	// side (standard engraving): heads in the upper half curve up, the lower
	// half down, and a middle head of an odd count away from the stem. A lone
	// note keeps the plain away-from-the-stem rule (`tieBelow` left unset).
	const placementUp = hasStem ? up : null;
	const placed = heads.map((head, i): readonly [NoteId, NotePlacement] => {
		let tieBelow: boolean | undefined;
		if (heads.length > 1) {
			const middle = (heads.length - 1) / 2;
			tieBelow = i < middle ? true : i > middle ? false : up;
		}
		return [
			head.note.id,
			{ noteX: headX(i), y: staffY(head.d, ctx), headGlyph, d: head.d, up: placementUp, tieBelow }
		];
	});

	// Hit boxes in the chord's model order, one per head, so a click resolves
	// to the head under the pointer.
	for (const note of chord) {
		const placement = placed.find(([id]) => id === note.id)?.[1];
		if (placement) notes.push({ id: note.id, bounds: glyphBounds(headGlyph, placement.noteX, placement.y, ss, 0.3) });
	}

	// The rightmost ink: the rightmost head, a ledger line's extension past
	// it (ledger lines only extend past a head outside the staff's own
	// top/bottom lines; this mirrors `layoutChordLedgerLines`' own bounds),
	// and the stem's outer edge, whichever reaches furthest.
	let inkRight = Math.max(...heads.map((_, i) => headX(i) + GLYPH_METRICS[headGlyph].bBoxNE[0] * ss));
	if (highest.d >= ctx.lines.topLine + 2 || lowest.d <= ctx.lines.bottomLine - 2) {
		inkRight = Math.max(inkRight, headsRight + ED.legerLineExtension * ss);
	}
	if (stem) inkRight = Math.max(inkRight, stem.left + ED.stemThickness * ss);

	return {
		heads: placed,
		stem,
		inkRight,
		collisionShift: collisionShift + extraAccidentalWidth
	};
}

/**
 * Which heads of a chord go on the "wrong" side of the stem, given their
 * diatonic positions sorted low to high (M6 Slice 2). Two heads a second
 * apart cannot share a column, so one crosses the stem: for an up stem the
 * walk goes bottom-up and the upper head of each second moves right of the
 * stem; for a down stem it goes top-down and the lower head moves left. A
 * head is only displaced when the head it seconds is *not* already
 * displaced, which is what makes a cluster (C-D-E) alternate sides rather
 * than all landing on one: the standard rule (Gould, "Behind Bars").
 *
 * Unisons (two heads at one position, e.g. F and F#) are not handled: they
 * overlap, as in many simple engravers; this slice's corpus has none.
 */
function chordHeadDisplacement(ds: readonly number[], up: boolean): boolean[] {
	const displaced = ds.map(() => false);
	if (up) {
		for (let i = 1; i < ds.length; i++) {
			if (ds[i]! - ds[i - 1]! === 1 && !displaced[i - 1]) displaced[i] = true;
		}
	} else {
		for (let i = ds.length - 2; i >= 0; i--) {
			if (ds[i + 1]! - ds[i]! === 1 && !displaced[i + 1]) displaced[i] = true;
		}
	}
	return displaced;
}

/**
 * Minimum diatonic distance between two accidentals sharing a column: a
 * sharp or natural is about three staff spaces tall (six diatonic steps), so
 * two closer than a seventh would overlap vertically.
 */
const ACCIDENTAL_COLUMN_MIN_STEPS = 6;

/**
 * Assign a chord's accidentals to columns left of the heads (M6 Slice 2),
 * column 0 nearest. The standard order (Gould; Ross, "The Art of Music
 * Engraving"): the topmost accidental first, then the bottommost, then the
 * second from the top, second from the bottom and so on inward, each taking
 * the nearest column where it clears every accidental already there by at
 * least `ACCIDENTAL_COLUMN_MIN_STEPS`. Outer accidentals therefore hug the
 * heads, and an inner one, which would collide with both, moves out a column.
 * A lone accidental is one column of one, i.e. the pre-chord layout exactly.
 */
function stackAccidentals<A extends { readonly d: number }>(accidentals: readonly A[]): A[][] {
	const byHeight = [...accidentals].sort((a, b) => b.d - a.d);
	const order: A[] = [];
	for (let top = 0, bottom = byHeight.length - 1; top <= bottom; top++, bottom--) {
		order.push(byHeight[top]!);
		if (bottom !== top) order.push(byHeight[bottom]!);
	}
	const columns: A[][] = [];
	for (const accidental of order) {
		const column = columns.find((candidate) =>
			candidate.every((other) => Math.abs(other.d - accidental.d) >= ACCIDENTAL_COLUMN_MIN_STEPS)
		);
		if (column) column.push(accidental);
		else columns.push([accidental]);
	}
	return columns;
}

/**
 * The rightward nudge a voice's notehead needs, in pixels, to clear a
 * second-interval (adjacent line/space, `Math.abs(d1 - d2) === 1`) clash
 * against any *earlier-numbered* voice's notehead already placed at the same
 * column or the one immediately before it, or `0` when there is nothing to
 * clear.
 *
 * Generalized during the M2 scoping recheck before M3 from the original
 * exactly-two-voice case (voice 1 against voice 2) to any number of voices:
 * `layoutMeasure`'s column loop already processes each column's voices in
 * ascending voice-number order (see `voiceNumbers`), so by the time a given
 * voice's note reaches this function, every lower-numbered voice already
 * placed *in this same column* (plus whichever of them were placed in the
 * previous column) is known and passed in as `atThisColumn`/`atPrevColumn`.
 * The check now loops over every entry in both arrays combined, taking the
 * largest shift any of them demands, instead of a single fixed "voice 1"
 * value. The one-directional convention itself is unchanged: a later-
 * numbered voice always yields to an earlier one, never the reverse, the
 * same asymmetry the original two-voice version already established
 * (mirroring `voiceStemOverride`'s fixed odd-up/even-down assignment, which
 * likewise treats a lower voice number as never having to move for a higher
 * one). A voice with nothing earlier placed at either column (voice 1 above
 * all, since no voice ever precedes it) naturally receives two empty
 * arrays and this function returns `0` with no special-casing needed,
 * reproducing voice 1's old always-unshifted behaviour for free.
 *
 * The check is genuinely geometric, not a blind interval match: a second
 * apart is necessary but not sufficient, since two notes a second apart at
 * columns already far enough separated in x clear each other with room to
 * spare (a half note against a much later eighth, say). The real test is
 * the actual pixel gap between the two noteheads' positions against one
 * notehead's own width, the standard convention's target clearance ("shifts
 * the clashing note so its head sits immediately to the right of the
 * other").
 *
 * Only the immediately preceding column is ever checked, not every earlier
 * one: `layoutMeasure`'s column loop only ever has the previous column's
 * result on hand by the time this runs, the same no-lookahead constraint
 * that keeps the whole restructured pass a single left-to-right walk.
 */
function secondIntervalClashShift(
	d: number,
	headGlyph: GlyphName,
	candidateCellX: number,
	atThisColumn: readonly { readonly d: number; readonly noteX: number }[],
	atPrevColumn: readonly { readonly d: number; readonly noteX: number }[],
	ss: number
): number {
	const requiredGap = GLYPH_METRICS[headGlyph].advance * ss;
	let shift = 0;
	for (const earlierNote of [...atThisColumn, ...atPrevColumn]) {
		if (Math.abs(earlierNote.d - d) !== 1) continue;
		const gap = candidateCellX - earlierNote.noteX;
		if (gap < requiredGap) shift = Math.max(shift, requiredGap - gap);
	}
	return shift;
}

/**
 * Draw a note's augmentation dots, right of the notehead (or rest) per SMuFL
 * convention.
 *
 * A dot sitting on a staff line reads as if it is touching the line, so when
 * the note it belongs to sits on a line, the dot is nudged up into the space
 * above instead of drawn at the note's own height. `onLine` is `false` for
 * rests, which have no line/space of their own to nudge off of.
 */
function layoutAugmentationDots(
	ops: DrawOp[],
	startX: number,
	glyphY: number,
	onLine: boolean,
	dots: number,
	ctx: MeasureContext
): void {
	if (dots === 0) return;
	const { ss } = ctx;
	const y = onLine ? glyphY - ss / 2 : glyphY;
	const dotAdvance = GLYPH_METRICS.augmentationDot.advance * ss;
	let x = startX + SPACING.dotGap * ss;
	for (let i = 0; i < dots; i++) {
		ops.push({ kind: 'glyph', glyph: 'augmentationDot', x, y });
		x += dotAdvance + SPACING.dotSpacing * ss;
	}
}

/**
 * Augmentation dots for every head of a chord (M6 Slice 2), in one column
 * starting just right of `headsRight` (the chord's rightmost head edge, so a
 * displaced head never collides with a dot). Each head's dot sits in that
 * head's own space, or, for a head on a line, the space above it, the
 * standard rule `layoutAugmentationDots` already applies to a single note.
 * Two heads a second apart can want the same space (a line head's space
 * above is the next head's own space); the later one then takes the space
 * below its line instead, so no dot is drawn twice or lost.
 */
function layoutChordDots(ops: DrawOp[], headsRight: number, ds: readonly number[], dots: number, ctx: MeasureContext): void {
	if (dots === 0) return;
	// Positions are claimed top-down so the highest head always keeps its
	// natural space and any conflict pushes a lower dot further down.
	const claimed = new Set<number>();
	for (const d of [...ds].sort((a, b) => b - a)) {
		const onLine = (d - ctx.lines.bottomLine) % 2 === 0;
		let position = onLine ? d + 1 : d;
		if (claimed.has(position) && onLine) position = d - 1;
		if (claimed.has(position)) continue;
		claimed.add(position);
		// `layoutAugmentationDots`' own `onLine` nudge is half a space up,
		// which is exactly `position = d + 1`; passing the resolved space's y
		// with `onLine: false` draws the same dot for that case and lets the
		// space-below case reuse it too.
		layoutAugmentationDots(ops, headsRight, staffY(position, ctx), false, dots, ctx);
	}
}

/**
 * Ledger lines for every head of a chord (M6 Slice 2), a single note being
 * the one-head case. Each ledger position beyond the staff is drawn once,
 * spanning every head that needs it: a head needs the ledger at `position`
 * when it sits on it or further out (a head in the space just past a ledger
 * still needs that ledger to be read). The span covers each such head's own
 * x, so a displaced head on a ledger widens that line across both sides of
 * the stem, while a ledger only the normal column needs stays head-width.
 * Ledger lines only ever land on line positions, the diatonic indices with
 * the same parity as the staff lines themselves. Tagged with the outermost
 * head's id, the one whose own ledger it most directly is.
 */
function layoutChordLedgerLines(
	ops: DrawOp[],
	heads: readonly { readonly d: number; readonly x: number; readonly noteId: NoteId }[],
	headWidth: number,
	ctx: MeasureContext
): void {
	const { ss } = ctx;
	const extension = ED.legerLineExtension * ss;
	const thickness = ED.legerLineThickness * ss;
	const push = (position: number, needing: readonly { readonly x: number }[], noteId: NoteId) => {
		const left = Math.min(...needing.map((head) => head.x));
		const right = Math.max(...needing.map((head) => head.x)) + headWidth;
		ops.push({
			kind: 'rect',
			x: left - extension,
			y: staffY(position, ctx) - thickness / 2,
			width: right - left + extension * 2,
			height: thickness,
			noteId
		});
	};
	const top = heads.reduce((a, b) => (b.d > a.d ? b : a));
	const bottom = heads.reduce((a, b) => (b.d < a.d ? b : a));
	for (let position = ctx.lines.topLine + 2; position <= top.d; position += 2) {
		push(position, heads.filter((head) => head.d >= position), top.noteId);
	}
	for (let position = ctx.lines.bottomLine - 2; position >= bottom.d; position -= 2) {
		push(position, heads.filter((head) => head.d <= position), bottom.noteId);
	}
}

function layoutStemAndFlag(
	ops: DrawOp[],
	stem: ChordStem,
	value: NoteValue,
	noteId: string,
	ctx: MeasureContext,
	up: boolean
): void {
	const { ss } = ctx;
	// Direction and geometry are decided once, by the caller (`layoutNote`),
	// via `stemDirectionForNotes` over every head; a single note is just the
	// one-head case of the same rule `layoutBeamGroup` uses for a whole group,
	// and passing the answer in rather than recomputing it here is what lets
	// a note's ink extent and its actual stem agree on which way it points.
	// The stem runs from the far head's attachment to `STEM_LENGTH` beyond
	// the near head, so a chord's stem spans every head plus the usual length.
	const thickness = ED.stemThickness * ss;
	const tipY = stem.nearY + (up ? -STEM_LENGTH * ss : STEM_LENGTH * ss);
	ops.push({
		kind: 'rect',
		x: stem.left,
		y: Math.min(stem.attachY, tipY),
		width: thickness,
		height: Math.abs(tipY - stem.attachY),
		noteId
	});

	const flagGlyphs = FLAG_GLYPHS[value];
	if (!flagGlyphs) return;
	// This function only ever runs for a note with no beamable neighbour
	// (`layoutMeasure` routes anything in a group of two or more to
	// `layoutBeamGroup` instead), so an eighth-and-shorter note reaching here
	// always draws its own flag.
	const glyph: GlyphName = up ? flagGlyphs.up : flagGlyphs.down;
	const flagAnchor = glyphMetrics(glyph).anchors[up ? 'stemUpNW' : 'stemDownSW'];
	if (!flagAnchor) return;
	ops.push({
		kind: 'glyph',
		glyph,
		x: stem.left - flagAnchor[0] * ss,
		y: tipY + flagAnchor[1] * ss,
		noteId
	});
}

/**
 * The x a note's stem occupies (its left/outer edge, and the right edge one
 * stem thickness in), given the notehead's own stem anchor. Shared by
 * `layoutNote`'s stem geometry (`ChordStem.left`, which both an unbeamed
 * stem and `layoutBeamGroup` then draw at) and its ink-extent calculation for
 * the accidental-collision check, which need the same two numbers and should
 * never compute them differently. `null` when the notehead publishes no
 * stem anchor at all (Phase 0/1 only lacks one for `noteheadWhole`, which
 * never reaches here since whole notes never carry a stem).
 */
function stemXEdges(
	headGlyph: GlyphName,
	noteX: number,
	up: boolean,
	ss: number
): { left: number; right: number } | null {
	const anchor = glyphMetrics(headGlyph).anchors[up ? 'stemUpSE' : 'stemDownNW'];
	if (!anchor) return null;
	const thickness = ED.stemThickness * ss;
	// The anchor names the *outer* edge of the stem, hence the inset by one
	// stem thickness on the up side: the stem hangs to the left of that edge.
	const left = up ? noteX + anchor[0] * ss - thickness : noteX + anchor[0] * ss;
	return { left, right: left + thickness };
}

/** A run of consecutive beamable notes sharing one beam. Always two or more
 *  members: `computeBeamGroups` never reports a group of one, since a lone
 *  eligible note is indistinguishable from an ordinary unbeamed one.
 *
 *  `notes` holds one note per beam member: for a chord (M6 Slice 2) that is
 *  its anchor only, the note its stem, flag and duration belong to; the
 *  chord's other heads are not listed (they share the anchor's stem). */
export interface BeamGroup {
	readonly notes: readonly Note[];
	/**
	 * The one stem direction shared by the whole group, decided once here
	 * (by `computeBeamGroups`, via `stemDirectionForNotes`) so every consumer
	 * agrees: `layoutBeamGroup`'s own stems and beam, and `layoutNote`'s
	 * ink-extent calculation for a beamed member (needed before
	 * `layoutBeamGroup` ever runs, since the accidental-collision check walks
	 * the measure's notes in order).
	 */
	readonly direction: 'up' | 'down';
}

/**
 * How much duration one beat holds, as a fraction of a whole note, for
 * deciding where a beam group must break.
 *
 * Simple meters (4/4, 3/4, 2/4, 2/2, ...) beam by the beat the time
 * signature's denominator names: one beat is one note of that value. Compound
 * meters (6/8, 9/8, 12/8) instead beam by the dotted-quarter beat: three
 * eighths make one beat, not one. Telling them apart from `beats`/`beatType`
 * alone is a real ambiguity at the edges (3/8 is sometimes beamed as a single
 * three-eighth group and sometimes as three separate one-eighth beats
 * depending on tempo and house style); this picks the simplest rule that gets
 * the common cases right rather than modelling the full convention: `beatType
 * === 8` and a `beats` count divisible by three and greater than three is
 * compound, everything else is simple.
 */
function beatDurationWholes(time: TimeSignature): number {
	const unit = 1 / time.beatType;
	const isCompound = time.beatType === 8 && time.beats % 3 === 0 && time.beats > 3;
	return isCompound ? unit * 3 : unit;
}

/**
 * Partition a measure's notes into beam groups: runs of consecutive eighth-
 * and-shorter notes that share a beat, per `beatDurationWholes`.
 *
 * A rest breaks a group (rests are never beamed to a neighbour, so a group
 * never has to reason about beaming over one), and so does a quarter note or
 * longer, and so does crossing a beat boundary. None of that makes a group of
 * one: a single eligible note with no beamable neighbour is reported as
 * nothing here and falls through to its ordinary individual flag in
 * `layoutNote`/`layoutStemAndFlag`.
 *
 * Position within the measure is tracked in `durationWholes`, which already
 * folds in dots and tuplet ratios, so a tupleted eighth lands in the same
 * beat math as a plain one without this function needing to know tuplets
 * exist.
 *
 * Chords (M6 Slice 2) are walked as events (`noteEvents`): a chord is one
 * beam member, eligible by its anchor's value, advancing the beat cursor
 * once, and every one of its heads votes in the group's stem direction.
 *
 * `notes` is expected to already be one voice's own notes (M2 Slice 1's
 * `layoutMeasure` calls this once per voice via `notesByVoice`, never on a
 * measure's raw flat array): the beat-position cursor above is a single
 * running total, which a second voice's notes interleaved into the same
 * array would corrupt (their durations would be counted against the first
 * voice's beat position, and vice versa). `voiceOverride`, when given, forces
 * every group's `direction` regardless of pitch (see `voiceStemOverride`);
 * omitted, a lone voice keeps `stemDirectionForNotes`'s ordinary pitch-based
 * rule exactly as before this slice.
 *
 * `middleLine` may instead be a per-note function (M6 Slice 4), for a
 * measure whose clef changes partway: each head is then judged against its
 * own clef's middle line.
 *
 * `excludeIds` (M2 Slice 6) marks notes that must never join an *automatic*
 * group here, because each already belongs to an explicit
 * `Score.CrossStaffBeam` instead (see `layoutMeasure`'s own cross-staff
 * integration). An excluded note still behaves like any other ineligible
 * one for the purposes of this function: it flushes whatever group is open
 * and its own duration still advances `position`, since it still occupies
 * real time in the beat-position tracker; it simply never starts or extends
 * a group of its own.
 */
export function computeBeamGroups(
	notes: readonly Note[],
	time: TimeSignature,
	middleLine: number | ((note: Note) => number),
	voiceOverride?: 'up' | 'down',
	excludeIds?: ReadonlySet<NoteId>
): BeamGroup[] {
	const beatWholes = beatDurationWholes(time);
	// A float position compared against a beat boundary with plain `<`/`floor`
	// would occasionally misfire on the rounding noise a chain of additions
	// accumulates; this tolerance is far tighter than any duration difference
	// that could be musically real.
	const EPS = 1e-9;

	// Runs of *events* (M6 Slice 2): a chord is one beam member, so a run
	// holds chords (anchor first) and the beat cursor advances once per chord.
	const groups: Note[][][] = [];
	let current: Note[][] = [];
	// The beat the notes in `current` fall in, so a new note can be compared
	// against it without recomputing anything about the notes already grouped.
	let currentBeat = -1;
	let position = 0;

	const flush = () => {
		if (current.length >= 2) groups.push(current);
		current = [];
	};

	for (const chord of noteEvents(notes)) {
		const note = chord[0]!;
		const eligible =
			note.pitch !== null && note.value in FLAG_GLYPHS && !(excludeIds?.has(note.id) ?? false);
		if (!eligible) {
			flush();
			position += note.durationWholes;
			continue;
		}
		const beat = Math.floor((position + EPS) / beatWholes);
		if (current.length > 0 && beat !== currentBeat) flush();
		current.push(chord);
		currentBeat = beat;
		position += note.durationWholes;
	}
	flush();

	// Direction from every head of every chord in the run, so a chord's
	// outermost head counts toward the farthest-from-the-middle-line rule.
	// With a per-note middle line (a clef change inside the measure, M6
	// Slice 4) each head is measured against its own clef's line: the rule
	// only ever looks at distance from the line, so heads are shifted to be
	// relative to it and judged against 0.
	if (typeof middleLine === 'function') {
		return groups.map((group) => ({
			notes: group.map((chord) => chord[0]!),
			direction: stemDirectionForNotes(
				group.flat().flatMap((note) => (note.pitch ? [diatonicIndex(note.pitch) - middleLine(note)] : [])),
				0,
				voiceOverride
			)
		}));
	}
	return groups.map((group) => ({
		notes: group.map((chord) => chord[0]!),
		direction: stemDirectionForNotes(
			group.flat().flatMap((note) => (note.pitch ? [diatonicIndex(note.pitch)] : [])),
			middleLine,
			voiceOverride
		)
	}));
}

/**
 * The single-voice stem direction rule, shared by a lone note and a beamed
 * group's one uniform direction: whichever side of the middle line has more
 * room wins.
 *
 * A single note (called here with one index) points up when it sits below
 * the middle line, since an up-stem then rises through the emptier half of
 * the staff, and down when it sits on or above the line, for the mirrored
 * reason. A note exactly on the middle line has no "more room" side to
 * prefer; this picks down-stem as the fixed tie-break (a common house
 * convention, not a universal one) so the same note always renders the same
 * way rather than flipping on whatever the caller happened to average it
 * with.
 *
 * A beamed group (called with every member's index) cannot point two ways at
 * once, so real engraving decides by the single member with the strongest
 * preference: whichever note sits farthest from the middle line, since its
 * single-note answer would be the least ambiguous of the group. A tie for
 * farthest between a note above the line and one below it (equally far on
 * both sides) falls back to a majority vote across every member, not just the
 * tied ones; a further tie (equal counts on both sides too, or every member
 * sitting exactly on the line) falls back to the same down-stem convention a
 * single on-the-line note uses.
 *
 * This deliberately does not average positions (Slice 2's original group
 * rule): an average is dominated by a cluster of notes only slightly off the
 * line and can be pulled to the wrong side by one note that is actually far
 * off it, exactly the disagreement this function resolves in the far note's
 * favour instead.
 *
 * `voiceOverride` (M2 Slice 1) short-circuits all of the above: when a
 * measure holds more than one voice, direction is decided by *which voice*,
 * not by pitch at all (see `voiceStemOverride`). Every existing call site
 * that never passes it (ties, slurs, and a single-voice measure's own notes)
 * keeps exactly the pitch-based rule below, unchanged.
 */
export function stemDirectionForNotes(
	diatonicIndices: readonly number[],
	middleLine: number,
	voiceOverride?: 'up' | 'down'
): 'up' | 'down' {
	if (voiceOverride) return voiceOverride;
	if (diatonicIndices.length === 0) return 'down';

	const displacement = (d: number) => d - middleLine;
	const maxAbsDisplacement = Math.max(...diatonicIndices.map((d) => Math.abs(displacement(d))));
	const farthest = diatonicIndices.filter((d) => Math.abs(displacement(d)) === maxAbsDisplacement);

	const farthestBelow = farthest.some((d) => displacement(d) < 0);
	const farthestAbove = farthest.some((d) => displacement(d) > 0);
	if (farthestBelow && !farthestAbove) return 'up';
	if (farthestAbove && !farthestBelow) return 'down';

	if (farthestBelow && farthestAbove) {
		// The farthest note is tied between the two sides: fall back to which
		// side the group as a whole leans toward.
		const below = diatonicIndices.filter((d) => displacement(d) < 0).length;
		const above = diatonicIndices.filter((d) => displacement(d) > 0).length;
		if (below > above) return 'up';
		if (above > below) return 'down';
	}

	// Either every note sits exactly on the middle line (maxAbsDisplacement is
	// 0, so neither side is "farthest"), or the majority vote above tied too:
	// same convention a single on-the-line note falls back to.
	return 'down';
}

/**
 * Draw one beam group: every member's stem, then the primary beam (spanning
 * the whole group) and any secondary/tertiary beams (spanning only the
 * sub-run of notes whose own duration needs that many beams, e.g. two 16ths
 * next to a beamed eighth get a secondary beam over just the 16ths).
 *
 * The beam is flat, at a height set so the group's most extreme member gets
 * exactly `STEM_LENGTH` and every other member's stem is at least that long,
 * reaching up (or down) to the same beam. Real engraving angles the beam
 * slightly to follow the notes' contour; a flat beam is this slice's
 * deliberate simplification, left for a later pass to refine, since it is
 * already correct enough to read as one beamed group rather than stacked
 * flags.
 *
 * `fixedBeamY` (M2 Slice 6), when given, overrides that "clear the group's
 * most extreme member" height with a cross-staff beam's own staff-geometry-
 * derived join height instead (see `layoutMeasure`'s own cross-staff
 * integration for where it comes from and why it must not be fitted to the
 * notes' own contour). Nothing else in this function needs to change for
 * that: a member's stem length is already computed generically as
 * `Math.abs(beamY - attachY)`, so an arbitrarily long stem, needed to reach
 * across a staff gap, already works with no special case.
 */
function layoutBeamGroup(
	ops: DrawOp[],
	group: BeamGroup,
	stems: ReadonlyMap<NoteId, ChordStem>,
	ctx: MeasureContext,
	fixedBeamY?: number,
	tips?: Map<NoteId, number>
): void {
	const { ss } = ctx;
	// Each member's stem geometry as `layoutNote` decided it, keyed by the
	// member (a chord's anchor; see `BeamGroup.notes`): the stem stands on the
	// chord's normal column, so the beam attaches there too, and it reaches
	// from the far head, so the beam's height is measured from the near one.
	const members = group.notes.flatMap((note) => {
		const stem = stems.get(note.id);
		return stem ? [{ note, stem }] : [];
	});
	if (members.length < 2) return;

	const up = group.direction === 'up';
	const beamY =
		fixedBeamY ??
		(up
			? Math.min(...members.map((m) => m.stem.nearY - STEM_LENGTH * ss))
			: Math.max(...members.map((m) => m.stem.nearY + STEM_LENGTH * ss)));

	const stemThickness = ED.stemThickness * ss;
	for (const { note, stem } of members) {
		// Every stem of the group ends at the beam's outer edge (the primary
		// beam is drawn inward from `beamY`, see `barY` below).
		tips?.set(note.id, beamY);
		ops.push({
			kind: 'rect',
			x: stem.left,
			y: Math.min(stem.attachY, beamY),
			width: stemThickness,
			height: Math.abs(beamY - stem.attachY),
			noteId: note.id
		});
	}

	const beamThickness = ED.beamThickness * ss;
	// Centre-to-centre distance between adjacent beams: the font's own
	// recommended gap plus the beam's own thickness.
	const beamPitch = (ED.beamThickness + ED.beamSpacing) * ss;
	const maxLevel = Math.max(...group.notes.map((n) => BEAM_LEVELS[n.value] ?? 1));

	for (let level = 1; level <= maxLevel; level++) {
		// Each additional beam stacks further from the noteheads than the last,
		// same direction as the stems extend.
		const barY = up
			? beamY + (level - 1) * beamPitch
			: beamY - (level - 1) * beamPitch - beamThickness;

		let runStart = -1;
		for (let i = 0; i <= members.length; i++) {
			const atLevel = i < members.length && (BEAM_LEVELS[members[i]!.note.value] ?? 1) >= level;
			if (atLevel && runStart === -1) runStart = i;
			if (!atLevel && runStart !== -1) {
				pushBeamSegment(ops, members, runStart, i - 1, barY, beamThickness, stemThickness, up, ss);
				runStart = -1;
			}
		}
	}
}

/**
 * One beam segment (a rectangle) at a given level, spanning from the first to
 * the last member of a run of notes that share that subdivision.
 *
 * `stemXOf` gives each member's stem's *left* edge, so a segment's width adds
 * back `stemWidth` to reach the last member's right edge; using the beam's
 * own (thicker) `beamHeight` for that padding instead would overshoot every
 * segment's right end by the difference between the two.
 *
 * A run of one note (a lone 16th next to notes that only need the primary
 * beam) has no neighbour to span to at this level; real engraving points its
 * partial beam ("beamlet") toward whichever neighbour is more subdivided.
 * This instead always points toward the next note in the group if there is
 * one, otherwise back toward the previous one, a fixed stub width rather than
 * that neighbour-duration comparison: simpler, and visually indistinguishable
 * for the common case this slice targets (a single 16th next to an eighth).
 */
function pushBeamSegment(
	ops: DrawOp[],
	members: readonly { readonly note: Note; readonly stem: ChordStem }[],
	startIndex: number,
	endIndex: number,
	barY: number,
	beamHeight: number,
	stemWidth: number,
	up: boolean,
	ss: number
): void {
	const stemXOf = (i: number) => members[i]!.stem.left;

	if (startIndex === endIndex) {
		const stubWidth = 0.9 * ss;
		const towardNext = endIndex + 1 < members.length;
		const anchorX = stemXOf(startIndex);
		const x = towardNext ? anchorX : anchorX - stubWidth;
		ops.push({ kind: 'rect', x, y: barY, width: stubWidth + stemWidth, height: beamHeight });
		return;
	}

	const x0 = stemXOf(startIndex);
	const x1 = stemXOf(endIndex);
	const left = Math.min(x0, x1);
	const right = Math.max(x0, x1);
	ops.push({ kind: 'rect', x: left, y: barY, width: right - left + stemWidth, height: beamHeight });
}

/**
 * Which side of the notehead a tie (or, later, a slur) attached to `point`
 * should curve toward: `true` for below, `false` for above. Standard
 * engraving convention is away from the stem, so this is just the opposite of
 * the note's own stem direction; a whole note has no real stem (`point.up` is
 * `null`), so it falls back to `stemDirectionForNotes` on its own diatonic
 * index, the same single-note rule a stem would have used.
 */
/** One event `layoutMeasure` defers to `layoutEventMarks` (M6 Slice 5). */
interface MarkedEvent {
	readonly chord: readonly Note[];
	/** Every head's final placement; empty for a rest. */
	readonly heads: readonly NotePlacement[];
	readonly stem: ChordStem | null;
	/** The clef context the event was laid out against (mid-measure clef
	 *  changes give a note its own), for staff positions and ledger lines. */
	readonly ctx: MeasureContext;
	/** A rest's glyph op index (valid until the staff lines are unshifted). */
	readonly restOp: number | null;
}

/** Bravura's glyph per articulation, in its above-the-note and below-the-note
 *  forms (an accent's wedge or a marcato's roof points away from the note). */
const ARTICULATION_GLYPHS: Readonly<Record<Articulation, { readonly above: GlyphName; readonly below: GlyphName }>> = {
	staccato: { above: 'articStaccatoAbove', below: 'articStaccatoBelow' },
	staccatissimo: { above: 'articStaccatissimoAbove', below: 'articStaccatissimoBelow' },
	tenuto: { above: 'articTenutoAbove', below: 'articTenutoBelow' },
	'detached-legato': { above: 'articTenutoStaccatoAbove', below: 'articTenutoStaccatoBelow' },
	accent: { above: 'articAccentAbove', below: 'articAccentBelow' },
	'strong-accent': { above: 'articMarcatoAbove', below: 'articMarcatoBelow' }
};

/** The flat marks small enough to sit inside a staff space (Gould, *Behind
 *  Bars*: staccato and tenuto go in the space next to the notehead, never on
 *  a line). Everything else (accent, marcato, the staccatissimo wedge, and
 *  the combined tenuto-staccato glyph, all about a space tall) cannot fit
 *  between two lines, so it goes outside the staff whenever it would
 *  otherwise cross one. */
const IN_STAFF_ARTICULATIONS: ReadonlySet<Articulation> = new Set(['staccato', 'tenuto']);

/** Minimum gap, staff spaces, between a mark and whatever it stacks beyond:
 *  the notehead, the stem tip or beam, or the previous mark. */
const ARTICULATION_CLEARANCE = 0.35;
/** The smaller gap a staccato or tenuto snapped into a staff space needs:
 *  the space right next to a space-note's head leaves a staccato dot only
 *  ~0.33 spaces of air, and that adjacent space is exactly where Gould puts
 *  it, so a larger figure would push every such dot one space too far. */
const IN_STAFF_CLEARANCE = 0.25;
/** Gap, staff spaces, between a fermata and the staff or the highest ink
 *  under it (a fermata sits clear of everything, like a tempo mark). */
const FERMATA_CLEARANCE = 0.5;

/**
 * Draw one event's articulations and fermata (M6 Slice 5), following the
 * standard engraving rules (Gould, *Behind Bars*, "Articulation"):
 *
 *  - Side: opposite the stem (above a stem-down note, below a stem-up one);
 *    above a rest or a stemless whole note. With two or more voices on the
 *    staff the side is the voice's, odd voices above and even below, which is
 *    their stem side, so there the marks stack beyond the stem tip (or beam)
 *    and centre on the stem. A marcato always goes above.
 *  - Order: outward from the note in `ARTICULATIONS` order, so staccato and
 *    tenuto sit nearest and accents outside them.
 *  - Staccato and tenuto are centred in the nearest staff space
 *    clear of the notehead, stepping one further out when that would put them
 *    on a staff or ledger line. Taller marks (accent, marcato, staccatissimo)
 *    stack at `ARTICULATION_CLEARANCE` from what is below them, and move
 *    outside the staff if they would cross its lines.
 *  - A fermata (`'upright'`) goes above the staff and above everything at its
 *    x (heads, a stem tip, the marks just placed, a tie or slur curve),
 *    centred on the note or rest; an `'inverted'` one mirrors that below.
 *
 * A chord gets each mark once (`eventArticulations`), centred on its normal
 * (stem) column and stacked beyond its outermost head. Each mark's op carries
 * the id of the head the mark was written on, so selecting it tints the mark.
 */
function layoutEventMarks(
	ops: DrawOp[],
	event: MarkedEvent,
	restBox: Rect | null,
	stemTipY: number | null,
	curves: readonly Extract<DrawOp, { kind: 'curve' }>[],
	multiVoice: boolean
): void {
	const { chord, heads, stem, ctx } = event;
	const { ss } = ctx;
	const anchor = chord[0]!;
	const staffTop = ctx.staffTopY;
	const staffBottom = ctx.staffTopY + 4 * ss;

	// The event's own ink extent, and the x a mark centres on.
	let top: number;
	let bottom: number;
	let headCentreX: number;
	let stemUp: boolean | null = null;
	let lowLine = ctx.lines.bottomLine;
	let highLine = ctx.lines.topLine;
	if (heads.length === 0) {
		if (!restBox) return;
		top = restBox.y;
		bottom = restBox.y + restBox.height;
		headCentreX = restBox.x + restBox.width / 2;
	} else {
		const headGlyph = heads[0]!.headGlyph;
		const { bBoxSW, bBoxNE } = GLYPH_METRICS[headGlyph];
		const ys = heads.map((head) => head.y);
		top = Math.min(...ys) - bBoxNE[1] * ss;
		bottom = Math.max(...ys) - bBoxSW[1] * ss;
		stemUp = heads[0]!.up;
		// The normal column: a displaced head of a second sits right of an up
		// stem and left of a down one, so the other side's x is the column.
		const xs = heads.map((head) => head.noteX);
		const normalX = stemUp === false ? Math.max(...xs) : Math.min(...xs);
		headCentreX = normalX + ((bBoxSW[0] + bBoxNE[0]) / 2) * ss;
		// Ledger lines reach from the staff out to the outermost heads.
		const ds = heads.map((head) => head.d);
		lowLine = Math.min(lowLine, ...ds);
		highLine = Math.max(highLine, ...ds);
	}
	const stemX = stem ? stem.left + (ED.stemThickness * ss) / 2 : null;

	// Each side's current outer edge (canvas y): where the next mark on that
	// side stacks from. The stem side starts at the stem's tip.
	let aboveEdge = stemUp === true && stemTipY !== null ? Math.min(top, stemTipY) : top;
	let belowEdge = stemUp === false && stemTipY !== null ? Math.max(bottom, stemTipY) : bottom;

	const override = voiceStemOverride(anchor.voice, multiVoice);
	const side: 'above' | 'below' = override ? (override === 'up' ? 'above' : 'below') : stemUp === true ? 'below' : 'above';

	const positionOfY = (y: number): number => ctx.lines.bottomLine + (staffBottom - y) / (ss / 2);
	const isLine = (p: number): boolean =>
		p >= lowLine && p <= highLine && (((p - ctx.lines.bottomLine) % 2) + 2) % 2 === 0;
	const carrierOf = (has: (note: Note) => boolean): NoteId => (chord.find(has) ?? anchor).id;

	for (const kind of eventArticulations(chord)) {
		const markSide = kind === 'strong-accent' ? 'above' : side;
		const above = markSide === 'above';
		// Canvas y grows downward, so "outward" above is negative.
		const out = above ? -1 : 1;
		const glyph = ARTICULATION_GLYPHS[kind][markSide];
		const { bBoxSW, bBoxNE } = GLYPH_METRICS[glyph];
		const height = (bBoxNE[1] - bBoxSW[1]) * ss;
		const edge = above ? aboveEdge : belowEdge;
		let centreY: number;
		if (IN_STAFF_ARTICULATIONS.has(kind)) {
			// The nearest half-space position (outward) whose mark clears the
			// edge, then one further out if that is a staff or ledger line.
			const wanted = positionOfY(edge + out * (IN_STAFF_CLEARANCE * ss + height / 2));
			let p = above ? Math.ceil(wanted - 1e-6) : Math.floor(wanted + 1e-6);
			if (isLine(p)) p += above ? 1 : -1;
			centreY = staffY(p, ctx);
		} else {
			let near = edge + out * ARTICULATION_CLEARANCE * ss;
			const far = near + out * height;
			const crossesStaff = Math.max(near, far) > staffTop && Math.min(near, far) < staffBottom;
			if (crossesStaff) {
				near = above
					? Math.min(near, staffTop - ARTICULATION_CLEARANCE * ss)
					: Math.max(near, staffBottom + ARTICULATION_CLEARANCE * ss);
			}
			centreY = near + (out * height) / 2;
		}
		// At the stem end (multi-voice) a mark centres on the stem, otherwise
		// on the notehead.
		const atStem = stemX !== null && (above ? stemUp === true : stemUp === false);
		const centreX = atStem ? stemX : headCentreX;
		ops.push({
			kind: 'glyph',
			glyph,
			x: centreX - ((bBoxSW[0] + bBoxNE[0]) / 2) * ss,
			y: centreY + ((bBoxSW[1] + bBoxNE[1]) / 2) * ss,
			noteId: carrierOf((note) => note.articulations.includes(kind))
		});
		if (above) aboveEdge = Math.min(aboveEdge, centreY - height / 2);
		else belowEdge = Math.max(belowEdge, centreY + height / 2);
	}

	const fermata = eventFermata(chord);
	if (fermata !== null) {
		const upright = fermata === 'upright';
		const glyph: GlyphName = upright ? 'fermataAbove' : 'fermataBelow';
		const { bBoxSW, bBoxNE } = GLYPH_METRICS[glyph];
		// Any tie or slur curve passing over this x: its control points
		// bound it (see `measureRegion`), a conservative but simple clearance.
		let extreme = upright ? Math.min(staffTop, aboveEdge) : Math.max(staffBottom, belowEdge);
		for (const curve of curves) {
			if (headCentreX < Math.min(curve.x0, curve.x1) || headCentreX > Math.max(curve.x0, curve.x1)) continue;
			extreme = upright
				? Math.min(extreme, curve.y0, curve.cy0, curve.cy1, curve.y1)
				: Math.max(extreme, curve.y0, curve.cy0, curve.cy1, curve.y1);
		}
		const x = headCentreX - ((bBoxSW[0] + bBoxNE[0]) / 2) * ss;
		// The glyph's ink bottom (upright) or top (inverted) at the clearance.
		const y = upright
			? extreme - FERMATA_CLEARANCE * ss + bBoxSW[1] * ss
			: extreme + FERMATA_CLEARANCE * ss + bBoxNE[1] * ss;
		ops.push({ kind: 'glyph', glyph, x, y, noteId: carrierOf((note) => note.fermata !== null) });
	}
}

function tieCurvesBelow(point: NotePlacement, middleLine: number): boolean {
	return point.tieBelow ?? point.up ?? stemDirectionForNotes([point.d], middleLine) === 'up';
}

/**
 * Push a `curve` draw op with these eight numbers, exactly as `DrawOp`'s
 * `curve` variant shapes them. The one place both `pushTieCurve` and
 * `pushSlurSegment` build the op itself, so a change to that shape (an extra
 * field, a renamed one) only has one call site to update, not two near-
 * identical object literals that could quietly drift apart.
 */
function pushCurve(
	ops: DrawOp[],
	x0: number,
	y0: number,
	cx0: number,
	cy0: number,
	cx1: number,
	cy1: number,
	x1: number,
	y1: number,
	thickness: number,
	noteId: NoteId | undefined
): void {
	ops.push({ kind: 'curve', x0, y0, cx0, cy0, cx1, cy1, x1, y1, thickness, noteId });
}

/**
 * Push one tie curve's draw op: a shallow cubic Bezier from `(x0, y0)` to
 * `(x1, y1)`, bulging below the straight line between them when `curvesBelow`
 * is true and above it otherwise. Shared by a same-measure tie's single,
 * full-span curve and each half of a tie crossing a barline (see the tie pass
 * in `layoutMeasure`).
 */
function pushTieCurve(
	ops: DrawOp[],
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	curvesBelow: boolean,
	noteId: NoteId,
	ctx: MeasureContext
): void {
	const { ss } = ctx;
	// Canvas y grows downward, so "below" is a positive offset.
	const dir = curvesBelow ? 1 : -1;
	const bulge = TIE_BULGE * ss;
	pushCurve(
		ops,
		x0,
		y0,
		x0 + (x1 - x0) * 0.25,
		y0 + dir * bulge,
		x0 + (x1 - x0) * 0.75,
		y1 + dir * bulge,
		x1,
		y1,
		ED.tieMidpointThickness * ss,
		noteId
	);
}

/**
 * Every note a slur spans, start to end inclusive, in score order. Computed
 * fresh from `Score.notesInOrder(staffIndex)` (not from any measure's
 * already-laid-out notes) every time it is asked for, which is what lets any
 * one of the slur's measures be re-laid-out on its own and still agree with
 * the others about what the whole slur looks like: see the slur pass's own
 * comment in `layoutMeasure`.
 *
 * `staffIndex` is threaded through by the caller rather than re-derived here,
 * because the slur-drawing loop in `layoutMeasure` already has
 * `startMeasure.staffIndex` on hand (it needs it for its own region-scoping
 * check just above); recomputing the same lookup a second time inside this
 * function would just be duplicate work for the same answer, and this
 * function has no other way to get a staff index since a bare `Slur` names
 * only its two note ids, not the staff they live on (`Score.addSlur` records
 * that separately, as the measures those ids resolve to).
 */
function slurSpanNotes(score: Score, slur: Slur, staffIndex: number): Note[] {
	const order = score.notesInOrder(staffIndex);
	const startIndex = order.findIndex((note) => note.id === slur.startNoteId);
	const endIndex = order.findIndex((note) => note.id === slur.endNoteId);
	return order.slice(startIndex, endIndex + 1);
}

/**
 * The canvas y a slur's curve cruises at everywhere it is not anchored to one
 * of its own two end notes: the flat "shelf" of a middle segment (a measure
 * the slur passes through without either end landing in it), and the control
 * points that pull a first or last segment's curve up (or down) off its one
 * real endpoint toward that shelf.
 *
 * Computed from the single most extreme diatonic position among *every* note
 * the whole slur spans (`spanNotes`, gathered by `slurSpanNotes`), on the
 * side the curve bulges toward, or the staff's own edge if nothing in the
 * span reaches past it. Reading the whole span rather than just this
 * measure's own notes is what lets one arc clear a note that dips or rises
 * further than either of the slur's own two ends, and is also why every
 * measure the slur touches computes the same shelf height: `spanNotes` does
 * not depend on which measure asked.
 *
 * Deliberate simplification: this only reads each spanned note's own
 * diatonic position, not its actual rendered ink (a stem's length, a beam, a
 * ledger line's extension). Real slur engraving avoids all of that; this
 * slice's acceptance criteria only ask for a reasonable-looking arc over the
 * notes it spans, not full collision avoidance against every obstacle a
 * slur could in principle cross.
 */
function slurRoofY(spanNotes: readonly Note[], curvesBelow: boolean, ctx: MeasureContext): number {
	const diatonics = spanNotes.flatMap((note) => (note.pitch ? [diatonicIndex(note.pitch)] : []));
	const extreme = curvesBelow
		? Math.min(ctx.lines.bottomLine, ...diatonics)
		: Math.max(ctx.lines.topLine, ...diatonics);
	const edgeY = staffY(extreme, ctx);
	return curvesBelow ? edgeY + SLUR_ROOF_CLEARANCE * ctx.ss : edgeY - SLUR_ROOF_CLEARANCE * ctx.ss;
}

/**
 * Push one slur segment's draw op: a cubic Bezier from `(x0, y0)` to
 * `(x1, y1)` whose *control* points both sit at `roofY`, regardless of where
 * the segment's own two endpoints are.
 *
 * That is what gives a multi-measure slur one continuous-looking arc built
 * out of independent per-measure segments: a middle segment's endpoints are
 * both already `roofY` (a flat shelf), a first or last segment's one real
 * endpoint (a notehead) is pulled up or down toward `roofY` by the control
 * point nearest it, and a single-measure slur's two endpoints are both
 * noteheads with the arc rising to `roofY` in between, arching over whatever
 * the slur spans exactly the way a real slur's midpoint sits higher (or
 * lower) than either of its ends.
 */
function pushSlurSegment(
	ops: DrawOp[],
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	roofY: number,
	noteId: NoteId,
	ctx: MeasureContext
): void {
	const { ss } = ctx;
	pushCurve(
		ops,
		x0,
		y0,
		x0 + (x1 - x0) * 0.25,
		roofY,
		x0 + (x1 - x0) * 0.75,
		roofY,
		x1,
		y1,
		ED.slurMidpointThickness * ss,
		noteId
	);
}

// --- Dynamics and hairpins (M6 Slice 6) ------------------------------------
//
// Placed in a pass of their own, after a system's measures on one staff are
// laid out (`layoutDirectionRow`), because the two rules that place them both
// read more than one measure: a system's dynamics and hairpins share one
// baseline per side of the staff, low (or high) enough to clear the ink of
// every measure carrying one, and a hairpin is one straight wedge from its
// start's x to its stop's x, which are usually in different measures. Every
// input to that pass is a measure's finished `LaidOutMeasure` (its region, its
// notes' boxes, its `inkExtent`) plus the model, so `relayoutMeasure` can
// redo it for one re-laid-out measure from its cached neighbours.
//
// Ownership stays per measure, as region-scoped redraw needs: a dynamic's
// glyph is in the ops of the measure holding it, and a hairpin is cut at
// every barline it crosses, each measure drawing its own piece of the two
// lines, so repainting any one measure puts back exactly its piece. A
// hairpin that crosses a system break is one segment per system, the
// continuation starting at the left of the new system's music: the opening
// grows (crescendo) or shrinks (diminuendo) across the whole hairpin, so a
// two-system crescendo ends its first segment half open and starts the
// second there, the way engraving continues one (Gould, *Behind Bars*,
// "Hairpins").

/** Bravura's combined glyph for each dynamic. */
const DYNAMIC_GLYPHS: Readonly<Record<DynamicKind, GlyphName>> = {
	pppppp: 'dynamicPPPPPP',
	ppppp: 'dynamicPPPPP',
	pppp: 'dynamicPPPP',
	ppp: 'dynamicPPP',
	pp: 'dynamicPP',
	p: 'dynamicPiano',
	mp: 'dynamicMP',
	mf: 'dynamicMF',
	f: 'dynamicForte',
	ff: 'dynamicFF',
	fff: 'dynamicFFF',
	ffff: 'dynamicFFFF',
	fffff: 'dynamicFFFFF',
	ffffff: 'dynamicFFFFFF',
	sf: 'dynamicSforzando1',
	sfz: 'dynamicSforzato',
	sffz: 'dynamicSforzatoFF',
	sfp: 'dynamicSforzandoPiano',
	sfpp: 'dynamicSforzandoPianissimo',
	sfzp: 'dynamicSforzatoPiano',
	fp: 'dynamicFortePiano',
	fz: 'dynamicForzando',
	rf: 'dynamicRinforzando1',
	rfz: 'dynamicRinforzando2',
	pf: 'dynamicPF',
	n: 'dynamicNiente'
};

const DIRECTION = {
	/** Blank between the ink a direction clears and the dynamic's tallest
	 *  letter (or a hairpin's edge), staff spaces. */
	clearance: 0.6,
	/** How far a dynamic letter can reach above its baseline (an `f`'s
	 *  ascender) and below it (a `p`'s or `f`'s descender), staff spaces:
	 *  Bravura's tallest and deepest dynamic glyphs. Every dynamic sits on one
	 *  baseline per side, so these fixed figures, not each glyph's own box,
	 *  decide how far that baseline is from the ink; a system's marks then
	 *  line up whatever letters they use. */
	ascent: 1.776,
	descent: 0.608,
	/** Height above the baseline of a hairpin's centre line: half the letters'
	 *  x-height, so a hairpin points at the middle of a `p` or `f`. */
	hairpinCentre: 0.55,
	/** A hairpin's full opening, staff spaces. MusicXML's `spread` default is
	 *  1.5; engraved hairpins are commonly a little narrower than a dynamic's
	 *  x-height, and this sits between the two. */
	hairpinOpening: 1.1,
	/** Gap between a hairpin's end and a dynamic it meets, staff spaces. */
	dynamicGap: 0.4,
	/** Gap between a hairpin's stop and the notehead it stops at. */
	noteGap: 0.3,
	/** A hairpin whose drawn length would come out shorter than this is not
	 *  drawn (OMR's zero-length hairpins, a start and stop at one onset). */
	minLength: 1
} as const;

/** One staff's measures in one system, as `layoutDirectionRow` needs them:
 *  `measures` laid out without directions (or cached with them; only their
 *  regions, notes and `inkExtent` are read), in order. */
interface DirectionRow {
	readonly staffIndex: number;
	readonly measures: readonly LaidOutMeasure[];
	readonly staffTopY: number;
	readonly ss: number;
	/** System index of every measure on this staff, so a hairpin can tell
	 *  which of its systems a measure is in. */
	readonly systemOf: readonly number[];
}

/** A wedge's effective stop: a stop on the downbeat of a measure that opens a
 *  new system is read as the end of the measure before it (the barline), so
 *  the hairpin does not reappear as a stub at the next system's start. */
function wedgeStop(score: Score, wedge: Wedge, systemOf: readonly number[]): { measureIndex: number; onset: number } {
	const { stop, start } = wedge;
	if (stop.onset === 0 && stop.measureIndex > start.measureIndex && systemOf[stop.measureIndex] !== systemOf[stop.measureIndex - 1]) {
		const previous = score.staves[wedge.staffIndex]!.measures[stop.measureIndex - 1]!;
		return { measureIndex: stop.measureIndex - 1, onset: measureDurationWholes(previous) };
	}
	return stop;
}

function sideOf(placement: Placement | null): Placement {
	return placement ?? 'below';
}

/**
 * The dynamics baseline (canvas y) on each side of the staff for a row: below
 * the lowest ink (above the highest) of every measure in the row carrying a
 * dynamic or a piece of a hairpin on that side, or `null` for a side with
 * none. One value per side is what lines a system's marks up.
 */
function directionBaselines(score: Score, row: DirectionRow): { above: number | null; below: number | null } {
	const { ss, staffIndex } = row;
	let lowest: number | null = null;
	let highest: number | null = null;
	const mark = (laid: LaidOutMeasure, side: Placement): void => {
		const extent = laid.inkExtent ?? { top: row.staffTopY, bottom: row.staffTopY + 4 * ss };
		if (side === 'below') lowest = Math.max(lowest ?? extent.bottom, extent.bottom);
		else highest = Math.min(highest ?? extent.top, extent.top);
	};
	const first = row.measures[0]?.index ?? 0;
	const last = row.measures[row.measures.length - 1]?.index ?? -1;
	const staff = score.staves[staffIndex]!;
	for (const laid of row.measures) {
		for (const dynamic of staff.measures[laid.index]!.dynamics) mark(laid, sideOf(dynamic.placement));
	}
	for (const wedge of score.wedges) {
		if (wedge.staffIndex !== staffIndex) continue;
		const stop = wedgeStop(score, wedge, row.systemOf);
		if (stop.measureIndex < first || wedge.start.measureIndex > last) continue;
		for (const laid of row.measures) {
			if (laid.index >= wedge.start.measureIndex && laid.index <= stop.measureIndex) mark(laid, sideOf(wedge.placement));
		}
	}
	return {
		below: lowest === null ? null : lowest + (DIRECTION.clearance + DIRECTION.ascent) * ss,
		above: highest === null ? null : highest - (DIRECTION.clearance + DIRECTION.descent) * ss
	};
}

/**
 * The x a direction at `onset` (wholes into the measure) lines up with: the
 * centre of the notehead (or rest) at that onset, the leftmost if several
 * voices have one; between two onsets that have notes, interpolated by time;
 * after the last one, interpolated towards the barline at the measure's end.
 * Also returns whether a note sits exactly there, which a hairpin's stop uses
 * to stop short of its head.
 */
function directionX(
	score: Score,
	staffIndex: number,
	laid: LaidOutMeasure,
	onset: number,
	ss: number
): { readonly x: number; readonly atNote: boolean } {
	const measure = score.staves[staffIndex]!.measures[laid.index]!;
	const onsets = noteOnsets(measure.notes);
	const boxes = new Map(laid.notes.map((n) => [n.id, n.bounds]));
	const xs = new Map<number, number>();
	for (const note of measure.notes) {
		const box = boxes.get(note.id);
		const at = onsets.get(note.id);
		if (!box || at === undefined) continue;
		const key = onsetKey(at);
		const centre = box.x + box.width / 2;
		xs.set(key, Math.min(xs.get(key) ?? centre, centre));
	}
	const known = [...xs].sort((a, b) => a[0] - b[0]);
	const key = onsetKey(onset);
	const exact = xs.get(key);
	if (exact !== undefined) return { x: exact, atNote: true };
	const right = laid.region.x + laid.region.width;
	const end = { key: onsetKey(Math.max(measureDurationWholes(measure), onset)), x: right - ss };
	if (known.length === 0) return { x: laid.region.x + (laid.region.width * Math.min(1, onset / (end.key || 1))), atNote: false };
	let before: readonly [number, number] | undefined;
	let after: readonly [number, number] | undefined;
	for (const entry of known) {
		if (entry[0] < key) before = entry;
		else if (!after) after = entry;
	}
	if (!before) return { x: known[0]![1], atNote: false };
	const next = after ?? ([end.key, end.x] as const);
	const t = next[0] === before[0] ? 1 : (key - before[0]) / (next[0] - before[0]);
	return { x: before[1] + (next[1] - before[1]) * t, atNote: false };
}

/** Where a dynamic's glyph goes: centred on its onset's x, kept inside its
 *  measure's band (a region never reaches into a neighbour's). */
function dynamicPlacement(
	score: Score,
	staffIndex: number,
	laid: LaidOutMeasure,
	mark: DynamicMark,
	ss: number
): { readonly glyph: GlyphName; readonly x: number; readonly left: number; readonly right: number } {
	const glyph = DYNAMIC_GLYPHS[mark.kind];
	const { bBoxSW, bBoxNE } = GLYPH_METRICS[glyph];
	const width = (bBoxNE[0] - bBoxSW[0]) * ss;
	const centre = directionX(score, staffIndex, laid, mark.onset, ss).x;
	const minLeft = laid.region.x + 0.2 * ss;
	const maxLeft = laid.region.x + laid.region.width - 0.2 * ss - width;
	const left = Math.max(minLeft, Math.min(maxLeft, centre - width / 2));
	return { glyph, x: left - bBoxSW[0] * ss, left, right: left + width };
}

/**
 * The ops one measure of `row` draws for its dynamics and its pieces of
 * hairpins, given the row's `baselines`. Every hairpin end and every
 * neighbour it reads is in `row` or derived from the model alone.
 */
function directionOpsForMeasure(
	score: Score,
	row: DirectionRow,
	baselines: { above: number | null; below: number | null },
	laid: LaidOutMeasure
): DrawOp[] {
	const { ss, staffIndex } = row;
	const ops: DrawOp[] = [];
	const staff = score.staves[staffIndex]!;
	const laidOf = (index: number): LaidOutMeasure | undefined => row.measures.find((m) => m.index === index);
	const baselineOf = (side: Placement): number => baselines[side] ?? row.staffTopY + (side === 'below' ? 6.4 : -2.4) * ss;

	for (const mark of staff.measures[laid.index]!.dynamics) {
		const placed = dynamicPlacement(score, staffIndex, laid, mark, ss);
		ops.push({ kind: 'glyph', glyph: placed.glyph, x: placed.x, y: baselineOf(sideOf(mark.placement)) });
	}

	const thisSystem = row.systemOf[laid.index]!;
	const rowFirst = row.measures[0]!;
	const rowLast = row.measures[row.measures.length - 1]!;
	for (const wedge of score.wedges) {
		if (wedge.staffIndex !== staffIndex || wedge.start.measureIndex > laid.index) continue;
		const stop = wedgeStop(score, wedge, row.systemOf);
		if (stop.measureIndex < laid.index) continue;
		const side = sideOf(wedge.placement);
		// Is there a dynamic on this side at (measure, onset)? Its box, if so.
		const dynamicAt = (index: number, onset: number) => {
			const laidThere = laidOf(index);
			const mark = laidThere
				? staff.measures[index]!.dynamics.find((d) => sideOf(d.placement) === side && Math.abs(d.onset - onset) < 1e-9)
				: undefined;
			return laidThere && mark ? dynamicPlacement(score, staffIndex, laidThere, mark, ss) : undefined;
		};

		// This system's segment, start to end x.
		let x0: number;
		const startLaid = row.systemOf[wedge.start.measureIndex] === thisSystem ? laidOf(wedge.start.measureIndex) : undefined;
		if (startLaid) {
			const dynamic = dynamicAt(wedge.start.measureIndex, wedge.start.onset);
			x0 = dynamic
				? dynamic.right + DIRECTION.dynamicGap * ss
				: directionX(score, staffIndex, startLaid, wedge.start.onset, ss).x - 0.6 * ss;
		} else {
			// A continuation: from the left of this system's music.
			x0 = Math.min(...rowFirst.notes.map((n) => n.bounds.x), rowFirst.region.x + rowFirst.region.width) - 0.5 * ss;
		}
		let x1: number;
		const stopLaid = row.systemOf[stop.measureIndex] === thisSystem ? laidOf(stop.measureIndex) : undefined;
		if (stopLaid) {
			const at = directionX(score, staffIndex, stopLaid, stop.onset, ss);
			x1 = at.atNote ? at.x - (0.6 + DIRECTION.noteGap) * ss : at.x;
			const measureEnd = measureDurationWholes(staff.measures[stop.measureIndex]!);
			const dynamic =
				dynamicAt(stop.measureIndex, stop.onset) ??
				(stop.onset >= measureEnd - 1e-9 && row.systemOf[stop.measureIndex + 1] === thisSystem
					? dynamicAt(stop.measureIndex + 1, 0)
					: undefined);
			if (dynamic) x1 = Math.min(x1, dynamic.left - DIRECTION.dynamicGap * ss);
		} else {
			// Continues on the next system: to this system's end.
			x1 = rowLast.region.x + rowLast.region.width - ss;
		}
		if (x1 - x0 < DIRECTION.minLength * ss) continue;

		// The opening at this segment's two ends: the hairpin's systems share
		// the growth evenly.
		const firstSystem = row.systemOf[wedge.start.measureIndex]!;
		const segments = row.systemOf[stop.measureIndex]! - firstSystem + 1;
		const i = thisSystem - firstSystem;
		const full = DIRECTION.hairpinOpening * ss;
		const grow = (fraction: number): number => (wedge.kind === 'crescendo' ? fraction : 1 - fraction) * full;
		const open0 = grow(i / segments);
		const open1 = grow((i + 1) / segments);

		// This measure's piece of the segment.
		const left = Math.max(x0, laid.region.x);
		const right = Math.min(x1, laid.region.x + laid.region.width);
		if (right <= left) continue;
		const at = (x: number): number => open0 + ((open1 - open0) * (x - x0)) / (x1 - x0);
		const centreY = baselineOf(side) - DIRECTION.hairpinCentre * ss;
		const a = at(left) / 2;
		const b = at(right) / 2;
		pushStraightLine(ops, left, centreY - a, right, centreY - b, ss);
		pushStraightLine(ops, left, centreY + a, right, centreY + b, ss);
	}
	return ops;
}

/** A straight stroke as a `curve` op (its control points on the line). */
function pushStraightLine(ops: DrawOp[], x0: number, y0: number, x1: number, y1: number, ss: number): void {
	pushCurve(
		ops,
		x0,
		y0,
		x0 + (x1 - x0) / 3,
		y0 + (y1 - y0) / 3,
		x0 + ((x1 - x0) * 2) / 3,
		y0 + ((y1 - y0) * 2) / 3,
		x1,
		y1,
		ED.hairpinThickness * ss,
		undefined
	);
}

/** Whether a staff's measures `first..last` (one system) have anything for
 *  the direction pass to draw: the cheap check that keeps a score without
 *  dynamics or hairpins on exactly its old layout path. */
function rowHasDirections(score: Score, staffIndex: number, first: number, last: number): boolean {
	const staff = score.staves[staffIndex]!;
	for (let i = first; i <= last; i++) if (staff.measures[i]!.dynamics.length > 0) return true;
	return score.wedges.some((w) => w.staffIndex === staffIndex && w.start.measureIndex <= last && w.stop.measureIndex >= first);
}

/** `laid` with `extra` ops appended and its region grown to cover them. */
function withDirectionOps(laid: LaidOutMeasure, extra: readonly DrawOp[], staffTopY: number, ss: number): LaidOutMeasure {
	if (extra.length === 0) return laid;
	const ops = [...laid.ops, ...extra];
	return { ...laid, ops, region: measureRegion(ops, laid.region.x, laid.region.width, staffTopY, ss) };
}

/** Every measure of `row` with its dynamics and hairpin pieces added. */
function layoutDirectionRow(score: Score, row: DirectionRow): LaidOutMeasure[] {
	const first = row.measures[0]?.index ?? 0;
	const last = row.measures[row.measures.length - 1]?.index ?? -1;
	if (!rowHasDirections(score, row.staffIndex, first, last)) return [...row.measures];
	const baselines = directionBaselines(score, row);
	return row.measures.map((laid) =>
		withDirectionOps(laid, directionOpsForMeasure(score, row, baselines, laid), row.staffTopY, row.ss)
	);
}

function pushGlyph(
	ops: DrawOp[],
	glyph: GlyphName,
	x: number,
	y: number,
	ctx: MeasureContext
): number {
	ops.push({ kind: 'glyph', glyph, x, y });
	return x + GLYPH_METRICS[glyph].advance * ctx.ss;
}

/** Canvas y of a diatonic staff position, for `ctx`'s own clef (`ctx.lines`). */
function staffY(diatonic: number, ctx: MeasureContext): number {
	return ctx.staffTopY + 4 * ctx.ss - (diatonic - ctx.lines.bottomLine) * (ctx.ss / 2);
}

function clampAlter(alter: number): -1 | 0 | 1 {
	return alter > 0 ? 1 : alter < 0 ? -1 : 0;
}

/**
 * A glyph's pixel bounding box, optionally padded. Note bounds are padded a
 * little because a notehead is only one staff space tall and a fingertip is
 * not; the pad is the whole reason hit targets are stored rather than derived
 * from the glyph box on demand.
 */
function glyphBounds(glyph: GlyphName, x: number, y: number, ss: number, pad = 0): Rect {
	const { bBoxSW, bBoxNE } = GLYPH_METRICS[glyph];
	// SMuFL bounding boxes are y-up; canvas is y-down, so NE supplies the top.
	return {
		x: x + bBoxSW[0] * ss - pad * ss,
		y: y - bBoxNE[1] * ss - pad * ss,
		width: (bBoxNE[0] - bBoxSW[0]) * ss + pad * 2 * ss,
		height: (bBoxNE[1] - bBoxSW[1]) * ss + pad * 2 * ss
	};
}

/**
 * The rectangle a measure owns.
 *
 * Vertically it is the union of everything drawn, so nothing this measure paints
 * escapes the area a redraw clears. Horizontally it is clamped to the measure's
 * own band even though a glyph could in principle overhang it, because a region
 * that reached into a neighbour would erase the neighbour on repaint. Nothing
 * Phase 0 draws overhangs: the lead-in and trail-out padding above exist to keep
 * that true.
 */
function measureRegion(
	ops: readonly DrawOp[],
	startX: number,
	width: number,
	staffTopY: number,
	ss: number
): Rect {
	let top = staffTopY;
	let bottom = staffTopY + 4 * ss;
	for (const op of ops) {
		if (op.kind === 'rect') {
			top = Math.min(top, op.y);
			bottom = Math.max(bottom, op.y + op.height);
		} else if (op.kind === 'curve') {
			// A cubic Bezier never leaves the convex hull of its four points, so
			// their y-extent is a safe (if slightly generous) enclosure.
			top = Math.min(top, op.y0, op.cy0, op.cy1, op.y1);
			bottom = Math.max(bottom, op.y0, op.cy0, op.cy1, op.y1);
		} else if (op.kind === 'text') {
			// Not reachable today: a `text` op only ever exists in
			// `LaidOutScore.partDecorations` (M2 Slice 5), never inside a
			// measure's own `ops`, so no measure's region needs to account for
			// one. Handled explicitly anyway, rather than falling into the
			// `glyph` branch below (which would misread `op`'s fields), so this
			// function stays correct if that ever changes rather than silently
			// wrong.
			top = Math.min(top, op.y - op.fontSizePx);
			bottom = Math.max(bottom, op.y);
		} else {
			const scale = op.fontSizePx !== undefined ? op.fontSizePx / (STAFF_SPACES_PER_EM * ss) : 1;
			const { bBoxSW, bBoxNE } = GLYPH_METRICS[op.glyph];
			top = Math.min(top, op.y - bBoxNE[1] * ss * scale);
			bottom = Math.max(bottom, op.y - bBoxSW[1] * ss * scale);
		}
	}
	// A hair of slack absorbs antialiasing at the edges of stems and staff
	// lines. `REGION_BLEED_PX`, not a locally re-declared literal: `barlineSpan`
	// (M2 Slice 4) has to know this exact value too, to keep two staves' own
	// bled regions from overlapping at a shared barline; see its own comment.
	return { x: startX, y: top - REGION_BLEED_PX, width, height: bottom - top + REGION_BLEED_PX * 2 };
}

/**
 * Shift every y-coordinate in a list of ops down by `dy`.
 *
 * A curve op has no single `y` field (it has four: `y0`/`cy0`/`cy1`/`y1`), so
 * the generic `{ ...op, y: op.y + dy }` shift that works for `rect`/`glyph`/
 * `text` would leave every one of its y-coordinates untouched while adding a
 * stray, `NaN`-valued `y` field on top. Shifting all four explicitly is what
 * keeps a tie's or slur's curve aligned with the notes it connects once the
 * whole score is translated into its final canvas position.
 *
 * Shared by `translateMeasure` (below) and `layoutScore`'s own part-
 * decoration ops (M2 Slice 5), which need the exact same shift but are not
 * attached to any `LaidOutMeasure`.
 */
function translateOps(ops: readonly DrawOp[], dy: number): DrawOp[] {
	return ops.map((op) =>
		op.kind === 'curve'
			? { ...op, y0: op.y0 + dy, cy0: op.cy0 + dy, cy1: op.cy1 + dy, y1: op.y1 + dy }
			: { ...op, y: op.y + dy }
	);
}

function translateMeasure(measure: LaidOutMeasure, dy: number): LaidOutMeasure {
	return {
		index: measure.index,
		staffIndex: measure.staffIndex,
		region: { ...measure.region, y: measure.region.y + dy },
		ops: translateOps(measure.ops, dy),
		notes: measure.notes.map((note) => ({
			id: note.id,
			bounds: { ...note.bounds, y: note.bounds.y + dy }
		})),
		...(measure.inkExtent
			? { inkExtent: { top: measure.inkExtent.top + dy, bottom: measure.inkExtent.bottom + dy } }
			: {})
	};
}
