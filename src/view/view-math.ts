// The arithmetic behind `mountScore`, kept free of the DOM so it runs in the
// Node test environment. Each function takes the few numbers it needs from an
// element (a rect, a scroll position) rather than the element itself.

import type { Rect } from '../layout/types.js';
import type { NoteId } from '../model/score.js';

/** Narrowest system `systemWidthForContainer` will ask layout for. Below it a
 *  measure or two per system stops being readable; the canvas scales down
 *  instead (see `fitScale`). */
export const MIN_SYSTEM_WIDTH_PX = 200;

/** The `systemWidthPx` to lay out at for a container whose content box is
 *  `contentWidthPx` wide, so systems cast off to fit it rather than overflow. */
export function systemWidthForContainer(contentWidthPx: number): number {
	return Math.max(MIN_SYSTEM_WIDTH_PX, Math.floor(contentWidthPx));
}

/** Layout pixels to CSS pixels: 1 unless the layout is wider than the room
 *  available (a container narrower than even one measure), in which case the
 *  score shrinks to fit, keeping its aspect ratio. */
export function fitScale(layoutWidthPx: number, availableWidthPx: number): number {
	if (layoutWidthPx <= 0 || availableWidthPx <= 0) return 1;
	return Math.min(1, availableWidthPx / layoutWidthPx);
}

/**
 * The band of the score a window-sized sticky canvas shows, in layout
 * coordinates. `canvasTopPx` is how far down the scrolled content the canvas
 * currently sits (CSS pixels): it tracks the scroll position until the canvas
 * reaches the bottom of the score, where sticky positioning stops it.
 */
export function viewportBand(canvasTopPx: number, viewHeightPx: number, layoutWidthPx: number, scale: number): Rect {
	return { x: 0, y: canvasTopPx / scale, width: layoutWidthPx, height: viewHeightPx / scale };
}

/** A pointer position (client coordinates) to layout coordinates, given the
 *  canvas's client rect, the renderer's viewport origin and the CSS scale. */
export function clientToLayout(
	clientX: number,
	clientY: number,
	canvasRect: { readonly left: number; readonly top: number },
	viewport: { readonly x: number; readonly y: number } | null,
	scale: number
): { x: number; y: number } {
	return {
		x: (clientX - canvasRect.left) / scale + (viewport?.x ?? 0),
		y: (clientY - canvasRect.top) / scale + (viewport?.y ?? 0)
	};
}

/**
 * Where to scroll so `region` (layout coordinates) is in view, or `null` when
 * it already fully is. `contentTopPx` is where the score starts in the scroll
 * content (the container's top padding). Centres the region rather than
 * snapping it to the edge, and leaves a visible region alone: onsets fire
 * several times a second, and restarting a smooth scroll on each one makes the
 * view judder, so in practice this scrolls once per system.
 */
export function followScrollTop(
	region: Rect,
	scale: number,
	contentTopPx: number,
	scrollTop: number,
	clientHeight: number
): number | null {
	const top = contentTopPx + region.y * scale;
	const height = region.height * scale;
	if (top >= scrollTop && top + height <= scrollTop + clientHeight) return null;
	return Math.max(0, top + height / 2 - clientHeight / 2);
}

/**
 * Collects the note ids of onsets that fire in one JS turn and hands them to
 * `flush` together on the next microtask.
 *
 * A chord or simultaneous voices arrive as one `OnsetEvent` per note, fired
 * back to back by one scheduler pass. Moving the cursor per event would flash
 * a one-note cursor for a turn before the next event widened it, an artifact
 * of scheduling order, not of the music.
 */
export class OnsetBatcher {
	#pending: NoteId[] = [];
	#queued = false;
	readonly #flush: (noteIds: NoteId[]) => void;
	readonly #schedule: (callback: () => void) => void;

	constructor(flush: (noteIds: NoteId[]) => void, schedule: (callback: () => void) => void = (callback) => queueMicrotask(callback)) {
		this.#flush = flush;
		this.#schedule = schedule;
	}

	push(noteId: NoteId): void {
		this.#pending.push(noteId);
		if (this.#queued) return;
		this.#queued = true;
		this.#schedule(() => {
			this.#queued = false;
			if (this.#pending.length === 0) return;
			const noteIds = this.#pending;
			this.#pending = [];
			this.#flush(noteIds);
		});
	}

	/** Drop whatever has not been flushed yet (a stop or seek mid-turn). */
	clear(): void {
		this.#pending = [];
	}
}
