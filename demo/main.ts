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
	EditHistory,
	exportMusicXml,
	hitTest,
	hitTestMeasure,
	importMusicXml,
	layoutScore,
	loadSmuflFont,
	PlaybackEngine,
	regionForNote,
	relayoutMeasure,
	type ClefType,
	type LaidOutScore,
	type NoteId
} from '../src/index.js';

const canvas = document.querySelector<HTMLCanvasElement>('#score')!;
/**
 * The scrollable wrapper around `canvas` (M4 Slice 4's demo check). Its
 * `max-height` is fixed and deliberately modest in `index.html`'s CSS
 * (`#score-scroll`'s own comment there has the exact figure and the reasoning),
 * chosen so `createFullDemoScore()`'s full height does not fit without
 * scrolling once it casts off into multiple systems. `systemWidthForViewport()`
 * below is left exactly as it already was rather than pinned to some other,
 * demo-specific width: at a typical viewport width `createFullDemoScore()`
 * (26 measures, not the 4-measure score `systemWidthForViewport`'s own
 * original comment describes, see that comment) already casts off into well
 * over a dozen systems (checked directly by running `layoutScore` at 910px,
 * this repo's effective body content width, and reading `layout.systems.length`
 * before writing any of this), so there is already a real multi-system case
 * for auto-scroll to follow without changing the layout options at all; only
 * the wrapper's height needed to shrink to make that vertical overflow, and
 * therefore scrolling, actually happen.
 */
const scoreScroll = document.querySelector<HTMLElement>('#score-scroll')!;
const status = document.querySelector<HTMLElement>('#status')!;
const timings = document.querySelector<HTMLElement>('#timings')!;
const upButton = document.querySelector<HTMLButtonElement>('#up')!;
const downButton = document.querySelector<HTMLButtonElement>('#down')!;
const fullButton = document.querySelector<HTMLButtonElement>('#full')!;
const flashButton = document.querySelector<HTMLButtonElement>('#flash')!;
const seamsButton = document.querySelector<HTMLButtonElement>('#seams')!;
const zoomOutButton = document.querySelector<HTMLButtonElement>('#zoom-out')!;
const zoomInButton = document.querySelector<HTMLButtonElement>('#zoom-in')!;
const playbackPlayButton = document.querySelector<HTMLButtonElement>('#playback-play')!;
const playbackPauseButton = document.querySelector<HTMLButtonElement>('#playback-pause')!;
const playbackStopButton = document.querySelector<HTMLButtonElement>('#playback-stop')!;
const playbackPosition = document.querySelector<HTMLElement>('#playback-position')!;
const playbackOnset = document.querySelector<HTMLElement>('#playback-onset')!;
const staffSelectCursorButton = document.querySelector<HTMLButtonElement>('#staff-select-cursor-demo')!;
const staffSelectUndoButton = document.querySelector<HTMLButtonElement>('#staff-select-undo')!;
const staffSelectRedoButton = document.querySelector<HTMLButtonElement>('#staff-select-redo')!;
const clefButtons = document.querySelectorAll<HTMLButtonElement>('button[data-clef]');
const undoButton = document.querySelector<HTMLButtonElement>('#undo')!;
const redoButton = document.querySelector<HTMLButtonElement>('#redo')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const openInput = document.querySelector<HTMLInputElement>('#open')!;
const dirtyIndicator = document.querySelector<HTMLElement>('#dirty')!;

// These mirror index.html's own CSS (`body { max-width: 60rem; padding: 2rem
// 1.5rem; }`, `#score { border: 1px solid #ddd; }`) so `systemWidthForViewport`
// can work out how much room the canvas actually has without waiting on a
// layout/paint round trip to measure it.
const BODY_MAX_WIDTH_PX = 960;
const BODY_HORIZONTAL_PADDING_PX = 48;
const CANVAS_BORDER_PX = 2;

/**
 * Bounds and step for the zoom control (M4 Slice 3). `staffSpacePx` is
 * "the single knob that scales the whole render" (see `LayoutOptions`'s own
 * doc comment in `src/layout/layout.ts`), so zooming is nothing more than
 * re-laying-out at a different value of it; these three constants just keep
 * a human mashing the button from zooming the score into an unreadable
 * sliver or off past any plausible viewport. Not derived from anything
 * principled, just wide enough to be useful and narrow enough to stay sane.
 */
const MIN_STAFF_SPACE_PX = 5;
const MAX_STAFF_SPACE_PX = 20;
const ZOOM_STEP_STAFF_SPACE_PX = 1;

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

