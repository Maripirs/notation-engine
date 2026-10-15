// The Phase 0 proof: an edit repaints one measure's region and nothing else.
//
// This is deliberately not a timing test. A wall-clock number proves a redraw
// was fast, not that it was *scoped*. Timings live in `redraw.bench.ts`; this
// file asserts the property that makes those timings mean something, and runs
// anywhere with no canvas at all.
//
// The recording context below is why no canvas is needed: it writes down the
// extent and style of every paint call, which is a complete record of which
// pixels the renderer would have touched.

import { createCanvas } from 'canvas';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoScore, createFullDemoScore } from '../demo-score.js';
import { layoutScore, relayoutMeasure, type LayoutOptions } from '../layout/layout.js';
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
	readonly style: string;
	readonly lineWidth?: number;
}

/** A context stub recording every paint call, in canvas coordinates (after
 *  any `translate`, so a viewport's offset shows up in what is recorded). A
 *  curve (tie, slur, hairpin) is one call spanning its start and end points. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Recorded[] } {
	const calls: Recorded[] = [];
	let dx = 0;
	let dy = 0;
	const saved: [number, number][] = [];
	const stub = {
		font: '',
		fillStyle: '',
		strokeStyle: '',
		lineWidth: 1,
		textBaseline: 'alphabetic',
		save() {
			saved.push([dx, dy]);
		},
		restore() {
			[dx, dy] = saved.pop() ?? [0, 0];
		},
		translate(x: number, y: number) {
			dx += x;
			dy += y;
		},
		fillRect(x: number, y: number, width: number, height: number) {
			calls.push({ call: 'fillRect', x: x + dx, y: y + dy, right: x + dx + width, bottom: y + dy + height, style: stub.fillStyle });
		},
		clearRect(x: number, y: number, width: number, height: number) {
			calls.push({ call: 'clearRect', x: x + dx, y: y + dy, right: x + dx + width, bottom: y + dy + height, style: '' });
		},
		fillText(_text: string, x: number, y: number) {
			calls.push({ call: 'fillText', x: x + dx, y: y + dy, right: x + dx, bottom: y + dy, style: stub.fillStyle });
		},
		beginPath() {},
		stroke() {},
		moveTo(x: number, y: number) {
			calls.push({ call: 'curve', x: x + dx, y: y + dy, right: x + dx, bottom: y + dy, style: stub.strokeStyle });
		},
		bezierCurveTo(_a: number, _b: number, _c: number, _d: number, x: number, y: number) {
			const start = calls.pop()!;
			x += dx;
			y += dy;
			calls.push({
				call: 'curve',
				x: Math.min(start.x, x),
				y: Math.min(start.y, y),
				right: Math.max(start.x, x),
				bottom: Math.max(start.y, y),
				style: stub.strokeStyle,
				lineWidth: stub.lineWidth
			});
		}
	};
	return { ctx: stub as unknown as CanvasRenderingContext2D, calls };
}

type Box = { x: number; right: number; y: number; bottom: number };
type Pair = { staffIndex: number; index: number };

const withinBox = (rect: Rect, point: Box, slack = 0.001) =>
	point.x >= rect.x - slack &&
	point.right <= rect.x + rect.width + slack &&
	point.y >= rect.y - slack &&
	point.bottom <= rect.y + rect.height + slack;

const regionOf = (layout: LaidOutScore, staffIndex: number, index: number) =>
	layout.measures.find((m) => m.staffIndex === staffIndex && m.index === index)!.region;

const sortPairs = (pairs: readonly Pair[]) => [...pairs].sort((a, b) => a.staffIndex - b.staffIndex || a.index - b.index);
const pairs = (staffIndex: number, indices: number[]) => indices.map((index) => ({ staffIndex, index }));

/** The core guarantee: some ink was painted, all of it inside `touched`'s
 *  regions, and none of it inside any other measure's region. 2D, since
 *  later staves and systems share x ranges with earlier ones. */
function expectScopedTo(calls: readonly Recorded[], layout: LaidOutScore, touched: readonly Pair[]): void {
	const isTouched = (m: Pair) => touched.some((p) => p.staffIndex === m.staffIndex && p.index === m.index);
	const regions = touched.map(({ staffIndex, index }) => regionOf(layout, staffIndex, index));
	expect(calls.length).toBeGreaterThan(0);
	for (const call of calls) expect(regions.some((region) => withinBox(region, call))).toBe(true);
	for (const m of layout.measures) {
		if (isTouched(m)) continue;
		expect(calls.filter((call) => withinBox(m.region, call))).toEqual([]);
	}
}

