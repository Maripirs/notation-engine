// The layout <-> renderer contract.
//
// Layout produces a flat list of positioned drawing operations in device
// pixels; the renderer is a dumb executor of that list. The split matters for
// two reasons. First, layout stays testable as pure data: the region-scoped
// redraw proof in `src/render/renderer.test.ts` asserts on coordinates, not on
// pixels, so it runs anywhere. Second, a second backend (an offscreen canvas,
// a print/PDF target, a headless rasterizer) is a new executor, not a second
// copy of the engraving rules.

import type { NoteId } from '../model/score.js';
import type { GlyphName } from '../render/glyph-metrics.js';

export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * One thing to draw.
 *
 * `glyph` and `rect` are Phase 0's whole staff: glyphs plus axis-aligned
 * rectangles for staff lines, stems, ledger lines and barlines. Drawing those
 * with `fillRect` rather than a stroked path avoids the half-pixel centring
 * that `lineWidth` imposes, which is what makes hairline staff lines look grey
 * and uneven.
 *
 * `curve` is Phase 1's addition (Slice 5, ties): a cubic Bezier, stroked at a
 * constant `thickness` rather than `fillRect`'s sharp-edged rectangle, because
 * a curve has no axis-aligned box to exploit the way a staff line does. A tie
 * is the short, two-point case of this primitive; Slice 6 (slurs) spans a
 * longer, arbitrary run of notes with the same op, just with control points
 * shaped differently, which is why this is a general Bezier rather than a
 * tie-specific "arc between two noteheads" shape.
 *
 * `noteId` tags the ops that belong to a specific note so the renderer can tint
 * a selection without layout knowing what "selected" means.
 *
 * `text` is M2 Slice 5's addition (part-name labels): plain, arbitrary text
 * ("Soprano", "Piano"), which is not a SMuFL glyph at all, so it carries its
 * own font size rather than reusing `LaidOutScore.fontSizePx` (the shared
 * Bravura size every `glyph` op draws at) and is rendered in an ordinary text
 * font, not the music font.
 */
export type DrawOp =
	| {
			readonly kind: 'glyph';
			readonly glyph: GlyphName;
			/** Glyph origin, which for SMuFL sits on the staff position, not on a text baseline box. */
			readonly x: number;
			readonly y: number;
			/**
			 * Draw this one glyph at a one-off font size instead of the shared
			 * `LaidOutScore.fontSizePx` every other `glyph` op uses. Only ever set
			 * by `layoutBrace` (M2 Slice 5): a curly brace has to stretch to fit
			 * whatever span its two staves need, and this engine's glyphs are
			 * ordinary font text with no path-transform API in play, so a
			 * different size is the only lever available for that stretch. Omitted
			 * for every other glyph, which draws at the shared size exactly as
			 * before this field existed.
			 */
			readonly fontSizePx?: number;
			readonly noteId?: NoteId;
	  }
	| {
			readonly kind: 'text';
			readonly text: string;
			/** Text origin (baseline-left, `CanvasRenderingContext2D`'s own
			 *  default), or the baseline's centre with `align: 'center'`. */
			readonly x: number;
			readonly y: number;
			readonly fontSizePx: number;
			/**
			 * Horizontal alignment about `x` (M6 Slice 9): `'center'` for a lyric
			 * syllable centred under its note. The renderer measures and centres
			 * the real text itself, so centring stays exact even though layout
			 * only estimates text widths. Omitted means `'left'`.
			 */
			readonly align?: 'left' | 'center';
			readonly noteId?: NoteId;
	  }
	| {
			readonly kind: 'rect';
			readonly x: number;
			readonly y: number;
			readonly width: number;
			readonly height: number;
			readonly noteId?: NoteId;
	  }
	| {
			readonly kind: 'curve';
			/** Start point, e.g. just clear of the first notehead's ink. */
			readonly x0: number;
			readonly y0: number;
			/** First cubic Bezier control point. */
			readonly cx0: number;
			readonly cy0: number;
			/** Second cubic Bezier control point. */
			readonly cx1: number;
			readonly cy1: number;
			/** End point, e.g. just clear of the second notehead's ink. */
			readonly x1: number;
			readonly y1: number;
			/** Stroke width, pixels. Real engraving tapers a tie/slur thicker at
			 *  its midpoint than at its ends; a constant width is this slice's
			 *  deliberate simplification, the same kind Phase 0/1 already makes
			 *  for a flat (unangled) beam. */
			readonly thickness: number;
			readonly noteId?: NoteId;
	  };

/** A note's clickable area. Hit-testing is ours; there is no DOM element per note. */
export interface LaidOutNote {
	readonly id: NoteId;
	readonly bounds: Rect;
}

