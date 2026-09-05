// Turning the model into positioned glyphs: one staff, one system, one voice.
//
// Everything here is measured in *staff spaces* and multiplied out to pixels at
// the end of each calculation, because that is the unit the font's own metrics
// use and the unit engraving rules are written in. `ss` below is always the
// pixel size of one staff space.
//
// Note spacing is deliberately naive: a fixed minimum plus a term linear in
// duration. Real optical spacing (the roughly logarithmic duration curve, then
// justification to a system width, then iteration for collisions) is where
// engraving software actually spends its engineering, and it is Phase 1. What
// Phase 0 needs from spacing is only that measures have stable, non-overlapping
// horizontal bands, which is what makes region-scoped redraw possible at all.

import type { Measure, Note, NoteId, NoteValue, Score, TimeSignature } from '../model/score.js';
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
	/** Minimum horizontal advance for any note, whatever its duration. */
	noteBase: 2.2,
	/** Extra advance per whole note of duration. Linear, hence "naive". */
	noteSlopePerWhole: 9,
	/** Gap between an accidental and the notehead it belongs to. */
	accidentalGap: 0.3,
	/**
	 * Minimum blank required between the previous note's rightmost ink (its
	 * stem, a ledger line, or just its notehead) and an accidental this note
	 * must draw. Below this, the accidental would print on top of that ink;
	 * `layoutNote` pushes the whole note right by however much clearance is
	 * missing rather than let that happen. Independent of `accidentalGap`,
	 * which is the gap on the *other* side, between the accidental and its
	 * own notehead.
	 *
	 * `noteBase` already reserves more room than a plain in-staff note's ink
	 * needs, so this only ever bites the case real engraving actually worries
	 * about: the shortest durations (32nd/64th), whose `noteSlopePerWhole`
	 * contribution is nearly zero, landing right after a note with a ledger
	 * line. 0.9 sits just above that specific gap (worked out from this
	 * file's own constants) without being so large it starts padding ordinary
	 * in-staff spacing that was never actually tight.
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

/** Stem length measured from the notehead centre, staff spaces. Phase 1 shortens
 *  and lengthens this for notes far from the middle line; Phase 0 does not. */
const STEM_LENGTH = 3.5;

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
	const systems: { measureIndices: number[]; topY: number }[] = [];
	let systemTopY = 0;
	let contentWidth = 0;

	for (const plan of systemPlans) {
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
				isLast: measureIndex === score.measures.length - 1
			});
			measures.push(laid);
			x = laid.region.x + laid.region.width;
		}
		systems.push({ measureIndices: [...plan], topY: staffTopY });
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
		systems: systems.map((s) => ({ measureIndices: s.measureIndices, topY: s.topY + shiftY }))
	};
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
		isLast: measureIndex === score.measures.length - 1
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
}

function layoutMeasure(score: Score, measure: Measure, ctx: MeasureContext): LaidOutMeasure {
	const { ss, staffTopY, startX } = ctx;
	const ops: DrawOp[] = [];
	const notes: LaidOutNote[] = [];

	// The clef, key signature and (for the score's true first measure only)
	// time signature belong to the *system-opening measure's* ops, not to some
	// separate header object. That is what makes redrawing that measure
	// self-contained: clearing its region wipes the clef, and drawing its ops
	// puts the clef back. A header owned by nobody would be erased by the
	// first edit in that measure and never repainted.
	//
	// Every system's first measure repeats the clef and key signature, real
	// engraving's rule for a new staff line. The time signature is different:
	// it is not repeated at each system, only stated once at the score's true
	// first measure (and again if it ever changed, which Phase 0 never does).
	let cursor = startX;
	if (ctx.isSystemFirst) {
		cursor += SPACING.headerGap * ss;
		cursor = layoutClef(ops, cursor, ctx);
		cursor = layoutKeySignature(ops, cursor, score.keyFifths, ctx);
		if (ctx.isScoreFirst) {
			cursor = layoutTimeSignature(ops, cursor, score.time.beats, score.time.beatType, ctx);
		}
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
	const beamGroups = computeBeamGroups(measure.notes, score.time);
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
			score.keyFifths,
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
	const barlineThickness = (ctx.isLast ? ED.thickBarlineThickness : ED.thinBarlineThickness) * ss;
	const barlineX = cursor;
	const measureWidth = barlineX + barlineThickness - startX;
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

	// A final barline is thin-then-thick. Cheap to draw and it is the difference
	// between "a score" and "a fragment" at a glance.
	if (ctx.isLast) {
		const thin = ED.thinBarlineThickness * ss;
		ops.push({
			kind: 'rect',
			x: barlineX - ED.barlineSeparation * ss - thin,
			y: staffTopY,
			width: thin,
			height: 4 * ss
		});
	}
	ops.push({
		kind: 'rect',
		x: barlineX,
		y: staffTopY,
		width: barlineThickness,
		height: 4 * ss
	});

	return {
		index: measure.index,
		region: measureRegion(ops, startX, measureWidth, staffTopY, ss),
		ops,
		notes
	};
}

function layoutClef(ops: DrawOp[], x: number, ctx: MeasureContext): number {
	// The G clef's origin sits on the line of the G it names, the second line
	// from the bottom of a treble staff.
	const y = staffY(diatonicIndex({ step: 'G', alter: 0, octave: 4 }), ctx);
	ops.push({ kind: 'glyph', glyph: 'gClef', x, y });
	return x + (GLYPH_METRICS.gClef.advance + SPACING.headerGap) * ctx.ss;
}

function layoutKeySignature(
	ops: DrawOp[],
	x: number,
	fifths: number,
	ctx: MeasureContext
): number {
	if (fifths === 0) return x;
	const kind = fifths > 0 ? 'sharp' : 'flat';
	const glyph: GlyphName = kind === 'sharp' ? 'accidentalSharp' : 'accidentalFlat';
	const steps = KEY_SIGNATURE_POSITIONS[kind];
	const octaves = KEY_SIGNATURE_OCTAVES[kind];
	let cursor = x;
	for (let i = 0; i < Math.min(Math.abs(fifths), 7); i++) {
		const step = steps[i];
		const octave = octaves[i];
		if (step === undefined || octave === undefined) break;
		cursor = pushGlyph(ops, glyph, cursor, staffY(diatonicIndex({ step, alter: 0, octave }), ctx), ctx);
	}
	return cursor + SPACING.headerGap * ctx.ss;
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
 * Where a beamed note's stem attaches, recorded so `layoutBeamGroup` can draw
 * every member's stem and the connecting beam(s) once the whole group's
 * positions are known, without redoing notehead placement itself.
 */
interface NotePlacement {
	readonly noteX: number;
	readonly y: number;
	readonly headGlyph: GlyphName;
	readonly d: number;
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
	const advance = (SPACING.noteBase + SPACING.noteSlopePerWhole * note.durationWholes) * ss;

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
	// room from `SPACING.noteBase`/`noteSlopePerWhole`. The shift has to widen
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
	let placement: NotePlacement | null = null;
	let up: boolean | null = null;
	if (note.value !== 'whole') {
		up = beamed ? beamDirection === 'up' : stemDirectionForNotes([d]) === 'up';
		if (beamed) {
			placement = { noteX, y, headGlyph, d };
		} else {
			layoutStemAndFlag(ops, noteX, y, headGlyph, note.value, note.id, ctx, up);
		}
	}

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
		ops: measure.ops.map((op) => ({ ...op, y: op.y + dy })),
		notes: measure.notes.map((note) => ({
			id: note.id,
			bounds: { ...note.bounds, y: note.bounds.y + dy }
		}))
	};
}