/** Two staves (treble, bass) of `measures` four-quarter measures each, so
 *  staff-local measure indices collide across staves. */
function twoStaffScore(measures = 3): Score {
	const score = new Score({ keyFifths: 0 });
	score.appendStaff('bass');
	for (const staffIndex of [0, 1] as const) {
		for (let i = 0; i < measures; i++) {
			const measure = score.appendMeasure(staffIndex);
			for (const pitch of ['C4', 'D4', 'E4', 'F4']) {
				score.appendNote(measure, { pitch: parsePitch(pitch), value: 'quarter' });
			}
		}
	}
	return score;
}

/** Lays out, paints everything once, then forgets those calls. */
function painted(score: Score, layoutOptions: LayoutOptions = {}) {
	const layout = layoutScore(score, layoutOptions);
	const recorder = recordingContext();
	const renderer = new CanvasRenderer(recorder.ctx, layout);
	renderer.drawAll();
	recorder.calls.length = 0;
	return { layout, recorder, renderer };
}

/** The whole edit loop: mutate the model, re-lay-out only the touched
 *  measure, repaint only that measure. Returns the updated layout. */
function transposeAndRedraw(
	score: Score,
	renderer: CanvasRenderer,
	staffIndex: number,
	index: number,
	semitones = 1,
	layoutOptions: LayoutOptions = {}
): LaidOutScore {
	const target = score.staves[staffIndex]!.measures[index]!.notes[0]!;
	const touched = score.transposeNote(target.id, semitones);
	expect(touched).toBe(index);
	const updated = relayoutMeasure(score, renderer.layout, touched!, layoutOptions, staffIndex);
	expect(updated).not.toBeNull();
	renderer.setLayout(updated!);
	renderer.redrawMeasure(touched!, staffIndex);
	return updated!;
}

describe('CanvasRenderer region-scoped redraw', () => {
	it('reports every measure for a full redraw', () => {
		const { renderer } = painted(createDemoScore());
		renderer.drawAll();
		expect(renderer.lastRedrawnMeasures).toEqual([0, 1, 2, 3]);
	});

	it.each([
		// Measure indices are 0-based: index 1 is "measure 2" of the demo score.
		{ name: 'one system', build: createDemoScore, options: {}, staffIndex: 0, index: 1 },
		// Index 2 opens the second system at this width, so this also covers
		// re-laying-out a system-first measure incrementally.
		{ name: 'multiple systems', build: createDemoScore, options: { systemWidthPx: 600 }, staffIndex: 0, index: 2 },
		// Staff 1's measure 1 collides by index with staff 0's own measure 1.
		{ name: 'two staves', build: () => twoStaffScore(), options: {}, staffIndex: 1, index: 1 }
	])('a transpose redraws only the touched measure ($name)', ({ build, options, staffIndex, index }) => {
		const score = build();
		const { layout, recorder, renderer } = painted(score, options);
		if (options.systemWidthPx) expect(layout.systems.length).toBeGreaterThan(1);

		const updated = transposeAndRedraw(score, renderer, staffIndex, index, 1, options);

		expect(renderer.lastRedrawnMeasures).toEqual([index]);
		expect(renderer.lastRedrawnRegions).toEqual([regionOf(updated, staffIndex, index)]);
		expectScopedTo(recorder.calls, updated, [{ staffIndex, index }]);
	});

	it('actually changes what it paints when the model changed', () => {
		// Guards the scoped tests against passing for the wrong reason: a
		// renderer that drew nothing would also touch no neighbouring measure.
		const score = createDemoScore();
		const { recorder, renderer } = painted(score);
		renderer.redrawMeasure(1);
		const baseline = recorder.calls.map((call) => call.y);
		recorder.calls.length = 0;
		transposeAndRedraw(score, renderer, 0, 1);
		expect(recorder.calls.map((call) => call.y)).not.toEqual(baseline);
	});

	it.each([
		{ background: undefined, clearCall: 'fillRect' },
		{ background: null, clearCall: 'clearRect' }
	] as const)('clears the whole region first with $clearCall (background $background)', ({ background, clearCall }) => {
		// Without the clear, a note moving down a step would leave its old
		// notehead behind.
		const layout = layoutScore(createDemoScore());
		const recorder = recordingContext();
		new CanvasRenderer(recorder.ctx, layout, background === null ? { background } : {}).redrawMeasure(2);
		const first = recorder.calls[0]!;
		const region = layout.measures[2]!.region;
		expect(first.call).toBe(clearCall);
		expect(first.x).toBeLessThanOrEqual(region.x);
		expect(first.right).toBeGreaterThanOrEqual(region.x + region.width);
	});

	it('costs the same per edit whatever the score length', () => {
		// Not "fast" but "constant": draw calls for a one-measure repaint must
		// not depend on how many measures exist.
		const callsForOneMeasure = (measureCount: number) => {
			const long = createDemoScore();
			while (long.measures.length < measureCount) {
				const source = long.measures[long.measures.length % 4]!;
				const copy = long.appendMeasure();
				for (const note of source.notes) long.appendNote(copy, { pitch: note.pitch, value: note.value });
			}
			const probe = recordingContext();
			new CanvasRenderer(probe.ctx, layoutScore(long)).redrawMeasure(1);
			return probe.calls.length;
		};
		expect(callsForOneMeasure(40)).toBe(callsForOneMeasure(4));
	});
});

