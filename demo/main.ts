// The Phase 0 demo: what a host application has to write.
//
// Everything framework-specific lives in this file, and it is about a hundred
// lines: load the font, size a canvas, translate pointer coordinates, bind two
// keys. The engine itself never sees a DOM event. That is the framework-agnostic
// principle in practice, and it is what makes the eventual Svelte adapter for
// Divisi's editor and player a wrapper rather than a port.

import bravuraUrl from '../assets/bravura/Bravura.woff2?url';
import {
	CanvasRenderer,
	createDemoScore,
	hitTest,
	layoutScore,
	loadSmuflFont,
	relayoutMeasure,
	type LaidOutScore,
	type NoteId
} from '../src/index.js';

const canvas = document.querySelector<HTMLCanvasElement>('#score')!;
const status = document.querySelector<HTMLElement>('#status')!;
const timings = document.querySelector<HTMLElement>('#timings')!;
const upButton = document.querySelector<HTMLButtonElement>('#up')!;
const downButton = document.querySelector<HTMLButtonElement>('#down')!;
const fullButton = document.querySelector<HTMLButtonElement>('#full')!;
const flashButton = document.querySelector<HTMLButtonElement>('#flash')!;

// These mirror index.html's own CSS (`body { max-width: 60rem; padding: 2rem
// 1.5rem; }`, `#score { border: 1px solid #ddd; }`) so `systemWidthForViewport`
// can work out how much room the canvas actually has without waiting on a
// layout/paint round trip to measure it.
const BODY_MAX_WIDTH_PX = 960;
const BODY_HORIZONTAL_PADDING_PX = 48;
const CANVAS_BORDER_PX = 2;

/**
 * How wide a system is allowed to be at the current viewport size.
 *
 * This is what makes the demo actually exercise multi-system wrapping instead
 * of leaving it a knob nothing ever turns: on a wide viewport it comes out
 * roomy enough that the four-measure demo score fits on one system, same as
 * before this feature existed; on a narrow one it comes out small enough that
 * measures cast off onto new systems instead of every one of them being
 * squeezed to fit, which was the bug this feature exists to close.
 */
function systemWidthForViewport(): number {
	const bodyContentWidth = Math.min(window.innerWidth, BODY_MAX_WIDTH_PX) - BODY_HORIZONTAL_PADDING_PX;
	return Math.max(200, bodyContentWidth - CANVAS_BORDER_PX);
}

const score = createDemoScore();
let layoutOptions = { staffSpacePx: 11, systemWidthPx: systemWidthForViewport() };
let layout: LaidOutScore = layoutScore(score, layoutOptions);
let selected: NoteId | null = null;

const ctx = canvas.getContext('2d')!;
const renderer = new CanvasRenderer(ctx, layout, { background: '#ffffff' });

/**
 * Size the backing store for the display's pixel density and scale the context
 * to match, so layout can keep working in CSS pixels. Without this, every glyph
 * is resampled from a 1x bitmap on a retina screen and the staff lines blur.
 */
