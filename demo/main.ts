// The demo: what a host application has to write.
//
// The main score is one `mountScore` call (M7 Slice 3): the view owns its
// canvas, scrolling, resizing, zoom and playback with a moving cursor. What
// this file adds on top is editing, built only on the view's escape hatches
// (`view.score`, `view.renderer`, `view.refresh`, `view.on('noteclick')`):
// selection, transposes, correction ops, undo/redo, open/save. That split is
// the proof the embed API covers a real host. The engine itself never sees a
// DOM event outside the view layer.

// M6 Slice 9's hand-written SATB-with-lyrics fixture, one click away.
import satbLyricsXml from '../src/test/fixtures/satb-lyrics.musicxml?raw';
import {
	CanvasRenderer,
	EditHistory,
	exportMusicXml,
	keyAlterForStep,
	hitTest,
	hitTestMeasure,
	importMusicXml,
	layoutScore,
	mountScore,
	playOnsetEvent,
	NOTE_VALUES,
	noteEvents,
	type ClefType,
	type LaidOutScore,
	type MeasureRef,
	type NoteId,
	type Pitch,
	type Score,
	type ScoreView,
	type Step
} from '../src/index.js';
import { createFullDemoScore, createGrandStaffShowcaseScore } from '../src/examples.js';

/**
 * The scroll container the view mounts into. Its `max-height` in index.html
 * is deliberately smaller than the full demo score, so the score scrolls and
 * playback's follow-scroll has something to show.
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

/** Zoom bounds and step (M4 Slice 3): arbitrary, just wide enough to be
 *  useful and narrow enough to stay readable. */
const MIN_STAFF_SPACE_PX = 5;
const MAX_STAFF_SPACE_PX = 20;
const ZOOM_STEP_STAFF_SPACE_PX = 1;

/** Renders seconds as `m:ss.d`, e.g. `0:07.3`. */
function formatPosition(seconds: number): string {
	const clamped = Math.max(0, seconds);
	const minutes = Math.floor(clamped / 60);
	const secondsWithinMinute = clamped - minutes * 60;
	return `${minutes}:${secondsWithinMinute.toFixed(1).padStart(4, '0')}`;
}

/**
 * The undo/redo stack and the owner of the live score. Every read goes
 * through `history.current`: `undo`/`redo` swap a different `Score` object in
 * (see `EditHistory`), which is why the view is handed it with `setScore`. An
 * edit through `history.record` mutates `history.current` in place, which is
 * the view's own score, so `view.refresh` repaints it.
 */
let history = new EditHistory(createFullDemoScore());
/** Assigned in `start()` once the font has loaded; nothing below runs before. */
let view!: ScoreView;
let selected: NoteId | null = null;

/** Time `work` in milliseconds. */
function timed(work: () => void): number {
	const started = performance.now();
	work();
	return performance.now() - started;
}

/**
 * Repaint after an edit through `history.record`, scoped to the measures it
 * touched unless one of them changed width. Reports which path ran.
 */
function repaintEdit(label: string, touched: readonly MeasureRef[], started: number): void {
	markScoreChanged();
	const scoped = view.refresh(touched);
	const elapsed = performance.now() - started;
	lastScopedMeasures = [...view.renderer.lastRedrawnMeasures];
	const multiStaff = history.current.staves.length > 1;
	const where = touched.map((ref) => `${ref.measureIndex + 1}${multiStaff ? ` (staff ${ref.staffIndex + 1})` : ''}`).join(', ');
	status.textContent = scoped
		? `${label}: redrew measure ${where} only.`
		: `${label}: the edit changed the system's geometry, so the whole score was re-laid-out.`;
	const first = touched[0]!;
	if (scoped) report(elapsed, first.measureIndex, first.staffIndex);
	else timings.textContent = `edit + whole-score layout/repaint  ${elapsed.toFixed(2)} ms`;
}

