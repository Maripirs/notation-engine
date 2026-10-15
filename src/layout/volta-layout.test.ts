// Volta brackets (M6 Slice 13): where layout puts 1st/2nd ending brackets.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../io/musicxml-import.js';
import type { Score } from '../model/score.js';
import { GLYPH_METRICS } from '../render/glyph-metrics.js';
import { layoutScore, relayoutMeasure } from './layout.js';
import { measureAt, SS, twoStaffScore, type GlyphOp, type RectOp, type TextOp } from './test-helpers.js';
import type { DrawOp, LaidOutScore } from './types.js';

const FIXTURE = readFileSync(join(import.meta.dirname, '../test/fixtures/repeats-voltas.musicxml'), 'utf8');

/** At this width the fixture casts off as m1-m3 | m4-m6 | m7-m9 (0-based
 *  0-2 | 3-5 | 6-8), splitting the two-measure 1st ending. */
const SPLIT_WIDTH = 750;

function lay(score: Score = importMusicXml(FIXTURE), systemWidthPx?: number) {
	return { score, layout: layoutScore(score, { staffSpacePx: SS, systemWidthPx }) };
}

/** The bracket line's y for the system holding measure `index` (staff 0). */
function voltaYOf(layout: LaidOutScore, index: number): number | undefined {
	return layout.systems.find((s) => s.staffIndex === 0 && s.measureIndices.includes(index))!.voltaY;
}

/** Measure `index`'s pieces of brackets: line segments, hooks, labels. */
function bracketIn(layout: LaidOutScore, index: number, staffIndex = 0) {
	const y = voltaYOf(layout, index);
	const ops = measureAt(layout, staffIndex, index).ops;
	const rects = ops.filter((op): op is RectOp => op.kind === 'rect' && y !== undefined);
	return {
		lines: rects.filter((op) => op.width > op.height && Math.abs(op.y + op.height / 2 - y!) < 1e-6),
		hooks: rects.filter((op) => op.height > 4 * op.width && Math.abs(op.y + op.width / 2 - y!) < 1e-6),
		labels: ops.filter((op): op is TextOp => op.kind === 'text').map((op) => op.text)
	};
}

/** The highest point of an op's ink (a text op's em box, as regions count it). */
function opTop(op: DrawOp): number {
	if (op.kind === 'rect') return op.y;
	if (op.kind === 'curve') return Math.min(op.y0, op.cy0, op.cy1, op.y1);
	if (op.kind === 'text') return op.y - op.fontSizePx;
	return op.y - GLYPH_METRICS[op.glyph].bBoxNE[1] * SS;
}

function opBottom(op: DrawOp): number {
	if (op.kind === 'rect') return op.y + op.height;
	if (op.kind === 'curve') return Math.max(op.y0, op.cy0, op.cy1, op.y1);
	if (op.kind === 'text') return op.y + 0.3 * op.fontSizePx;
	return op.y - GLYPH_METRICS[op.glyph].bBoxSW[1] * SS;
}

