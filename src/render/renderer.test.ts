// The Phase 0 proof: an edit repaints one measure's region and nothing else.
//
// This is deliberately not a timing test. A wall-clock number proves a redraw
// was fast, not that it was *scoped*, and on a four-measure score a full repaint
// is fast too. Timings live in `redraw.bench.ts`, which needs a real rasterizer
// and a real machine; this file asserts the property that makes those timings
// mean something, and it runs anywhere, in CI, with no canvas at all.
//
// The recording context below is why no canvas is needed: `CanvasRenderer` only
// ever calls four methods on its context, so a stub that writes down the
// coordinates of every call is a complete record of which pixels the renderer
// would have touched.

import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoScore } from '../demo-score.js';
import { layoutScore, relayoutMeasure } from '../layout/layout.js';
import { parsePitch } from '../model/pitch.js';
import { buildScore, Score } from '../model/score.js';
import type { LaidOutScore, Rect } from '../layout/types.js';
import { CanvasRenderer } from './renderer.js';

interface Recorded {
	readonly call: 'fillRect' | 'clearRect' | 'fillText';
	readonly x: number;
	readonly y: number;
	/** Right edge, so a glyph's origin and a rectangle's extent compare the same way. */
	readonly right: number;
	readonly bottom: number;
}

function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const stub = {
		font: '',
		fillStyle: '',
		textBaseline: 'alphabetic',
		fillRect(x: number, y: number, width: number, height: number) {
			calls.push({ call: 'fillRect', x, y, right: x + width, bottom: y + height });
		},
		clearRect(x: number, y: number, width: number, height: number) {
			calls.push({ call: 'clearRect', x, y, right: x + width, bottom: y + height });
		},
		fillText(_text: string, x: number, y: number) {
			calls.push({ call: 'fillText', x, y, right: x, bottom: y });
		}
	};
	return { ctx: stub as unknown as CanvasRenderingContext2D, calls };
}

const within = (rect: Rect, point: Recorded, slack = 0.001) =>
	point.x >= rect.x - slack && point.right <= rect.x + rect.width + slack;