/**
 * The demo's undo/redo stack, and the owner of the live score. There is no
 * module-level `score` variable on purpose: `EditHistory`'s constructor clones
 * what it is given, and `undo`/`redo` swap a *different* `Score` object in as
 * `current` (see `EditHistory`'s own header comment), so any long-lived
 * reference to "the score" would silently go stale after the first undo.
 * Every read below goes through `history.current` instead, and every edit
 * through `history.record`. The renderer itself never holds a `Score`, only
 * a `LaidOutScore`, so it needs no re-pointing beyond the usual `setLayout`.
 */
// `let`, not `const`, since M6 Slice 2's Open MusicXML control replaces the
// whole history with a fresh one for the opened file (see `openMusicXml`).
let history = new EditHistory(createFullDemoScore());
let layoutOptions = { staffSpacePx: 11, systemWidthPx: systemWidthForViewport() };
let layout: LaidOutScore = layoutScore(history.current, layoutOptions);
let selected: NoteId | null = null;

const ctx = canvas.getContext('2d')!;
const renderer = new CanvasRenderer(ctx, layout, { background: '#ffffff' });

/**
 * Size the backing store for the display's pixel density and scale the context
 * to match, so layout can keep working in CSS pixels. Without this, every glyph
 * is resampled from a 1x bitmap on a retina screen and the staff lines blur.
 */
function sizeCanvas(): void {
	// Browsers refuse to allocate a canvas taller than ~32k device pixels (it
	// silently renders blank), and an opened real score (M6 Slice 2: Les Djinns
	// is ~43k CSS pixels tall at the default zoom) passes that at any pixel
	// ratio above 0.75. Lowering the backing-store density for such a score
	// trades some crispness for a canvas that draws at all.
	const MAX_CANVAS_DEVICE_PX = 32767;
	const dpr = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DEVICE_PX / Math.max(layout.width, layout.height));
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

	// Routed through `record` so the pre-edit state is snapshotted for undo.
	// `record` only keeps that snapshot when the edit reports a change, so a
	// no-op on a rest leaves the undo stack (and the dirty flag) alone.
	const noteId = selected;
	// `transposeNote` reports a staff-local measure index; an opened
	// multi-staff file (M6 Slice 2's Open MusicXML) can select a note on any
	// staff, so the scoped relayout and redraw need the staff too.
	const staffIndex = history.current.measureOfNote(noteId)?.staffIndex ?? 0;
	const touched = history.record((score) => score.transposeNote(noteId, semitones));
	if (touched === null) {
		status.textContent = 'Rests have no pitch to transpose.';
		return;
	}
	markScoreChanged();

	// Try the incremental path first. It declines when the edit would change the
	// measure's width or overflow the canvas, which a transpose never does but a
	// duration edit would, and then the only correct answer is a full pass.
	const updated = relayoutMeasure(history.current, layout, touched, layoutOptions, staffIndex);
	let scoped = true;
	if (updated) {
		layout = updated;
		renderer.setLayout(layout);
		renderer.redrawMeasure(touched, staffIndex);
	} else {
		scoped = false;
		layout = layoutScore(history.current, layoutOptions);
		renderer.setLayout(layout);
		sizeCanvas();
		renderer.drawAll();
	}
	const elapsed = performance.now() - started;
	lastScopedMeasures = [...renderer.lastRedrawnMeasures];

	status.textContent = scoped
		? `Transposed note ${selected} in measure ${touched + 1}. Redrew measure ${touched + 1} only.`
		: `Transposed note ${selected}: the edit changed the system's geometry, so the whole score was re-laid-out.`;
	report(elapsed, touched, staffIndex);
}

/**
 * Step the history one way or the other and repaint.
 *
 * Unlike `transposeSelected`, this always does a full re-layout rather than
 * a scoped one: the score `undo`/`redo` swaps in is a different object that
 * could in principle differ from the old one in any measure, and working out
 * which would mean diffing two scores. A whole-score pass is simpler and
 * always correct, and at demo scale it is fast enough not to matter. The
 * selection survives for free: `Score.clone` preserves note ids, and the
 * renderer keys its highlight by `NoteId` (see `setZoom`'s doc comment below),
 * so the same note is still selected and tinted in the restored score.
 */
function stepHistory(direction: 'undo' | 'redo'): void {
	const restored = direction === 'undo' ? history.undo() : history.redo();
	if (restored === null) return;
	markScoreChanged();

	layout = layoutScore(history.current, layoutOptions);
	renderer.setLayout(layout);
	sizeCanvas();
	lastFullDrawMs = drawAll();
	lastScopedMeasures = [...renderer.lastRedrawnMeasures];
	status.textContent = direction === 'undo'
		? 'Undid transpose. Re-laid-out and repainted the whole score.'
		: 'Redid transpose. Re-laid-out and repainted the whole score.';
	timings.textContent = `whole-score repaint                ${lastFullDrawMs.toFixed(2)} ms`;
}