describe('CanvasRenderer selection and playback cursor', () => {
	it.each([
		{ name: 'setSelection', set: (r: CanvasRenderer, id: NoteId) => r.setSelection(id) },
		{ name: 'setPlaybackCursor', set: (r: CanvasRenderer, id: NoteId) => r.setPlaybackCursor([id]) }
	])('$name moving between measures reports both measures', ({ set }) => {
		const { layout, renderer } = painted(createDemoScore());
		const from = layout.measures[0]!.notes[0]!.id;
		const to = layout.measures[2]!.notes[1]!.id;
		expect(set(renderer, from)).toEqual(pairs(0, [0]));
		expect(sortPairs(set(renderer, to))).toEqual(pairs(0, [0, 2]));
	});

	it("setSelection on a lower staff returns that staff's (staffIndex, index), and redrawing it stays on that staff", () => {
		const score = twoStaffScore();
		const { layout, recorder, renderer } = painted(score);
		const changed = renderer.setSelection(score.staves[1]!.measures[1]!.notes[0]!.id);
		expect(changed).toEqual([{ staffIndex: 1, index: 1 }]);
		for (const { staffIndex, index } of changed) renderer.redrawMeasure(index, staffIndex);
		expectScopedTo(recorder.calls, layout, changed);
	});

	it('a multi-note cursor onset unions every affected measure across staves, and redrawing paints only those', () => {
		// A chord/multi-voice onset is several events sharing one startSeconds,
		// so a host passes several note ids at once.
		const score = twoStaffScore();
		const { layout, recorder, renderer } = painted(score);
		renderer.setPlaybackCursor([score.staves[0]!.measures[0]!.notes[0]!.id]);
		const changed = renderer.setPlaybackCursor([
			score.staves[0]!.measures[1]!.notes[0]!.id,
			score.staves[1]!.measures[2]!.notes[0]!.id
		]);
		// The outgoing cursor's measure, plus each new note's measure.
		const expected = [...pairs(0, [0, 1]), ...pairs(1, [2])];
		expect(sortPairs(changed)).toEqual(expected);
		for (const { staffIndex, index } of changed) renderer.redrawMeasure(index, staffIndex);
		expectScopedTo(recorder.calls, layout, expected);
	});

	const colours = { foreground: '#000000', selection: '#ff00ff', playbackCursor: '#00ffff' };

	it('a note both selected and cursor-highlighted renders with the cursor colour', () => {
		const layout = layoutScore(createDemoScore());
		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, layout, colours);
		const noteId = layout.measures[0]!.notes[0]!.id;
		renderer.setSelection(noteId);
		renderer.setPlaybackCursor([noteId]);
		renderer.redrawMeasure(0);
		const styles = recorder.calls.map((call) => call.style);
		expect(styles).toContain(colours.playbackCursor);
		expect(styles).not.toContain(colours.selection);
	});

	it('both tints follow their notes to new coordinates after setLayout at a different staffSpacePx', () => {
		// Selection and cursor are keyed by NoteId, so a zoom (fresh layout at
		// another staffSpacePx, then setLayout) needs no further calls.
		const score = createDemoScore();
		const small = layoutScore(score, { staffSpacePx: 7 });
		const selected = small.measures[0]!.notes[0]!.id;
		const cursor = small.measures[2]!.notes[1]!.id;
		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, small, colours);
		renderer.setSelection(selected);
		renderer.setPlaybackCursor([cursor]);

		const large = layoutScore(score, { staffSpacePx: 15 });
		renderer.setLayout(large);
		recorder.calls.length = 0;
		renderer.drawAll();

		const opsFor = (layout: LaidOutScore, id: NoteId) =>
			layout.measures
				.flatMap((m) => m.ops)
				.filter((op): op is Extract<DrawOp, { x: number; y: number }> => op.kind !== 'curve' && op.noteId === id);
		for (const [id, colour] of [
			[selected, colours.selection],
			[cursor, colours.playbackCursor]
		] as const) {
			const ops = opsFor(large, id);
			expect(ops.length).toBeGreaterThan(0);
			for (const op of ops) {
				expect(recorder.calls.find((c) => c.x === op.x && c.y === op.y)?.style).toBe(colour);
			}
		}
		// The note really moved, or the above would pass against a stale layout.
		expect(opsFor(large, selected)[0]!.x).not.toBeCloseTo(opsFor(small, selected)[0]!.x, 5);
	});
});

