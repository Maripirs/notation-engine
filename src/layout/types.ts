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
 */
export type DrawOp =
	| {
			readonly kind: 'glyph';
			readonly glyph: GlyphName;
			/** Glyph origin, which for SMuFL sits on the staff position, not on a text baseline box. */
			readonly x: number;
			readonly y: number;
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
	readonly index: number;
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
	 */
	readonly systems: readonly {
		readonly measureIndices: readonly number[];
		readonly topY: number;
		readonly spacingScale: number;
	}[];
}