describe('CanvasRenderer region-scoped redraw', () => {
	let score: ReturnType<typeof createDemoScore>;
	let layout: LaidOutScore;
	let recorder: ReturnType<typeof recordingContext>;
	let renderer: CanvasRenderer;

	beforeEach(() => {
		score = createDemoScore();
		layout = layoutScore(score);
		recorder = recordingContext();
		renderer = new CanvasRenderer(recorder.ctx, layout);
		renderer.drawAll();
		recorder.calls.length = 0;
	});

	it('reports every measure for a full redraw', () => {
		renderer.drawAll();
		expect(renderer.lastRedrawnMeasures).toEqual([0, 1, 2, 3]);
	});

	it('transposing a note in measure 2 redraws only measure 2', () => {
		// Measure indices are 0-based, so "measure 2" of the four-measure score is
		// index 1. Everything below is the whole edit loop: mutate the model, ask
		// the model which measure moved, re-lay-out only that measure, repaint
		// only that measure.
		const target = score.measures[1]!.notes[0]!;
		const touched = score.transposeNote(target.id, 1);
		expect(touched).toBe(1);

		const updated = relayoutMeasure(score, layout, touched!);
		expect(updated).not.toBeNull();
		renderer.setLayout(updated!);
		renderer.redrawMeasure(touched!);

		// 1. The renderer's own account of what it painted.
		expect(renderer.lastRedrawnMeasures).toEqual([1]);
		expect(renderer.lastRedrawnRegions).toEqual([updated!.measures[1]!.region]);

		// 2. The independent account: every drawing call actually issued lands
		//    inside measure 2's band and outside measures 1, 3 and 4's.
		const region = updated!.measures[1]!.region;
		expect(recorder.calls.length).toBeGreaterThan(0);
		for (const call of recorder.calls) {
			expect(within(region, call)).toBe(true);
		}
		for (const other of [0, 2, 3]) {
			const otherRegion = updated!.measures[other]!.region;
			const intruders = recorder.calls.filter(
				(call) => call.x < otherRegion.x + otherRegion.width && call.right > otherRegion.x
			);
			expect(intruders).toEqual([]);
		}
	});

	it('clears the region before repainting it, so nothing stale survives', () => {
		// Without the clear, a note moving down a step would leave its old
		// notehead behind. The clear must come first and must cover the region.
		renderer.redrawMeasure(2);
		const first = recorder.calls[0]!;
		const region = layout.measures[2]!.region;
		expect(first.call).toBe('fillRect');
		expect(first.x).toBeLessThanOrEqual(region.x);
		expect(first.right).toBeGreaterThanOrEqual(region.x + region.width);
	});

	it('uses clearRect instead when the canvas has no opaque background', () => {
		const transparent = recordingContext();
		const layered = new CanvasRenderer(transparent.ctx, layout, { background: null });
		layered.redrawMeasure(0);
		expect(transparent.calls[0]!.call).toBe('clearRect');
	});

	it('costs the same per edit whatever the score length', () => {
		// The claim being tested is not "fast" but "constant": the number of
		// drawing calls for a one-measure repaint must not depend on how many
		// measures exist. This is the property OSMD cannot have, since its
		// load()+render() re-does the entire score every time.
		const callsForOneMeasure = (measureCount: number) => {
			const long = createDemoScore();
			while (long.measures.length < measureCount) {
				const source = long.measures[long.measures.length % 4]!;
				const copy = long.appendMeasure();
				for (const note of source.notes) {
					long.appendNote(copy, { pitch: note.pitch, value: note.value });
				}
			}
			const longLayout = layoutScore(long);
			const probe = recordingContext();
			new CanvasRenderer(probe.ctx, longLayout).redrawMeasure(1);
			return probe.calls.length;
		};
		expect(callsForOneMeasure(40)).toBe(callsForOneMeasure(4));
	});

	it('redraws both measures when a selection moves between them', () => {
		// Selection is a two-region edit: the old note has to lose its highlight
		// and the new one has to gain it. Reported as a set so the caller does not
		// have to work that out.
		const from = layout.measures[0]!.notes[0]!.id;
		const to = layout.measures[2]!.notes[1]!.id;
		expect(renderer.setSelection(from)).toEqual([{ staffIndex: 0, index: 0 }]);
		expect(renderer.setSelection(to).sort((a, b) => a.index - b.index)).toEqual([
			{ staffIndex: 0, index: 0 },
			{ staffIndex: 0, index: 2 }
		]);
		renderer.redrawMeasures([0, 2]);
		expect(renderer.lastRedrawnMeasures).toEqual([0, 2]);
	});

	it('redraws only the touched measure when the score spans multiple systems', () => {
		// Same proof as "transposing a note in measure 2 redraws only measure 2"
		// above, but with the score cast off into systems. This is the case the
		// horizontal-only `within`/intruder checks above cannot cover: once
		// measures stop running in one long row, a later system's measures sit
		// at *overlapping* x ranges with earlier systems (every system starts
		// back at the left margin), differing only in y, so a real 2D check is
		// needed to catch a redraw that leaked into another system's band.
		const withinBox = (rect: Rect, point: Recorded, slack = 0.001) =>
			point.x >= rect.x - slack &&
			point.right <= rect.x + rect.width + slack &&
			point.y >= rect.y - slack &&
			point.bottom <= rect.y + rect.height + slack;

		const multiSystemScore = createDemoScore();
		const options = { systemWidthPx: 600 };
		let multiSystemLayout = layoutScore(multiSystemScore, options);
		expect(multiSystemLayout.systems.length).toBeGreaterThan(1);

		const multiRecorder = recordingContext();
		const multiRenderer = new CanvasRenderer(multiRecorder.ctx, multiSystemLayout);
		multiRenderer.drawAll();
		multiRecorder.calls.length = 0;

		// Measure 2 (index 2) opens the second system at this width, so this
		// also exercises re-laying-out a system-first measure incrementally.
		const target = multiSystemScore.measures[2]!.notes[0]!;
		const touched = multiSystemScore.transposeNote(target.id, 1);
		expect(touched).toBe(2);

		const updated = relayoutMeasure(multiSystemScore, multiSystemLayout, touched!, options);
		expect(updated).not.toBeNull();
		multiSystemLayout = updated!;
		multiRenderer.setLayout(multiSystemLayout);
		multiRenderer.redrawMeasure(touched!);

		expect(multiRenderer.lastRedrawnMeasures).toEqual([2]);
		const region = multiSystemLayout.measures[2]!.region;
		expect(multiRecorder.calls.length).toBeGreaterThan(0);
		for (const call of multiRecorder.calls) {
			expect(withinBox(region, call)).toBe(true);
		}
		for (const other of [0, 1, 3]) {
			const otherRegion = multiSystemLayout.measures[other]!.region;
			const intruders = multiRecorder.calls.filter((call) => withinBox(otherRegion, call));
			expect(intruders).toEqual([]);
		}
	});

	it('actually changes what it paints when the model changed', () => {
		// A guard against the test above passing for the wrong reason: a renderer
		// that drew nothing at all would also touch no neighbouring measure.
		const before = [...recorder.calls];
		renderer.redrawMeasure(1);
		const baseline = recorder.calls.slice(before.length).map((call) => call.y);

		recorder.calls.length = 0;
		const target = score.measures[1]!.notes[0]!;
		score.transposeNote(target.id, 1);
		const updated = relayoutMeasure(score, layout, 1)!;
		renderer.setLayout(updated);
		renderer.redrawMeasure(1);
		expect(recorder.calls.map((call) => call.y)).not.toEqual(baseline);
	});
});

