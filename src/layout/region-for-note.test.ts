import { describe, expect, it } from 'vitest';
import { createDemoScore } from '../demo-score.js';
import { parsePitch } from '../model/pitch.js';
import { Score } from '../model/score.js';
import { layoutScore } from './layout.js';
import { regionForNote } from './region-for-note.js';

describe('regionForNote', () => {
	it("resolves a note in the first measure to that measure's own region", () => {
		const score = createDemoScore();
		const layout = layoutScore(score);
		const note = layout.measures[0]!.notes[0]!;

		expect(regionForNote(layout, note.id)).toEqual(layout.measures[0]!.region);
	});

	it('resolves a note in a later system after cast-off, not just the first', () => {
		// Same technique `renderer.test.ts`'s "redraws only the touched measure
		// when the score spans multiple systems" test uses to force multi-system
		// casting: a narrow `systemWidthPx` against the demo score.
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
		// Same twoStaffScore fixture `renderer.test.ts`'s M4 Slice 1 block builds:
		// two staves, each with its own colliding "measure 1", so a lookup that
		// ignored staffIndex would find the wrong region.
		const score = new Score({ keyFifths: 0 });
		score.appendStaff('bass');
		for (const staffIndex of [0, 1] as const) {
			for (let i = 0; i < 3; i++) {
				const measure = score.appendMeasure(staffIndex);
				for (const pitch of ['C4', 'D4', 'E4', 'F4']) {
					score.appendNote(measure, { pitch: parsePitch(pitch), value: 'quarter' });
				}
			}
		}

		const layout = layoutScore(score);
		const note = score.staves[1]!.measures[1]!.notes[0]!;
		const measure = layout.measures.find((m) => m.staffIndex === 1 && m.index === 1)!;

		expect(regionForNote(layout, note.id)).toEqual(measure.region);
	});

	it('returns null for a note id not present in the layout', () => {
		const score = createDemoScore();
		const layout = layoutScore(score);

		expect(regionForNote(layout, 'not-a-real-note-id')).toBeNull();
	});
});
