// Hit-testing: canvas point -> note id.
//
// This is the piece that a canvas engine has to own and an SVG engine gets for
// free. OSMD's approach is one DOM element per notehead plus `GetNearestNote`,
// which is why an OSMD score of any size is thousands of live SVG nodes and why
// re-rendering means rebuilding that tree. Here selection costs a scan over
// rectangles layout already computed, and the DOM contains exactly one element:
// the canvas.
//
// The scan is linear over the score. That is fine at Phase 0's scale, and the
// structure to fix it later is obvious (measures are already sorted by x, so a
// binary search over regions narrows to one measure before scanning its notes).
// The measure-band check below is a cheap first cut of exactly that.

import type { NoteId } from '../model/score.js';
import type { LaidOutScore, Rect } from './types.js';

export function containsPoint(rect: Rect, x: number, y: number): boolean {
	return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

export interface HitResult {
	readonly noteId: NoteId;
	readonly measureIndex: number;
	/** Which staff (`Score.staves`) `measureIndex` belongs to (M2 Slice 3's
	 *  `(staffIndex, measureIndex)` addressing scheme). 0 for every score
	 *  before this slice, and for the still-common single-staff case. */
	readonly staffIndex: number;
}

/**
 * Resolve a point in canvas coordinates to a note, or `null` for empty space.
 *
 * The caller is responsible for converting a pointer event into canvas
 * coordinates (subtract the canvas bounding rect, divide by any device-pixel or
 * zoom scale). Keeping that out of here is what lets the engine stay free of
 * DOM event handling, per the framework-agnostic principle: a host app decides
 * what a click even is.
 */
export function hitTest(layout: LaidOutScore, x: number, y: number): HitResult | null {
	for (const measure of layout.measures) {
		// Note bounds always lie inside their measure's region, so a point outside
		// the region cannot hit any of its notes.
		if (!containsPoint(measure.region, x, y)) continue;
		for (const note of measure.notes) {
			if (containsPoint(note.bounds, x, y)) {
				return { noteId: note.id, measureIndex: measure.index, staffIndex: measure.staffIndex };
			}
		}
	}
	return null;
}

/** A measure resolved from a point (M5 Slice 4), addressed by the same
 *  `(staffIndex, measureIndex)` pair `HitResult` carries. */
export interface MeasureHitResult {
	/** Which staff (`Score.staves`) the measure belongs to. */
	readonly staffIndex: number;
	/** The measure's staff-local index (`LaidOutMeasure.index`). */
	readonly measureIndex: number;
}

/**
 * Resolve a point in canvas coordinates to the measure whose region contains
 * it, or `null` for empty space outside every measure (M5 Slice 4).
 *
 * `hitTest` above answers "which note", which is the wrong question for a
 * measure-range selection: a user shift-clicking or dragging across bars
 * means the bar, wherever inside it the pointer lands, including the blank
 * staff space between noteheads that `hitTest` reports as `null`. Measure
 * regions never overlap (see `CanvasRenderer.redrawMeasure`'s own comment),
 * so the first region containing the point is the only one, and the same
 * `containsPoint` scan works unchanged across staves and across systems after
 * cast-off. Coordinate conversion stays the caller's job, as for `hitTest`.
 */
export function hitTestMeasure(layout: LaidOutScore, x: number, y: number): MeasureHitResult | null {
	for (const measure of layout.measures) {
		if (containsPoint(measure.region, x, y)) {
			return { staffIndex: measure.staffIndex, measureIndex: measure.index };
		}
	}
	return null;
}