describe('CanvasRenderer region-scoped redraw across staves (M2 Slice 3)', () => {
	// Same 2D "call falls inside/outside this rectangle" check the multi-
	// system test above uses, needed here for the same reason: staves are now
	// stacked vertically, so a later staff's measures sit at *overlapping* x
	// ranges with an earlier staff's (every staff starts back at the left
	// margin), differing only in y.
	const withinBox = (rect: Rect, point: { x: number; right: number; y: number; bottom: number }, slack = 0.001) =>
		point.x >= rect.x - slack &&
		point.right <= rect.x + rect.width + slack &&
		point.y >= rect.y - slack &&
		point.bottom <= rect.y + rect.height + slack;

	it("redraws only the touched staff's touched measure, leaving every other staff and measure untouched", () => {
		// Two staves, each with three measures of its own: staff-local measure
		// indices deliberately collide (both staves have their own "measure
		// 0", "1", "2"), which is exactly the ambiguity `(staffIndex, index)`
		// addressing exists to resolve; a bare `index` lookup could not have
		// told these apart.
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

		let layout = layoutScore(score);
		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, layout);
		renderer.drawAll();
		recorder.calls.length = 0;

		// Touch staff 1 (bass), measure 1 (its own middle measure).
		const target = score.staves[1]!.measures[1]!.notes[0]!;
		const touched = score.transposeNote(target.id, 1);
		expect(touched).toBe(1);

		const updated = relayoutMeasure(score, layout, touched!, {}, 1);
		expect(updated).not.toBeNull();
		layout = updated!;
		renderer.setLayout(layout);
		renderer.redrawMeasure(touched!, 1);

		const touchedRegion = layout.measures.find((m) => m.staffIndex === 1 && m.index === 1)!.region;
		expect(recorder.calls.length).toBeGreaterThan(0);
		for (const call of recorder.calls) {
			expect(withinBox(touchedRegion, call)).toBe(true);
		}
		// Every other (staffIndex, index) pair, on *both* staves, sees no
		// intruding draw call: staff 0's measures (a different staff entirely)
		// and staff 1's own measures 0 and 2 (same staff, different measure).
		for (const m of layout.measures) {
			if (m.staffIndex === 1 && m.index === 1) continue;
			const intruders = recorder.calls.filter((call) => withinBox(m.region, call));
			expect(intruders).toEqual([]);
		}
	});
});

