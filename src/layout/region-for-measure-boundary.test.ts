import { describe, expect, it } from 'vitest';
import { createDemoScore } from '../demo-score.js';
import { layoutScore } from './layout.js';
import { regionForMeasureBoundary, SEAM_STRIP_WIDTH_STAFF_SPACES } from './region-for-measure-boundary.js';
import { measureAt, twoStaffScore } from './test-helpers.js';
import type { LaidOutMeasure, LaidOutScore, Rect } from './types.js';

/** The strip `regionForMeasureBoundary` should return for an edge at `edgeX`
 *  owned by `owner`, written out independently of the implementation:
 *  centred on the edge, or right-aligned to it for the final boundary. */
const expectedStrip = (layout: LaidOutScore, owner: LaidOutMeasure, edgeX: number, final = false): Rect => {
	const width = SEAM_STRIP_WIDTH_STAFF_SPACES * layout.staffSpacePx;
	const x = final ? edgeX - width : edgeX - width / 2;
	return { x, y: owner.region.y, width, height: owner.region.height };
};

/** The x extent of a measure's end barline: its rightmost full-height rect op. */
const endBarline = (measure: LaidOutMeasure): { left: number; right: number } => {
	const rects = measure.ops.filter((op) => op.kind === 'rect' && op.height > op.width);
	const last = rects.reduce((a, b) => (a.kind === 'rect' && b.kind === 'rect' && b.x > a.x ? b : a));
	if (last.kind !== 'rect') throw new Error('unreachable');
	return { left: last.x, right: last.x + last.width };
};

describe('regionForMeasureBoundary', () => {
	it('centres a first-system boundary on the barline between the two measures', () => {
		const layout = layoutScore(createDemoScore());
		const before = measureAt(layout, 0, 1);
		const after = measureAt(layout, 0, 2);
		// Inside a system, measure 2 starts exactly where measure 1 ends.
		expect(after.region.x).toBeCloseTo(before.region.x + before.region.width, 6);

		const strip = regionForMeasureBoundary(layout, 0, 2)!;
		expect(strip).toEqual(expectedStrip(layout, after, after.region.x));
		// And it actually covers measure 1's end barline ink.
		const barline = endBarline(before);
		expect(strip.x).toBeLessThanOrEqual(barline.left);
		expect(strip.x + strip.width).toBeGreaterThanOrEqual(barline.right);
	});

	it('marks the start of the new system at a system break, not the previous system\'s end barline', () => {
		const layout = layoutScore(createDemoScore(), { staffSpacePx: 11, systemWidthPx: 600 });
		expect(layout.systems.length).toBeGreaterThan(1);
		const firstOfLater = layout.systems[layout.systems.length - 1]!.measureIndices[0]!;
		expect(firstOfLater).toBeGreaterThan(0);
		const owner = measureAt(layout, 0, firstOfLater);
		const previous = measureAt(layout, 0, firstOfLater - 1);
		// Sanity: the two sit on different rows.
		expect(owner.region.y).toBeGreaterThan(previous.region.y + previous.region.height);

		expect(regionForMeasureBoundary(layout, 0, firstOfLater)).toEqual(expectedStrip(layout, owner, owner.region.x));
	});

	it("uses a non-zero staff's own measure, not staff 0's same-numbered one", () => {
		const layout = layoutScore(twoStaffScore());
		const owner = measureAt(layout, 1, 1);
		const strip = regionForMeasureBoundary(layout, 1, 1)!;
		expect(strip).toEqual(expectedStrip(layout, owner, owner.region.x));
		expect(strip.y).toBeGreaterThan(measureAt(layout, 0, 1).region.y);
	});

	it('treats boundaryIndex === measureCount as the final barline, inside its right edge', () => {
		const layout = layoutScore(createDemoScore());
		const last = measureAt(layout, 0, 3);
		const strip = regionForMeasureBoundary(layout, 0, 4)!;
		expect(strip).toEqual(expectedStrip(layout, last, last.region.x + last.region.width, true));
		const barline = endBarline(last);
		expect(strip.x).toBeLessThanOrEqual(barline.left);
		expect(strip.x + strip.width).toBeGreaterThanOrEqual(barline.right);
	});

	it('treats boundary 0 as the left edge of the first measure', () => {
		const layout = layoutScore(createDemoScore());
		const first = measureAt(layout, 0, 0);
		expect(regionForMeasureBoundary(layout, 0, 0)).toEqual(expectedStrip(layout, first, first.region.x));
	});

	it('returns null for an out-of-range or non-integer boundary, or a staff with no measures', () => {
		const layout = layoutScore(createDemoScore());
		for (const [staff, boundary] of [[0, 5], [0, -1], [0, 1.5], [1, 0], [-1, 0]]) {
			expect(regionForMeasureBoundary(layout, staff!, boundary!)).toBeNull();
		}
	});
});
