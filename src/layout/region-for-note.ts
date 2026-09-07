// Scroll-into-view region lookup: note id -> the region a host should bring
// into view to show that note.
//
// Follow-scroll (a selection or playback cursor should stay on screen as a
// score scrolls) and the PDF-sync host described in plan.md's M4 intro both
// need the same thing: "given a note, what canvas region matters". Without
// this, a caller would have to reach into `LaidOutScore.measures` by hand,
// exactly the internal-structure reach-in the layout/render split
// (`types.ts`'s own header comment) exists to avoid. This mirrors
// `CanvasRenderer.setSelection`'s own measure search (`src/render/renderer.ts`)
// as a standalone pure function rather than a private method, so it works off
// a `LaidOutScore` directly with no renderer instance required.
//
// Kept in its own file rather than folded into `hit-test.ts` even though both
// are small pure "given a layout, answer a position question" helpers:
// `hit-test.ts`'s own header comment scopes it specifically to "canvas point
// -> note id", the opposite direction of the lookup here, and its file-level
// framing (DOM-element-per-notehead avoidance) does not apply to this query
// at all.

import type { NoteId } from '../model/score.js';
import type { LaidOutScore, Rect } from './types.js';

/**
 * Resolve a note to the region a host should scroll into view to see it:
 * its owning measure's `region`. Returns `null` if `noteId` is not present
 * anywhere in `layout` (e.g. a stale id from a previous, differently-shaped
 * score).
 *
 * `LaidOutMeasure.region`'s own two invariants (contains every pixel the
 * measure's ops touch, never overlaps a neighbouring measure) are what make
 * it a correct answer here, not just a convenient one: scrolling it fully
 * into view is guaranteed to bring the note itself into view too.
 *
 * This is a lookup primitive only, not a scrolling implementation. Per the
 * framework-agnostic principle (the same one that keeps pointer-coordinate
 * translation in the demo's own `pointerdown` handler rather than the
 * engine, see `demo/main.ts`), a host decides what "scroll into view" means
 * for its own container: a plain DOM `scrollIntoView`, a canvas-relative
 * `scrollTo`, or, per plan.md's M4 intro, syncing a separate PDF pane.
 */
export function regionForNote(layout: LaidOutScore, noteId: NoteId): Rect | null {
	const measure = layout.measures.find((m) => m.notes.some((note) => note.id === noteId));
	return measure ? measure.region : null;
}