describe('CanvasRenderer painting part decorations and ties', () => {
	it('drawAll paints a brace/bracket and its part-name label; redrawMeasure never repaints them', () => {
		const score = new Score({ keyFifths: 0 });
		score.appendStaff('bass');
		score.addPart([0, 1], 'Piano');
		for (const staffIndex of [0, 1] as const) {
			score.appendNote(score.appendMeasure(staffIndex), { pitch: parsePitch('C4'), value: 'quarter' });
		}
		const layout = layoutScore(score);
		const recorder = recordingContext();
		const renderer = new CanvasRenderer(recorder.ctx, layout);
		renderer.drawAll();

		const label = layout.partDecorations.find((op) => op.kind === 'text')!;
		expect(label).toBeDefined();
		expect(recorder.calls.some((call) => call.call === 'fillText' && Math.abs(call.x - label.x) < 0.001)).toBe(true);

		recorder.calls.length = 0;
		renderer.redrawMeasure(0);
		const decorationXs = new Set(layout.partDecorations.flatMap((op) => (op.kind === 'curve' ? [] : [op.x])));
		expect(recorder.calls.some((call) => decorationXs.has(call.x))).toBe(false);
	});

	it("strokes a tie's curve between its endpoints, using the op's own thickness", () => {
		const layout = layoutScore(buildScore([[['C4', 'quarter', { tiedToNext: true }], ['C4', 'quarter']]]));
		const tie = layout.measures[0]!.ops.find((op): op is Extract<DrawOp, { kind: 'curve' }> => op.kind === 'curve')!;
		expect(tie).toBeDefined();
		const recorder = recordingContext();
		new CanvasRenderer(recorder.ctx, layout).drawAll();
		const curves = recorder.calls.filter((call) => call.call === 'curve');
		expect(curves).toHaveLength(1);
		expect(curves[0]).toMatchObject({ x: Math.min(tie.x0, tie.x1), right: Math.max(tie.x0, tie.x1), lineWidth: tie.thickness });
	});
});