function sizeCanvas(): void {
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.ceil(layout.width * dpr);
	canvas.height = Math.ceil(layout.height * dpr);
	canvas.style.width = `${layout.width}px`;
	canvas.style.height = `${layout.height}px`;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawAll(): number {
	const started = performance.now();
	renderer.drawAll();
	return performance.now() - started;
}

/** Transpose the selected note and repaint only the measure it lives in. */
function transposeSelected(semitones: number): void {
	if (selected === null) return;
	const started = performance.now();

	const touched = score.transposeNote(selected, semitones);
	if (touched === null) {
		status.textContent = 'Rests have no pitch to transpose.';
		return;
	}

	// Try the incremental path first. It declines when the edit would change the
	// measure's width or overflow the canvas, which a transpose never does but a
	// duration edit would, and then the only correct answer is a full pass.
	const updated = relayoutMeasure(score, layout, touched, layoutOptions);
	let scoped = true;
	if (updated) {
		layout = updated;
		renderer.setLayout(layout);
		renderer.redrawMeasure(touched);
	} else {
		scoped = false;
		layout = layoutScore(score, layoutOptions);
		renderer.setLayout(layout);
		sizeCanvas();
		renderer.drawAll();
	}
	const elapsed = performance.now() - started;
	lastScopedMeasures = [...renderer.lastRedrawnMeasures];

	status.textContent = scoped
		? `Transposed note ${selected} in measure ${touched + 1}. Redrew measure ${touched + 1} only.`
		: `Transposed note ${selected}: the edit changed the system's geometry, so the whole score was re-laid-out.`;
	report(elapsed, touched);
}

/**
 * The full-redraw figure is whatever the last whole-score pass cost, not a
 * comparison run after every edit. Running one would repaint the screen and
 * quietly falsify the thing the demo is showing, which is that an edit leaves
 * every other measure's pixels alone.
 */
let lastFullDrawMs = 0;
let lastScopedMeasures: number[] = [];

function report(scopedMs: number, measureIndex: number): void {
	const region = layout.measures[measureIndex]!.region;
	const areaRatio = (region.width * region.height) / (layout.width * layout.height);
	timings.textContent = [
		`edit -> measure ${measureIndex + 1} repainted   ${scopedMs.toFixed(2)} ms`,
		`last whole-score repaint           ${lastFullDrawMs.toFixed(2)} ms`,
		`speedup                            ${(lastFullDrawMs / scopedMs).toFixed(1)}x`,
		`pixels touched                     ${(areaRatio * 100).toFixed(1)}% of the canvas`
	].join('\n');
}

canvas.addEventListener('pointerdown', (event) => {
	// Pointer coordinates are relative to the viewport and in CSS pixels; layout
	// works in CSS pixels relative to the canvas origin. The engine deliberately
	// does not do this conversion, because only the host knows what else it has
	// done to the canvas (zoom, scroll, transforms). Here that "what else": the
	// canvas is now sized to fit its laid-out content (multi-system wrapping
	// keeps every system within `systemWidthPx`, so this is normally a no-op),
	// but `max-width: 100%` on #score is kept as a belt-and-suspenders safety
	// net for a viewport narrower than even one system, which still shrinks
	// the CSS box below layout.width and would otherwise point at the wrong
	// note (or none).
	const rect = canvas.getBoundingClientRect();
	const scaleX = layout.width / rect.width;
	const scaleY = layout.height / rect.height;
	const hit = hitTest(
		layout,
		(event.clientX - rect.left) * scaleX,
		(event.clientY - rect.top) * scaleY
	);
	const changed = renderer.setSelection(hit ? hit.noteId : null);
	selected = hit ? hit.noteId : null;
	if (changed.length > 0) renderer.redrawMeasures(changed);
	upButton.disabled = selected === null;
	downButton.disabled = selected === null;
	status.textContent = hit
		? `Selected note ${hit.noteId} in measure ${hit.measureIndex + 1}.`
		: 'Nothing selected. Click a notehead or a rest.';
});

window.addEventListener('keydown', (event) => {
	if (event.key === 'ArrowUp') transposeSelected(1);
	else if (event.key === 'ArrowDown') transposeSelected(-1);
	else return;
	event.preventDefault();
});

upButton.addEventListener('click', () => transposeSelected(1));
downButton.addEventListener('click', () => transposeSelected(-1));
fullButton.addEventListener('click', () => {
	lastFullDrawMs = drawAll();
	lastScopedMeasures = [...renderer.lastRedrawnMeasures];
	status.textContent = `Repainted all ${layout.measures.length} measures.`;
	timings.textContent = `whole-score repaint                ${lastFullDrawMs.toFixed(2)} ms`;
});

// A visible answer to "did it really only touch that region": tint whatever the
// last draw call painted, then put it back. The redraw itself is too fast to see.
flashButton.addEventListener('click', () => {
	if (lastScopedMeasures.length === 0) return;
	const measures = lastScopedMeasures.map((index) => layout.measures[index]!);
	ctx.save();
	ctx.fillStyle = 'rgba(194, 65, 12, 0.18)';
	for (const measure of measures) {
		const { x, y, width, height } = measure.region;
		ctx.fillRect(x, y, width, height);
	}
	ctx.restore();
	window.setTimeout(() => renderer.redrawMeasures(lastScopedMeasures), 450);
});

// Resizing the window changes how much room a system has, so it can change
// how measures cast off; debounced because `resize` fires continuously while
// dragging, and re-laying-out the whole score on every one of those events
// would be wasteful (and would misleadingly dominate the "whole-score
// repaint" timing this page reports).
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
	window.clearTimeout(resizeTimer);
	resizeTimer = window.setTimeout(() => {
		layoutOptions = { ...layoutOptions, systemWidthPx: systemWidthForViewport() };
		layout = layoutScore(score, layoutOptions);
		renderer.setLayout(layout);
		sizeCanvas();
		lastFullDrawMs = drawAll();
		lastScopedMeasures = [...renderer.lastRedrawnMeasures];
		status.textContent = `Window resized: re-laid-out across ${layout.systems.length} system(s).`;
		timings.textContent = `whole-score repaint                ${lastFullDrawMs.toFixed(2)} ms`;
	}, 150);
});

async function start(): Promise<void> {
	// Canvas has no "the font arrived" callback: text drawn before the font
	// loads renders as tofu and stays that way, so the first draw waits.
	await loadSmuflFont(bravuraUrl);
	sizeCanvas();
	lastFullDrawMs = drawAll();
	lastScopedMeasures = [...renderer.lastRedrawnMeasures];
	status.textContent = 'Click a notehead or a rest to select it.';
	timings.textContent = `initial whole-score draw           ${lastFullDrawMs.toFixed(2)} ms`;
}

void start();
