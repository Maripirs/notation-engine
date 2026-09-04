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

import type { Measure, Note, Score } from '../model/score.js';
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
	eighth: 'noteheadBlack'
} as const satisfies Record<string, GlyphName>;

const REST_GLYPHS = {
	whole: 'restWhole',
	half: 'restHalf',
	quarter: 'restQuarter',
	eighth: 'rest8th'
} as const satisfies Record<string, GlyphName>;

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

	for (const note of measure.notes) {
		cursor = layoutNote(ops, notes, cursor, note, score.keyFifths, ctx);
	}
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

function layoutNote(
	ops: DrawOp[],
	notes: LaidOutNote[],
	cellX: number,
	note: Note,
	keyFifths: number,
	ctx: MeasureContext
): number {
	const { ss } = ctx;
	const advance = (SPACING.noteBase + SPACING.noteSlopePerWhole * note.durationWholes) * ss;

	if (note.pitch === null) {
		const glyph = REST_GLYPHS[note.value];
		// Every rest hangs from, sits on, or centres about the middle of the
		// staff; the glyph origins encode which, so one y works for all four.
		const y = ctx.staffTopY + (note.value === 'whole' ? 1 : 2) * ss;
		ops.push({ kind: 'glyph', glyph, x: cellX, y, noteId: note.id });
		notes.push({ id: note.id, bounds: glyphBounds(glyph, cellX, y, ss, 0.25) });
		return cellX + advance;
	}

	const pitch = note.pitch;
	const d = diatonicIndex(pitch);
	const y = staffY(d, ctx);

	// Draw an accidental only when the note disagrees with the key signature.
	// The fuller rule also remembers accidentals already drawn earlier in the
	// same measure, which is part of Phase 1's accidental handling; skipping it
	// here means a repeated F-sharp in G major is correct but a repeated
	// F-natural would be redrawn on every note. Phase 0 never generates that.
	let noteX = cellX;
	if (pitch.alter !== keyAlterForStep(keyFifths, pitch.step)) {
		const glyph = ACCIDENTAL_GLYPHS[String(clampAlter(pitch.alter)) as keyof typeof ACCIDENTAL_GLYPHS];
		ops.push({ kind: 'glyph', glyph, x: noteX, y, noteId: note.id });
		noteX += (GLYPH_METRICS[glyph].advance + SPACING.accidentalGap) * ss;
	}

	const headGlyph = NOTEHEAD_GLYPHS[note.value];
	ops.push({ kind: 'glyph', glyph: headGlyph, x: noteX, y, noteId: note.id });
	layoutLedgerLines(ops, noteX, headGlyph, d, note.id, ctx);

	if (note.value !== 'whole') {
		layoutStemAndFlag(ops, noteX, y, headGlyph, d, note.value === 'eighth', note.id, ctx);
	}

	notes.push({ id: note.id, bounds: glyphBounds(headGlyph, noteX, y, ss, 0.3) });
	return cellX + advance;
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
	d: number,
	hasFlag: boolean,
	noteId: string,
	ctx: MeasureContext
): void {
	const { ss } = ctx;
	// Below the middle line the stem goes up, on or above it the stem goes down.
	// Phase 1 replaces this with the voice- and beam-aware rule.
	const up = d < TREBLE_MIDDLE_LINE;
	const anchors = glyphMetrics(headGlyph).anchors;
	const anchor = up ? anchors.stemUpSE : anchors.stemDownNW;
	if (!anchor) return;
	const thickness = ED.stemThickness * ss;
	// The anchor names the *outer* edge of the stem, hence the inset by one
	// stem thickness on the up side: the stem hangs to the left of that edge.
	const stemX = up ? noteX + anchor[0] * ss - thickness : noteX + anchor[0] * ss;
	const attachY = noteY - anchor[1] * ss;
	const tipY = noteY + (up ? -STEM_LENGTH * ss : STEM_LENGTH * ss);
	ops.push({
		kind: 'rect',
		x: stemX,
		y: Math.min(attachY, tipY),
		width: thickness,
		height: Math.abs(tipY - attachY),
		noteId
	});

	if (!hasFlag) return;
	// Unbeamed eighths get a flag. Beaming (deciding which notes group, then
	// solving beam angle and stem lengths together) is Phase 1.
	const glyph: GlyphName = up ? 'flag8thUp' : 'flag8thDown';
	const flagAnchor = glyphMetrics(glyph).anchors[up ? 'stemUpNW' : 'stemDownSW'];
	if (!flagAnchor) return;
	ops.push({
		kind: 'glyph',
		glyph,
		x: stemX - flagAnchor[0] * ss,
		y: tipY + flagAnchor[1] * ss,
		noteId
	});
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
