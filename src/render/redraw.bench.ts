// Wall-clock comparison: region-scoped redraw versus whole-score redraw.
//
// Run with `npm run bench`. It is deliberately outside `npm test`: timings are
// machine- and load-dependent, and a benchmark that can fail CI is a benchmark
// people delete. The CI-checkable claim is the region-scoping property asserted
// in `renderer.test.ts`; this file only puts numbers on how much that property
// is worth.
//
// It rasterizes for real, through node-canvas, because a stubbed context would
// measure our own loop overhead and none of the glyph rasterization that
// dominates an actual repaint. That is also why the font registered here is the
// OTF rather than the WOFF2 the browser uses: node-canvas cannot read WOFF2.
//
// What this does *not* measure is OSMD. Installing OSMD or VexFlow to race
// against would contradict the repo's first design principle, and there is no
// need: OSMD's figure (~1.1-1.3s per edit, ~70% of it inside load() + render())
// is already profiled and recorded in Divisi's OMR_EDITOR_PLAN.md, milestone
// E13. Note that it was measured on a 124-measure choral score, so it is not
// like-for-like with the small scores below. The comparison that matters is not
// millisecond against millisecond, it is the shape of the curve: OSMD's cost is
// a full reparse and re-layout whose size is the score's, ours is one measure's
// whether the score has four measures or a hundred.

import { createCanvas, registerFont } from 'canvas';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDemoScore } from '../demo-score.js';
import { layoutScore, relayoutMeasure } from '../layout/layout.js';
import type { Score } from '../model/score.js';
import { CanvasRenderer } from './renderer.js';
import { BRAVURA_FAMILY } from './glyph-metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
registerFont(join(here, '..', '..', 'assets', 'bravura', 'Bravura.otf'), {
	family: BRAVURA_FAMILY
});

const LAYOUT_OPTIONS = { staffSpacePx: 11 };

/** Repeat the demo score until it has `measureCount` measures. */
function scoreOfLength(measureCount: number): Score {
	const score = createDemoScore();
	while (score.measures.length < measureCount) {
		const source = score.measures[score.measures.length % 4]!;
		const copy = score.appendMeasure();
		for (const note of source.notes) {
			score.appendNote(copy, { pitch: note.pitch, value: note.value });
		}
	}
	return score;
}

function median(samples: number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
		: (sorted[middle] ?? 0);
}

/** Median of `iterations` timed runs after a warm-up, in milliseconds. */
function time(iterations: number, run: (index: number) => void): number {
	for (let i = 0; i < 20; i++) run(i);
	const samples: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const started = performance.now();
		run(i);
		samples.push(performance.now() - started);
	}
	return median(samples);
}

interface Row {
	readonly measures: number;
	readonly scopedMs: number;
	readonly fullMs: number;
}

function measureScore(measureCount: number): Row {
	const score = scoreOfLength(measureCount);
	let layout = layoutScore(score, LAYOUT_OPTIONS);
	const canvas = createCanvas(Math.ceil(layout.width), Math.ceil(layout.height));
	const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
	const renderer = new CanvasRenderer(ctx, layout);
	renderer.drawAll();

	// The edit is applied to a measure in the middle of the score, so nothing
	// about the result depends on the touched measure being cheap to reach.
	const target = score.measures[Math.floor(measureCount / 2)]!;
	const noteId = target.notes[0]!.id;

	const scopedMs = time(200, (index) => {
		const touched = score.transposeNote(noteId, index % 2 === 0 ? 1 : -1)!;
		const updated = relayoutMeasure(score, layout, touched, LAYOUT_OPTIONS);
		if (!updated) throw new Error('expected the transpose to stay within its measure');
		layout = updated;
		renderer.setLayout(layout);
		renderer.redrawMeasure(touched);
	});

	// Same edit, same rasterizer, but the whole system repainted: this is the
	// stand-in for what an engine without a partial-update API has to do.
	const fullMs = time(200, (index) => {
		score.transposeNote(noteId, index % 2 === 0 ? 1 : -1);
		layout = layoutScore(score, LAYOUT_OPTIONS);
		renderer.setLayout(layout);
		renderer.drawAll();
	});

	return { measures: measureCount, scopedMs, fullMs };
}

describe('redraw cost', () => {
	it('scales with the edited measure, not with the score', () => {
		const rows = [4, 16, 64, 124].map(measureScore);
		const lines = [
			'',
			'  measures   scoped edit   full redraw   speedup',
			'  --------   -----------   -----------   -------'
		];
		for (const row of rows) {
			lines.push(
				`  ${String(row.measures).padStart(8)}   ${row.scopedMs.toFixed(3).padStart(8)} ms   ` +
					`${row.fullMs.toFixed(3).padStart(8)} ms   ${(row.fullMs / row.scopedMs).toFixed(1).padStart(5)}x`
			);
		}
		console.log(lines.join('\n'));

		// The only assertion: the scoped path must not get materially more
		// expensive as the score grows. A 3x slack absorbs cache effects and
		// whatever else a shared machine is doing.
		const smallest = rows[0]!;
		const largest = rows[rows.length - 1]!;
		expect(largest.scopedMs).toBeLessThan(smallest.scopedMs * 3);
		expect(largest.fullMs / largest.scopedMs).toBeGreaterThan(
			smallest.fullMs / smallest.scopedMs
		);
	});
});
