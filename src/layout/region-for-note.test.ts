import { describe, expect, it } from 'vitest';
import { createDemoScore } from '../demo-score.js';
import { layoutScore } from './layout.js';
import { regionForNote } from './region-for-note.js';
import { measureAt, twoStaffScore } from './test-helpers.js';

describe('regionForNote', () => {
	it("resolves a note in the first measure to that measure's own region", () => {
		const score = createDemoScore();
		const layout = layoutScore(score);
		const note = layout.measures[0]!.notes[0]!;

		expect(regionForNote(layout, note.id)).toEqual(layout.measures[0]!.region);
	});

	it('resolves a note in a later system after cast-off, not just the first', () => {
		const score = createDemoScore();
		const layout = layoutScore(score, { staffSpacePx: 11, systemWidthPx: 600 });
		expect(layout.systems.length).toBeGreaterThan(1);

		const lastSystem = layout.systems[layout.systems.length - 1]!;
		const measureIndex = lastSystem.measureIndices[0]!;
		const measure = layout.measures[measureIndex]!;
		const note = measure.notes[0]!;

		expect(regionForNote(layout, note.id)).toEqual(measure.region);
	});

	it('resolves a note on a non-zero staff to that staff\'s own measure region', () => {
		// Both staves have a "measure 1": ignoring staffIndex finds the wrong one.
		const score = twoStaffScore();
		const layout = layoutScore(score);
		const note = score.staves[1]!.measures[1]!.notes[0]!;
		expect(regionForNote(layout, note.id)).toEqual(measureAt(layout, 1, 1).region);
	});

	it('returns null for a note id not present in the layout', () => {
		const score = createDemoScore();
		const layout = layoutScore(score);

		expect(regionForNote(layout, 'not-a-real-note-id')).toBeNull();
	});
});
