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

import { createCanvas } from 'canvas';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoScore } from '../demo-score.js';
import { layoutScore, relayoutMeasure } from '../layout/layout.js';
import { regionForMeasureBoundary } from '../layout/region-for-measure-boundary.js';
import { parsePitch } from '../model/pitch.js';
import { buildScore, Score } from '../model/score.js';
import type { NoteId } from '../model/score.js';
import type { DrawOp, LaidOutScore, Rect } from '../layout/types.js';
import { CanvasRenderer } from './renderer.js';
import { GLYPH_METRICS } from './glyph-metrics.js';

interface Recorded {
	readonly call: 'fillRect' | 'clearRect' | 'fillText' | 'curve';
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
		},
		// Curves (ties, slurs, hairpins: M6 Slice 6) are recorded as one call
		// spanning their start and end points.
		lineWidth: 1,
		strokeStyle: '',
		beginPath() {},
		stroke() {},
		moveTo(x: number, y: number) {
			calls.push({ call: 'curve', x, y, right: x, bottom: y });
		},
		bezierCurveTo(_a: number, _b: number, _c: number, _d: number, x: number, y: number) {
			const start = calls.pop()!;
			calls.push({ call: 'curve', x: Math.min(start.x, x), y: Math.min(start.y, y), right: Math.max(start.x, x), bottom: Math.max(start.y, y) });
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

describe('CanvasRenderer.setPlaybackCursor (M4 Slice 2)', () => {
	// Same 2D containment check the two describe blocks above already use,
	// needed here for the same reason: a two-staff fixture's staves overlap in
	// x, differing only in y.
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

	it('redraws both the old and new note\'s measures when the cursor moves between them', () => {
		// Mirrors "redraws both measures when a selection moves between them"
		// above, one note at a time: the diff shape is the same, just fed a
		// single-element array instead of a bare id.
		const score = createDemoScore();
		const layout = layoutScore(score);
		const renderer = new CanvasRenderer(recordingContext().ctx, layout);

		const from = layout.measures[0]!.notes[0]!.id;
		const to = layout.measures[2]!.notes[1]!.id;
		expect(renderer.setPlaybackCursor([from])).toEqual([{ staffIndex: 0, index: 0 }]);
		expect(renderer.setPlaybackCursor([to]).sort((a, b) => a.index - b.index)).toEqual([
			{ staffIndex: 0, index: 0 },
			{ staffIndex: 0, index: 2 }
		]);
	});

	it('unions every affected measure across staves for a simultaneous multi-note onset, and redrawing paints only those regions', () => {
		// A chord/multi-voice onset is several `OnsetEvent`s sharing one
		// `startSeconds` (see `OnsetEvent`'s own doc comment), so a host passes
		// `setPlaybackCursor` several note ids at once. This fixture spans both
		// staves, since that is exactly the case a single-staff score cannot
		// exercise.
		const score = twoStaffScore();
		const layout = layoutScore(score);
		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, layout);
		renderer.drawAll();
		recorder.calls.length = 0;

		// Seed a first cursor set so the chord's diff has an "old" measure to
		// drop as well as new ones to pick up, not just the latter.
		const first = score.staves[0]!.measures[0]!.notes[0]!.id;
		renderer.setPlaybackCursor([first]);

		const chordA = score.staves[0]!.measures[1]!.notes[0]!.id;
		const chordB = score.staves[1]!.measures[2]!.notes[0]!.id;
		const changed = renderer.setPlaybackCursor([chordA, chordB]);

		const expectedPairs = [
			{ staffIndex: 0, index: 0 }, // the outgoing (old) cursor set's measure
			{ staffIndex: 0, index: 1 }, // chordA's measure
			{ staffIndex: 1, index: 2 } // chordB's measure, the other staff
		];
		const sortPairs = (pairs: { staffIndex: number; index: number }[]) =>
			[...pairs].sort((a, b) => a.staffIndex - b.staffIndex || a.index - b.index);
		expect(sortPairs(changed)).toEqual(sortPairs(expectedPairs));

		for (const { staffIndex, index } of changed) renderer.redrawMeasure(index, staffIndex);

		const touchedRegions = expectedPairs.map(
			({ staffIndex, index }) => layout.measures.find((m) => m.staffIndex === staffIndex && m.index === index)!.region
		);
		expect(recorder.calls.length).toBeGreaterThan(0);
		for (const call of recorder.calls) {
			expect(touchedRegions.some((region) => withinBox(region, call))).toBe(true);
		}
		// Every other (staffIndex, index) pair, on either staff, sees no
		// intruding draw call.
		for (const m of layout.measures) {
			if (expectedPairs.some((p) => p.staffIndex === m.staffIndex && p.index === m.index)) continue;
			const intruders = recorder.calls.filter((call) => withinBox(m.region, call));
			expect(intruders).toEqual([]);
		}
	});

	it('a note both selected and cursor-highlighted renders with the cursor colour, not the selection colour', () => {
		// A narrower stub than `recordingContext`, since this test needs to know
		// which colour was active at each paint call, not just where it landed.
		// Kept local rather than folded into the shared stub for the same
		// reason `curveRecordingContext` below is kept local to its own suite.
		function styledRecordingContext(): { ctx: CanvasRenderingContext2D; styles: string[] } {
			const styles: string[] = [];
			const stub = {
				font: '',
				fillStyle: '',
				strokeStyle: '',
				textBaseline: 'alphabetic',
				fillRect() {
					styles.push(this.fillStyle);
				},
				clearRect() {},
				fillText() {
					styles.push(this.fillStyle);
				}
			};
			return { ctx: stub as unknown as CanvasRenderingContext2D, styles };
		}

		const score = createDemoScore();
		const layout = layoutScore(score);
		const recorder = styledRecordingContext();
		// Explicit, mutually distinguishable colours: the point of this test is
		// which exact string got used, so the defaults (which merely happen to
		// look different) would not prove anything.
		const renderer = new CanvasRenderer(recorder.ctx, layout, {
			foreground: '#000000',
			selection: '#ff00ff',
			playbackCursor: '#00ffff'
		});

		const noteId = layout.measures[0]!.notes[0]!.id;
		renderer.setSelection(noteId);
		renderer.setPlaybackCursor([noteId]);
		renderer.redrawMeasure(0);

		expect(recorder.styles).toContain('#00ffff');
		expect(recorder.styles).not.toContain('#ff00ff');
	});
});