/** Transpose the selected note and repaint only the measure it lives in. */
function transposeSelected(semitones: number): void {
	if (selected === null) return;
	const started = performance.now();
	const noteId = selected;
	// `transposeNote` reports a staff-local measure index; an opened
	// multi-staff file can select a note on any staff.
	const staffIndex = history.current.measureOfNote(noteId)?.staffIndex ?? 0;
	// `record` keeps the undo snapshot only when the edit reports a change, so
	// a no-op on a rest leaves the undo stack (and the dirty flag) alone.
	const touched = history.record((score) => score.transposeNote(noteId, semitones));
	if (touched === null) {
		status.textContent = 'Rests have no pitch to transpose.';
		return;
	}
	repaintEdit(`Transposed note ${noteId}`, [{ staffIndex, measureIndex: touched }], started);
	auditionNote(noteId);
}

/**
 * Sound one note briefly so a click or a transpose is heard, the way notation
 * editors audition a selection. Uses the same synth as playback on a context
 * of the demo's own (the view's is private to its playback), created on the
 * first click, which is a user gesture. A rest stays silent.
 */
let auditionContext: AudioContext | null = null;
function auditionNote(noteId: NoteId): void {
	const pitch = history.current.findNote(noteId)?.pitch;
	if (!pitch) return;
	auditionContext ??= new AudioContext();
	void auditionContext.resume();
	playOnsetEvent(
		{ noteId, pitch, startSeconds: auditionContext.currentTime, durationSeconds: 0.4 },
		{ audioContext: auditionContext }
	);
}

// --- Correction ops (M6 Slice 7) -------------------------------------------
//
// Keyboard shortcuts on the selected note for fixing rough OMR output (see
// the list in index.html). Each runs one `Score` correction op through
// `history.record`, exactly like a transpose.

/** The pitch on a clef's middle staff line (before the key signature): what
 *  R turns a rest into. */
const MIDDLE_LINE_PITCH: Readonly<Record<ClefType, Pitch>> = {
	treble: { step: 'B', alter: 0, octave: 4 },
	treble8: { step: 'B', alter: 0, octave: 4 },
	bass: { step: 'D', alter: 0, octave: 3 },
	alto: { step: 'C', alter: 0, octave: 4 },
	tenor: { step: 'A', alter: 0, octave: 3 }
};

const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** A diatonic third above (`direction` 1) or below (-1) `pitch`, spelled in
 *  the key in force at the note's measure (so in D major a third above D is
 *  F#, not F). */
function thirdFrom(pitch: Pitch, direction: 1 | -1, keyFifths: number): Pitch {
	const index = STEPS.indexOf(pitch.step) + 2 * direction;
	const step = STEPS[(index + 7) % 7]!;
	const octave = pitch.octave + Math.floor(index / 7);
	return { step, alter: keyAlterForStep(keyFifths, step), octave };
}

/**
 * Run one correction op on the selected note and repaint what it touched.
 * `refusal` is the status line when the op returns `null` (refused, or
 * nothing to change), which records nothing.
 */
function applyCorrection(label: string, refusal: string, op: (score: Score, id: NoteId) => readonly MeasureRef[] | null): void {
	if (selected === null) return;
	const started = performance.now();
	const noteId = selected;
	// The heads of the selected note's event, so that when the op removes the
	// selected head (a chord head deleted) the selection can move to one that
	// is still there.
	const measure = history.current.measureOfNote(noteId);
	const siblings = (measure && noteEvents(measure.notes).find((e) => e.some((n) => n.id === noteId))?.map((n) => n.id)) ?? [];
	const touched = history.record((score) => op(score, noteId));
	if (touched === null) {
		status.textContent = refusal;
		return;
	}
	if (history.current.findNote(noteId) === undefined) {
		// The measures this changes are the touched ones, repainted below.
		view.renderer.setSelection(siblings.find((id) => history.current.findNote(id) !== undefined) ?? null);
		setSelected(view.renderer.selectedNoteId);
	}
	repaintEdit(label, touched, started);
}

function deleteSelected(): void {
	applyCorrection('Note to rest', 'Already a rest.', (score, id) => score.noteToRest(id));
}

/** R: a rest becomes a note on the staff's middle line; a note becomes a rest. */
function toggleRestSelected(): void {
	if (selected === null) return;
	const note = history.current.findNote(selected);
	if (!note) return;
	if (note.pitch !== null) {
		deleteSelected();
		return;
	}
	const measure = history.current.measureOfNote(selected)!;
	const line = MIDDLE_LINE_PITCH[history.current.clefAt(measure.index, measure.staffIndex)];
	// Spelled in the key, so in A-flat major the treble middle line is B-flat.
	const pitch = { ...line, alter: keyAlterForStep(history.current.keyFifthsAt(measure.index, measure.staffIndex), line.step) };
	applyCorrection(
		'Rest to note',
		'This whole-measure rest cannot become one note: no single note value fills the measure.',
		(score, id) => score.restToNote(id, pitch)
	);
}

