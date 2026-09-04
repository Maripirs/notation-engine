import { describe, expect, it } from 'vitest';
import { createDemoScore } from '../demo-score.js';
import { hitTest } from './hit-test.js';
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
			expect(hit).toEqual({ noteId: target.id, measureIndex });
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
