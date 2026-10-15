// `mountScore`: a score viewer with playback in one call.
//
// The only module in the package that touches the DOM, `window`,
// `ResizeObserver` or `AudioContext`. Everything here is wiring the other
// layers already expose (layout, the canvas renderer's viewport, the playback
// engine), done once so a host does not have to; the arithmetic lives in
// `view-math.ts` where Node tests can reach it. Editing is deliberately not
// built in: a host that wants it edits `view.score` with the model API, paints
// selection through `view.renderer`, and calls `view.refresh(...)`.

import { importMusicXml } from '../io/musicxml-import.js';
import { hitTest, type HitResult } from '../layout/hit-test.js';
import { layoutScore, relayoutMeasure, type LayoutOptions } from '../layout/layout.js';
import { regionForNote } from '../layout/region-for-note.js';
import type { LaidOutScore } from '../layout/types.js';
import type { MeasureRef, NoteId, Score } from '../model/score.js';
import { PlaybackEngine } from '../playback/playback-engine.js';
import { computePlaybackTimeline, firstOnsetSeconds, type OnsetEvent } from '../playback/timeline.js';
import { loadSmuflFont } from '../render/font.js';
import { CanvasRenderer, type CanvasRendererOptions } from '../render/renderer.js';
import {
	clientToLayout,
	fitScale,
	followScrollTop,
	OnsetBatcher,
	systemWidthForContainer,
	viewportBand
} from './view-math.js';

/** Staff space the view lays out at when `staffSpacePx` is not given. */
export const DEFAULT_STAFF_SPACE_PX = 10;

/** How long a resize must settle before the score is cast off again. Layout
 *  is a whole-score pass, too slow to run on every frame of a drag. */
const RESIZE_SETTLE_MS = 100;

export interface MountOptions {
	/** Pixels between two staff lines: the zoom. Default `DEFAULT_STAFF_SPACE_PX`. */
	readonly staffSpacePx?: number;
	/** Fixed system width. Omit it to fit systems to the container's width,
	 *  re-cast-off whenever the container resizes. */
	readonly systemWidthPx?: number;
	/** Where to load the SMuFL font from. Default: the Bravura shipped with
	 *  the package (see `loadSmuflFont`). */
	readonly fontUrl?: string | URL;
	/** Colours and the label font, passed to `CanvasRenderer`. */
	readonly renderer?: Omit<CanvasRendererOptions, 'fontFamily'>;
	/** Scroll the container to keep the playback cursor in view. Default true. */
	readonly followScroll?: boolean;
	/** `false` makes the view silent: `play()` does nothing and no
	 *  `AudioContext` is ever created. Default true. */
	readonly playback?: boolean;
}

export interface ScoreViewEvents {
	/** A press on the score. `hit` is the note under the pointer, or `null`
	 *  for empty space (so a host can clear its selection). */
	readonly noteclick: (hit: HitResult | null, event: PointerEvent) => void;
	/** A note starting during playback, as `PlaybackEngine`'s `onOnset`. */
	readonly onset: (event: OnsetEvent) => void;
	/** Playback ran off the end of the score (not fired by `stop()`). */
	readonly end: () => void;
}

export interface ScoreView {
	/** Show a new score: stops playback, lays out, scrolls to the top. */
	load(source: string | Score): void;
	/** Start or resume. The first call creates the `AudioContext`, so call it
	 *  from a user gesture (a click handler) for the browser to allow sound. */
	play(): void;
	/** Freeze at the current position; notes already sounding ring out. */
	pause(): void;
	/** Silence, rewind to the start and clear the cursor. */
	stop(): void;
	/** Move to `seconds` into the piece, playing on from there if playing. */
	seek(seconds: number): void;
	/** Seek to the first time `noteId` sounds (repeats play it more than
	 *  once). Returns false, without seeking, for a note that never sounds. */
	seekToNote(noteId: NoteId): boolean;
	readonly isPlaying: boolean;
	readonly positionSeconds: number;
	/** The piece's length in seconds, repeats included. */
	readonly durationSeconds: number;
	/** Re-lay-out at a new staff space, keeping the same part of the score in view. */
	setZoom(staffSpacePx: number): void;
	readonly staffSpacePx: number;
	/** Scroll the container so `noteId`'s measure is in view, if it is not. */
	scrollToNote(noteId: NoteId): void;
	/** Subscribe; returns the unsubscribe function. */
	on<K extends keyof ScoreViewEvents>(name: K, handler: ScoreViewEvents[K]): () => void;