describe('CanvasRenderer.setMeasureRange (M5 Slice 4)', () => {
	// Six measures per staff, so a range can grow, shrink and move disjointly.
	let layout: LaidOutScore;
	let renderer: CanvasRenderer;
	let recorder: ReturnType<typeof recordingContext>;

	beforeEach(() => {
		({ layout, renderer, recorder } = painted(twoStaffScore(6)));
	});

	type Range = { staffIndex: number; from: number; to: number } | null;
	it.each<{ name: string; from: Range; to: Range; changed: Pair[] }>([
		{ name: 'setting from none returns every member', from: null, to: { staffIndex: 0, from: 1, to: 3 }, changed: pairs(0, [1, 2, 3]) },
		{ name: 'growing returns only joiners', from: { staffIndex: 0, from: 1, to: 2 }, to: { staffIndex: 0, from: 1, to: 4 }, changed: pairs(0, [3, 4]) },
		{ name: 'shrinking returns only leavers', from: { staffIndex: 0, from: 0, to: 4 }, to: { staffIndex: 0, from: 2, to: 4 }, changed: pairs(0, [0, 1]) },
		{ name: 'overlapping move returns the symmetric difference', from: { staffIndex: 0, from: 1, to: 3 }, to: { staffIndex: 0, from: 2, to: 4 }, changed: pairs(0, [1, 4]) },
		{ name: 'disjoint move returns old and new', from: { staffIndex: 0, from: 0, to: 1 }, to: { staffIndex: 0, from: 4, to: 5 }, changed: pairs(0, [0, 1, 4, 5]) },
		{ name: 'clearing returns every former member', from: { staffIndex: 1, from: 2, to: 4 }, to: null, changed: pairs(1, [2, 3, 4]) },
		{ name: 'clearing when already clear returns nothing', from: null, to: null, changed: [] },
		{ name: 'out-of-order from/to is normalized', from: null, to: { staffIndex: 0, from: 4, to: 2 }, changed: pairs(0, [2, 3, 4]) },
		{ name: 'the same range in the other order is unchanged', from: { staffIndex: 0, from: 4, to: 2 }, to: { staffIndex: 0, from: 2, to: 4 }, changed: [] },
		{ name: 'the same range again returns nothing', from: { staffIndex: 0, from: 1, to: 3 }, to: { staffIndex: 0, from: 1, to: 3 }, changed: [] },
		{ name: 'moving staff returns both staves', from: { staffIndex: 0, from: 1, to: 2 }, to: { staffIndex: 1, from: 1, to: 2 }, changed: [...pairs(0, [1, 2]), ...pairs(1, [1, 2])] },
		{ name: 'never returns measures beyond the layout', from: null, to: { staffIndex: 0, from: 4, to: 99 }, changed: pairs(0, [4, 5]) }
	])('$name', ({ from, to, changed }) => {
		renderer.setMeasureRange(from);
		expect(sortPairs(renderer.setMeasureRange(to))).toEqual(changed);
		expect(renderer.measureRange).toEqual(to && { staffIndex: to.staffIndex, from: Math.min(to.from, to.to), to: Math.max(to.from, to.to) });
	});

	it("redrawing the returned pairs touches only those measures' regions", () => {
		renderer.setMeasureRange({ staffIndex: 1, from: 1, to: 3 });
		const changed = renderer.setMeasureRange({ staffIndex: 1, from: 2, to: 4 });
		for (const { staffIndex, index } of changed) renderer.redrawMeasure(index, staffIndex);
		expectScopedTo(recorder.calls, layout, changed);
	});

	it("tints a range measure's whole region after the background and before its ink, and nowhere else", () => {
		const tint = 'rgba(1, 2, 3, 0.5)';
		const rec = recordingContext();
		const tinted = new CanvasRenderer(rec.ctx, layout, { background: '#ffffff', foreground: '#000000', measureRange: tint });
		tinted.setMeasureRange({ staffIndex: 0, from: 1, to: 2 });
		const covers = (call: Recorded, r: Rect) =>
			call.x === r.x && call.y === r.y && call.right === r.x + r.width && call.bottom === r.y + r.height;
		const fills = () => rec.calls.filter((call) => call.call !== 'clearRect');

		tinted.redrawMeasure(1, 0);
		const [background, tintFill, ...ink] = fills();
		expect(background!.style).toBe('#ffffff');
		expect(covers(background!, regionOf(layout, 0, 1))).toBe(true);
		expect(tintFill!.style).toBe(tint);
		expect(covers(tintFill!, regionOf(layout, 0, 1))).toBe(true);
		expect(ink.every((f) => f.style !== tint)).toBe(true);
		expect(ink.some((f) => f.style === '#000000')).toBe(true);

		// Staff 1's same-numbered measure is not in the range.
		rec.calls.length = 0;
		tinted.redrawMeasure(1, 1);
		expect(fills().some((f) => f.style === tint)).toBe(false);

		rec.calls.length = 0;
		tinted.drawAll();
		const tintFills = fills().filter((f) => f.style === tint);
		expect(tintFills).toHaveLength(2);
		[1, 2].forEach((index, i) => expect(covers(tintFills[i]!, regionOf(layout, 0, index))).toBe(true));
	});
});