describe('CanvasRenderer.setSelection across staves (M4 Slice 1)', () => {
	// Same withinBox 2D check the M2 Slice 3 block above uses, needed here for
	// the same reason: staff 1's measures sit at the same x range as staff 0's
	// same-numbered ones, differing only in y.
	const withinBox = (rect: Rect, point: { x: number; right: number; y: number; bottom: number }, slack = 0.001) =>
		point.x >= rect.x - slack &&
		point.right <= rect.x + rect.width + slack &&
		point.y >= rect.y - slack &&
		point.bottom <= rect.y + rect.height + slack;

	function twoStaffScore(): Score {
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
		return score;
	}

	it("returns the note's real (staffIndex, index) pair, and redrawing with it touches only that staff's own measure", () => {
		const score = twoStaffScore();
		const layout = layoutScore(score);
		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, layout);
		renderer.drawAll();
		recorder.calls.length = 0;

		// Select a note on staff 1 (bass), measure 1: the same "collides with
		// staff 0's own measure 1" case the M2 Slice 3 block above exercises for
		// `redrawMeasure`/`redrawMeasures`, but here for `setSelection` itself.
		const noteId = score.staves[1]!.measures[1]!.notes[0]!.id;
		const changed = renderer.setSelection(noteId);
		expect(changed).toEqual([{ staffIndex: 1, index: 1 }]);

		for (const { staffIndex, index } of changed) renderer.redrawMeasure(index, staffIndex);

		const touchedRegion = layout.measures.find((m) => m.staffIndex === 1 && m.index === 1)!.region;
		expect(recorder.calls.length).toBeGreaterThan(0);
		for (const call of recorder.calls) {
			expect(withinBox(touchedRegion, call)).toBe(true);
		}
		// Staff 0's own measure 1 (the same numeric index, the other staff)
		// stays untouched, along with every other (staffIndex, index) pair.
		for (const m of layout.measures) {
			if (m.staffIndex === 1 && m.index === 1) continue;
			const intruders = recorder.calls.filter((call) => withinBox(m.region, call));
			expect(intruders).toEqual([]);
		}
	});

	it('reproduces the pre-fix bug: dropping staffIndex and defaulting to 0 paints the wrong staff', () => {
		// This is the failure mode Slice 1 closes, made concrete: simulate what
		// the old bare-`number[]`-returning `setSelection` plus a caller trusting
		// `redrawMeasures`'s `staffIndex = 0` default would have done, and show
		// it paints staff 0's unrelated measure instead of the one that was
		// actually selected. If this test failed, the fix above would be
		// unproven, not just untested.
		const score = twoStaffScore();
		const layout = layoutScore(score);
		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, layout);
		renderer.drawAll();
		recorder.calls.length = 0;

		const noteId = score.staves[1]!.measures[1]!.notes[0]!.id;
		const changed = renderer.setSelection(noteId);

		// The pre-fix path: keep only the bare `index`, discard `staffIndex`,
		// and let `redrawMeasures` fall back to its `staffIndex = 0` default.
		const preFixIndices = changed.map(({ index }) => index);
		renderer.redrawMeasures(preFixIndices);

		const wronglyPaintedRegion = layout.measures.find((m) => m.staffIndex === 0 && m.index === 1)!.region;
		const intendedRegion = layout.measures.find((m) => m.staffIndex === 1 && m.index === 1)!.region;
		expect(recorder.calls.length).toBeGreaterThan(0);
		// Every call landed in staff 0's measure 1, the wrong one.
		for (const call of recorder.calls) {
			expect(withinBox(wronglyPaintedRegion, call)).toBe(true);
		}
		// None of them landed in staff 1's own measure 1, the one that was
		// actually selected: the pre-fix path leaves the true change unpainted.
		const correctHits = recorder.calls.filter((call) => withinBox(intendedRegion, call));
		expect(correctHits).toEqual([]);
	});
});

