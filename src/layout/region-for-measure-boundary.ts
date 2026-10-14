// Seam-marker geometry (M5 Slice 6): (staff, measure boundary) -> the thin
// vertical strip a host should mark there.
//
// The motivating host is an OMR pipeline that stitches a score together from
// several scanned fragments and wants to show where one fragment ends and the
// next begins. The engine owns no seam concept at all: no OMR mapping, no
// persistence, nothing in the model. It answers one geometric question, "where
// on the canvas is this boundary", and `CanvasRenderer.setSeamMarkers` draws
// whatever boundary list a host hands it using this same answer.
//
// Same shape as `region-for-note.ts`: a pure function over a `LaidOutScore`,
// with the measure found by the same flat `layout.measures.find(...)` lookup
// `regionForNote` and `CanvasRenderer`'s own redraw path use, rather than a
// new walk over `systems` or any other layout internals. Kept in its own file
// rather than added to `region-for-note.ts` because that file's header scopes
// it to "note id -> region", and a boundary is not a note.

import type { LaidOutScore, Rect } from './types.js';

/**
 * Width of a seam strip, in staff spaces. Wide enough to read as a deliberate
 * mark over a thin barline (about 0.16 staff spaces of ink) and to cover a
 * final barline's thick stroke (0.5), narrow enough not to swallow the first
 * note after the boundary. Scaled by `staffSpacePx`, not a fixed pixel
 * count, so the strip zooms with the rest of the score.
 */
export const SEAM_STRIP_WIDTH_STAFF_SPACES = 0.6;

/**
 * Resolve a measure boundary on one staff to the vertical strip a host should
 * mark there, or `null` if there is no such boundary.
 *
 * `boundaryIndex` numbering, for a staff with `measureCount` measures:
 * - `0 <= i < measureCount`: the boundary at the *start* of measure `i`. Inside
 *   a system that is the barline between measures `i - 1` and `i` (measure
 *   `i - 1`'s end barline sits flush against its region's right edge, and
 *   measure `i`'s region starts exactly there). At a system break it is the
 *   left edge of measure `i`, the start of the new system, not the end barline
 *   of measure `i - 1` on the previous system: a seam marks where new material
 *   begins. Boundary 0 is the left edge of the staff's very first measure.
 * - `i === measureCount`: the final boundary, the right edge of the last
 *   measure (its final barline).
 * - anything else, a non-integer, or a `staffIndex` with no measures in the
 *   layout: `null`.
 *
 * Geometry: horizontally, `SEAM_STRIP_WIDTH_STAFF_SPACES * staffSpacePx`
 * wide. For `i < measureCount` it is centred on the edge, so it straddles the
 * barline and spills half its width into each neighbour (or, at a system
 * start, into the empty margin before the staff). For the final boundary it
 * sits just inside the edge instead (right-aligned to it): there is no
 * following measure to straddle into, and a final barline's thick stroke is
 * wider than half a strip, so centring would leave part of it unmarked.
 * Vertically, the full height of the measure that owns the edge: measure
 * `i`'s region, or the last measure's for the final boundary.
 *
 * The strip deliberately does not respect `LaidOutMeasure.region`'s
 * no-overlap invariant: it is an overlay, not a measure's own ink, and no
 * measure's region is ever grown to contain it. `CanvasRenderer` repaints the
 * part of any strip that overlaps a measure it redraws; see `setSeamMarkers`.
 */
export function regionForMeasureBoundary(
	layout: LaidOutScore,
	staffIndex: number,
	boundaryIndex: number
): Rect | null {
	if (!Number.isInteger(boundaryIndex) || boundaryIndex < 0) return null;
	const measureCount = layout.measures.filter((m) => m.staffIndex === staffIndex).length;
	if (measureCount === 0 || boundaryIndex > measureCount) return null;

	const isFinal = boundaryIndex === measureCount;
	const owner = layout.measures.find(
		(m) => m.staffIndex === staffIndex && m.index === (isFinal ? measureCount - 1 : boundaryIndex)
	);
	if (!owner) return null;

	const { region } = owner;
	const width = SEAM_STRIP_WIDTH_STAFF_SPACES * layout.staffSpacePx;
	const x = isFinal ? region.x + region.width - width : region.x - width / 2;
	return { x, y: region.y, width, height: region.height };
}
