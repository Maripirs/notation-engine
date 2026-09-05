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

import type { Measure, Note, NoteId, NoteValue, Score, Slur, TimeSignature } from '../model/score.js';
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
	systemGap: 6
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

/** Diatonic index of E4, the bottom line of a treble staff. */
const TREBLE_BOTTOM_LINE = diatonicIndex({ step: 'E', alter: 0, octave: 4 });
/** Diatonic index of B4, the middle line, which decides stem direction. */
const TREBLE_MIDDLE_LINE = diatonicIndex({ step: 'B', alter: 0, octave: 4 });
/** Diatonic index of F5, the top line. */
const TREBLE_TOP_LINE = diatonicIndex({ step: 'F', alter: 0, octave: 5 });

/** Staff positions of key-signature accidentals on a treble staff, in the order
 *  they are written. Other clefs put them elsewhere; other clefs are Phase 1. */
const KEY_SIGNATURE_POSITIONS: Readonly<Record<'sharp' | 'flat', readonly Step[]>> = {
	sharp: ['F', 'C', 'G', 'D', 'A', 'E', 'B'],
	flat: ['B', 'E', 'A', 'D', 'G', 'C', 'F']
};
const KEY_SIGNATURE_OCTAVES: Readonly<Record<'sharp' | 'flat', readonly number[]>> = {
	// F5 C5 G5 D5 A4 E5 B4
	sharp: [5, 5, 5, 5, 4, 5, 4],
	// B4 E5 A4 D5 G4 C5 F4
	flat: [4, 5, 4, 5, 4, 5, 4]
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
 * Lay a whole score out, casting measures off into systems (staff lines,
 * stacked vertically) as needed.
 *
 * Without `options.systemWidthPx` this keeps Phase 0's original behaviour:
 * one system, forever, however wide the score gets. With it, measures run
 * left to right until the next one would overflow the budget, then a new
 * system starts below (see `planSystems`). Either way the result is built the
 * same way: figure out which measures belong to which system, then lay out
 * each system's measures left to right with that system's own staff top.
 */
export function layoutScore(score: Score, options: LayoutOptions = {}): LaidOutScore {
	const ss = options.staffSpacePx ?? DEFAULTS.staffSpacePx;
	const padding = options.paddingPx ?? DEFAULTS.paddingPx;
	const fontSizePx = ss * STAFF_SPACES_PER_EM;

	const systemPlans = planSystems(score, ss, padding, options.systemWidthPx);

	// Lay out against a provisional first staff top of 0 and translate
	// everything afterwards. Ledger lines, stems and flags can reach well
	// above the staff, and how far is not known until the notes are placed,
	// so reserving a guessed margin up front would either waste space or clip.
	const measures: LaidOutMeasure[] = [];
	const systems: { measureIndices: number[]; topY: number; spacingScale: number }[] = [];
	let systemTopY = 0;
	let contentWidth = 0;

	for (let systemIndex = 0; systemIndex < systemPlans.length; systemIndex++) {
		const plan = systemPlans[systemIndex]!;
		const isLastSystem = systemIndex === systemPlans.length - 1;
		const spacingScale = systemSpacingScale(score, plan, ss, padding, options.systemWidthPx, isLastSystem);
		const staffTopY = systemTopY;
		let x = padding;
		for (const measureIndex of plan) {
			const measure = score.measures[measureIndex]!;
			const laid = layoutMeasure(score, measure, {
				ss,
				staffTopY,
				startX: x,
				isSystemFirst: measureIndex === plan[0],
				isScoreFirst: measureIndex === 0,
				isLast: measureIndex === score.measures.length - 1,
				spacingScale
			});
			measures.push(laid);
			x = laid.region.x + laid.region.width;
		}
		systems.push({ measureIndices: [...plan], topY: staffTopY, spacingScale });
		contentWidth = Math.max(contentWidth, x + padding);

		const systemMeasures = measures.slice(-plan.length);
		const systemBottom = Math.max(
			staffTopY + 4 * ss,
			...systemMeasures.map((m) => m.region.y + m.region.height)
		);
		systemTopY = systemBottom + SPACING.systemGap * ss;
	}

	const top = Math.min(0, ...measures.map((m) => m.region.y));
	const bottom = Math.max(
		...systems.map((s) => s.topY + 4 * ss),
		...measures.map((m) => m.region.y + m.region.height)
	);
	const shiftY = padding - top;

	return {
		width: contentWidth,
		height: bottom - top + padding * 2,
		staffSpacePx: ss,
		// Layout is translation-invariant in y, so shifting a score laid out
		// with a first staff top of 0 by `shiftY` is the same as having laid
		// it out at `shiftY` to begin with.
		staffTopY: shiftY,
		fontSizePx,
		measures: measures.map((m) => translateMeasure(m, shiftY)),
		systems: systems.map((s) => ({
			measureIndices: s.measureIndices,
			topY: s.topY + shiftY,
			spacingScale: s.spacingScale
		}))
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
	plan: readonly number[],
	ss: number,
	padding: number,
	systemWidthPx: number | undefined,
	isLastSystem: boolean
): number {
	if (systemWidthPx === undefined || isLastSystem) return 1;

	let naturalWidth = 0;
	let advanceSpaces = 0;
	for (const measureIndex of plan) {
		const measure = score.measures[measureIndex]!;
		naturalWidth += probeMeasureWidth(score, measure, ss, {
			isSystemFirst: measureIndex === plan[0],
			isScoreFirst: measureIndex === 0,
			isLast: measureIndex === score.measures.length - 1
		});
		for (const note of measure.notes) advanceSpaces += noteAdvanceSpaces(note);
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
	ss: number,
	padding: number,
	systemWidthPx: number | undefined
): number[][] {
	if (systemWidthPx === undefined) return [score.measures.map((m) => m.index)];

	const availableWidth = systemWidthPx - 2 * padding;
	const systems: number[][] = [];
	let current: number[] = [];
	let currentWidth = 0;

	for (const measure of score.measures) {
		const isScoreFirst = measure.index === 0;
		const isLast = measure.index === score.measures.length - 1;
		const widthAsSystemFirst = probeMeasureWidth(score, measure, ss, {
			isSystemFirst: true,
			isScoreFirst,
			isLast
		});

		if (current.length === 0) {
			current.push(measure.index);
			currentWidth = widthAsSystemFirst;
			continue;
		}

		const widthAsMidSystem = probeMeasureWidth(score, measure, ss, {
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

/** A measure's width in isolation, for the casting-off decision in `planSystems`. */
function probeMeasureWidth(
	score: Score,
	measure: Measure,
	ss: number,
	flags: { isSystemFirst: boolean; isScoreFirst: boolean; isLast: boolean }
): number {
	return layoutMeasure(score, measure, { ss, staffTopY: 0, startX: 0, ...flags }).region.width;
}

/**
 * The vertical band a system's own content may occupy without a re-laid-out
 * measure spilling into a neighbouring system.
 *
 * Bounded by the neighbouring systems' *actual* laid-out extent (not their
 * nominal staff band), so a neighbour with tall ledger lines still leaves the
 * right amount of room. The score's first and last systems are bounded by the
 * canvas itself, which is exactly the single-system check this replaces.
 */
function systemBounds(layout: LaidOutScore, systemIndex: number): { top: number; bottom: number } {
	const extent = (measureIndices: readonly number[], pick: 'top' | 'bottom') =>
		measureIndices.map((i) => {
			const m = layout.measures.find((mm) => mm.index === i)!;
			return pick === 'top' ? m.region.y : m.region.y + m.region.height;
		});

	const prev = layout.systems[systemIndex - 1];
	const next = layout.systems[systemIndex + 1];
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
 */
export function relayoutMeasure(
	score: Score,
	layout: LaidOutScore,
	measureIndex: number,
	options: LayoutOptions = {}
): LaidOutScore | null {
	const measure = score.measures[measureIndex];
	const previous = layout.measures.find((m) => m.index === measureIndex);
	const systemIndex = layout.systems.findIndex((s) => s.measureIndices.includes(measureIndex));
	const system = layout.systems[systemIndex];
	if (!measure || !previous || !system) return null;

	const laid = layoutMeasure(score, measure, {
		ss: options.staffSpacePx ?? DEFAULTS.staffSpacePx,
		staffTopY: system.topY,
		startX: previous.region.x,
		isSystemFirst: system.measureIndices[0] === measureIndex,
		isScoreFirst: measureIndex === 0,
		isLast: measureIndex === score.measures.length - 1,
		spacingScale: system.spacingScale
	});

	// Sub-pixel tolerance: the same arithmetic run twice should agree exactly,
	// but a width comparison is not worth making brittle over a float.
	const widthChanged = Math.abs(laid.region.width - previous.region.width) > 0.001;
	// The band this measure's system may use without spilling into a
	// neighbouring system. For a single-system score this is exactly the
	// canvas itself, i.e. the original single-system check.
	const bounds = systemBounds(layout, systemIndex);
	const overflows = laid.region.y < bounds.top || laid.region.y + laid.region.height > bounds.bottom;
	if (widthChanged || overflows) return null;

	return {
		...layout,
		measures: layout.measures.map((m) => (m.index === measureIndex ? laid : m))
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
	const keyFifths = score.keyFifthsAt(measure.index);
	const time = score.timeAt(measure.index);
	// Whether *this* measure is the one where the key (or time) actually
	// changes, as opposed to merely being in whatever key an earlier measure
	// set. Measure 0 never "changes" anything, since there is no earlier
	// measure to differ from; its key/time come from the score's initial
	// values instead, drawn unconditionally below via `isScoreFirst`/
	// `isSystemFirst`.
	const keyChangedHere = measure.index > 0 && keyFifths !== score.keyFifthsAt(measure.index - 1);
	const timeChangedHere = measure.index > 0 && !timeSignaturesEqual(time, score.timeAt(measure.index - 1));

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
	let cursor = startX;
	if (ctx.isSystemFirst) {
		cursor += SPACING.headerGap * ss;
		cursor = layoutClef(ops, cursor, ctx);
		cursor = layoutKeySignature(
			ops,
			cursor,
			keyFifths,
			ctx,
			keyChangedHere ? score.keyFifthsAt(measure.index - 1) : undefined
		);
		if (ctx.isScoreFirst || timeChangedHere) {
			cursor = layoutTimeSignature(ops, cursor, time.beats, time.beatType, ctx);
		}
	} else if (keyChangedHere || timeChangedHere) {
		cursor += SPACING.headerGap * ss;
		if (keyChangedHere) {
			cursor = layoutKeySignature(ops, cursor, keyFifths, ctx, score.keyFifthsAt(measure.index - 1));
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
	cursor += SPACING.measureLeadIn * ss;

	// Deciding beam groups is a pass over the whole measure's notes (a group
	// cannot be known note-by-note: whether the third eighth joins the first
	// two depends on the beat it falls in), so it happens once here rather
	// than inside `layoutNote`. A note that lands in a group of two or more
	// skips its individual stem-and-flag in the main loop below and instead
	// has its notehead position recorded in `placements`; `layoutBeamGroup`
	// draws the shared stems and beam afterwards, once every member's position
	// is known. A note with no beamable neighbour is not in any group here and
	// falls straight through to its ordinary single-flag stem.
	const beamGroups = computeBeamGroups(measure.notes, time);
	const beamGroupOfNote = new Map<NoteId, BeamGroup>();
	for (const group of beamGroups) {
		for (const note of group.notes) beamGroupOfNote.set(note.id, group);
	}
	const placements = new Map<NoteId, NotePlacement>();

	// Tracks, per diatonic step, the alter most recently *stated* by a note
	// drawn earlier in this measure: an explicit accidental, or the absence of
	// one when a note simply matched what was already in force. Starts empty
	// each measure (a fresh `Map` per `layoutMeasure` call), so the first note
	// on a step falls back to the key signature; see `layoutNote`'s own
	// comment on the same-measure carry-over rule this implements.
	const lastStatedAlterForStep = new Map<Step, number>();
	// The previous note's rightmost ink (notehead, ledger line, or stem), so
	// the current note can tell whether an accidental it needs would land too
	// close to it. `null` for the measure's first note, which has nothing
	// before it in this measure to collide with; see `layoutNote`'s collision-
	// clearance comment.
	let previousInkRight: number | null = null;

	for (const note of measure.notes) {
		const beamDirection = beamGroupOfNote.get(note.id)?.direction ?? null;
		const laid = layoutNote(
			ops,
			notes,
			cursor,
			note,
			keyFifths,
			ctx,
			beamDirection,
			lastStatedAlterForStep,
			previousInkRight
		);
		cursor = laid.cursor;
		previousInkRight = laid.inkRight;
		if (laid.placement) placements.set(note.id, laid.placement);
	}
	for (const group of beamGroups) layoutBeamGroup(ops, group, placements, ctx);
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
	const endBarline = score.endBarlineAt(measure.index);
	const thin = ED.thinBarlineThickness * ss;
	const thick = ED.thickBarlineThickness * ss;
	const mainThickness =
		endBarline === 'repeatStart' ? 0 : endBarline === 'final' || endBarline === 'repeatEnd' ? thick : thin;
	const barlineX = cursor;
	const measureWidth = barlineX + mainThickness - startX;
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
			y: staffTopY,
			width: thin,
			height: 4 * ss
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
			y: staffTopY,
			width: mainThickness,
			height: 4 * ss
		});
	}

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
			const curvesBelow = tieCurvesBelow(point);
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
			const curvesBelow = tieCurvesBelow(point);
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
		if (measure.index < startMeasure.index || measure.index > endMeasure.index) continue;

		const spanNotes = slurSpanNotes(score, slur);
		const curvesBelow =
			stemDirectionForNotes(
				spanNotes.flatMap((spanNote) => (spanNote.pitch ? [diatonicIndex(spanNote.pitch)] : []))
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

	return {
		index: measure.index,
		region: measureRegion(ops, startX, measureWidth, staffTopY, ss),
		ops,
		notes
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
	ops.push({ kind: 'glyph', glyph: 'repeatDot', x, y: staffY(TREBLE_MIDDLE_LINE + 1, ctx) });
	ops.push({ kind: 'glyph', glyph: 'repeatDot', x, y: staffY(TREBLE_MIDDLE_LINE - 1, ctx) });
}

function layoutClef(ops: DrawOp[], x: number, ctx: MeasureContext): number {
	// The G clef's origin sits on the line of the G it names, the second line
	// from the bottom of a treble staff.
	const y = staffY(diatonicIndex({ step: 'G', alter: 0, octave: 4 }), ctx);
	ops.push({ kind: 'glyph', glyph: 'gClef', x, y });
	return x + (GLYPH_METRICS.gClef.advance + SPACING.headerGap) * ctx.ss;
}

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
	const octaves = KEY_SIGNATURE_OCTAVES[kind];
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
	const oldOctaves = KEY_SIGNATURE_OCTAVES[oldKind];
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
}

function layoutNote(
	ops: DrawOp[],
	notes: LaidOutNote[],
	cellX: number,
	note: Note,
	keyFifths: number,
	ctx: MeasureContext,
	beamDirection: 'up' | 'down' | null,
	lastStatedAlterForStep: Map<Step, number>,
	previousInkRight: number | null
): { cursor: number; placement: NotePlacement | null; inkRight: number } {
	const { ss } = ctx;
	const beamed = beamDirection !== null;
	const advance = noteAdvanceSpaces(note) * ss * (ctx.spacingScale ?? 1);

	if (note.pitch === null) {
		const glyph = REST_GLYPHS[note.value];
		// Every rest hangs from, sits on, or centres about the middle of the
		// staff; the glyph origins encode which, so one y works for all four.
		const y = ctx.staffTopY + (note.value === 'whole' ? 1 : 2) * ss;
		ops.push({ kind: 'glyph', glyph, x: cellX, y, noteId: note.id });
		// A rest has no line/space of its own to nudge a dot off of, so its dot
		// sits at the rest's own y with no vertical adjustment.
		layoutAugmentationDots(ops, cellX + GLYPH_METRICS[glyph].advance * ss, y, false, note.dots, ctx);
		notes.push({ id: note.id, bounds: glyphBounds(glyph, cellX, y, ss, 0.25) });
		return { cursor: cellX + advance, placement: null, inkRight: cellX + GLYPH_METRICS[glyph].bBoxNE[0] * ss };
	}

	const pitch = note.pitch;
	const d = diatonicIndex(pitch);
	const y = staffY(d, ctx);

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
	const impliedAlter = lastStatedAlterForStep.get(pitch.step) ?? keyAlterForStep(keyFifths, pitch.step);
	const needsAccidental = pitch.alter !== impliedAlter;

	// A tight previous note can leave less than a clean gap before this
	// accidental: push the whole note (accidental, head, stem, everything
	// after it) right by however much clearance is missing, rather than let
	// the accidental print on top of the previous note's stem or ledger line.
	// Only an accidental triggers this, since it is the one thing drawn to the
	// *left* of the note's own cell; the notehead itself already gets its own
	// room from `noteAdvanceSpaces`. The shift has to widen
	// this note's returned cursor too (below), or the next note's cell would
	// start back where this one would have landed without it, undoing the
	// very clearance just added.
	let collisionShift = 0;
	if (needsAccidental && previousInkRight !== null) {
		const shortfall = SPACING.minAccidentalClearance * ss - (cellX - previousInkRight);
		if (shortfall > 0) collisionShift = shortfall;
	}
	let noteX = cellX + collisionShift;

	if (needsAccidental) {
		const glyph = ACCIDENTAL_GLYPHS[String(clampAlter(pitch.alter)) as keyof typeof ACCIDENTAL_GLYPHS];
		ops.push({ kind: 'glyph', glyph, x: noteX, y, noteId: note.id });
		noteX += (GLYPH_METRICS[glyph].advance + SPACING.accidentalGap) * ss;
		lastStatedAlterForStep.set(pitch.step, pitch.alter);
	}

	const headGlyph = NOTEHEAD_GLYPHS[note.value];
	ops.push({ kind: 'glyph', glyph: headGlyph, x: noteX, y, noteId: note.id });
	layoutLedgerLines(ops, noteX, headGlyph, d, note.id, ctx);

	// Ledger lines only land on line positions (see `layoutLedgerLines`), so
	// the same parity check says whether this note itself sits on a line.
	const onLine = (d - TREBLE_BOTTOM_LINE) % 2 === 0;
	layoutAugmentationDots(
		ops,
		noteX + GLYPH_METRICS[headGlyph].advance * ss,
		y,
		onLine,
		note.dots,
		ctx
	);

	// A beamed note's stem is drawn later, by `layoutBeamGroup`, once every
	// member of its group has a recorded position: its length and direction
	// depend on the whole group, not on this note alone. An unbeamed note
	// (whole, or eighth-and-shorter with no beamable neighbour) keeps the
	// simple single-note path it always had. Either way the direction itself
	// is decided once, here, rather than separately by whichever of the two
	// paths ends up drawing the stem: a beamed note takes its already-decided
	// group direction, an unbeamed one the ordinary single-note rule.
	let up: boolean | null = null;
	if (note.value !== 'whole') {
		up = beamed ? beamDirection === 'up' : stemDirectionForNotes([d]) === 'up';
		if (!beamed) {
			layoutStemAndFlag(ops, noteX, y, headGlyph, note.value, note.id, ctx, up);
		}
	}
	// Every pitched note's final position is recorded here, not just a beamed
	// member's: `layoutBeamGroup` only ever reads the entries for its own
	// group (unaffected by the wider population), and the tie pass in
	// `layoutMeasure` needs an unbeamed or whole note's position too, to draw
	// a same-measure tie's one curve or either half of one crossing a barline.
	const placement: NotePlacement = { noteX, y, headGlyph, d, up };

	notes.push({ id: note.id, bounds: glyphBounds(headGlyph, noteX, y, ss, 0.3) });
	return {
		cursor: cellX + advance + collisionShift,
		placement,
		inkRight: noteInkRight(noteX, headGlyph, d, up, ss)
	};
}

/**
 * The rightmost x a note's own ink reaches: past the notehead itself when a
 * ledger line's extension or a stem's outer edge sticks out further, which
 * they routinely do. The only consumer is the accidental collision check
 * above; nothing else in this file needs a note's horizontal ink extent
 * collapsed to one number.
 */
function noteInkRight(
	noteX: number,
	headGlyph: GlyphName,
	d: number,
	up: boolean | null,
	ss: number
): number {
	let right = noteX + GLYPH_METRICS[headGlyph].bBoxNE[0] * ss;
	// Ledger lines only ever land on line positions and only extend past a
	// note outside the staff's own top/bottom lines; this mirrors
	// `layoutLedgerLines`'s own loop bounds.
	if (d >= TREBLE_TOP_LINE + 2 || d <= TREBLE_BOTTOM_LINE - 2) {
		right = Math.max(right, noteX + GLYPH_METRICS[headGlyph].advance * ss + ED.legerLineExtension * ss);
	}
	if (up !== null) {
		const stem = stemXEdges(headGlyph, noteX, up, ss);
		if (stem) right = Math.max(right, stem.right);
	}
	return right;
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

function layoutLedgerLines(
	ops: DrawOp[],
	noteX: number,
	headGlyph: GlyphName,
	d: number,
	noteId: string,
	ctx: MeasureContext
): void {
	const { ss } = ctx;
	const headWidth = GLYPH_METRICS[headGlyph].advance * ss;
	const extension = ED.legerLineExtension * ss;
	const thickness = ED.legerLineThickness * ss;
	const push = (position: number) => {
		ops.push({
			kind: 'rect',
			x: noteX - extension,
			y: staffY(position, ctx) - thickness / 2,
			width: headWidth + extension * 2,
			height: thickness,
			noteId
		});
	};
	// Ledger lines only ever land on line positions, which are the diatonic
	// indices with the same parity as the staff lines themselves.
	for (let position = TREBLE_TOP_LINE + 2; position <= d; position += 2) push(position);
	for (let position = TREBLE_BOTTOM_LINE - 2; position >= d; position -= 2) push(position);
}

function layoutStemAndFlag(
	ops: DrawOp[],
	noteX: number,
	noteY: number,
	headGlyph: GlyphName,
	value: NoteValue,
	noteId: string,
	ctx: MeasureContext,
	up: boolean
): void {
	const { ss } = ctx;
	// Direction is decided once, by the caller (`layoutNote`), via
	// `stemDirectionForNotes`; a single note is just the one-element case of
	// the same function `layoutBeamGroup` uses for a whole group, and passing
	// the answer in rather than recomputing it here is what lets a note's ink
	// extent (`noteInkRight`, computed before this function runs) and its
	// actual stem agree on which way it points.
	const anchors = glyphMetrics(headGlyph).anchors;
	const anchor = up ? anchors.stemUpSE : anchors.stemDownNW;
	if (!anchor) return;
	const stem = stemXEdges(headGlyph, noteX, up, ss);
	if (!stem) return;
	const thickness = ED.stemThickness * ss;
	const attachY = noteY - anchor[1] * ss;
	const tipY = noteY + (up ? -STEM_LENGTH * ss : STEM_LENGTH * ss);
	ops.push({
		kind: 'rect',
		x: stem.left,
		y: Math.min(attachY, tipY),
		width: thickness,
		height: Math.abs(tipY - attachY),
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
 * `layoutStemAndFlag`, `beamStemX` (a beamed note's stem, decided once its
 * group's direction is known) and `noteInkRight`'s accidental-collision
 * check, all three of which need the same two numbers and none of which
 * should compute them differently. `null` when the notehead publishes no
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
 *  eligible note is indistinguishable from an ordinary unbeamed one. */
interface BeamGroup {
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
 */
function computeBeamGroups(notes: readonly Note[], time: TimeSignature): BeamGroup[] {
	const beatWholes = beatDurationWholes(time);
	// A float position compared against a beat boundary with plain `<`/`floor`
	// would occasionally misfire on the rounding noise a chain of additions
	// accumulates; this tolerance is far tighter than any duration difference
	// that could be musically real.
	const EPS = 1e-9;

	const groups: Note[][] = [];
	let current: Note[] = [];
	// The beat the notes in `current` fall in, so a new note can be compared
	// against it without recomputing anything about the notes already grouped.
	let currentBeat = -1;
	let position = 0;

	const flush = () => {
		if (current.length >= 2) groups.push(current);
		current = [];
	};

	for (const note of notes) {
		const eligible = note.pitch !== null && note.value in FLAG_GLYPHS;
		if (!eligible) {
			flush();
			position += note.durationWholes;
			continue;
		}
		const beat = Math.floor((position + EPS) / beatWholes);
		if (current.length > 0 && beat !== currentBeat) flush();
		current.push(note);
		currentBeat = beat;
		position += note.durationWholes;
	}
	flush();

	return groups.map((group) => ({
		notes: group,
		direction: stemDirectionForNotes(group.flatMap((note) => (note.pitch ? [diatonicIndex(note.pitch)] : [])))
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
 */
function stemDirectionForNotes(diatonicIndices: readonly number[]): 'up' | 'down' {
	if (diatonicIndices.length === 0) return 'down';

	const displacement = (d: number) => d - TREBLE_MIDDLE_LINE;
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

/** The x a beamed note's stem occupies, matching `layoutStemAndFlag`'s own
 *  placement so a beam group's stems line up with what an unbeamed note next
 *  to them would have drawn. `null` when the notehead publishes no stem
 *  anchor (Phase 0/1 only lacks one for `noteheadWhole`, which never reaches
 *  here since whole notes are never beam-eligible). */
function beamStemX(placement: NotePlacement, up: boolean, ss: number): number | null {
	return stemXEdges(placement.headGlyph, placement.noteX, up, ss)?.left ?? null;
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
 */
function layoutBeamGroup(
	ops: DrawOp[],
	group: BeamGroup,
	placements: ReadonlyMap<NoteId, NotePlacement>,
	ctx: MeasureContext
): void {
	const { ss } = ctx;
	const members = group.notes.flatMap((note) => {
		const placement = placements.get(note.id);
		return placement ? [{ note, placement }] : [];
	});
	if (members.length < 2) return;

	const up = group.direction === 'up';
	const beamY = up
		? Math.min(...members.map((m) => m.placement.y - STEM_LENGTH * ss))
		: Math.max(...members.map((m) => m.placement.y + STEM_LENGTH * ss));

	const stemThickness = ED.stemThickness * ss;
	for (const { note, placement } of members) {
		const stemX = beamStemX(placement, up, ss);
		if (stemX === null) continue;
		const anchor = glyphMetrics(placement.headGlyph).anchors[up ? 'stemUpSE' : 'stemDownNW']!;
		const attachY = placement.y - anchor[1] * ss;
		ops.push({
			kind: 'rect',
			x: stemX,
			y: Math.min(attachY, beamY),
			width: stemThickness,
			height: Math.abs(beamY - attachY),
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
	members: readonly { readonly note: Note; readonly placement: NotePlacement }[],
	startIndex: number,
	endIndex: number,
	barY: number,
	beamHeight: number,
	stemWidth: number,
	up: boolean,
	ss: number
): void {
	const stemXOf = (i: number) => beamStemX(members[i]!.placement, up, ss) ?? members[i]!.placement.noteX;

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
function tieCurvesBelow(point: NotePlacement): boolean {
	return point.up ?? stemDirectionForNotes([point.d]) === 'up';
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
 * fresh from `Score.notesInOrder()` (not from any measure's already-laid-out
 * notes) every time it is asked for, which is what lets any one of the
 * slur's measures be re-laid-out on its own and still agree with the others
 * about what the whole slur looks like: see the slur pass's own comment in
 * `layoutMeasure`.
 */
function slurSpanNotes(score: Score, slur: Slur): Note[] {
	const order = score.notesInOrder();
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
		? Math.min(TREBLE_BOTTOM_LINE, ...diatonics)
		: Math.max(TREBLE_TOP_LINE, ...diatonics);
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

/** Canvas y of a diatonic staff position, for a treble staff. */
function staffY(diatonic: number, ctx: MeasureContext): number {
	return ctx.staffTopY + 4 * ctx.ss - (diatonic - TREBLE_BOTTOM_LINE) * (ctx.ss / 2);
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
		} else {
			const { bBoxSW, bBoxNE } = GLYPH_METRICS[op.glyph];
			top = Math.min(top, op.y - bBoxNE[1] * ss);
			bottom = Math.max(bottom, op.y - bBoxSW[1] * ss);
		}
	}
	// A hair of slack absorbs antialiasing at the edges of stems and staff lines.
	const bleed = 1;
	return { x: startX, y: top - bleed, width, height: bottom - top + bleed * 2 };
}

function translateMeasure(measure: LaidOutMeasure, dy: number): LaidOutMeasure {
	return {
		index: measure.index,
		region: { ...measure.region, y: measure.region.y + dy },
		// A curve op has no single `y` field (it has four: `y0`/`cy0`/`cy1`/`y1`),
		// so the generic `{ ...op, y: op.y + dy }` shift used for `rect`/`glyph`
		// would leave every one of its y-coordinates untouched while adding a
		// stray, `NaN`-valued `y` field on top. Shifting all four explicitly is
		// what keeps a tie's curve aligned with the notes it connects once the
		// whole score is translated into its final canvas position.
		ops: measure.ops.map((op) =>
			op.kind === 'curve'
				? { ...op, y0: op.y0 + dy, cy0: op.cy0 + dy, cy1: op.cy1 + dy, y1: op.y1 + dy }
				: { ...op, y: op.y + dy }
		),
		notes: measure.notes.map((note) => ({
			id: note.id,
			bounds: { ...note.bounds, y: note.bounds.y + dy }
		}))
	};
}