	// Escape hatches for hosts that build editing on top. The renderer is the
	// view's own: selection, measure ranges and seam markers set on it persist
	// across every relayout the view does.
	readonly score: Score;
	readonly layout: LaidOutScore;
	readonly renderer: CanvasRenderer;
	readonly canvas: HTMLCanvasElement;
	/**
	 * Repaint after the host edited `score` in place. With `changed` (the
	 * `MeasureRef`s an edit op returned) only those measures are re-laid-out
	 * and redrawn, falling back to a whole-score pass when one of them
	 * declines (its width changed). Returns true when the scoped path held.
	 * Also marks the playback timeline stale; it is rebuilt at the next
	 * `play()` that does not interrupt playback.
	 */
	refresh(changed?: readonly MeasureRef[]): boolean;
	/**
	 * Show a different `Score` object without stopping playback or moving the
	 * scroll position, e.g. the one `EditHistory.undo()` swaps in. Otherwise
	 * like `refresh()` with no argument.
	 */
	setScore(score: Score): void;
	/** Remove the canvas, listeners and observer, stop playback and close the
	 *  `AudioContext`. Safe to call more than once. */
	destroy(): void;
}

/**
 * Render `source` (a MusicXML string or a `Score`) into `container` and return
 * a handle to play, zoom and repaint it.
 *
 * The container is the scroll element. The view appends a canvas sized to the
 * visible window (sticky at the container's top, so it can render scores far
 * taller than a browser allows a canvas to be) and a spacer that makes up the
 * rest of the score's height. Give the container a `height` or `max-height`:
 * without one it grows to the whole score and the canvas with it. If its
 * `overflow` is `visible` the view sets `overflow: auto` (restored by
 * `destroy`); no other styling is imposed. Resolves once the music font has
 * loaded, since text drawn before then stays as tofu.
 */
export async function mountScore(
	container: HTMLElement,
	source: string | Score,
	options: MountOptions = {}
): Promise<ScoreView> {
	const fontFamily = options.fontUrl === undefined ? await loadSmuflFont() : await loadSmuflFont(options.fontUrl);
	return new MountedScoreView(container, toScore(source), options, fontFamily);
}

function toScore(source: string | Score): Score {
	return typeof source === 'string' ? importMusicXml(source) : source;
}

type Handlers = { [K in keyof ScoreViewEvents]: Set<ScoreViewEvents[K]> };

class MountedScoreView implements ScoreView {
	readonly #container: HTMLElement;
	readonly #window: Window & typeof globalThis;
	readonly #canvas: HTMLCanvasElement;
	readonly #spacer: HTMLElement;
	readonly #ctx: CanvasRenderingContext2D;
	readonly #renderer: CanvasRenderer;
	readonly #options: MountOptions;
	readonly #handlers: Handlers = { noteclick: new Set(), onset: new Set(), end: new Set() };
	readonly #batcher: OnsetBatcher;
	readonly #observer: ResizeObserver | null;
	/** The container's inline `overflow` before the view set it, or `null`
	 *  when the view left it alone. */
	readonly #previousOverflow: string | null = null;

	#score: Score;
	#layout: LaidOutScore;
	#staffSpacePx: number;
	#systemWidthPx: number;
	/** Layout pixels to CSS pixels (see `fitScale`). */
	#scale = 1;
	#viewHeight = 0;
	#resizeTimer: ReturnType<typeof setTimeout> | undefined;
	#destroyed = false;

	#audioContext: AudioContext | null = null;
	#engine: PlaybackEngine | null = null;
	/** The timeline `#engine` was built from; rebuilt when the score changes. */
	#engineEvents: readonly OnsetEvent[] | null = null;
	/** The current score's timeline, `null` until needed or after an edit. */
	#events: readonly OnsetEvent[] | null = null;
	/** Position to start from while no engine exists yet (a seek before the first play). */
	#idlePosition = 0;