function setValueSelected(digit: number): void {
	const value = NOTE_VALUES[digit - 1];
	if (value === undefined) return;
	applyCorrection(
		`Set to ${value}`,
		`Could not make it a ${value}: unchanged, a tuplet, or a longer value would run into a following note or past the barline.`,
		(score, id) => score.setDuration(id, value, 0)
	);
}

function toggleDotSelected(): void {
	if (selected === null) return;
	const note = history.current.findNote(selected);
	if (!note) return;
	const dots = note.dots === 0 ? 1 : 0;
	applyCorrection(
		dots ? 'Dotted' : 'Undotted',
		'Could not change the dot: a tuplet, or the longer value would run into a following note or past the barline.',
		(score, id) => score.setDuration(id, note.value, dots)
	);
}

function addThirdSelected(direction: 1 | -1): void {
	if (selected === null) return;
	const note = history.current.findNote(selected);
	const measure = history.current.measureOfNote(selected);
	if (!note?.pitch || !measure) {
		status.textContent = 'Select a note (not a rest) to add a chord head.';
		return;
	}
	const pitch = thirdFrom(note.pitch, direction, history.current.keyFifthsAt(measure.index, measure.staffIndex));
	applyCorrection(
		`Added a head a third ${direction === 1 ? 'above' : 'below'}`,
		'The chord already has that pitch.',
		(score, id) => score.addChordMember(id, pitch)
	);
}

/** T: untie a tied note, or tie it to the same pitch in the next event. */
function toggleTieSelected(): void {
	if (selected === null) return;
	const note = history.current.findNote(selected);
	if (!note?.pitch) return;
	if (note.tiedToId !== null) {
		applyCorrection('Untied', 'Nothing to untie.', (score, id) => score.editTie(id, null));
		return;
	}
	const target = history.current.tieTargetFor(selected);
	if (target === null && note.passthrough.length === 0) {
		status.textContent = 'No same-pitch note right after this one to tie to.';
		return;
	}
	applyCorrection(
		target === null ? 'Removed a dangling tie' : 'Tied to the next note',
		'No same-pitch note right after this one to tie to.',
		(score, id) => score.editTie(id, target)
	);
}

/**
 * Step the history one way or the other and repaint the whole score: the
 * score `undo`/`redo` swaps in is a different object that could differ in any
 * measure. The selection survives for free, since `Score.clone` keeps note
 * ids and the renderer keys its highlight by id.
 */
function stepHistory(direction: 'undo' | 'redo'): void {
	const restored = direction === 'undo' ? history.undo() : history.redo();
	if (restored === null) return;
	markScoreChanged();
	// A correction op can remove or add notes, so the selected id may not
	// exist on the other side of the step.
	if (selected !== null && history.current.findNote(selected) === undefined) {
		view.renderer.setSelection(null);
		setSelected(null);
	}
	lastFullDrawMs = timed(() => view.setScore(history.current));
	lastScopedMeasures = [...view.renderer.lastRedrawnMeasures];
	status.textContent = direction === 'undo'
		? 'Undid the last edit. Re-laid-out and repainted the whole score.'
		: 'Redid the edit. Re-laid-out and repainted the whole score.';
	timings.textContent = `whole-score layout + repaint       ${lastFullDrawMs.toFixed(2)} ms`;
}

/** Refresh the Undo/Redo buttons and the saved/unsaved indicator. */
function markScoreChanged(): void {
	undoButton.disabled = !history.canUndo;
	redoButton.disabled = !history.canRedo;
	const dirty = history.dirty;
	dirtyIndicator.textContent = dirty ? 'Unsaved changes' : 'Saved';
	dirtyIndicator.classList.toggle('dirty', dirty);
}