describe('CanvasRenderer selection and playback cursor survive a rescale (M4 Slice 3)', () => {
	// A third local stub, alongside `recordingContext` and `styledRecordingContext`
	// above: this one needs both a call's colour and its coordinates in the same
	// record, since the point of this suite is "the *same note* keeps the *right
	// tint* once its ops have moved to new coordinates", which neither of the
	// other two stubs alone can show.
	function styledPositionRecordingContext(): {
		ctx: CanvasRenderingContext2D;
		calls: { x: number; y: number; style: string }[];
	} {
		const calls: { x: number; y: number; style: string }[] = [];
		const stub = {
			font: '',
			fillStyle: '',
			strokeStyle: '',
			textBaseline: 'alphabetic',
			fillRect(x: number, y: number) {
				calls.push({ x, y, style: this.fillStyle });
			},
			clearRect() {},
			fillText(_text: string, x: number, y: number) {
				calls.push({ x, y, style: this.fillStyle });
			}
		};
		return { ctx: stub as unknown as CanvasRenderingContext2D, calls };
	}

	/** Every op belonging to `id` that carries an `(x, y)` origin. Excludes
	 *  `curve` ops (ties/slurs), which use `(x0, y0)` instead: this demo score
	 *  has none on the notes under test, and the point here is comparing
	 *  origins across two layouts, not covering every op shape. */
	function opsWithOriginFor(layout: LaidOutScore, id: NoteId): Extract<DrawOp, { x: number; y: number }>[] {
		return layout.measures
			.flatMap((m) => m.ops)
			.filter((op): op is Extract<DrawOp, { x: number; y: number }> => op.kind !== 'curve' && op.noteId === id);
	}

	it('reapplies both tints to the same notes\' new draw ops after setLayout at a different staffSpacePx, with no new setSelection/setPlaybackCursor calls', () => {
		// staffSpacePx is "the single knob that scales the whole render" (see
		// `LayoutOptions.staffSpacePx`'s own doc comment): laying the same score
		// out again at a different value is mechanically a full zoom, and this
		// test's whole claim is that `#selectedNoteId`/`#playbackCursorNoteIds`
		// (keyed by `NoteId`, not by measure index or pixel position) go on
		// finding the right ops after that, with no call telling them to.
		const score = createDemoScore();
		const smallLayout = layoutScore(score, { staffSpacePx: 7 });

		const selectedNoteId = smallLayout.measures[0]!.notes[0]!.id;
		const cursorNoteId = smallLayout.measures[2]!.notes[1]!.id;

		const recorder = styledPositionRecordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, smallLayout, {
			foreground: '#000000',
			selection: '#ff00ff',
			playbackCursor: '#00ffff'
		});
		renderer.setSelection(selectedNoteId);
		renderer.setPlaybackCursor([cursorNoteId]);

		// The relayout-and-swap a zoom control performs: a fresh `layoutScore`
		// call at a different `staffSpacePx`, then `setLayout`. No further
		// `setSelection`/`setPlaybackCursor` call follows.
		const largeLayout = layoutScore(score, { staffSpacePx: 15 });
		renderer.setLayout(largeLayout);
		recorder.calls.length = 0;
		renderer.drawAll();

		const selectedOpsAtNewScale = opsWithOriginFor(largeLayout, selectedNoteId);
		const cursorOpsAtNewScale = opsWithOriginFor(largeLayout, cursorNoteId);
		expect(selectedOpsAtNewScale.length).toBeGreaterThan(0);
		expect(cursorOpsAtNewScale.length).toBeGreaterThan(0);

		// Every call painted at the selected note's *new*, large-scale
		// coordinates used the selection colour...
		for (const op of selectedOpsAtNewScale) {
			const call = recorder.calls.find((c) => c.x === op.x && c.y === op.y);
			expect(call?.style).toBe('#ff00ff');
		}
		// ...and every call at the cursor note's new coordinates used the cursor
		// colour: the tint followed the note to where it actually landed this
		// time, not to wherever it used to be.
		for (const op of cursorOpsAtNewScale) {
			const call = recorder.calls.find((c) => c.x === op.x && c.y === op.y);
			expect(call?.style).toBe('#00ffff');
		}

		// The two notes really did move: same note, a different `staffSpacePx`,
		// so its ops land at different coordinates. Without this, the assertions
		// above would pass just as well against a renderer that had silently
		// kept painting the stale, small-scale layout.
		const selectedOpsAtOldScale = opsWithOriginFor(smallLayout, selectedNoteId);
		expect(selectedOpsAtNewScale[0]!.x).not.toBeCloseTo(selectedOpsAtOldScale[0]!.x, 5);
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

describe('CanvasRenderer.setMeasureRange (M5 Slice 4)', () => {
	// Same 2D containment check the multi-staff blocks above use, for the same
	// reason: staff 1's measures share x ranges with staff 0's.
	const withinBox = (rect: Rect, point: { x: number; right: number; y: number; bottom: number }, slack = 0.001) =>
		point.x >= rect.x - slack &&
		point.right <= rect.x + rect.width + slack &&
		point.y >= rect.y - slack &&
		point.bottom <= rect.y + rect.height + slack;

	// Six measures per staff rather than the three the blocks above use, so a
	// range has room to grow, shrink and move disjointly without running off
	// the end of the staff.
	function twoStaffScore(): Score {
		const score = new Score({ keyFifths: 0 });
		score.appendStaff('bass');
		for (const staffIndex of [0, 1] as const) {
			for (let i = 0; i < 6; i++) {
				const measure = score.appendMeasure(staffIndex);
				for (const pitch of ['C4', 'D4', 'E4', 'F4']) {
					score.appendNote(measure, { pitch: parsePitch(pitch), value: 'quarter' });
				}
			}
		}
		return score;
	}

	const sortPairs = (pairs: { staffIndex: number; index: number }[]) =>
		[...pairs].sort((a, b) => a.staffIndex - b.staffIndex || a.index - b.index);
	const pairs = (staffIndex: number, indices: number[]) => indices.map((index) => ({ staffIndex, index }));

	let layout: LaidOutScore;
	let renderer: CanvasRenderer;

	beforeEach(() => {
		layout = layoutScore(twoStaffScore());
		renderer = new CanvasRenderer(recordingContext().ctx, layout);
	});

	it('setting a range from none returns every member measure', () => {
		expect(sortPairs(renderer.setMeasureRange({ staffIndex: 0, from: 1, to: 3 }))).toEqual(pairs(0, [1, 2, 3]));
		expect(renderer.measureRange).toEqual({ staffIndex: 0, from: 1, to: 3 });
	});

	it('growing returns only the measures that joined', () => {
		renderer.setMeasureRange({ staffIndex: 0, from: 1, to: 2 });
		expect(sortPairs(renderer.setMeasureRange({ staffIndex: 0, from: 1, to: 4 }))).toEqual(pairs(0, [3, 4]));
	});

	it('shrinking returns only the measures that left', () => {
		renderer.setMeasureRange({ staffIndex: 0, from: 0, to: 4 });
		expect(sortPairs(renderer.setMeasureRange({ staffIndex: 0, from: 2, to: 4 }))).toEqual(pairs(0, [0, 1]));
	});

	it('moving to an overlapping range returns only the symmetric difference', () => {
		renderer.setMeasureRange({ staffIndex: 0, from: 1, to: 3 });
		expect(sortPairs(renderer.setMeasureRange({ staffIndex: 0, from: 2, to: 4 }))).toEqual(pairs(0, [1, 4]));
	});

	it('moving to a disjoint range returns both the old and new members', () => {
		renderer.setMeasureRange({ staffIndex: 0, from: 0, to: 1 });
		expect(sortPairs(renderer.setMeasureRange({ staffIndex: 0, from: 4, to: 5 }))).toEqual(pairs(0, [0, 1, 4, 5]));
	});

	it('clearing to null returns every former member', () => {
		renderer.setMeasureRange({ staffIndex: 1, from: 2, to: 4 });
		expect(sortPairs(renderer.setMeasureRange(null))).toEqual(pairs(1, [2, 3, 4]));
		expect(renderer.measureRange).toBeNull();
		expect(renderer.setMeasureRange(null)).toEqual([]);
	});

	it('normalizes an out-of-order from/to', () => {
		expect(sortPairs(renderer.setMeasureRange({ staffIndex: 0, from: 4, to: 2 }))).toEqual(pairs(0, [2, 3, 4]));
		expect(renderer.measureRange).toEqual({ staffIndex: 0, from: 2, to: 4 });
		// The same range in the other order is the same range: nothing changes.
		expect(renderer.setMeasureRange({ staffIndex: 0, from: 2, to: 4 })).toEqual([]);
	});

	it("moving to another staff returns both staves' members, each with its own staffIndex", () => {
		renderer.setMeasureRange({ staffIndex: 0, from: 1, to: 2 });
		expect(sortPairs(renderer.setMeasureRange({ staffIndex: 1, from: 1, to: 2 }))).toEqual([
			...pairs(0, [1, 2]),
			...pairs(1, [1, 2])
		]);
	});

	it('setting the same range again returns nothing', () => {
		renderer.setMeasureRange({ staffIndex: 0, from: 1, to: 3 });
		expect(renderer.setMeasureRange({ staffIndex: 0, from: 1, to: 3 })).toEqual([]);
	});

	it('never returns measures that do not exist in the layout', () => {
		expect(sortPairs(renderer.setMeasureRange({ staffIndex: 0, from: 4, to: 99 }))).toEqual(pairs(0, [4, 5]));
	});

	it('redrawing the returned pairs touches only those measures\' regions', () => {
		const recorder = recordingContext();
		const scoped = new CanvasRenderer(recorder.ctx, layout);
		scoped.setMeasureRange({ staffIndex: 1, from: 1, to: 3 });
		scoped.drawAll();
		recorder.calls.length = 0;

		// An overlapping move on staff 1: measure 1 leaves, measure 4 joins, and
		// measures 2-3 (still members) must not repaint.
		const changed = scoped.setMeasureRange({ staffIndex: 1, from: 2, to: 4 });
		expect(sortPairs(changed)).toEqual(pairs(1, [1, 4]));
		for (const { staffIndex, index } of changed) scoped.redrawMeasure(index, staffIndex);

		const touchedRegions = changed.map(
			({ staffIndex, index }) => layout.measures.find((m) => m.staffIndex === staffIndex && m.index === index)!.region
		);
		expect(recorder.calls.length).toBeGreaterThan(0);
		for (const call of recorder.calls) {
			expect(touchedRegions.some((region) => withinBox(region, call))).toBe(true);
		}
		for (const m of layout.measures) {
			if (changed.some((p) => p.staffIndex === m.staffIndex && p.index === m.index)) continue;
			const intruders = recorder.calls.filter((call) => withinBox(m.region, call));
			expect(intruders).toEqual([]);
		}
	});

	it("paints the tint over a range measure's whole region, after the background and before its ink, and not on a non-range measure", () => {
		// Records each fillRect's colour and extent together, since this test
		// needs to know both that the tint was used and exactly where it went.
		const fills: { style: string; x: number; y: number; width: number; height: number }[] = [];
		const stub = {
			font: '',
			fillStyle: '',
			strokeStyle: '',
			textBaseline: 'alphabetic',
			fillRect(x: number, y: number, width: number, height: number) {
				fills.push({ style: this.fillStyle, x, y, width, height });
			},
			clearRect() {},
			fillText() {
				fills.push({ style: this.fillStyle, x: NaN, y: NaN, width: 0, height: 0 });
			}
		};
		const tint = 'rgba(1, 2, 3, 0.5)';
		const tinted = new CanvasRenderer(stub as unknown as CanvasRenderingContext2D, layout, {
			background: '#ffffff',
			foreground: '#000000',
			measureRange: tint
		});
		tinted.setMeasureRange({ staffIndex: 0, from: 1, to: 2 });

		const region = layout.measures.find((m) => m.staffIndex === 0 && m.index === 1)!.region;
		tinted.redrawMeasure(1, 0);
		expect(fills[0]).toEqual({ style: '#ffffff', ...region });
		expect(fills[1]).toEqual({ style: tint, ...region });
		expect(fills.slice(2).every((f) => f.style !== tint)).toBe(true);
		expect(fills.slice(2).some((f) => f.style === '#000000')).toBe(true);

		// Staff 1's same-numbered measure is not in the range: no tint.
		fills.length = 0;
		tinted.redrawMeasure(1, 1);
		expect(fills.some((f) => f.style === tint)).toBe(false);

		// drawAll tints exactly the two range measures.
		fills.length = 0;
		tinted.drawAll();
		const tintFills = fills.filter((f) => f.style === tint);
		const expected = layout.measures
			.filter((m) => m.staffIndex === 0 && (m.index === 1 || m.index === 2))
			.map((m) => ({ style: tint, ...m.region }));
		expect(tintFills).toEqual(expected);
	});
});

describe('CanvasRenderer.setSeamMarkers (M5 Slice 6)', () => {
	const SEAM = 'rgba(1, 2, 3, 0.5)';

	/** `recordingContext`, plus the fill style each `fillRect` was issued
	 *  with, so a seam strip's fill can be told apart from staff lines,
	 *  stems and barlines (all plain `fillRect`s too). */
	function styledRecordingContext(): {
		ctx: CanvasRenderingContext2D;
		calls: (Recorded & { readonly style: string })[];
	} {
		const calls: (Recorded & { readonly style: string })[] = [];
		const stub = {
			font: '',
			fillStyle: '',
			strokeStyle: '',
			textBaseline: 'alphabetic',
			fillRect(x: number, y: number, width: number, height: number) {
				calls.push({ call: 'fillRect', x, y, right: x + width, bottom: y + height, style: stub.fillStyle });
			},
			clearRect(x: number, y: number, width: number, height: number) {
				calls.push({ call: 'clearRect', x, y, right: x + width, bottom: y + height, style: '' });
			},
			fillText(_text: string, x: number, y: number) {
				calls.push({ call: 'fillText', x, y, right: x, bottom: y, style: stub.fillStyle });
			}
		};
		return { ctx: stub as unknown as CanvasRenderingContext2D, calls };
	}

	const withinBox = (rect: Rect, point: { x: number; right: number; y: number; bottom: number }, slack = 0.001) =>
		point.x >= rect.x - slack &&
		point.right <= rect.x + rect.width + slack &&
		point.y >= rect.y - slack &&
		point.bottom <= rect.y + rect.height + slack;

	const intersect = (a: Rect, b: Rect): Rect | null => {
		const x = Math.max(a.x, b.x);
		const y = Math.max(a.y, b.y);
		const right = Math.min(a.x + a.width, b.x + b.width);
		const bottom = Math.min(a.y + a.height, b.y + b.height);
		return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
	};

	let score: Score;
	let layout: LaidOutScore;
	let recorder: ReturnType<typeof styledRecordingContext>;
	let renderer: CanvasRenderer;

	beforeEach(() => {
		score = createDemoScore();
		layout = layoutScore(score);
		recorder = styledRecordingContext();
		renderer = new CanvasRenderer(recorder.ctx, layout, { seamMarker: SEAM });
	});

	it('drawAll paints one strip per marker, last, at regionForMeasureBoundary\'s rect', () => {
		renderer.setSeamMarkers([
			{ staffIndex: 0, boundaryIndex: 1 },
			{ staffIndex: 0, boundaryIndex: 4 }
		]);
		renderer.drawAll();
		const seamCalls = recorder.calls.filter((call) => call.style === SEAM);
		expect(seamCalls).toHaveLength(2);
		// The two seam fills are the very last calls: an overlay over all ink.
		expect(recorder.calls.slice(-2)).toEqual(seamCalls);
		const m1 = layout.measures[1]!.region;
		expect(seamCalls[0]!.x + (seamCalls[0]!.right - seamCalls[0]!.x) / 2).toBeCloseTo(m1.x, 6);
	});

	it('drops a boundary that does not exist in the layout without throwing', () => {
		renderer.setSeamMarkers([
			{ staffIndex: 0, boundaryIndex: 99 },
			{ staffIndex: 3, boundaryIndex: 0 }
		]);
		renderer.drawAll();
		expect(recorder.calls.filter((call) => call.style === SEAM)).toEqual([]);
		expect(renderer.seamMarkers).toHaveLength(2);
	});

	it('setSeamMarkers([]) clears them from the next drawAll', () => {
		renderer.setSeamMarkers([{ staffIndex: 0, boundaryIndex: 2 }]);
		renderer.drawAll();
		expect(recorder.calls.some((call) => call.style === SEAM)).toBe(true);

		renderer.setSeamMarkers([]);
		recorder.calls.length = 0;
		renderer.drawAll();
		expect(recorder.calls.some((call) => call.style === SEAM)).toBe(false);
		recorder.calls.length = 0;
		renderer.redrawMeasure(2);
		expect(recorder.calls.some((call) => call.style === SEAM)).toBe(false);
	});

	it("setting markers never changes any measure's region", () => {
		const before = renderer.layout.measures.map((m) => m.region);
		renderer.setSeamMarkers([
			{ staffIndex: 0, boundaryIndex: 0 },
			{ staffIndex: 0, boundaryIndex: 2 },
			{ staffIndex: 0, boundaryIndex: 4 }
		]);
		renderer.drawAll();
		expect(renderer.layout).toBe(layout);
		expect(renderer.layout.measures.map((m) => m.region)).toEqual(before);
		// And the same layout with no markers set lays out identically.
		expect(layoutScore(createDemoScore()).measures.map((m) => m.region)).toEqual(before);
	});

	it('transposing a note next to a seam and redrawing its measure repaints the seam inside that region, and only there', () => {
		// Seams on both sides of measure index 1: boundary 1 (its start) and
		// boundary 2 (its end barline, which measure 2's strip straddles).
		const seams = [
			{ staffIndex: 0, boundaryIndex: 1 },
			{ staffIndex: 0, boundaryIndex: 2 }
		];
		renderer.setSeamMarkers(seams);
		renderer.drawAll();
		recorder.calls.length = 0;

		const target = score.measures[1]!.notes[0]!;
		const touched = score.transposeNote(target.id, 1);
		expect(touched).toBe(1);
		const updated = relayoutMeasure(score, layout, touched!)!;
		renderer.setLayout(updated);
		renderer.redrawMeasure(touched!);

		const region = updated.measures[1]!.region;
		// Still scoped: every call, seam fills included, stays inside the region.
		expect(recorder.calls.length).toBeGreaterThan(0);
		for (const call of recorder.calls) expect(withinBox(region, call)).toBe(true);

		// Both strips' overlapping parts are repainted, exactly clipped to the
		// region, after the background clear and after every ink op.
		const expected = seams.map(({ boundaryIndex }) => {
			const strip = regionForMeasureBoundary(updated, 0, boundaryIndex)!;
			return intersect(strip, region)!;
		});
		const seamCalls = recorder.calls.filter((call) => call.style === SEAM);
		expect(seamCalls.map((c) => ({ x: c.x, y: c.y, width: c.right - c.x, height: c.bottom - c.y }))).toEqual(
			expected
		);
		expect(recorder.calls.slice(-seamCalls.length)).toEqual(seamCalls);
		expect(recorder.calls[0]!.style).not.toBe(SEAM);

		// The neighbours' halves of those strips were never cleared, so they
		// are never touched either.
		for (const other of [0, 2]) {
			const otherRegion = updated.measures[other]!.region;
			expect(recorder.calls.filter((c) => c.x < otherRegion.x + otherRegion.width && c.right > otherRegion.x)).toEqual(
				[]
			);
		}
	});

	it('markers follow setLayout to new geometry without another setSeamMarkers call', () => {
		renderer.setSeamMarkers([{ staffIndex: 0, boundaryIndex: 2 }]);
		const rescaled = layoutScore(score, { staffSpacePx: 20 });
		renderer.setLayout(rescaled);
		renderer.drawAll();
		const seamCall = recorder.calls.find((call) => call.style === SEAM)!;
		const strip = regionForMeasureBoundary(rescaled, 0, 2)!;
		expect(seamCall.x).toBeCloseTo(strip.x, 6);
		expect(seamCall.right).toBeCloseTo(strip.x + strip.width, 6);
	});
});

describe('CanvasRenderer seam markers survive a scoped redraw, in real pixels (M5 Slice 6)', () => {
	it("leaves every seam strip's pixels identical to a fresh whole-score draw after transposing a neighbouring note", () => {
		// The op-level test above proves which calls a scoped redraw issues; this
		// one proves what they add up to on a real rasterizer (node-canvas, the
		// same backend `redraw.bench.ts` uses). No music font is registered, so
		// glyphs fall back to a system font: irrelevant here, since only the
		// strips' own columns are compared and those hold barlines and seam fill.
		const score = createDemoScore();
		const layout = layoutScore(score);
		const seams = [
			{ staffIndex: 0, boundaryIndex: 1 },
			{ staffIndex: 0, boundaryIndex: 2 }
		];
		const width = Math.ceil(layout.width);
		const height = Math.ceil(layout.height);

		const scopedCanvas = createCanvas(width, height);
		const scoped = new CanvasRenderer(scopedCanvas.getContext('2d') as unknown as CanvasRenderingContext2D, layout);
		scoped.setSeamMarkers(seams);
		scoped.drawAll();

		const target = score.measures[1]!.notes[0]!;
		const touched = score.transposeNote(target.id, 1)!;
		const updated = relayoutMeasure(score, layout, touched)!;
		scoped.setLayout(updated);
		scoped.redrawMeasure(touched);

		const freshCanvas = createCanvas(width, height);
		const fresh = new CanvasRenderer(freshCanvas.getContext('2d') as unknown as CanvasRenderingContext2D, updated);
		fresh.setSeamMarkers(seams);
		fresh.drawAll();

		// Pixel rows/columns a measure region's *fractional* edge passes
		// through are skipped. A scoped redraw's background fill only partly
		// covers such a pixel, blending over whatever was already there, so
		// it never exactly matches a fresh draw even with no seams at all
		// (measured: up to ~40 levels at the left edge of the redrawn region
		// with zero markers set). That is pre-existing antialiasing slack of
		// region-scoped redraw itself, not something seams introduce.
		const edgeCols = new Set(updated.measures.flatMap((m) => [m.region.x, m.region.x + m.region.width].map(Math.floor)));
		const edgeRows = new Set(updated.measures.flatMap((m) => [m.region.y, m.region.y + m.region.height].map(Math.floor)));

		for (const { boundaryIndex } of seams) {
			const strip = regionForMeasureBoundary(updated, 0, boundaryIndex)!;
			const x = Math.floor(strip.x);
			const y = Math.floor(strip.y);
			const w = Math.ceil(strip.x + strip.width) - x;
			const h = Math.ceil(strip.y + strip.height) - y;
			const a = scopedCanvas.getContext('2d').getImageData(x, y, w, h).data;
			const b = freshCanvas.getContext('2d').getImageData(x, y, w, h).data;
			// The strip is actually there: a staff-gap pixel just right of the
			// boundary is red-tinted, not plain white background.
			const probe = ((Math.floor(h / 2) + 2) * w + w - 2) * 4;
			expect(b[probe]! - b[probe + 2]!).toBeGreaterThan(50);
			// And the scoped redraw left every other strip pixel exactly as a
			// whole-score draw paints it.
			let compared = 0;
			for (let row = 0; row < h; row++) {
				if (edgeRows.has(y + row)) continue;
				for (let col = 0; col < w; col++) {
					if (edgeCols.has(x + col)) continue;
					const i = (row * w + col) * 4;
					for (let channel = 0; channel < 4; channel++) expect(a[i + channel]).toBe(b[i + channel]);
					compared++;
				}
			}
			expect(compared).toBeGreaterThan(w * h * 0.5);
		}
	});
});

describe('CanvasRenderer: articulations and fermatas in a scoped redraw (M6 Slice 5)', () => {
	it('repaints a note\'s fermata and accent inside its measure\'s cleared region after an edit', () => {
		const score = buildScore(
			[[['C5', 'whole']], [['G5', 'whole', { articulations: ['accent'], fermata: 'upright' }]], [['C5', 'whole']]],
			{ keyFifths: 0 }
		);
		const layout = layoutScore(score);
		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, layout);
		renderer.drawAll();
		recorder.calls.length = 0;

		const target = score.measures[1]!.notes[0]!;
		const touched = score.transposeNote(target.id, 2);
		const updated = relayoutMeasure(score, layout, touched!);
		expect(updated).not.toBeNull();
		renderer.setLayout(updated!);
		renderer.redrawMeasure(touched!);

		const measure = updated!.measures[1]!;
		const marks = measure.ops.filter(
			(op): op is Extract<DrawOp, { kind: 'glyph' }> =>
				op.kind === 'glyph' && (op.glyph.startsWith('artic') || op.glyph.startsWith('fermata'))
		);
		expect(marks.map((op) => op.glyph)).toEqual(['articAccentAbove', 'fermataAbove']);
		const clear = recorder.calls[0]!;
		for (const op of marks) {
			// Painted by this redraw...
			expect(recorder.calls.some((call) => call.call === 'fillText' && call.x === op.x && call.y === op.y)).toBe(true);
			// ...entirely inside the area it cleared first.
			const { bBoxSW, bBoxNE } = GLYPH_METRICS[op.glyph];
			expect(op.y - bBoxNE[1] * updated!.staffSpacePx).toBeGreaterThanOrEqual(clear.y);
			expect(op.y - bBoxSW[1] * updated!.staffSpacePx).toBeLessThanOrEqual(clear.bottom);
			expect(within(measure.region, { ...clear, x: op.x, right: op.x + bBoxNE[0] * updated!.staffSpacePx })).toBe(true);
		}
	});
});

describe('CanvasRenderer: dynamics and hairpins in a scoped redraw (M6 Slice 6)', () => {
	it('repaints exactly its own piece of a hairpin crossing three measures, and its dynamic', () => {
		const score = buildScore(
			[
				[['C5', 'half'], ['D5', 'half']],
				{ notes: [['E5', 'half'], ['F5', 'half']], dynamics: [{ kind: 'mp', onset: 0.5 }] },
				[['G5', 'half'], ['A5', 'half']]
			],
			{ keyFifths: 0 },
			[],
			[{ kind: 'crescendo', start: [0, 0], stop: [2, 0.5] }]
		);
		const layout = layoutScore(score);
		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, layout);
		renderer.drawAll();
		const curvesOf = (index: number) =>
			layout.measures[index]!.ops.filter((op): op is Extract<DrawOp, { kind: 'curve' }> => op.kind === 'curve');
		// Two lines per measure, and the pieces abut at each barline: one wedge.
		for (const index of [0, 1, 2]) expect(curvesOf(index)).toHaveLength(2);
		expect(curvesOf(0)[0]!.x1).toBeCloseTo(curvesOf(1)[0]!.x0, 6);
		expect(curvesOf(0)[0]!.y1).toBeCloseTo(curvesOf(1)[0]!.y0, 6);
		expect(curvesOf(1)[1]!.x1).toBeCloseTo(curvesOf(2)[1]!.x0, 6);

		for (const index of [0, 1, 2]) {
			recorder.calls.length = 0;
			// A transpose in the middle measure goes through the scoped path too.
			if (index === 1) {
				const touched = score.transposeNote(score.measures[1]!.notes[0]!.id, 1)!;
				const updated = relayoutMeasure(score, renderer.layout, touched);
				expect(updated).not.toBeNull();
				renderer.setLayout(updated!);
			}
			renderer.redrawMeasure(index);
			const measure = renderer.layout.measures[index]!;
			const clear = recorder.calls[0]!;
			const painted = recorder.calls.filter((call) => call.call === 'curve');
			const own = measure.ops.filter((op) => op.kind === 'curve');
			// Every curve this measure owns (its two hairpin lines) was repainted,
			// all inside the area it cleared.
			expect(painted).toHaveLength(own.length);
			for (const call of painted) {
				expect(within(measure.region, call)).toBe(true);
				expect(call.y).toBeGreaterThanOrEqual(clear.y);
				expect(call.bottom).toBeLessThanOrEqual(clear.bottom);
			}
			if (index === 1) {
				const dynamic = measure.ops.find((op) => op.kind === 'glyph' && op.glyph === 'dynamicMP')!;
				expect(dynamic).toBeDefined();
				expect(
					recorder.calls.some(
						(call) => call.call === 'fillText' && dynamic.kind === 'glyph' && call.x === dynamic.x && call.y === dynamic.y
					)
				).toBe(true);
			}
		}
	});
});

describe('CanvasRenderer: lyrics in a scoped redraw (M6 Slice 9)', () => {
	it('repaints a measure\'s syllables and its pieces of a hyphen and an extender, inside its region', () => {
		const score = buildScore([
			[['C5', 'half', { lyrics: [{ text: 'Hal', syllabic: 'begin' }] }], ['D5', 'half']],
			[['E5', 'whole']],
			[['F5', 'half', { lyrics: [{ text: 'le', syllabic: 'end' }] }], ['G5', 'half', { lyrics: [{ text: 'sing', extend: 'start' }] }]],
			[['A5', 'whole']],
			[['B5', 'whole', { lyrics: [{ text: 'on' }] }]]
		]);
		const layout = layoutScore(score);
		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, layout);
		renderer.drawAll();
		const lyricInk = (index: number) =>
			renderer.layout.measures[index]!.ops.filter(
				(op) => op.kind === 'text' || (op.kind === 'rect' && op.y > renderer.layout.staffTopY + 6 * renderer.layout.staffSpacePx)
			);
		// The hyphen run crosses measure 2, and the extender reaches measure 4.
		expect(lyricInk(1).length).toBeGreaterThan(0);
		expect(lyricInk(3).length).toBeGreaterThan(0);

		for (const index of [0, 1, 2, 3, 4]) {
			recorder.calls.length = 0;
			if (index === 2) {
				// A transpose on the sung F5 goes through the scoped path.
				const touched = score.transposeNote(score.measures[2]!.notes[0]!.id, -1)!;
				const updated = relayoutMeasure(score, renderer.layout, touched);
				expect(updated).not.toBeNull();
				renderer.setLayout(updated!);
			}
			renderer.redrawMeasure(index);
			const measure = renderer.layout.measures[index]!;
			const clear = recorder.calls[0]!;
			for (const op of lyricInk(index)) {
				if (op.kind === 'text') {
					// Painted by this redraw, its baseline inside the cleared area.
					expect(recorder.calls.some((call) => call.call === 'fillText' && call.x === op.x && call.y === op.y)).toBe(true);
					expect(op.y - op.fontSizePx).toBeGreaterThanOrEqual(clear.y);
					expect(op.y + 0.3 * op.fontSizePx).toBeLessThanOrEqual(clear.bottom);
					expect(within(measure.region, { ...clear, x: op.x, right: op.x })).toBe(true);
				} else if (op.kind === 'rect') {
					const painted = recorder.calls.find((call) => call.call === 'fillRect' && call.x === op.x && call.y === op.y);
					expect(painted).toBeDefined();
					expect(within(measure.region, painted!)).toBe(true);
					expect(painted!.bottom).toBeLessThanOrEqual(clear.bottom);
				}
			}
		}
	});
});
