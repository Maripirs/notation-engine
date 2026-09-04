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
 * Only two kinds, because a Phase 0 staff is glyphs plus axis-aligned
 * rectangles: staff lines, stems, ledger lines and barlines are all rectangles.
 * Drawing them with `fillRect` rather than a stroked path avoids the half-pixel
 * centring that `lineWidth` imposes, which is what makes hairline staff lines
 * look grey and uneven. Curves (slurs, ties, beam wedges) will need a `path`
 * kind in Phase 1; there is no point inventing it before something draws one.
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
}