	constructor(container: HTMLElement, score: Score, options: MountOptions, fontFamily: string) {
		const doc = container.ownerDocument;
		const win = doc.defaultView;
		if (!win) throw new Error('mountScore needs a container attached to a window.');
		this.#container = container;
		this.#window = win as Window & typeof globalThis;
		this.#options = options;
		this.#score = score;
		this.#staffSpacePx = options.staffSpacePx ?? DEFAULT_STAFF_SPACE_PX;

		if (win.getComputedStyle(container).overflowY === 'visible') {
			this.#previousOverflow = container.style.overflow;
			container.style.overflow = 'auto';
		}
		this.#canvas = doc.createElement('canvas');
		Object.assign(this.#canvas.style, { display: 'block', position: 'sticky', top: '0', width: '0', height: '0' });
		this.#spacer = doc.createElement('div');
		container.append(this.#canvas, this.#spacer);
		const ctx = this.#canvas.getContext('2d');
		if (!ctx) throw new Error('mountScore could not get a 2D canvas context.');
		this.#ctx = ctx;

		this.#systemWidthPx = options.systemWidthPx ?? systemWidthForContainer(this.#contentWidth());
		this.#layout = layoutScore(score, this.#layoutOptions());
		this.#renderer = new CanvasRenderer(ctx, this.#layout, { ...options.renderer, fontFamily });
		this.#batcher = new OnsetBatcher((noteIds) => this.#showCursor(noteIds));

		this.#size();
		// Laying the score out can add a vertical scrollbar that narrows the
		// container; cast off once more at the narrower width before the first
		// paint rather than after a visible jump.
		if (this.#refitWidth()) {
			this.#relayout();
			this.#size();
		}
		this.#renderer.drawAll();

		container.addEventListener('scroll', this.#onScroll, { passive: true });
		this.#canvas.addEventListener('pointerdown', this.#onPointerDown);
		this.#observer = win.ResizeObserver ? new win.ResizeObserver(this.#onResize) : null;
		this.#observer?.observe(container);
	}

	get score(): Score {
		return this.#score;
	}

	get layout(): LaidOutScore {
		return this.#layout;
	}

	get renderer(): CanvasRenderer {
		return this.#renderer;
	}

	get canvas(): HTMLCanvasElement {
		return this.#canvas;
	}

	get staffSpacePx(): number {
		return this.#staffSpacePx;
	}

	get isPlaying(): boolean {
		return this.#engine?.isPlaying ?? false;
	}

	get positionSeconds(): number {
		return this.#engine?.positionSeconds ?? this.#idlePosition;
	}

	get durationSeconds(): number {
		return this.#timeline().reduce((end, event) => Math.max(end, event.startSeconds + event.durationSeconds), 0);
	}

	on<K extends keyof ScoreViewEvents>(name: K, handler: ScoreViewEvents[K]): () => void {
		const set = this.#handlers[name] as Set<ScoreViewEvents[K]>;
		set.add(handler);
		return () => set.delete(handler);
	}

	load(source: string | Score): void {
		if (this.#destroyed) return;
		this.stop();
		this.#score = toScore(source);
		this.#events = null;
		this.#relayout();
		this.#container.scrollTop = 0;
		this.#size();
		this.#renderer.drawAll();
	}

	setScore(score: Score): void {
		if (this.#destroyed) return;
		this.#score = score;
		this.refresh();
	}

	refresh(changed?: readonly MeasureRef[]): boolean {
		if (this.#destroyed) return false;
		this.#events = null;
		if (changed) {
			let scoped: LaidOutScore | null = this.#layout;
			for (const { staffIndex, measureIndex } of changed) {
				scoped = scoped && relayoutMeasure(this.#score, scoped, measureIndex, this.#layoutOptions(), staffIndex);
			}
			if (scoped) {
				this.#layout = scoped;
				this.#renderer.setLayout(scoped);
				for (const { staffIndex, measureIndex } of changed) this.#renderer.redrawMeasure(measureIndex, staffIndex);
				return true;
			}
		}
		this.#relayout();
		this.#size();
		this.#renderer.drawAll();
		return false;
	}

	setZoom(staffSpacePx: number): void {
		if (this.#destroyed || staffSpacePx === this.#staffSpacePx || !(staffSpacePx > 0)) return;
		// Keep the same fraction of the score in view: systems recast at the new
		// size, so no pixel offset survives a zoom.
		const container = this.#container;
		const fraction = container.scrollHeight > 0 ? container.scrollTop / container.scrollHeight : 0;
		this.#staffSpacePx = staffSpacePx;
		this.#relayout();
		this.#size();
		container.scrollTop = fraction * container.scrollHeight;
		this.#updateViewport();
		this.#renderer.drawAll();
	}

	scrollToNote(noteId: NoteId): void {
		const region = regionForNote(this.#layout, noteId);
		if (!region) return;
		const container = this.#container;
		const paddingTop = parseFloat(this.#window.getComputedStyle(container).paddingTop) || 0;
		const top = followScrollTop(region, this.#scale, paddingTop, container.scrollTop, container.clientHeight);
		if (top !== null) container.scrollTo({ top, behavior: 'smooth' });
	}

	play(): void {
		if (this.#destroyed || this.#options.playback === false) return;
		const engine = this.#ensureEngine();
		// A context created outside a user gesture starts suspended.
		void this.#audioContext?.resume();
		engine.play();
	}

	pause(): void {
		this.#engine?.pause();
	}

	stop(): void {
		this.#engine?.stop();
		this.#idlePosition = 0;
		this.#clearCursor();
	}

	seek(seconds: number): void {
		const target = Math.max(0, seconds);
		if (this.#engine) this.#engine.seek(target);
		else this.#idlePosition = target;
		this.#clearCursor();
	}

	seekToNote(noteId: NoteId): boolean {
		const seconds = firstOnsetSeconds(this.#timeline(), noteId);
		if (seconds === undefined) return false;
		this.seek(seconds);
		return true;
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#engine?.stop();
		this.#engine = null;
		this.#batcher.clear();
		void this.#audioContext?.close();
		this.#audioContext = null;
		clearTimeout(this.#resizeTimer);
		this.#observer?.disconnect();
		this.#container.removeEventListener('scroll', this.#onScroll);
		this.#canvas.removeEventListener('pointerdown', this.#onPointerDown);
		this.#canvas.remove();
		this.#spacer.remove();
		if (this.#previousOverflow !== null) this.#container.style.overflow = this.#previousOverflow;
		for (const set of Object.values(this.#handlers)) set.clear();
	}

	// --- Layout and painting ------------------------------------------------

	#layoutOptions(): LayoutOptions {
		return { staffSpacePx: this.#staffSpacePx, systemWidthPx: this.#systemWidthPx };
	}

	#relayout(): void {
		this.#layout = layoutScore(this.#score, this.#layoutOptions());
		this.#renderer.setLayout(this.#layout);
	}

	#padding(): { left: number; right: number; top: number; bottom: number } {
		const style = this.#window.getComputedStyle(this.#container);
		return {
			left: parseFloat(style.paddingLeft) || 0,
			right: parseFloat(style.paddingRight) || 0,
			top: parseFloat(style.paddingTop) || 0,
			bottom: parseFloat(style.paddingBottom) || 0
		};
	}

	#contentWidth(): number {
		const padding = this.#padding();
		return this.#container.clientWidth - padding.left - padding.right;
	}

	/** Update the derived system width; true when it changed (needs a relayout). */
	#refitWidth(): boolean {
		if (this.#options.systemWidthPx !== undefined) return false;
		const width = systemWidthForContainer(this.#contentWidth());
		if (width === this.#systemWidthPx) return false;
		this.#systemWidthPx = width;
		return true;
	}

	/**
	 * Size the canvas to the visible window and the spacer to the rest of the
	 * score's height, at the full device pixel ratio, then point the renderer
	 * at the visible band. Does not paint.
	 *
	 * Measured in passes because each answer depends on the last: the
	 * container's width depends on whether the score's height gave it a
	 * scrollbar, the scale on that width, and the visible height on the
	 * scaled height. The total content height stays the score's throughout,
	 * so the scroll position is not disturbed along the way.
	 */
	#size(): void {
		const canvas = this.#canvas;
		const padding = this.#padding();
		const place = (scale: number, viewHeight: number): void => {
			const total = this.#layout.height * scale;
			canvas.style.width = `${this.#layout.width * scale}px`;
			canvas.style.height = `${viewHeight}px`;
			this.#spacer.style.height = `${total - viewHeight}px`;
		};
		place(1, 0);
		const scale = fitScale(this.#layout.width, this.#contentWidth());
		place(scale, 0);
		const total = this.#layout.height * scale;
		const available = this.#container.clientHeight - padding.top - padding.bottom;
		const viewHeight = Math.min(total, available > 0 ? available : this.#window.innerHeight);
		place(scale, viewHeight);

		const dpr = this.#window.devicePixelRatio || 1;
		canvas.width = Math.ceil(this.#layout.width * scale * dpr);
		canvas.height = Math.ceil(viewHeight * dpr);
		this.#ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
		this.#scale = scale;
		this.#viewHeight = viewHeight;
		this.#updateViewport();
	}

	/** Point the renderer at the band the canvas currently shows. The canvas's
	 *  offset into the scrolled content is read off the spacer, which sits
	 *  right after it in flow, so container padding and borders cancel out. */
	#updateViewport(): void {
		const canvasTop = this.#canvas.getBoundingClientRect().top;
		const spacerTop = this.#spacer.getBoundingClientRect().top;
		const offset = Math.max(0, this.#viewHeight - (spacerTop - canvasTop));
		this.#renderer.setViewport(viewportBand(offset, this.#viewHeight, this.#layout.width, this.#scale));
	}

	// Scroll events arrive at most once per frame, before it paints, so painting
	// here keeps the canvas in step. Only the visible measures draw.
	readonly #onScroll = (): void => {
		this.#updateViewport();
		this.#renderer.drawAll();
	};

	readonly #onPointerDown = (event: PointerEvent): void => {
		const point = clientToLayout(
			event.clientX,
			event.clientY,
			this.#canvas.getBoundingClientRect(),
			this.#renderer.viewport,
			this.#scale
		);
		const hit = hitTest(this.#layout, point.x, point.y);
		for (const handler of this.#handlers.noteclick) handler(hit, event);
	};

	readonly #onResize = (): void => {
		clearTimeout(this.#resizeTimer);
		this.#resizeTimer = setTimeout(() => {
			if (this.#destroyed) return;
			if (this.#refitWidth()) this.#relayout();
			this.#size();
			this.#renderer.drawAll();
		}, RESIZE_SETTLE_MS);
	};

	// --- Playback -----------------------------------------------------------

	#timeline(): readonly OnsetEvent[] {
		this.#events ??= computePlaybackTimeline(this.#score);
		return this.#events;
	}

	/**
	 * The engine for the current score. An engine takes its timeline once, so
	 * after an edit it is rebuilt here, carrying the paused position over;
	 * while playing, the old one plays on and the edit is heard from the next
	 * play. The `AudioContext` is created on first use, inside the `play()`
	 * the host called from a user gesture, and reused across rebuilds.
	 */
	#ensureEngine(): PlaybackEngine {
		const current = this.#engine;
		if (current && (current.isPlaying || this.#engineEvents === this.#timeline())) return current;
		const resumeFrom = current?.positionSeconds ?? this.#idlePosition;
		current?.stop();
		const events = this.#timeline();
		this.#audioContext ??= new this.#window.AudioContext();
		const engine = new PlaybackEngine({
			events,
			audioContext: this.#audioContext,
			onOnset: (event) => {
				this.#batcher.push(event.noteId);
				for (const handler of this.#handlers.onset) handler(event);
			},
			onEnd: () => {
				this.#clearCursor();
				for (const handler of this.#handlers.end) handler();
			}
		});
		if (resumeFrom > 0) engine.seek(resumeFrom);
		this.#engine = engine;
		this.#engineEvents = events;
		this.#idlePosition = 0;
		return engine;
	}

	#showCursor(noteIds: readonly NoteId[]): void {
		if (this.#destroyed) return;
		for (const { staffIndex, index } of this.#renderer.setPlaybackCursor(noteIds)) {
			this.#renderer.redrawMeasure(index, staffIndex);
		}
		// Any note of the onset names the right system to follow.
		if (this.#options.followScroll !== false) this.scrollToNote(noteIds[0]!);
	}

	#clearCursor(): void {
		this.#batcher.clear();
		for (const { staffIndex, index } of this.#renderer.setPlaybackCursor([])) {
			this.#renderer.redrawMeasure(index, staffIndex);
		}
	}
}