describe('CanvasRenderer.setSeamMarkers (M5 Slice 6)', () => {
	const SEAM = 'rgba(1, 2, 3, 0.5)';
	const seamCalls = (calls: readonly Recorded[]) => calls.filter((call) => call.style === SEAM);

	let score: Score;
	let layout: LaidOutScore;
	let recorder: ReturnType<typeof recordingContext>;
	let renderer: CanvasRenderer;

	beforeEach(() => {
		score = createDemoScore();
		layout = layoutScore(score);
		recorder = recordingContext();
		renderer = new CanvasRenderer(recorder.ctx, layout, { seamMarker: SEAM });
	});

	it('drawAll paints one strip per marker, last, centred on the boundary, without moving any region', () => {
		const regions = layout.measures.map((m) => m.region);
		renderer.setSeamMarkers([
			{ staffIndex: 0, boundaryIndex: 1 },
			{ staffIndex: 0, boundaryIndex: 4 }
		]);
		renderer.drawAll();
		const seams = seamCalls(recorder.calls);
		expect(seams).toHaveLength(2);
		expect(recorder.calls.slice(-2)).toEqual(seams);
		expect((seams[0]!.x + seams[0]!.right) / 2).toBeCloseTo(layout.measures[1]!.region.x, 6);
		expect(renderer.layout.measures.map((m) => m.region)).toEqual(regions);
	});

	it('drops a boundary that does not exist in the layout without throwing', () => {
		renderer.setSeamMarkers([
			{ staffIndex: 0, boundaryIndex: 99 },
			{ staffIndex: 3, boundaryIndex: 0 }
		]);
		renderer.drawAll();
		expect(seamCalls(recorder.calls)).toEqual([]);
		expect(renderer.seamMarkers).toHaveLength(2);
	});

	it('setSeamMarkers([]) clears them from the next drawAll and redrawMeasure', () => {
		renderer.setSeamMarkers([{ staffIndex: 0, boundaryIndex: 2 }]);
		renderer.setSeamMarkers([]);
		renderer.drawAll();
		renderer.redrawMeasure(2);
		expect(seamCalls(recorder.calls)).toEqual([]);
	});

	it('a scoped redraw beside two seams repaints their in-region parts, clipped and last, and nothing outside', () => {
		const seams = [
			{ staffIndex: 0, boundaryIndex: 1 },
			{ staffIndex: 0, boundaryIndex: 2 }
		];
		renderer.setSeamMarkers(seams);
		renderer.drawAll();
		recorder.calls.length = 0;

		const updated = transposeAndRedraw(score, renderer, 0, 1);
		expectScopedTo(recorder.calls, updated, [{ staffIndex: 0, index: 1 }]);

		const region = updated.measures[1]!.region;
		const intersect = (a: Rect, b: Rect): Rect => {
			const x = Math.max(a.x, b.x);
			const y = Math.max(a.y, b.y);
			return { x, y, width: Math.min(a.x + a.width, b.x + b.width) - x, height: Math.min(a.y + a.height, b.y + b.height) - y };
		};
		const expected = seams.map(({ boundaryIndex }) => intersect(regionForMeasureBoundary(updated, 0, boundaryIndex)!, region));
		const painted = seamCalls(recorder.calls);
		expect(painted.map((c) => ({ x: c.x, y: c.y, width: c.right - c.x, height: c.bottom - c.y }))).toEqual(expected);
		expect(recorder.calls.slice(-painted.length)).toEqual(painted);
	});

	it('markers follow setLayout to new geometry without another setSeamMarkers call', () => {
		renderer.setSeamMarkers([{ staffIndex: 0, boundaryIndex: 2 }]);
		const rescaled = layoutScore(score, { staffSpacePx: 20 });
		renderer.setLayout(rescaled);
		renderer.drawAll();
		const seam = seamCalls(recorder.calls)[0]!;
		const strip = regionForMeasureBoundary(rescaled, 0, 2)!;
		expect(seam.x).toBeCloseTo(strip.x, 6);
		expect(seam.right).toBeCloseTo(strip.x + strip.width, 6);
	});

	it("leaves every seam strip's real pixels identical to a fresh whole-score draw after a scoped redraw", () => {
		// The op-level test above proves which calls a scoped redraw issues;
		// this one proves what they add up to on node-canvas. No music font is
		// registered, which is irrelevant: only the strips' columns are compared.
		const seams = [
			{ staffIndex: 0, boundaryIndex: 1 },
			{ staffIndex: 0, boundaryIndex: 2 }
		];
		const width = Math.ceil(layout.width);
		const height = Math.ceil(layout.height);
		const canvasRenderer = (target: ReturnType<typeof createCanvas>, l: LaidOutScore) => {
			const r = new CanvasRenderer(target.getContext('2d') as unknown as CanvasRenderingContext2D, l);
			r.setSeamMarkers(seams);
			r.drawAll();
			return r;
		};

		const scopedCanvas = createCanvas(width, height);
		const scoped = canvasRenderer(scopedCanvas, layout);
		const target = score.measures[1]!.notes[0]!;
		const touched = score.transposeNote(target.id, 1)!;
		const updated = relayoutMeasure(score, layout, touched)!;
		scoped.setLayout(updated);
		scoped.redrawMeasure(touched);

		const freshCanvas = createCanvas(width, height);
		canvasRenderer(freshCanvas, updated);

		// Pixels a region's fractional edge passes through are skipped: a scoped
		// background fill only partly covers them, blending over what was there,
		// which is antialiasing slack of region-scoped redraw itself (present
		// with zero markers too), not something seams introduce.
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
			// The strip is actually there: a staff-gap pixel is red-tinted.
			const probe = ((Math.floor(h / 2) + 2) * w + w - 2) * 4;
			expect(b[probe]! - b[probe + 2]!).toBeGreaterThan(50);
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

describe('CanvasRenderer: M6 notation ink in a scoped redraw', () => {
	/** The vertical extent an op actually inks, which must fit inside the
	 *  area its measure's redraw cleared first. */
	const inkBox = (op: DrawOp, staffSpacePx: number): Box => {
		switch (op.kind) {
			case 'glyph': {
				const { bBoxSW, bBoxNE } = GLYPH_METRICS[op.glyph];
				return { x: op.x, right: op.x, y: op.y - bBoxNE[1] * staffSpacePx, bottom: op.y - bBoxSW[1] * staffSpacePx };
			}
			case 'text':
				return { x: op.x, right: op.x, y: op.y - op.fontSizePx, bottom: op.y + 0.3 * op.fontSizePx };
			case 'rect':
				return { x: op.x, right: op.x + op.width, y: op.y, bottom: op.y + op.height };
			case 'curve':
				return { x: Math.min(op.x0, op.x1), right: Math.max(op.x0, op.x1), y: Math.min(op.y0, op.y1), bottom: Math.max(op.y0, op.y1) };
			default:
				throw new Error(`unexpected op ${(op as DrawOp).kind}`);
		}
	};
	const paintedBy = (calls: readonly Recorded[], op: DrawOp) => {
		const box = inkBox(op, 0);
		const call = op.kind === 'glyph' || op.kind === 'text' ? 'fillText' : op.kind === 'rect' ? 'fillRect' : 'curve';
		return calls.some((c) => c.call === call && c.x === box.x && (op.kind === 'curve' ? c.right === box.right : c.y === op.y));
	};

	it.each([
		{
			name: 'articulations and fermatas',
			score: () =>
				buildScore([[['C5', 'whole']], [['G5', 'whole', { articulations: ['accent'], fermata: 'upright' }]], [['C5', 'whole']]], {
					keyFifths: 0
				}),
			edit: { index: 1, semitones: 2 },
			isInk: (op: DrawOp) => op.kind === 'glyph' && (op.glyph.startsWith('artic') || op.glyph.startsWith('fermata')),
			inkedMeasures: [1]
		},
		{
			name: 'a hairpin crossing three measures, and a dynamic',
			score: () =>
				buildScore(
					[
						[['C5', 'half'], ['D5', 'half']],
						{ notes: [['E5', 'half'], ['F5', 'half']], dynamics: [{ kind: 'mp', onset: 0.5 }] },
						[['G5', 'half'], ['A5', 'half']]
					],
					{ keyFifths: 0 },
					[],
					[{ kind: 'crescendo', start: [0, 0], stop: [2, 0.5] }]
				),
			edit: { index: 1, semitones: 1 },
			isInk: (op: DrawOp) => op.kind === 'curve' || (op.kind === 'glyph' && op.glyph.startsWith('dynamic')),
			inkedMeasures: [0, 1, 2]
		},
		{
			name: 'lyric syllables, a hyphen run and an extender',
			score: () =>
				buildScore([
					[['C5', 'half', { lyrics: [{ text: 'Hal', syllabic: 'begin' }] }], ['D5', 'half']],
					[['E5', 'whole']],
					[['F5', 'half', { lyrics: [{ text: 'le', syllabic: 'end' }] }], ['G5', 'half', { lyrics: [{ text: 'sing', extend: 'start' }] }]],
					[['A5', 'whole']],
					[['B5', 'whole', { lyrics: [{ text: 'on' }] }]]
				]),
			edit: { index: 2, semitones: -1 },
			isInk: (op: DrawOp, layout: LaidOutScore) =>
				op.kind === 'text' || (op.kind === 'rect' && op.y > layout.staffTopY + 6 * layout.staffSpacePx),
			// The hyphen run crosses measure 2 (index 1); the extender reaches index 3.
			inkedMeasures: [0, 1, 2, 3, 4]
		}
	])('repaints $name inside each measure\'s cleared region', ({ score: build, edit, isInk, inkedMeasures }) => {
		const score = build();
		const { recorder, renderer } = painted(score);
		for (let index = 0; index < score.measures.length; index++) {
			recorder.calls.length = 0;
			if (index === edit.index) transposeAndRedraw(score, renderer, 0, index, edit.semitones);
			else renderer.redrawMeasure(index);
			const layout = renderer.layout;
			const measure = layout.measures[index]!;
			const clear = recorder.calls[0]!;
			const clearedRect = { x: measure.region.x, width: measure.region.width, y: clear.y, height: clear.bottom - clear.y };
			const ink = measure.ops.filter((op) => isInk(op, layout));
			if (inkedMeasures.includes(index)) expect(ink.length).toBeGreaterThan(0);
			for (const op of ink) {
				expect(paintedBy(recorder.calls, op)).toBe(true);
				expect(withinBox(clearedRect, inkBox(op, layout.staffSpacePx))).toBe(true);
			}
		}
	});
});

describe('CanvasRenderer.setViewport (M6 Slice 11)', () => {
	/** A many-system layout and a viewport over a band of its middle, cut so
	 *  it slices through a system rather than lining up with one. */
	function viewportCase() {
		const { layout, recorder, renderer } = painted(createFullDemoScore(), { systemWidthPx: 600 });
		expect(layout.systems.length).toBeGreaterThan(4);
		const viewport = { x: 0, y: layout.height * 0.4, width: layout.width, height: layout.height * 0.2 };
		const intersects = (r: Rect) => r.y < viewport.y + viewport.height && r.y + r.height > viewport.y;
		return { layout, recorder, renderer, viewport, intersects };
	}

	it('drawAll paints only the measures intersecting the viewport, shifted to its origin', () => {
		const { layout, recorder, renderer, viewport, intersects } = viewportCase();
		renderer.setViewport(viewport);
		renderer.drawAll();

		const visible = layout.measures.filter((m) => intersects(m.region));
		expect(visible.length).toBeGreaterThan(0);
		expect(visible.length).toBeLessThan(layout.measures.length);
		expect(renderer.lastRedrawnMeasures).toEqual(visible.map((m) => m.index));
		// The first call is the background, exactly covering the canvas.
		expect(recorder.calls[0]).toMatchObject({ x: 0, y: 0, right: viewport.width, bottom: viewport.height });
		// Every ink call lands inside some visible measure's region once shifted,
		// so nothing is issued for a measure scrolled out of view.
		const shifted = visible.map((m) => ({ ...m.region, x: m.region.x - viewport.x, y: m.region.y - viewport.y }));
		for (const call of recorder.calls.slice(1)) expect(shifted.some((region) => withinBox(region, call))).toBe(true);
	});

	it('a scoped redraw outside the viewport paints nothing; one inside matches the unshifted draw, offset', () => {
		const { layout, recorder, renderer, viewport, intersects } = viewportCase();
		const outside = layout.measures.find((m) => !intersects(m.region))!;
		const inside = layout.measures.find((m) => intersects(m.region))!;

		renderer.redrawMeasure(inside.index);
		const unshifted = recorder.calls.splice(0);

		renderer.setViewport(viewport);
		renderer.redrawMeasures([outside.index]);
		expect(recorder.calls).toEqual([]);
		expect(renderer.lastRedrawnMeasures).toEqual([]);

		renderer.redrawMeasure(inside.index);
		expect(renderer.lastRedrawnMeasures).toEqual([inside.index]);
		// Rounded, since shifting a coordinate before or after adding a width
		// differs in the last floating-point bit.
		const rounded = (calls: readonly Recorded[], dx = 0, dy = 0) =>
			calls.map((call) => [call.call, call.style, ...[call.x - dx, call.right - dx, call.y - dy, call.bottom - dy].map((v) => v.toFixed(6))]);
		expect(rounded(recorder.calls)).toEqual(rounded(unshifted, viewport.x, viewport.y));
	});

	it('setViewport(null) goes back to painting every measure at layout coordinates', () => {
		const { layout, recorder, renderer, viewport } = viewportCase();
		renderer.drawAll();
		const whole = recorder.calls.splice(0);
		renderer.setViewport(viewport);
		renderer.drawAll();
		renderer.setViewport(null);
		recorder.calls.length = 0;
		renderer.drawAll();
		expect(renderer.lastRedrawnMeasures).toHaveLength(layout.measures.length);
		expect(recorder.calls).toEqual(whole);
	});
});