export interface LaidOutMeasure {
	/** Position within its own staff, 0-based. See `staffIndex`: before M2
	 *  Slice 3 this was a single score-wide flat address (every score had one
	 *  implicit staff), and a single-staff score (the common case, and every
	 *  score before this slice) is the `staffIndex`-always-0 degenerate case
	 *  with this field's meaning unchanged. */
	readonly index: number;
	/** Which staff (`Score.staves`) this measure belongs to (M2 Slice 3's
	 *  `(staffIndex, index)` addressing scheme, replacing `index` alone).
	 *  `relayoutMeasure` and `CanvasRenderer.redrawMeasure`/`redrawMeasures`
	 *  both take this alongside a measure index to redraw exactly one staff's
	 *  one measure, independently of every other staff's own measures. */
	readonly staffIndex: number;
	/**
	 * The exact rectangle `CanvasRenderer.redrawMeasure` clears and repaints.
	 *
	 * Two invariants make partial redraw safe. It contains every pixel this
	 * measure's ops touch, so repainting it cannot leave stale ink behind. And
	 * it never overlaps a neighbouring measure's region horizontally, so
	 * repainting it cannot erase a neighbour. Layout enforces the second by
	 * clamping the region to the measure's own horizontal band and keeping
	 * content inside that band with padding.
	 */
	readonly region: Rect;
	readonly ops: readonly DrawOp[];
	readonly notes: readonly LaidOutNote[];
	/**
	 * The vertical extent (canvas y) of this measure's own ink apart from its
	 * barlines and its dynamics/hairpins (M6 Slice 6): the staff, notes,
	 * stems, beams, ledger lines, marks, ties and slurs. Dynamics and hairpins
	 * clear it, and a system's dynamics line up at one height computed from
	 * the extents of every measure carrying one (see `layout.ts`'s
	 * `directionBaselines`); recorded so a scoped `relayoutMeasure` can redo
	 * that from its neighbours without laying them out again. A shared
	 * multi-staff barline is left out because it reaches into the gap between
	 * staves by construction, which would push every dynamic below it.
	 * Optional only so hand-built test fixtures need not state it; layout
	 * always sets it.
	 */
	readonly inkExtent?: { readonly top: number; readonly bottom: number };
}

export interface LaidOutScore {
	/** Canvas size this layout expects, CSS pixels. */
	readonly width: number;
	readonly height: number;
	/** The engraving unit everything derives from: the gap between two staff lines. */
	readonly staffSpacePx: number;
	/**
	 * Canvas y of the staff's top line. Recorded so a single measure can be
	 * re-laid-out later against the same staff position without redoing (or
	 * guessing at) the whole system's vertical placement.
	 */
	readonly staffTopY: number;
	/** Font size to draw glyph ops at, i.e. `staffSpacePx * STAFF_SPACES_PER_EM`. */
	readonly fontSizePx: number;
	readonly measures: readonly LaidOutMeasure[];
	/**
	 * Which measures belong to which system (a staff line), in score order,
	 * and where each system's staff top landed. `measures` stays a flat list
	 * for callers like `hit-test.ts` and `renderer.ts` that only care about a
	 * measure's own region and never needed to know about systems; this is
	 * the extra index for callers (`relayoutMeasure`, a future page-flow
	 * layer) that do.
	 *
	 * Without `LayoutOptions.systemWidthPx` there is always exactly one system
	 * holding every measure, matching Phase 0's original single-system layout.
	 *
	 * `spacingScale` is the justification factor `layout.ts`'s
	 * `systemSpacingScale` decided for this system (1 for natural, unstretched
	 * spacing, e.g. the score's own last system, which is never justified).
	 * Recorded here, not just used internally, so `relayoutMeasure` can re-lay
	 * a single measure out at its system's already-decided scale without
	 * recomputing the whole system's justification on every incremental edit.
	 *
	 * `staffIndex` (M2 Slice 3) says which staff this row belongs to: there
	 * is one entry per staff per system (a 6-staff score cast off into 20
	 * systems has 120 entries, in system order, staves top to bottom within
	 * each), since each staff's row has its own `topY` and lyric line. Every
	 * staff's entries share the same `measureIndices` and `spacingScale`
	 * (casting-off and justification are decided once per score, M6 Slice
	 * 10), so a `measureIndices` entry is only unique *within* the same
	 * `staffIndex`, the same reason `LaidOutMeasure` itself needs the pair,
	 * not `index` alone. Count systems by filtering to one staff.
	 */
	readonly systems: readonly {
		readonly measureIndices: readonly number[];
		readonly topY: number;
		readonly spacingScale: number;
		readonly staffIndex: number;
		/**
		 * This row's verse lines, in order, and verse 1's baseline (M6 Slice
		 * 9; see `layout.ts`'s lyric section). Both absent for a row without
		 * lyrics. Recorded so `relayoutMeasure` can tell whether an edit moved
		 * the row's lyric line (a full relayout) or not (a scoped one), and
		 * whether the staff's barlines join the next staff's (a lyric staff's
		 * do not: they would run through the text).
		 */
		readonly lyricVerses?: readonly string[];
		readonly lyricBaseline?: number;
	}[];
	/**
	 * Part-grouping decorations (M2 Slice 5): a brace or bracket per
	 * multi-staff `Part`, drawn at every system, plus a part-name label per
	 * named `Part`, drawn only at the score's first system. See `layout.ts`'s
	 * `layoutSystemPartDecorations` for how these are built.
	 *
	 * Deliberately *not* folded into any `LaidOutMeasure`'s own `ops`/
	 * `region`, unlike everything else this engine draws. A brace/bracket's
	 * ink spans every staff a `Part` groups, which would blow up whichever
	 * single measure "owned" it into a region whose bounding rectangle
	 * reaches into every other staff's own row at the same x, breaking the
	 * "a measure's region never overlaps a neighbour's" invariant that makes
	 * region-scoped redraw safe at all (see the doc comment on `layoutScore`'s
	 * `computePartDecorationPlan` for the full reasoning). Living outside
	 * every measure's own region instead, in its own dedicated x-band no
	 * measure ever draws into, sidesteps the problem entirely: nothing here
	 * ever changes in response to an edit (no edit op that exists touches a
	 * `Part`'s grouping or name), so `drawAll()` paints these once and
	 * `redrawMeasure`/`redrawMeasures` never need to touch them at all.
	 */
	readonly partDecorations: readonly DrawOp[];
}