/**
 * Refresh everything that depends on the history's state: the Undo/Redo
 * buttons' enabled state and the saved/unsaved indicator. Called after every
 * record, undo, redo and save, and once at startup.
 */
function refreshHistoryControls(): void {
	undoButton.disabled = !history.canUndo;
	redoButton.disabled = !history.canRedo;
	const dirty = history.dirty;
	dirtyIndicator.textContent = dirty ? 'Unsaved changes' : 'Saved';
	dirtyIndicator.classList.toggle('dirty', dirty);
}

/**
 * Bookkeeping after any change to `history.current` (an edit, an undo or a
 * redo): refresh the history controls, and flag the playback timeline as
 * stale so the next Play rebuilds it from the current score (see
 * `playbackTimelineStale` below).
 */
function markScoreChanged(): void {
	playbackTimelineStale = true;
	refreshHistoryControls();
}

/**
 * Download the current score as MusicXML, then bless it as the saved
 * baseline. A temporary `<a download>` is the standard way to hand the
 * browser a file from memory without a server round trip; the object URL is
 * revoked right after the click, since the download has already captured the
 * Blob by then.
 */
function saveMusicXml(): void {
	const xml = exportMusicXml(history.current);
	const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = 'score.musicxml';
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
	history.markSaved();
	refreshHistoryControls();
	status.textContent = 'Saved the score as score.musicxml.';
}

/**
 * The full-redraw figure is whatever the last whole-score pass cost, not a
 * comparison run after every edit. Running one would repaint the screen and
 * quietly falsify the thing the demo is showing, which is that an edit leaves
 * every other measure's pixels alone.
 */
let lastFullDrawMs = 0;
let lastScopedMeasures: number[] = [];

function report(scopedMs: number, measureIndex: number, staffIndex = 0): void {
	const measure = layout.measures.find((m) => m.index === measureIndex && m.staffIndex === staffIndex);
	if (!measure) return;
	const region = measure.region;
	const areaRatio = (region.width * region.height) / (layout.width * layout.height);
	timings.textContent = [
		`edit -> measure ${measureIndex + 1} repainted   ${scopedMs.toFixed(2)} ms`,
		`last whole-score repaint           ${lastFullDrawMs.toFixed(2)} ms`,
		`speedup                            ${(lastFullDrawMs / scopedMs).toFixed(1)}x`,
		`pixels touched                     ${(areaRatio * 100).toFixed(1)}% of the canvas`
	].join('\n');
}