/**
 * Download the current score as MusicXML, then bless it as the saved
 * baseline. The object URL is revoked right after the click, since the
 * download has already captured the Blob by then.
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
	markScoreChanged();
	status.textContent = 'Saved the score as score.musicxml.';
}

/**
 * The full-redraw figure is whatever the last whole-score pass cost, not a
 * comparison run after every edit: running one would repaint the screen and
 * falsify what the demo shows, that an edit leaves other measures alone.
 */
let lastFullDrawMs = 0;
let lastScopedMeasures: number[] = [];

function report(scopedMs: number, measureIndex: number, staffIndex = 0): void {
	const layout = view.layout;
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

function setSelected(noteId: NoteId | null): void {
	selected = noteId;
	upButton.disabled = selected === null;
	downButton.disabled = selected === null;
}

/**
 * Select `noteId` (or clear the selection), repaint what changed, sound the
 * note, and report it. Shared by a click and Left/Right stepping. Each changed
 * measure is redrawn on its own staff: `redrawMeasures` takes one staff per call.
 */
function selectNote(noteId: NoteId | null): void {
	const changed = view.renderer.setSelection(noteId);
	setSelected(noteId);
	if (noteId !== null) auditionNote(noteId);
	for (const { staffIndex, index } of changed) view.renderer.redrawMeasure(index, staffIndex);
	const measure = noteId === null ? undefined : history.current.measureOfNote(noteId);
	status.textContent = measure
		? `Selected note ${noteId} in measure ${measure.index + 1}.`
		: 'Nothing selected. Click a notehead or a rest.';
}

/**
 * Move the selection to the next (`+1`) or previous (`-1`) event in the
 * selected note's own staff and voice, across barlines, and scroll it into
 * view. A chord counts as one event: stepping lands on its anchor. Stays put
 * at either end of the voice.
 */
function stepSelection(direction: 1 | -1): void {
	if (selected === null) return;
	const score = history.current;
	const note = score.findNote(selected);
	const measure = score.measureOfNote(selected);
	if (!note || !measure) return;
	const events = score.staves[measure.staffIndex]!.measures.flatMap((m) =>
		m.notes.filter((n) => n.voice === note.voice && !n.chordWithPrevious)
	);
	// A chord member's position is its anchor's: the nearest earlier head in
	// its measure and voice that does not join the previous note.
	let current = note;
	if (note.chordWithPrevious) {
		const inMeasure = measure.notes.filter((n) => n.voice === note.voice);
		const at = inMeasure.indexOf(note);
		for (let i = at - 1; i >= 0; i--) {
			if (!inMeasure[i]!.chordWithPrevious) {
				current = inMeasure[i]!;
				break;
			}
		}
	}
	const next = events[events.indexOf(current) + direction];
	if (!next) return;
	selectNote(next.id);
	view.scrollToNote(next.id);
}

/**
 * Which canvas's own `EditHistory` the keyboard undo/redo shortcuts step
 * (M5 Slice 5 gave the grand-staff canvas below a history of its own): the
 * one the user last clicked on, or used a history-changing button of.
 */
let activeHistoryCanvas: 'main' | 'staffSelect' = 'main';

window.addEventListener('keydown', (event) => {
	// Cmd on macOS, Ctrl elsewhere; either is accepted on any platform.
	const modifier = event.metaKey || event.ctrlKey;
	const key = event.key.toLowerCase();
	const step = activeHistoryCanvas === 'main' ? stepHistory : stepStaffSelectHistory;
	if (modifier && key === 'z') step(event.shiftKey ? 'redo' : 'undo');
	else if (modifier && key === 'y') step('redo');
	else if (event.shiftKey && event.key === 'ArrowUp') addThirdSelected(1);
	else if (event.shiftKey && event.key === 'ArrowDown') addThirdSelected(-1);
	else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
		if (selected === null || modifier || event.altKey) return;
		stepSelection(event.key === 'ArrowRight' ? 1 : -1);
	} else if (event.key === 'ArrowUp') transposeSelected(1);
	else if (event.key === 'ArrowDown') transposeSelected(-1);
	// M6 Slice 7 correction shortcuts (listed in index.html), on the main
	// canvas's selection; a modified key is the browser's, not ours.
	else if (modifier || event.altKey) return;
	else if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected();
	else if (key === 'r') toggleRestSelected();
	else if (key === 't') toggleTieSelected();
	else if (event.key === '.') toggleDotSelected();
	else if (/^[1-7]$/.test(event.key)) setValueSelected(Number(event.key));
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
 * Replace the main score with a MusicXML file (M6 Slice 2's demo check: any
 * real score, chords and all). It gets a fresh `EditHistory`, so Undo cannot
 * step back into the demo score; `view.load` stops playback and scrolls to
 * the top, and the selection and seam markers, which named the old score's
 * notes and measures, are cleared.
 */
async function openMusicXml(file: File): Promise<void> {
	const started = performance.now();
	const score = importMusicXml(await file.text());
	const imported = performance.now();
	history = new EditHistory(score);
	view.renderer.setSelection(null);
	setSelected(null);
	seamsOn = false;
	view.renderer.setSeamMarkers([]);
	seamsButton.textContent = 'Show seam markers';
	markScoreChanged();
	lastFullDrawMs = timed(() => view.load(history.current));
	lastScopedMeasures = [...view.renderer.lastRedrawnMeasures];
	const noteCount = score.staves.reduce(
		(sum, staff) => sum + staff.measures.reduce((n, measure) => n + measure.notes.length, 0),
		0
	);
	status.textContent =
		`Opened ${file.name}: ${score.staves.length} staves, ${score.staves[0]?.measures.length ?? 0} measures, ` +
		`${noteCount} notes and rests, across ${view.layout.systems.length} system(s).`;
	timings.textContent = [
		`import                             ${(imported - started).toFixed(2)} ms`,
		`layout + whole-score repaint       ${lastFullDrawMs.toFixed(2)} ms`
	].join('\n');
}

document.querySelector<HTMLButtonElement>('#open-lyrics')!.addEventListener('click', () => {
	// Through the same path as a picked file (M6 Slice 9's demo check: two
	// verses, hyphens and extenders across system breaks, dynamics above).
	openMusicXml(new File([satbLyricsXml], 'satb-lyrics.musicxml')).catch((error: unknown) => {
		status.textContent = `Could not open the lyrics sample: ${error instanceof Error ? error.message : String(error)}`;
	});
});

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
	lastFullDrawMs = timed(() => view.renderer.drawAll());
	lastScopedMeasures = [...view.renderer.lastRedrawnMeasures];
	status.textContent = `Repainted all ${view.layout.measures.length} measures.`;
	timings.textContent = `whole-score repaint                ${lastFullDrawMs.toFixed(2)} ms`;
});

