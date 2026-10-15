import { describe, expect, it } from 'vitest';
import {
	clientToLayout,
	fitScale,
	followScrollTop,
	MIN_SYSTEM_WIDTH_PX,
	OnsetBatcher,
	systemWidthForContainer
} from './view-math.js';

describe('view math', () => {
	it.each([
		{ content: 800.6, width: 800 },
		{ content: 120, width: MIN_SYSTEM_WIDTH_PX }
	])('a $content px container lays out $width px systems', ({ content, width }) => {
		expect(systemWidthForContainer(content)).toBe(width);
	});

	it.each([
		{ layout: 600, available: 800, scale: 1 },
		{ layout: 800, available: 400, scale: 0.5 },
		{ layout: 800, available: 0, scale: 1 }
	])('a $layout px layout in $available px scales by $scale', ({ layout, available, scale }) => {
		expect(fitScale(layout, available)).toBe(scale);
	});

	it.each([
		{ name: 'unscrolled', viewport: null, scale: 1, expected: { x: 40, y: 30 } },
		{ name: 'scrolled down', viewport: { x: 0, y: 500 }, scale: 1, expected: { x: 40, y: 530 } },
		{ name: 'scaled and scrolled', viewport: { x: 0, y: 500 }, scale: 0.5, expected: { x: 80, y: 560 } }
	])('maps a click to layout coordinates when $name', ({ viewport, scale, expected }) => {
		expect(clientToLayout(140, 80, { left: 100, top: 50 }, viewport, scale)).toEqual(expected);
	});

	it.each([
		{ name: 'stays put for a region in view', y: 100, scrollTop: 0, expected: null },
		{ name: 'centres a region below the window', y: 900, scrollTop: 0, expected: 900 + 50 - 150 },
		{ name: 'never scrolls above the top', y: 0, scrollTop: 500, expected: 0 }
	])('follow-scroll $name', ({ y, scrollTop, expected }) => {
		const region = { x: 0, y, width: 300, height: 100 };
		expect(followScrollTop(region, 1, 0, scrollTop, 300)).toBe(expected);
	});

	it('batches onsets from one turn into one flush, and drops cleared ones', () => {
		const queue: (() => void)[] = [];
		const flushed: string[][] = [];
		const batcher = new OnsetBatcher((ids) => flushed.push(ids), (callback) => queue.push(callback));
		batcher.push('a');
		batcher.push('b');
		expect(queue).toHaveLength(1);
		queue.shift()!();
		batcher.push('c');
		batcher.clear();
		queue.shift()!();
		expect(flushed).toEqual([['a', 'b']]);
	});
});
