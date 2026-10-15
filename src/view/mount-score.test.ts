// `mountScore`'s handle lifecycle against a hand-rolled DOM: just the element,
// window, ResizeObserver and AudioContext members the view uses, recording
// listeners and observers so a test can check that `destroy` leaves none.
// Painting goes to a real node-canvas context; what it draws is the renderer
// tests' business, not this file's.

import { readFileSync } from 'node:fs';
import { createCanvas } from 'canvas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoScore } from '../demo-score.js';
import { mockAudioContext } from '../playback/test-helpers.js';
import { mountScore, type ScoreView } from './mount-score.js';

const repeatsXml = readFileSync(new URL('../test/fixtures/repeats-voltas.musicxml', import.meta.url), 'utf8');

type Listener = (event: never) => void;

function fakeElement(tag: string) {
	const listeners = new Map<string, Set<Listener>>();
	return {
		tag,
		style: {} as Record<string, string>,
		children: [] as unknown[],
		parent: null as { children: unknown[] } | null,
		width: 0,
		height: 0,
		listeners,
		addEventListener(type: string, listener: Listener) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(listener);
		},
		removeEventListener(type: string, listener: Listener) {
			listeners.get(type)?.delete(listener);
		},
		dispatch(type: string, event: object) {
			for (const listener of listeners.get(type) ?? []) listener(event as never);
		},
		listenerCount() {
			return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
		},
		remove() {
			const siblings = this.parent?.children;
			siblings?.splice(siblings.indexOf(this), 1);
			this.parent = null;
		}
	};
}

/** A 800x300 container in a fake window. The canvas sits at the content's
 *  top (scroll 0), so the spacer's rect starts one canvas height below it. */
function fakeDom() {
	const audio = mockAudioContext();
	const observers: { observing: number }[] = [];
	const audioContexts: unknown[] = [];
	let canvasEl: ReturnType<typeof fakeElement> | null = null;
	const win = {
		devicePixelRatio: 2,
		innerHeight: 600,
		getComputedStyle: (el: ReturnType<typeof fakeElement>) => ({
			overflowY: el.style.overflow || 'visible',
			paddingLeft: '0px',
			paddingRight: '0px',
			paddingTop: '0px',
			paddingBottom: '0px'
		}),
		ResizeObserver: class {
			observing = 0;
			constructor() {
				observers.push(this);
			}
			observe() {
				this.observing++;
			}
			disconnect() {
				this.observing = 0;
			}
		},
		AudioContext: function () {
			audioContexts.push(audio.audioContext);
			return audio.audioContext;
		}
	};
	const doc = {
		defaultView: win,
		createElement(tag: string) {
			const el = fakeElement(tag);
			if (tag === 'canvas') {
				canvasEl = el;
				const ctx = createCanvas(1, 1).getContext('2d');
				Object.assign(el, {
					getContext: () => ctx,
					getBoundingClientRect: () => ({ left: 0, top: 0 })
				});
			} else {
				Object.assign(el, { getBoundingClientRect: () => ({ left: 0, top: parseFloat(canvasEl?.style.height ?? '0') }) });
			}
			return el;
		}
	};
	const container = Object.assign(fakeElement('div'), {
		style: { overflow: '' } as Record<string, string>,
		ownerDocument: doc,
		clientWidth: 800,
		clientHeight: 300,
		scrollTop: 0,
		scrollHeight: 0,
		scrollTo() {},
		append(...nodes: ReturnType<typeof fakeElement>[]) {
			for (const node of nodes) {
				node.parent = container;
				container.children.push(node);
			}
		}
	});
	return { container, observers, audioContexts, audio };
}

describe('mountScore', () => {
	let dom: ReturnType<typeof fakeDom>;
	let view: ScoreView;

	beforeEach(async () => {
		vi.useFakeTimers();
		// `loadSmuflFont` needs a browser's font loading; a no-op stands in.
		vi.stubGlobal('FontFace', class { load = async () => {}; });
		vi.stubGlobal('document', { fonts: { add() {} } });
		dom = fakeDom();
		view = await mountScore(dom.container as unknown as HTMLElement, repeatsXml);
	});

	afterEach(() => {
		view.destroy();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	/** Advance the audio clock and the scheduler's timer together. */
	const playFor = (seconds: number) => {
		for (let t = 0; t < seconds; t += 0.05) {
			dom.audio.setCurrentTime(dom.audio.audioContext.currentTime + 0.05);
			vi.advanceTimersByTime(50);
		}
	};

	it('fits the container, makes it scrollable, and reports clicks on notes', () => {
		expect(dom.container.style.overflow).toBe('auto');
		expect(dom.container.children).toHaveLength(2);
		expect(view.layout.width).toBeLessThanOrEqual(800);

		const note = view.layout.measures[0]!.notes[0]!;
		const hits: unknown[] = [];
		view.on('noteclick', (hit) => hits.push(hit && hit.noteId));
		const { x, y, width, height } = note.bounds;
		(view.canvas as unknown as ReturnType<typeof fakeElement>).dispatch('pointerdown', {
			clientX: x + width / 2,
			clientY: y + height / 2
		});
		expect(hits).toEqual([note.id]);
	});

	it('creates the AudioContext on first play, and load replaces the score and stops playback', () => {
		expect(dom.audioContexts).toHaveLength(0);
		view.play();
		playFor(0.5);
		expect(dom.audioContexts).toHaveLength(1);
		expect(view.isPlaying).toBe(true);
		expect(view.positionSeconds).toBeGreaterThan(0);

		const replacement = createDemoScore();
		view.load(replacement);
		expect(view.score).toBe(replacement);
		expect(view.isPlaying).toBe(false);
		expect(view.positionSeconds).toBe(0);
		expect(view.renderer.layout).toBe(view.layout);
	});

	it('fires end once when playback runs off the end', () => {
		let ends = 0;
		view.on('end', () => ends++);
		view.seek(view.durationSeconds - 0.5);
		view.play();
		playFor(2);
		expect(ends).toBe(1);
		expect(view.isPlaying).toBe(false);
		playFor(1);
		expect(ends).toBe(1);
	});

	it('destroy releases everything it took and is idempotent', () => {
		view.play();
		view.destroy();
		view.destroy();
		expect(dom.container.children).toHaveLength(0);
		expect(dom.container.listenerCount()).toBe(0);
		expect((view.canvas as unknown as ReturnType<typeof fakeElement>).listenerCount()).toBe(0);
		expect(dom.observers.map((o) => o.observing)).toEqual([0]);
		expect(dom.audio.closeCalls()).toBe(1);
		expect(dom.container.style.overflow).toBe('');
		vi.runAllTimers();
		expect(view.isPlaying).toBe(false);
	});
});