// A visible answer to "did it really only touch that region": tint whatever the
// last draw call painted, then put it back. The redraw itself is too fast to see.
flashButton.addEventListener('click', () => {
	if (lastScopedMeasures.length === 0) return;
	const measures = lastScopedMeasures.map((index) => view.layout.measures[index]!);
	const ctx = view.canvas.getContext('2d')!;
	// In layout coordinates, like the renderer's own draws: shift to the
	// visible band's origin (M6 Slice 11).
	const band = view.renderer.viewport;
	ctx.save();
	if (band) ctx.translate(-band.x, -band.y);
	ctx.fillStyle = 'rgba(194, 65, 12, 0.18)';
	for (const measure of measures) {
		const { x, y, width, height } = measure.region;
		ctx.fillRect(x, y, width, height);
	}
	ctx.restore();
	window.setTimeout(() => view.renderer.redrawMeasures(lastScopedMeasures), 450);
});

// Seam markers (M5 Slice 6). Stands in for an OMR host marking where one
// stitched scan fragment ends and the next begins: the host owns the list,
// the engine just draws it. Hand-picked boundaries, plus the first measure of
// the second system so one mark lands on a system break (computed at toggle
// time, since where the score casts off depends on the window width).
// `setSeamMarkers` takes effect on the next `drawAll`; after that a scoped
// redraw keeps the marks intact on its own.
let seamsOn = false;

function demoSeamBoundaries(): { staffIndex: number; boundaryIndex: number }[] {
	const layout = view.layout;
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
	view.renderer.setSeamMarkers(boundaries);
	lastFullDrawMs = timed(() => view.renderer.drawAll());
	lastScopedMeasures = [...view.renderer.lastRedrawnMeasures];
	seamsButton.textContent = seamsOn ? 'Hide seam markers' : 'Show seam markers';
	status.textContent = seamsOn
		? `Seam markers at boundaries ${boundaries.map((b) => b.boundaryIndex).join(', ')} ` +
			'(boundary i = start of measure i, 0-based; the last is the final barline). ' +
			'Transpose a note next to one: the scoped redraw keeps the mark.'
		: 'Seam markers cleared.';
});

