import { describe, expect, it } from 'vitest';
import { createDemoScore, createFullDemoScore, createGrandStaffShowcaseScore } from '../demo-score.js';
import { hitTest, hitTestMeasure } from './hit-test.js';
import { layoutScore } from './layout.js';

describe('hitTest', () => {
	const score = createDemoScore();
	const layout = layoutScore(score);
	const centre = (measureIndex: number, noteIndex: number) => {
		const note = layout.measures[measureIndex]!.notes[noteIndex]!;
		return {
			id: note.id,
			x: note.bounds.x + note.bounds.width / 2,
			y: note.bounds.y + note.bounds.height / 2
		};
	};

	it('resolves a point on a notehead to that note', () => {
		for (const [measureIndex, noteIndex] of [
			[0, 0],
			[1, 3],
			[3, 1]
		] as const) {
			const target = centre(measureIndex, noteIndex);
			const hit = hitTest(layout, target.x, target.y);
			expect(hit).toEqual({ noteId: target.id, measureIndex, staffIndex: 0 });
		}
	});

	it('returns null for empty space', () => {
		// Above the system entirely, so outside every measure region.
		expect(hitTest(layout, layout.width / 2, 0)).toBeNull();
		// Past the final barline.
		expect(hitTest(layout, layout.width - 1, layout.height / 2)).toBeNull();
	});

	it('finds a rest, because rests are selectable notes too', () => {
		const rest = centre(3, 1);
		expect(hitTest(layout, rest.x, rest.y)?.noteId).toBe(rest.id);
	});

	it('reports the measure alongside the note, so a caller can redraw it', () => {
		const target = centre(2, 0);
		expect(hitTest(layout, target.x, target.y)?.measureIndex).toBe(2);
	});
});

describe('hitTest across systems', () => {
	// Casting a score off into systems packs measure regions into multiple
	// vertical bands rather than one long horizontal row; hit-testing must
	// still resolve a point to the right note wherever its system landed.
	it('resolves a note in a later system, not just the first', () => {
		const score = createDemoScore();
		const layout = layoutScore(score, { staffSpacePx: 11, systemWidthPx: 600 });
		expect(layout.systems.length).toBeGreaterThan(1);

		const lastSystem = layout.systems[layout.systems.length - 1]!;
		const measureIndex = lastSystem.measureIndices[0]!;
		const measure = layout.measures[measureIndex]!;
		const note = measure.notes[0]!;
		const x = note.bounds.x + note.bounds.width / 2;
		const y = note.bounds.y + note.bounds.height / 2;

		// Sanity check that this point really is below the first system, i.e.
		// the test is actually exercising a later system and not measure 0 by
		// accident.
		expect(y).toBeGreaterThan(layout.systems[0]!.topY + 4 * layout.staffSpacePx);

		expect(hitTest(layout, x, y)).toEqual({ noteId: note.id, measureIndex, staffIndex: 0 });
	});
});

describe('hitTestMeasure (M5 Slice 4)', () => {
	// Click points are derived from each measure's own laid-out region rather
	// than hard-coded pixels, so these tests keep meaning the same thing if
	// spacing or cast-off ever shifts.
	const regionCentre = (region: { x: number; y: number; width: number; height: number }) => ({
		x: region.x + region.width / 2,
		y: region.y + region.height / 2
	});

	it('resolves a point inside a measure region to that measure, notes or not', () => {
		const layout = layoutScore(createDemoScore());
		for (const measure of layout.measures) {
			const { x, y } = regionCentre(measure.region);
			expect(hitTestMeasure(layout, x, y)).toEqual({ staffIndex: 0, measureIndex: measure.index });
		}
		// The region's own top-left corner sits in blank staff space, where
		// `hitTest` would report nothing; a measure hit still resolves it.
		const first = layout.measures[0]!.region;
		expect(hitTestMeasure(layout, first.x + 1, first.y + 1)).toEqual({ staffIndex: 0, measureIndex: 0 });
	});

	it('resolves a measure on a non-zero staff to that staff, not staff 0', () => {
		const layout = layoutScore(createGrandStaffShowcaseScore());
		const bass = layout.measures.filter((m) => m.staffIndex === 1);
		expect(bass.length).toBeGreaterThan(1);
		for (const measure of bass) {
			const { x, y } = regionCentre(measure.region);
			expect(hitTestMeasure(layout, x, y)).toEqual({ staffIndex: 1, measureIndex: measure.index });
		}
	});

	it('resolves a measure in a later system after cast-off', () => {
		const layout = layoutScore(createFullDemoScore(), { staffSpacePx: 11, systemWidthPx: 600 });
		expect(layout.systems.length).toBeGreaterThan(1);
		const lastSystem = layout.systems[layout.systems.length - 1]!;
		const measureIndex = lastSystem.measureIndices[lastSystem.measureIndices.length - 1]!;
		const measure = layout.measures.find((m) => m.staffIndex === 0 && m.index === measureIndex)!;
		const { x, y } = regionCentre(measure.region);
		// Really below the first system, not measure 0 by accident.
		expect(y).toBeGreaterThan(layout.systems[0]!.topY + 4 * layout.staffSpacePx);
		expect(hitTestMeasure(layout, x, y)).toEqual({ staffIndex: 0, measureIndex });
	});

	it('resolves a bass-staff measure in a later system of a multi-staff score', () => {
		const layout = layoutScore(createGrandStaffShowcaseScore(), { staffSpacePx: 11, systemWidthPx: 300 });
		expect(layout.systems.length).toBeGreaterThan(1);
		const lastSystem = layout.systems[layout.systems.length - 1]!;
		const measureIndex = lastSystem.measureIndices[0]!;
		const measure = layout.measures.find((m) => m.staffIndex === 1 && m.index === measureIndex)!;
		const { x, y } = regionCentre(measure.region);
		expect(hitTestMeasure(layout, x, y)).toEqual({ staffIndex: 1, measureIndex });
	});

	it('returns null for empty space outside every measure', () => {
		const layout = layoutScore(createDemoScore());
		expect(hitTestMeasure(layout, layout.width / 2, 0)).toBeNull();
		expect(hitTestMeasure(layout, layout.width - 1, layout.height / 2)).toBeNull();
	});
});
