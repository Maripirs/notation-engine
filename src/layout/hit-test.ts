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
				return { noteId: note.id, measureIndex: measure.index };
			}
		}
	}
	return null;
}