/** Zoom by `deltaStaffSpacePx` within the demo's bounds (M4 Slice 3). The
 *  selection and playback cursor stay highlighted: both are keyed by note id. */
function zoomBy(deltaStaffSpacePx: number): void {
	const next = Math.min(MAX_STAFF_SPACE_PX, Math.max(MIN_STAFF_SPACE_PX, view.staffSpacePx + deltaStaffSpacePx));
	if (next === view.staffSpacePx) return;
	lastFullDrawMs = timed(() => view.setZoom(next));
	lastScopedMeasures = [...view.renderer.lastRedrawnMeasures];
	status.textContent = `Zoomed to staffSpacePx ${next}. Repainted all ${view.layout.measures.length} measures.`;
	timings.textContent = `whole-score layout + repaint       ${lastFullDrawMs.toFixed(2)} ms`;
}

zoomOutButton.addEventListener('click', () => zoomBy(-ZOOM_STEP_STAFF_SPACE_PX));
zoomInButton.addEventListener('click', () => zoomBy(ZOOM_STEP_STAFF_SPACE_PX));

// --- Playback -----------------------------------------------------------
//
// The view owns the engine, the cursor and follow-scroll; the demo only drives
// the transport buttons and the position readout. An edit made mid-playback
// is heard from the next pause/resume or stop/play.

function showPosition(): void {
	playbackPosition.textContent = `${formatPosition(view.positionSeconds)} / ${formatPosition(view.durationSeconds)}`;
}

/** Polls the position once per frame while playing. */
function schedulePositionUpdate(): void {
	showPosition();
	if (view.isPlaying) requestAnimationFrame(schedulePositionUpdate);
}

function setTransportStopped(): void {
	playbackPauseButton.disabled = true;
	playbackStopButton.disabled = true;
	showPosition();
}

playbackPlayButton.addEventListener('click', () => {
	const wasPlaying = view.isPlaying;
	view.play();
	// Play stays enabled so it also doubles as "resume" after a pause.
	playbackPauseButton.disabled = false;
	playbackStopButton.disabled = false;
	if (!wasPlaying) schedulePositionUpdate();
});

playbackPauseButton.addEventListener('click', () => {
	view.pause();
	playbackPauseButton.disabled = true;
});

playbackStopButton.addEventListener('click', () => {
	view.stop();
	setTransportStopped();
});

// --- Multi-staff selection (M4 Slice 1) ---------------------------------
//
// A second, independent canvas/renderer pair for `createGrandStaffShowcaseScore`
// (two staves, treble over bass). Not folded into the main canvas above:
// `createFullDemoScore` cannot include it (`appendMeasures` only ever merges
// into staff 0, see that score's own doc comment), so it needs its own score,
// its own layout and its own renderer. It is wired by hand on the lower-level
// API (no `mountScore`) and does not track the window's width, so its
// `systemWidthPx` is a fixed constant.
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
	// `mountScore` resolves once the music font has loaded (text drawn before
	// then stays as tofu), so the second canvas can draw right after it.
	view = await mountScore(scoreScroll, history.current, { staffSpacePx: 11, renderer: { background: '#ffffff' } });
	view.on('noteclick', (hit) => {
		activeHistoryCanvas = 'main';
		selectNote(hit ? hit.noteId : null);
	});
	view.on('onset', (event) => {
		playbackOnset.textContent = `note ${event.noteId} at ${event.startSeconds.toFixed(2)}s`;
	});
	view.on('end', setTransportStopped);
	lastFullDrawMs = timed(() => view.renderer.drawAll());
	lastScopedMeasures = [...view.renderer.lastRedrawnMeasures];
	markScoreChanged();
	status.textContent = 'Click a notehead or a rest to select it.';
	timings.textContent = `initial whole-score draw           ${lastFullDrawMs.toFixed(2)} ms`;

	sizeStaffSelectCanvas();
	staffSelectRenderer.drawAll();
}

void start();