describe('CanvasRenderer painting part decorations (M2 Slice 5)', () => {
	it('drawAll paints a brace/bracket and its part-name label; redrawMeasure never repaints them', () => {
		const score = new Score({ keyFifths: 0 });
		score.appendStaff('bass');
		score.addPart([0, 1], 'Piano');
		for (const staffIndex of [0, 1] as const) {
			const measure = score.appendMeasure(staffIndex);
			score.appendNote(measure, { pitch: parsePitch('C4'), value: 'quarter' });
		}

		const layout = layoutScore(score);
		expect(layout.partDecorations.length).toBeGreaterThan(0);

		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, layout);
		renderer.drawAll();

		// The label text reaches the renderer as a real `fillText` call, the
		// same call every glyph draws with; nothing about `partDecorations`
		// needs its own renderer code path beyond what `#drawOps` already had.
		const label = layout.partDecorations.find((op) => op.kind === 'text')!;
		expect(label).toBeDefined();
		expect(recorder.calls.some((call) => call.call === 'fillText' && Math.abs(call.x - label.x) < 0.001)).toBe(
			true
		);

		// A region-scoped redraw never repaints the decoration ink: nothing in
		// this slice's scope ever changes a `Part`'s grouping or name, so there
		// is nothing for an edit to keep in sync there.
		recorder.calls.length = 0;
		renderer.redrawMeasure(0);
		const decorationXs = new Set(layout.partDecorations.flatMap((op) => (op.kind === 'curve' ? [] : [op.x])));
		expect(recorder.calls.some((call) => decorationXs.has(call.x))).toBe(false);
	});
});

describe('CanvasRenderer painting a tie curve', () => {
	// A second, narrower stub than `recordingContext`, since only this suite's
	// tests need to know a curve was actually stroked rather than just that
	// *some* drawing happened; folding these methods into the shared stub
	// above would make every other test in this file track calls it does not
	// care about.
	function curveRecordingContext(): {
		ctx: CanvasRenderingContext2D;
		strokes: { x0: number; y0: number; cx0: number; cy0: number; cx1: number; cy1: number; x1: number; y1: number }[];
		lineWidths: number[];
	} {
		const strokes: {
			x0: number;
			y0: number;
			cx0: number;
			cy0: number;
			cx1: number;
			cy1: number;
			x1: number;
			y1: number;
		}[] = [];
		const lineWidths: number[] = [];
		let current: { x0: number; y0: number } | null = null;
		const stub = {
			font: '',
			fillStyle: '',
			strokeStyle: '',
			lineWidth: 1,
			textBaseline: 'alphabetic',
			fillRect() {},
			clearRect() {},
			fillText() {},
			beginPath() {
				current = null;
			},
			moveTo(x: number, y: number) {
				current = { x0: x, y0: y };
			},
			bezierCurveTo(cx0: number, cy0: number, cx1: number, cy1: number, x1: number, y1: number) {
				if (!current) throw new Error('bezierCurveTo before moveTo');
				strokes.push({ ...current, cx0, cy0, cx1, cy1, x1, y1 });
			},
			stroke() {
				lineWidths.push(this.lineWidth);
			}
		};
		return { ctx: stub as unknown as CanvasRenderingContext2D, strokes, lineWidths };
	}

	it('strokes a bezier curve for a tie, using the op\'s own thickness', () => {
		const score = buildScore([[['C4', 'quarter', { tiedToNext: true }], ['C4', 'quarter']]]);
		const layout = layoutScore(score);
		const curveOp = layout.measures[0]!.ops.find((op) => op.kind === 'curve');
		expect(curveOp).toBeDefined();
		expect(curveOp!.kind).toBe('curve');

		const recorder = curveRecordingContext();
		new CanvasRenderer(recorder.ctx, layout).drawAll();

		expect(recorder.strokes).toHaveLength(1);
		if (curveOp!.kind === 'curve') {
			expect(recorder.strokes[0]).toEqual({
				x0: curveOp!.x0,
				y0: curveOp!.y0,
				cx0: curveOp!.cx0,
				cy0: curveOp!.cy0,
				cx1: curveOp!.cx1,
				cy1: curveOp!.cy1,
				x1: curveOp!.x1,
				y1: curveOp!.y1
			});
			expect(recorder.lineWidths).toEqual([curveOp!.thickness]);
		}
	});
});