canvas.addEventListener('pointerdown', (event) => {
	activeHistoryCanvas = 'main';
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

/**
 * Which canvas's own `EditHistory` the keyboard undo/redo shortcuts step
 * (M5 Slice 5 gave the grand-staff canvas below a history of its own): the
 * one the user last clicked on, or used a history-changing button of. The
 * main canvas by default, so the shortcuts keep their pre-slice behaviour
 * until the grand-staff canvas is actually touched.
 */
let activeHistoryCanvas: 'main' | 'staffSelect' = 'main';

window.addEventListener('keydown', (event) => {
	// Cmd on macOS, Ctrl elsewhere; either is accepted on any platform rather
	// than sniffing the OS. `event.key` is lowercase 'z' without Shift and
	// usually uppercase 'Z' with it, so compare case-insensitively.
	const modifier = event.metaKey || event.ctrlKey;
	const key = event.key.toLowerCase();
	const step = activeHistoryCanvas === 'main' ? stepHistory : stepStaffSelectHistory;
	if (modifier && key === 'z') step(event.shiftKey ? 'redo' : 'undo');
	else if (modifier && key === 'y') step('redo');
	else if (event.key === 'ArrowUp') transposeSelected(1);
	else if (event.key === 'ArrowDown') transposeSelected(-1);
	else return;
	event.preventDefault();
});

upButton.addEventListener('click', () => transposeSelected(1));
downButton.addEventListener('click', () => transposeSelected(-1));
undoButton.addEventListener('click', () => {
	activeHistoryCanvas = 'main';
	stepHistory('undo');
});
redoButton.addEventListener('click', () => {
	activeHistoryCanvas = 'main';
	stepHistory('redo');
});
saveButton.addEventListener('click', saveMusicXml);

/**
 * Replace the main canvas's score with a MusicXML file the user picked (M6
 * Slice 2's demo check: an SFCC fixture such as
 * `src/test/fixtures/sfcc/Faure__-_Les_djinns__Op._12.musicxml`, chords and
 * all). The opened score gets a fresh `EditHistory`, so Undo cannot step back
 * into the demo score and the file opens as "Saved"; selection, seam markers
 * and any running playback are cleared since they all named the old score's
 * notes and measures.
 */
async function openMusicXml(file: File): Promise<void> {
	const started = performance.now();
	const score = importMusicXml(await file.text());
	const imported = performance.now();
	playbackEngine?.stop();
	history = new EditHistory(score);
	for (const { staffIndex, index } of renderer.setSelection(null)) renderer.redrawMeasure(index, staffIndex);
	selected = null;
	upButton.disabled = true;
	downButton.disabled = true;
	seamsOn = false;
	renderer.setSeamMarkers([]);
	seamsButton.textContent = 'Show seam markers';
	markScoreChanged();
	layout = layoutScore(history.current, layoutOptions);
	const laidOut = performance.now();
	renderer.setLayout(layout);
	sizeCanvas();
	lastFullDrawMs = drawAll();
	lastScopedMeasures = [...renderer.lastRedrawnMeasures];
	scoreScroll.scrollTo({ top: 0 });
	const noteCount = score.staves.reduce(
		(sum, staff) => sum + staff.measures.reduce((n, measure) => n + measure.notes.length, 0),
		0
	);
	status.textContent =
		`Opened ${file.name}: ${score.staves.length} staves, ${score.staves[0]?.measures.length ?? 0} measures, ` +
		`${noteCount} notes and rests, across ${layout.systems.length} system(s).`;
	timings.textContent = [
		`import                             ${(imported - started).toFixed(2)} ms`,
		`layout                             ${(laidOut - imported).toFixed(2)} ms`,
		`whole-score repaint                ${lastFullDrawMs.toFixed(2)} ms`
	].join('\n');
}

openInput.addEventListener('change', () => {
	const file = openInput.files?.[0];
	if (!file) return;
	openMusicXml(file).catch((error: unknown) => {
		status.textContent = `Could not open ${file.name}: ${error instanceof Error ? error.message : String(error)}`;
	});
	// Clearing the value lets the same file be picked again after an edit.
	openInput.value = '';
});
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

// Seam markers (M5 Slice 6). Stands in for an OMR host marking where one
// stitched scan fragment ends and the next begins: the host owns the list,
// the engine just draws it. Hand-picked boundaries, plus the first measure of
// the second system so one mark lands on a system break (computed from the
// current layout at toggle time, since where the score casts off depends on
// the window width). `setSeamMarkers` only takes effect on the next
// `drawAll`, so toggling repaints the whole score once; after that, a
// transpose's scoped `redrawMeasure` keeps the marks intact on its own.
let seamsOn = false;

function demoSeamBoundaries(): { staffIndex: number; boundaryIndex: number }[] {
	const staffMeasures = layout.measures.filter((m) => m.staffIndex === 0).length;
	const staffSystems = layout.systems.filter((system) => system.staffIndex === 0);
	const systemBreak = staffSystems[1]?.measureIndices[0];
	const picked = new Set([1, 5, staffMeasures]);
	if (systemBreak !== undefined) picked.add(systemBreak);
	return [...picked].sort((a, b) => a - b).map((boundaryIndex) => ({ staffIndex: 0, boundaryIndex }));
}

seamsButton.addEventListener('click', () => {
	seamsOn = !seamsOn;
	const boundaries = seamsOn ? demoSeamBoundaries() : [];
	renderer.setSeamMarkers(boundaries);
	lastFullDrawMs = drawAll();
	lastScopedMeasures = [...renderer.lastRedrawnMeasures];
	seamsButton.textContent = seamsOn ? 'Hide seam markers' : 'Show seam markers';
	status.textContent = seamsOn
		? `Seam markers at boundaries ${boundaries.map((b) => b.boundaryIndex).join(', ')} ` +
			'(boundary i = start of measure i, 0-based; the last is the final barline). ' +
			'Transpose a note next to one: the scoped redraw keeps the mark.'
		: 'Seam markers cleared.';
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
		layout = layoutScore(history.current, layoutOptions);
		renderer.setLayout(layout);
		sizeCanvas();
		lastFullDrawMs = drawAll();
		lastScopedMeasures = [...renderer.lastRedrawnMeasures];
		status.textContent = `Window resized: re-laid-out across ${layout.systems.length} system(s).`;
		timings.textContent = `whole-score repaint                ${lastFullDrawMs.toFixed(2)} ms`;
	}, 150);
});

