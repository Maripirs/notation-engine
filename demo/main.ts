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
	computePlaybackTimeline,
	createFullDemoScore,
	createGrandStaffShowcaseScore,
	hitTest,
	layoutScore,
	loadSmuflFont,
	PlaybackEngine,
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
const playbackPlayButton = document.querySelector<HTMLButtonElement>('#playback-play')!;
const playbackPauseButton = document.querySelector<HTMLButtonElement>('#playback-pause')!;
const playbackStopButton = document.querySelector<HTMLButtonElement>('#playback-stop')!;
const playbackPosition = document.querySelector<HTMLElement>('#playback-position')!;
const playbackOnset = document.querySelector<HTMLElement>('#playback-onset')!;

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

/**
 * Renders a position in seconds as `m:ss.d`, e.g. `0:07.3`: minutes, a
 * zero-padded two-digit seconds field, one decimal. Used by both the running
 * position readout and the "reset to zero" text Stop writes immediately.
 */
function formatPosition(seconds: number): string {
	const clamped = Math.max(0, seconds);
	const minutes = Math.floor(clamped / 60);
	const secondsWithinMinute = clamped - minutes * 60;
	return `${minutes}:${secondsWithinMinute.toFixed(1).padStart(4, '0')}`;
}

const score = createFullDemoScore();
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
	// A selection change touches at most two measures (the old note's and the
	// new one's), and in principle those can sit on two different staves, so
	// each pair is redrawn on its own staff rather than batching them through
	// one `redrawMeasures` call, which only takes a single `staffIndex` for
	// the whole batch (M4 Slice 1: see `CanvasRenderer.setSelection`'s own
	// doc comment on why the pair's `staffIndex` can no longer be assumed 0).
	for (const { staffIndex, index } of changed) renderer.redrawMeasure(index, staffIndex);
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

// --- Playback -----------------------------------------------------------
//
// One AudioContext and one PlaybackEngine, built lazily on the first Play
// click rather than at module load. Two reasons, both about that first
// click: the browser's autoplay policy requires an AudioContext to be
// created (or resumed) from inside a user-gesture handler, so building one
// eagerly here would either start it suspended or, in stricter browsers,
// throw outright; and PlaybackEngine itself owns the paused-position state
// across calls (see its own `basePosition`/`baseAudioTime` doc comment), so
// once built it is reused for every later play/pause/stop click rather than
// reconstructed, which would silently discard wherever a prior pause left
// off.
let playbackEngine: PlaybackEngine | null = null;
let totalPlaybackSeconds = 0;
let positionLoopRunning = false;

function ensurePlaybackEngine(): PlaybackEngine {
	if (playbackEngine) return playbackEngine;

	const events = computePlaybackTimeline(score);
	totalPlaybackSeconds = events.reduce(
		(latest, event) => Math.max(latest, event.startSeconds + event.durationSeconds),
		0
	);

	const audioContext = new AudioContext();
	playbackEngine = new PlaybackEngine({
		events,
		audioContext,
		// Exercises Slice 6's onset-callback half (not just its position-query
		// half, which the rAF loop below covers): fires once per note right as
		// it is handed to the audio clock.
		onOnset: (event) => {
			playbackOnset.textContent = `note ${event.noteId} at ${event.startSeconds.toFixed(2)}s`;
		}
	});
	return playbackEngine;
}

/**
 * Polls `positionSeconds` once per frame while playing. PlaybackEngine does
 * not flip `isPlaying` false on its own when playback runs off the end of
 * the timeline, only on an explicit pause()/stop() (see its own doc
 * comments), so this loop does not try to detect "playback finished"
 * itself: it just keeps polling for as long as `isPlaying` is true, driven
 * off the same flag the button handlers below set, and stops rescheduling
 * itself the moment that flag goes false.
 */
function schedulePositionUpdate(): void {
	if (!playbackEngine || !playbackEngine.isPlaying) {
		positionLoopRunning = false;
		return;
	}
	playbackPosition.textContent =
		`${formatPosition(playbackEngine.positionSeconds)} / ${formatPosition(totalPlaybackSeconds)}`;
	requestAnimationFrame(schedulePositionUpdate);
}