describe('layout: volta brackets (M6 Slice 13)', () => {
	it.each([
		// measure, label, left hook, right hook
		[2, ['1.'], true, false],
		[3, [], false, true],
		[4, ['2.'], true, false],
		[6, ['1.-2.'], true, true],
		[7, ['3.'], true, false]
	])('measure %i: label %j, left hook %s, right hook %s', (index, labels, left, right) => {
		const { layout } = lay();
		const bracket = bracketIn(layout, index);
		const region = measureAt(layout, 0, index).region;
		const mid = region.x + region.width / 2;
		expect(bracket.labels).toEqual(labels);
		expect(bracket.lines).toHaveLength(1);
		expect(bracket.hooks.some((h) => h.x < mid)).toBe(left);
		expect(bracket.hooks.some((h) => h.x > mid)).toBe(right);
	});

	it('labels an ending without text from its numbers, and draws nothing outside endings', () => {
		const score = importMusicXml(FIXTURE);
		for (const staff of score.staves) {
			const measure = staff.measures[6]!;
			measure.endingStart = { ...measure.endingStart!, text: null };
		}
		const { layout } = lay(score);
		expect(bracketIn(layout, 6).labels).toEqual(['1, 2.']);
		for (const index of [0, 1, 5, 8]) expect(bracketIn(layout, index).lines).toHaveLength(0);
	});

	it('sits on one line above every ending measure\'s ink, an above dynamic included', () => {
		const score = importMusicXml(FIXTURE);
		score.addDynamic(0, 3, { kind: 'ff', placement: 'above' });
		const { layout } = lay(score);
		const y = voltaYOf(layout, 2)!;
		for (const index of [2, 3, 4, 6, 7]) {
			const ops = measureAt(layout, 0, index).ops;
			const { lines, hooks } = bracketIn(layout, index);
			const bracket = new Set<DrawOp>([...lines, ...hooks, ...ops.filter((op) => op.kind === 'text')]);
			const inkTop = Math.min(...ops.filter((op) => !bracket.has(op)).map(opTop));
			const bracketBottom = Math.max(...[...bracket].map(opBottom));
			expect(lines[0]!.y + lines[0]!.height / 2).toBeCloseTo(y, 6);
			expect(bracketBottom).toBeLessThan(inkTop);
		}
		// The ff is part of the ink cleared.
		const ff = measureAt(layout, 0, 3).ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.glyph === 'dynamicFF')!;
		expect(y).toBeLessThan(opTop(ff));
	});

	it('continues across a system break with no left hook or label on the continued piece', () => {
		const { layout } = lay(undefined, SPLIT_WIDTH);
		expect(voltaYOf(layout, 2)).not.toBe(voltaYOf(layout, 3));
		// The opening piece runs to its system's end with no closing hook.
		const opening = bracketIn(layout, 2);
		const end = measureAt(layout, 0, 2).region;
		expect(opening.hooks).toHaveLength(1);
		expect(opening.lines[0]!.x + opening.lines[0]!.width).toBeCloseTo(end.x + end.width, 6);
		// The continued piece starts at the music, right of the clef, and only
		// closes.
		const continued = bracketIn(layout, 3);
		const measure = measureAt(layout, 0, 3);
		const clef = measure.ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.glyph.endsWith('Clef'))!;
		expect(continued.labels).toEqual([]);
		expect(continued.hooks).toHaveLength(1);
		expect(continued.hooks[0]!.x).toBeGreaterThan(measure.region.x + measure.region.width / 2);
		expect(continued.lines[0]!.x).toBeGreaterThan(clef.x + GLYPH_METRICS[clef.glyph].bBoxNE[0] * SS);
		expect(continued.lines[0]!.x).toBeLessThan(Math.min(...measure.notes.map((n) => n.bounds.x)));
	});

	it('keeps a system\'s bracket clear of the system above', () => {
		const score = importMusicXml(FIXTURE);
		// Measure 2 (0-based 1) far below the staff, a dynamic under it.
		for (const note of score.staves[0]!.measures[1]!.notes) for (let i = 0; i < 30; i++) score.transposeNote(note.id, -1);
		score.addDynamic(0, 1, { kind: 'p', placement: 'below' });
		const { layout } = lay(score, SPLIT_WIDTH);
		const above = Math.max(...[0, 1, 2].flatMap((i) => measureAt(layout, 0, i).ops.map(opBottom)));
		const bracketTop = Math.min(...bracketIn(layout, 3).lines.map((op) => op.y));
		expect(bracketTop).toBeGreaterThan(above + SS);
	});

	it('draws on the top staff only', () => {
		const score = twoStaffScore();
		for (const staff of score.staves) {
			staff.measures[1]!.endingStart = { numbers: [1], text: null, attrs: {} };
			staff.measures[1]!.endingEnd = { kind: 'stop', attrs: {} };
		}
		const { layout } = lay(score);
		expect(bracketIn(layout, 1, 0).labels).toEqual(['1.']);
		expect(measureAt(layout, 1, 1).ops.some((op) => op.kind === 'text')).toBe(false);
		expect(layout.systems.find((s) => s.staffIndex === 1)!.voltaY).toBeUndefined();
	});
});

describe('relayoutMeasure with volta brackets (M6 Slice 13)', () => {
	it('reproduces the full layout\'s bracket for an edit inside an ending that leaves its line alone', () => {
		const { score, layout } = lay(undefined, SPLIT_WIDTH);
		const touched = score.transposeNote(score.staves[0]!.measures[3]!.notes[0]!.id, -2)!;
		const updated = relayoutMeasure(score, layout, touched, { staffSpacePx: SS, systemWidthPx: SPLIT_WIDTH });
		expect(updated).not.toBeNull();
		const fresh = layoutScore(score, { staffSpacePx: SS, systemWidthPx: SPLIT_WIDTH });
		const pick = (l: LaidOutScore) => {
			const { lines, hooks } = bracketIn(l, 3);
			return [...lines, ...hooks].flatMap((op) => [op.x, op.y, op.width, op.height]);
		};
		const scoped = pick(updated!);
		expect(scoped).toHaveLength(8);
		scoped.forEach((v, i) => expect(v).toBeCloseTo(pick(fresh)[i]!, 6));
		const region = (l: LaidOutScore) => Object.values(measureAt(l, 0, 3).region);
		region(updated!).forEach((v, i) => expect(v).toBeCloseTo(region(fresh)[i]!, 6));
	});

	it('falls back to a full layout when the edit raises the bracket', () => {
		const { score, layout } = lay(undefined, SPLIT_WIDTH);
		const id = score.staves[0]!.measures[3]!.notes[0]!.id;
		for (let i = 0; i < 12; i++) score.transposeNote(id, 1);
		expect(relayoutMeasure(score, layout, 3, { staffSpacePx: SS, systemWidthPx: SPLIT_WIDTH })).toBeNull();
	});
});