/**
 * Rescale the score by `deltaStaffSpacePx` (positive to zoom in, negative to
 * zoom out), clamped to `MIN_STAFF_SPACE_PX`/`MAX_STAFF_SPACE_PX`.
 *
 * This is the whole zoom feature: `layoutScore` re-derives every coordinate
 * in the score from `staffSpacePx` alone (see that option's own doc comment
 * for why nothing else needs to change), so this function is a relayout at a
 * new value of it, `setLayout`, a resize, and a redraw, the same four steps
 * `transposeSelected`'s full-relayout fallback and the `resize` handler
 * below already do. `drawAll` is the right call here even though it is a
 * whole-canvas repaint: every pixel's position just changed, which is not
 * true of an ordinary edit, so this is not a violation of the
 * region-scoped-redraw invariant those other paths exist to prove. Whatever
 * note is currently selected and/or playback-cursor-highlighted stays
 * highlighted afterwards for free: both are keyed by `NoteId`, which
 * `setLayout` never touches (see `CanvasRenderer.setLayout`'s own doc
 * comment), so `#drawOps` finds the same note's new ops and tints them
 * exactly as before.
 */
function setZoom(deltaStaffSpacePx: number): void {
	const next = Math.min(
		MAX_STAFF_SPACE_PX,
		Math.max(MIN_STAFF_SPACE_PX, layoutOptions.staffSpacePx + deltaStaffSpacePx)
	);
	if (next === layoutOptions.staffSpacePx) return;

	layoutOptions = { ...layoutOptions, staffSpacePx: next };
	layout = layoutScore(history.current, layoutOptions);
	renderer.setLayout(layout);
	sizeCanvas();
	lastFullDrawMs = drawAll();
	lastScopedMeasures = [...renderer.lastRedrawnMeasures];
	status.textContent = `Zoomed to staffSpacePx ${next}. Repainted all ${layout.measures.length} measures.`;
	timings.textContent = `whole-score repaint                ${lastFullDrawMs.toFixed(2)} ms`;
}

zoomOutButton.addEventListener('click', () => setZoom(-ZOOM_STEP_STAFF_SPACE_PX));
zoomInButton.addEventListener('click', () => setZoom(ZOOM_STEP_STAFF_SPACE_PX));

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
let audioContext: AudioContext | null = null;
let totalPlaybackSeconds = 0;
/**
 * Set whenever `history.current` changes (an edit, undo or redo; see
 * `markScoreChanged`), so the engine's precomputed timeline no longer matches
 * the score on screen. `PlaybackEngine` takes its events once, at
 * construction, so the fix is to rebuild it, which `ensurePlaybackEngine`
 * does on the next Play click if the engine is not currently playing. An edit
 * made mid-playback therefore takes effect from the next pause/resume or
 * stop/play, not instantly. The `AudioContext` is reused across rebuilds
 * (browsers cap how many a page may create), and a paused position is carried
 * over via `seek`, so Play still resumes where Pause left off.
 */
let playbackTimelineStale = false;
let positionLoopRunning = false;

/**
 * Note ids accumulated from `onOnset` calls not yet flushed into a
 * `setPlaybackCursor` call (M4 Slice 2).
 *
 * `OnsetEvent` is always one note per event, even for a chord or a
 * simultaneous multi-voice onset (see its own doc comment in
 * `src/playback/timeline.ts`): several such events just share the same
 * `startSeconds`. `LookaheadScheduler.tick()` fires every event due in one
 * pass synchronously, back to back, in the same JS turn (see
 * `LookaheadScheduler`'s own doc comment), so every onset belonging to one
 * moment in playback time lands in this buffer before the `queueMicrotask`
 * flush below ever runs, however many notes sound at once. Without this
 * batching, two simultaneous notes would each trigger their own
 * `setPlaybackCursor` call, and the first call's single-note cursor would
 * flash on screen for one JS turn before the second call replaced it with
 * both notes, an artifact of scheduling order that has nothing to do with
 * the music.
 */
let pendingOnsetNoteIds: NoteId[] = [];
let onsetFlushQueued = false;

/**
 * Auto-scroll `#score-scroll` so the playback cursor's measure stays on
 * screen as playback proceeds into a later system (M4 Slice 4's demo check).
 *
 * `regionForNote` hands back the measure's region in the canvas's own
 * coordinate space; turning that into an actual scroll position is this
 * function's job, not the engine's, per `regionForNote`'s own doc comment
 * (the same framework-agnostic split `pointerdown` above already follows for
 * click coordinates). The canvas is one unstyled element with no child node
 * per note to hand to `Element.scrollIntoView`, so this computes a manual
 * `scrollTo` instead: `canvas.offsetTop` accounts for the canvas's own
 * position within the wrapper (0 today, since the canvas is the wrapper's
 * only child, but read rather than assumed in case that ever changes). That
 * only holds because `#score-scroll` is `position: relative` in index.html,
 * which makes it the canvas's `offsetParent`; without it `offsetTop` is
 * measured from the page body and every target overshoots by the height of
 * the prose above the score. Centring on the region's vertical midpoint
 * rather than snapping to its top edge keeps a system from sitting flush
 * against the wrapper's rim.
 *
 * It scrolls only when the measure is not already fully visible. Onsets fire
 * several times a second, and restarting a smooth scroll on every one (even
 * toward the same target) makes successive animations cancel each other and
 * the view visibly judder; in practice this now scrolls once per system.
 */