playbackPlayButton.addEventListener('click', () => {
	const engine = ensurePlaybackEngine();
	engine.play();
	// Play stays enabled so it also doubles as "resume" after a pause.
	playbackPauseButton.disabled = false;
	playbackStopButton.disabled = false;
	if (!positionLoopRunning) {
		positionLoopRunning = true;
		schedulePositionUpdate();
	}
});

playbackPauseButton.addEventListener('click', () => {
	playbackEngine?.pause();
	playbackPauseButton.disabled = true;
});

playbackStopButton.addEventListener('click', () => {
	playbackEngine?.stop();
	playbackPauseButton.disabled = true;
	playbackStopButton.disabled = true;
	// Reset the readout immediately rather than waiting on the next rAF tick,
	// which may be a frame away or, since the loop only reschedules itself
	// while isPlaying is true, may never come at all.
	playbackPosition.textContent = `${formatPosition(0)} / ${formatPosition(totalPlaybackSeconds)}`;
});

// --- Multi-staff selection (M4 Slice 1) ---------------------------------
//
// A second, independent canvas/renderer pair for `createGrandStaffShowcaseScore`
// (two staves, treble over bass). Not folded into the main canvas above:
// `createFullDemoScore` cannot include it (`appendMeasures` only ever merges
// into staff 0, see that score's own doc comment), so it needs its own score,
// its own layout and its own renderer. This canvas does not need to track the
// window's width the way the main one does, so its `systemWidthPx` is just a
// fixed constant rather than `systemWidthForViewport()`.
const staffSelectCanvas = document.querySelector<HTMLCanvasElement>('#staff-select-demo')!;
const staffSelectStatus = document.querySelector<HTMLElement>('#staff-select-status')!;

const staffSelectScore = createGrandStaffShowcaseScore();
const staffSelectLayoutOptions = { staffSpacePx: 11, systemWidthPx: 700 };
const staffSelectLayout: LaidOutScore = layoutScore(staffSelectScore, staffSelectLayoutOptions);
const staffSelectCtx = staffSelectCanvas.getContext('2d')!;
const staffSelectRenderer = new CanvasRenderer(staffSelectCtx, staffSelectLayout, { background: '#ffffff' });

/** Same retina-sizing trick as the main canvas's own `sizeCanvas`, above. */
function sizeStaffSelectCanvas(): void {
	const dpr = window.devicePixelRatio || 1;
	staffSelectCanvas.width = Math.ceil(staffSelectLayout.width * dpr);
	staffSelectCanvas.height = Math.ceil(staffSelectLayout.height * dpr);
	staffSelectCanvas.style.width = `${staffSelectLayout.width}px`;
	staffSelectCanvas.style.height = `${staffSelectLayout.height}px`;
	staffSelectCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

staffSelectCanvas.addEventListener('pointerdown', (event) => {
	// Same coordinate-scaling logic as the main canvas's own handler, above.
	const rect = staffSelectCanvas.getBoundingClientRect();
	const scaleX = staffSelectLayout.width / rect.width;
	const scaleY = staffSelectLayout.height / rect.height;
	const hit = hitTest(
		staffSelectLayout,
		(event.clientX - rect.left) * scaleX,
		(event.clientY - rect.top) * scaleY
	);
	// The fixed version of the main canvas's handler above: each affected
	// pair is redrawn against its own `staffIndex`, so a click on the bass
	// staff never touches the treble staff's same-numbered measure.
	const changed = staffSelectRenderer.setSelection(hit ? hit.noteId : null);
	for (const { staffIndex, index } of changed) staffSelectRenderer.redrawMeasure(index, staffIndex);
	staffSelectStatus.textContent = hit
		? `Selected note ${hit.noteId} on staff ${hit.staffIndex} (${hit.staffIndex === 0 ? 'treble' : 'bass'}), ` +
			`measure ${hit.measureIndex + 1}. Redrew staff ${hit.staffIndex}'s measure ${hit.measureIndex + 1} only.`
		: 'Nothing selected. Click a notehead or a rest.';
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

	sizeStaffSelectCanvas();
	staffSelectRenderer.drawAll();
}

void start();