function followPlaybackCursor(noteId: NoteId): void {
	const region = regionForNote(layout, noteId);
	if (!region) return;
	const top = canvas.offsetTop + region.y;
	const viewTop = scoreScroll.scrollTop;
	if (top >= viewTop && top + region.height <= viewTop + scoreScroll.clientHeight) return;
	const targetTop = top + region.height / 2 - scoreScroll.clientHeight / 2;
	scoreScroll.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
}

function flushPendingOnsets(): void {
	onsetFlushQueued = false;
	if (pendingOnsetNoteIds.length === 0) return;
	const noteIds = pendingOnsetNoteIds;
	const changed = renderer.setPlaybackCursor(noteIds);
	pendingOnsetNoteIds = [];
	for (const { staffIndex, index } of changed) renderer.redrawMeasure(index, staffIndex);
	// Any one note from this onset identifies the right measure to follow; the
	// first is as good as any other since a simultaneous chord's notes all
	// share the same measure region on their own staff, or an adjacent one at
	// worst.
	followPlaybackCursor(noteIds[0]!);
}

function ensurePlaybackEngine(): PlaybackEngine {
	if (playbackEngine && (playbackEngine.isPlaying || !playbackTimelineStale)) return playbackEngine;

	const resumeFrom = playbackEngine?.positionSeconds ?? 0;
	playbackEngine?.stop();
	playbackTimelineStale = false;
	const events = computePlaybackTimeline(history.current);
	totalPlaybackSeconds = events.reduce(
		(latest, event) => Math.max(latest, event.startSeconds + event.durationSeconds),
		0
	);

	audioContext ??= new AudioContext();
	playbackEngine = new PlaybackEngine({
		events,
		audioContext,
		// Exercises Slice 6's onset-callback half (not just its position-query
		// half, which the rAF loop below covers): fires once per note right as
		// it is handed to the audio clock. Drives both the existing "last note"
		// status line and (M4 Slice 2) the playback cursor, via the same-turn
		// buffering scheme documented on `pendingOnsetNoteIds` above.
		onOnset: (event) => {
			playbackOnset.textContent = `note ${event.noteId} at ${event.startSeconds.toFixed(2)}s`;
			pendingOnsetNoteIds.push(event.noteId);
			if (!onsetFlushQueued) {
				onsetFlushQueued = true;
				queueMicrotask(flushPendingOnsets);
			}
		}
	});
	if (resumeFrom > 0) playbackEngine.seek(resumeFrom);
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
	// A hard stop silences every sounding note, so the cursor should not go on
	// showing whichever note happened to be highlighted the instant Stop was
	// clicked; drop it the same way. Pause leaves it alone deliberately (see
	// PlaybackEngine.pause's own doc comment: paused audio keeps ringing to
	// its already-scheduled stop time, so freezing the visual highlight along
	// with it stays consistent with what is still actually sounding).
	pendingOnsetNoteIds = [];
	const changed = renderer.setPlaybackCursor([]);
	for (const { staffIndex, index } of changed) renderer.redrawMeasure(index, staffIndex);
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
//
// M5 Slice 5 gives it its own `EditHistory` too (for range clef changes), with
// the same ownership rule as the main canvas's `history`: no long-lived score
// variable, every read through `staffSelectHistory.current`, and `let`
// layout, since a clef change or an undo replaces the whole layout.
const staffSelectCanvas = document.querySelector<HTMLCanvasElement>('#staff-select-demo')!;
const staffSelectStatus = document.querySelector<HTMLElement>('#staff-select-status')!;

const staffSelectHistory = new EditHistory(createGrandStaffShowcaseScore());
const staffSelectLayoutOptions = { staffSpacePx: 11, systemWidthPx: 700 };
let staffSelectLayout: LaidOutScore = layoutScore(staffSelectHistory.current, staffSelectLayoutOptions);
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

/** Same coordinate-scaling logic as the main canvas's own handler, above:
 *  pointer event to layout coordinates. Shared by every pointer handler on
 *  this canvas (M5 Slice 4 added `pointermove` alongside `pointerdown`). */
function staffSelectPoint(event: PointerEvent): { x: number; y: number } {
	const rect = staffSelectCanvas.getBoundingClientRect();
	const scaleX = staffSelectLayout.width / rect.width;
	const scaleY = staffSelectLayout.height / rect.height;
	return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
}

/** Redraw each affected `(staffIndex, index)` pair once, against its own
 *  staff. Deduplicated because one gesture can change both the note
 *  selection and the measure range, and both may name the same measure. */
function redrawStaffSelectPairs(pairs: readonly { staffIndex: number; index: number }[]): string[] {
	const seen = new Set<string>();
	for (const { staffIndex, index } of pairs) {
		const key = `${staffIndex}:${index}`;
		if (seen.has(key)) continue;
		seen.add(key);
		staffSelectRenderer.redrawMeasure(index, staffIndex);
	}
	return [...seen].map((key) => {
		const [staffIndex, index] = key.split(':').map(Number);
		return `staff ${staffIndex} measure ${index! + 1}`;
	});
}

// Measure-range selection (M5 Slice 4). The anchor is the measure the last
// plain click (or first shift-click) landed on; a shift-click or a drag then
// sets the range from the anchor to the measure under the pointer. Ranges are
// single-staff, so a shift-click on the other staff starts a fresh one-measure
// range there instead of spanning staves. A plain click clears the range and
// keeps M4 Slice 1's note selection behaviour exactly as it was.
let measureAnchor: { staffIndex: number; measureIndex: number } | null = null;
let measureDragging = false;

function describeRange(redrew: string[]): string {
	const range = staffSelectRenderer.measureRange;
	const what = range
		? `Measure range: staff ${range.staffIndex}, measures ${range.from + 1}-${range.to + 1}.`
		: 'No measure range.';
	return `${what} Redrew ${redrew.length} measure(s)${redrew.length ? `: ${redrew.join(', ')}` : ''}.`;
}

staffSelectCanvas.addEventListener('pointerdown', (event) => {
	activeHistoryCanvas = 'staffSelect';
	const { x, y } = staffSelectPoint(event);
	const measureHit = hitTestMeasure(staffSelectLayout, x, y);

	if (event.shiftKey && measureHit) {
		if (!measureAnchor || measureAnchor.staffIndex !== measureHit.staffIndex) measureAnchor = measureHit;
		const changed = staffSelectRenderer.setMeasureRange({
			staffIndex: measureAnchor.staffIndex,
			from: measureAnchor.measureIndex,
			to: measureHit.measureIndex
		});
		staffSelectStatus.textContent = describeRange(redrawStaffSelectPairs(changed));
		return;
	}

	const hit = hitTest(staffSelectLayout, x, y);
	// The fixed version of the main canvas's handler above: each affected
	// pair is redrawn against its own `staffIndex`, so a click on the bass
	// staff never touches the treble staff's same-numbered measure.
	const changed = [
		...staffSelectRenderer.setSelection(hit ? hit.noteId : null),
		...staffSelectRenderer.setMeasureRange(null)
	];
	const redrew = redrawStaffSelectPairs(changed);
	measureAnchor = measureHit;
	if (measureHit) {
		measureDragging = true;
		staffSelectCanvas.setPointerCapture(event.pointerId);
	}
	staffSelectStatus.textContent = hit
		? `Selected note ${hit.noteId} on staff ${hit.staffIndex} ` +
			`(${staffSelectHistory.current.clefAt(hit.measureIndex, hit.staffIndex)} clef), ` +
			`measure ${hit.measureIndex + 1}. Redrew ${redrew.length ? `${redrew.join(', ')} only` : 'nothing'}.`
		: 'Nothing selected. Click a notehead or a rest, or shift-click/drag across measures. ' +
			`Redrew ${redrew.length} measure(s).`;
});

staffSelectCanvas.addEventListener('pointermove', (event) => {
	if (!measureDragging || !measureAnchor || (event.buttons & 1) === 0) return;
	const { x, y } = staffSelectPoint(event);
	const measureHit = hitTestMeasure(staffSelectLayout, x, y);
	// Ignore space between measures and the other staff: the range is
	// single-staff, so the drag simply holds its last range there.
	if (!measureHit || measureHit.staffIndex !== measureAnchor.staffIndex) return;
	// A press that never leaves its own measure stays a plain click, not a
	// one-measure range, until the pointer actually crosses into another one.
	if (staffSelectRenderer.measureRange === null && measureHit.measureIndex === measureAnchor.measureIndex) return;
	const changed = staffSelectRenderer.setMeasureRange({
		staffIndex: measureAnchor.staffIndex,
		from: measureAnchor.measureIndex,
		to: measureHit.measureIndex
	});
	if (changed.length > 0) staffSelectStatus.textContent = describeRange(redrawStaffSelectPairs(changed));
});

const endMeasureDrag = () => {
	measureDragging = false;
};
staffSelectCanvas.addEventListener('pointerup', endMeasureDrag);
staffSelectCanvas.addEventListener('pointercancel', endMeasureDrag);

// Temporary debug control (M4 Slice 2): confirms `setPlaybackCursor` lands
// correctly across staves without a second `PlaybackEngine`/`AudioContext`
// pair, which is out of this slice's scope (see plan.md's own note on why
// the two demo parts are split: this canvas's score is the only one with a
// staff-to-staff case to show, and the main canvas above is the only one
// wired to real audio). Hand-picked ids rather than a hit-test result:
// measure 2 (index 2) of both staves holds quarter notes, so its first note
// on each staff plus the treble's second note stand in for a three-note
// chord/voice-clash onset spanning both staves at once.
const staffSelectChordNoteIds: NoteId[] = [
	staffSelectHistory.current.staves[0]!.measures[2]!.notes[0]!.id,
	staffSelectHistory.current.staves[0]!.measures[2]!.notes[1]!.id,
	staffSelectHistory.current.staves[1]!.measures[2]!.notes[0]!.id
];
staffSelectCursorButton.addEventListener('click', () => {
	const changed = staffSelectRenderer.setPlaybackCursor(staffSelectChordNoteIds);
	for (const { staffIndex, index } of changed) staffSelectRenderer.redrawMeasure(index, staffIndex);
	staffSelectStatus.textContent =
		`Playback cursor set to notes ${staffSelectChordNoteIds.join(', ')} ` +
		'(measure 3 of both the treble and bass staves). ' +
		`Redrew ${changed.length} measure(s): ` +
		changed.map(({ staffIndex, index }) => `staff ${staffIndex} measure ${index + 1}`).join(', ') +
		'.';
});

// Range clef change (M5 Slice 5). Applies `setClefRange` to the current
// measure range through `staffSelectHistory.record`, so the whole change, the
// clef at the range's start and the restore after it, is one undo step. Then
// a full `layoutScore`, not a scoped `relayoutMeasure`: a clef change moves
// every notehead in the range and adds (or drops) a change-clef glyph, which
// changes measure widths and can recast later systems. The renderer keeps its
// measure range and note selection across `setLayout`, so both survive.

/** Install a fresh full layout of `staffSelectHistory.current` and repaint.
 *  Shared by a clef change and by undo/redo on this canvas. */
function relayoutStaffSelect(): void {
	staffSelectLayout = layoutScore(staffSelectHistory.current, staffSelectLayoutOptions);
	staffSelectRenderer.setLayout(staffSelectLayout);
	sizeStaffSelectCanvas();
	staffSelectRenderer.drawAll();
	staffSelectUndoButton.disabled = !staffSelectHistory.canUndo;
	staffSelectRedoButton.disabled = !staffSelectHistory.canRedo;
}

function applyClefToRange(clef: ClefType): void {
	activeHistoryCanvas = 'staffSelect';
	const range = staffSelectRenderer.measureRange;
	if (range === null) {
		staffSelectStatus.textContent = 'Select a measure range first (shift-click or drag across measures).';
		return;
	}
	const changed = staffSelectHistory.record((score) => score.setClefRange(range.staffIndex, range.from, range.to, clef));
	if (changed === null) {
		staffSelectStatus.textContent = `Measures ${range.from + 1}-${range.to + 1} are already in the ${clef} clef.`;
		return;
	}
	relayoutStaffSelect();
	staffSelectStatus.textContent =
		`Set staff ${range.staffIndex} measures ${changed.from + 1}-${changed.to + 1} to the ${clef} clef. ` +
		'Re-laid-out and repainted the whole score.';
}

function stepStaffSelectHistory(direction: 'undo' | 'redo'): void {
	const restored = direction === 'undo' ? staffSelectHistory.undo() : staffSelectHistory.redo();
	if (restored === null) return;
	relayoutStaffSelect();
	staffSelectStatus.textContent = `${direction === 'undo' ? 'Undid' : 'Redid'} clef change. ` +
		'Re-laid-out and repainted the whole score.';
}

for (const button of clefButtons) {
	button.addEventListener('click', () => applyClefToRange(button.dataset.clef as ClefType));
}
staffSelectUndoButton.addEventListener('click', () => {
	activeHistoryCanvas = 'staffSelect';
	stepStaffSelectHistory('undo');
});
staffSelectRedoButton.addEventListener('click', () => {
	activeHistoryCanvas = 'staffSelect';
	stepStaffSelectHistory('redo');
});

async function start(): Promise<void> {
	// Canvas has no "the font arrived" callback: text drawn before the font
	// loads renders as tofu and stays that way, so the first draw waits.
	await loadSmuflFont(bravuraUrl);
	sizeCanvas();
	lastFullDrawMs = drawAll();
	lastScopedMeasures = [...renderer.lastRedrawnMeasures];
	refreshHistoryControls();
	status.textContent = 'Click a notehead or a rest to select it.';
	timings.textContent = `initial whole-score draw           ${lastFullDrawMs.toFixed(2)} ms`;

	sizeStaffSelectCanvas();
	staffSelectRenderer.drawAll();
}

void start();
