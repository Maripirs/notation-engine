// The canvas renderer, and the point of the whole Phase 0 spike.
//
// `drawAll()` paints the score. `redrawMeasure(n)` paints one measure's region
// and touches no other pixel. That second method is the thing being proved:
// OSMD has no equivalent, so Divisi's editor pays a full MusicXML reparse plus a
// whole-score re-layout on every keystroke (~1.1-1.3s on a 124-measure piece,
// about 70% of it inside OSMD itself). An edit here costs one measure's layout
// and one measure's worth of fill calls, and that cost does not grow with the
// score.
//
// The renderer holds no engraving knowledge. It executes the op list layout
// produced, and the only decision it makes is what colour to paint an op.

import type { DrawOp, LaidOutScore, Rect } from '../layout/types.js';
import type { NoteId } from '../model/score.js';
import { BRAVURA_FAMILY, GLYPH_METRICS } from './glyph-metrics.js';

export interface CanvasRendererOptions {
	/** Font family the SMuFL font is registered under. */
	readonly fontFamily?: string;
	/** Font family a `text` op (M2 Slice 5's part-name labels) draws with.
	 *  Ordinary text, not a music glyph, so it uses a normal text font rather
	 *  than `fontFamily`'s SMuFL one. */
	readonly labelFontFamily?: string;
	/** Ink colour for staff, glyphs and stems. */
	readonly foreground?: string;
	/**
	 * Colour painted over a region before redrawing it. `null` uses
	 * `clearRect` instead, for a canvas layered over something else.
	 */
	readonly background?: string | null;
	/** Ink colour for the ops belonging to the selected note. */
	readonly selection?: string;
	/**
	 * Ink colour for the ops belonging to a note currently under the playback
	 * cursor (M4 Slice 2). Deliberately distinct from `selection`'s orange/rust
	 * so a live editor selection and an in-progress playback highlight never
	 * read as the same thing on screen.
	 */
	readonly playbackCursor?: string;
}

const DEFAULTS = {
	fontFamily: BRAVURA_FAMILY,
	labelFontFamily: 'sans-serif',
	foreground: '#111111',
	background: '#ffffff',
	selection: '#c2410c',
	playbackCursor: '#0369a1'
} as const;

export class CanvasRenderer {
	readonly #ctx: CanvasRenderingContext2D;
	readonly #options: Required<CanvasRendererOptions>;
	#layout: LaidOutScore;
	#selectedNoteId: NoteId | null = null;
	/** The note ids currently under the playback cursor (M4 Slice 2), e.g. every
	 *  note of a chord/multi-voice onset sounding at once. Empty, not `null`,
	 *  when nothing is highlighted, since `setPlaybackCursor` always takes an
	 *  array (possibly empty) rather than a nullable single id like
	 *  `setSelection` does: a cursor is inherently a set, a selection is not. */
	#playbackCursorNoteIds: ReadonlySet<NoteId> = new Set();

	/**
	 * Measure indices painted by the most recent draw call, in the order they
	 * were painted.
	 *
	 * This exists for testing, not for the host app. "Only the touched measure
	 * redraws" is the claim Phase 0 has to substantiate, and a wall-clock number
	 * cannot substantiate it: a fast redraw might still be repainting everything
	 * on a small score. This makes the claim a property that can be asserted in
	 * CI on any machine.
	 */
	lastRedrawnMeasures: number[] = [];

	/** Regions cleared and repainted by the most recent draw call. */
	lastRedrawnRegions: Rect[] = [];

	constructor(
		ctx: CanvasRenderingContext2D,
		layout: LaidOutScore,
		options: CanvasRendererOptions = {}
	) {
		this.#ctx = ctx;
		this.#layout = layout;
		this.#options = {
			fontFamily: options.fontFamily ?? DEFAULTS.fontFamily,
			labelFontFamily: options.labelFontFamily ?? DEFAULTS.labelFontFamily,
			foreground: options.foreground ?? DEFAULTS.foreground,
			background: options.background === undefined ? DEFAULTS.background : options.background,
			selection: options.selection ?? DEFAULTS.selection,
			playbackCursor: options.playbackCursor ?? DEFAULTS.playbackCursor
		};
	}

	get layout(): LaidOutScore {
		return this.#layout;
	}

	/**
	 * Swap in a new layout without redrawing.
	 *
	 * After an edit the caller re-lays-out the score, installs the new layout,
	 * then redraws only the measures the edit reported. Splitting "install" from
	 * "draw" is what makes that possible; a `render(layout)` API would force a
	 * full repaint on every layout change, which is exactly OSMD's shape.
	 */
	setLayout(layout: LaidOutScore): void {
		this.#layout = layout;
	}

	get selectedNoteId(): NoteId | null {
		return this.#selectedNoteId;
	}

	/**
	 * Change the selection, returning the `(staffIndex, index)` pairs whose
	 * appearance changed so the caller can redraw exactly those. Selection is a
	 * render-time concern, not a model one: nothing about the music changes
	 * when a user clicks a note.
	 *
	 * Fixed in M4 Slice 1: this used to return bare measure indices, and a
	 * caller feeding that straight into `redrawMeasures` (which defaults
	 * `staffIndex` to 0) would repaint staff 0's same-numbered measure instead
	 * of the staff the selection actually changed on, since each staff numbers
	 * its own measures from 0 (see `LaidOutMeasure.staffIndex`'s own doc
	 * comment). That was silent as long as every score had one staff; on a
	 * multi-staff one it left the true change unpainted and vandalised an
	 * unrelated measure's pixels instead. Returning the pair the note actually
	 * lives on removes the ambiguity at the source rather than trusting every
	 * caller to know which staff a note came from.
	 */
	setSelection(noteId: NoteId | null): { staffIndex: number; index: number }[] {
		if (noteId === this.#selectedNoteId) return [];
		const affected = new Map<string, { staffIndex: number; index: number }>();
		for (const id of [this.#selectedNoteId, noteId]) {
			if (id === null) continue;
			const measure = this.#layout.measures.find((m) => m.notes.some((note) => note.id === id));
			if (measure) {
				affected.set(`${measure.staffIndex}:${measure.index}`, {
					staffIndex: measure.staffIndex,
					index: measure.index
				});
			}
		}
		this.#selectedNoteId = noteId;
		return [...affected.values()];
	}

	/**
	 * Change the playback cursor to `noteIds`, returning the `(staffIndex,
	 * index)` pairs whose appearance changed so the caller can redraw exactly
	 * those. Mirrors `setSelection` above, but over a *set* of ids rather than
	 * one: a chord or a simultaneous multi-voice onset (see `OnsetEvent`'s own
	 * doc comment in `src/playback/timeline.ts`, one event per note, never one
	 * event for several) highlights several notes across possibly several
	 * staves at the same instant, so a single nullable id cannot represent it.
	 *
	 * Like `setSelection`, this does not try to be clever about only returning
	 * notes whose highlight state actually changed: it unions "measure of
	 * every old id" with "measure of every new id", deduplicated by
	 * `(staffIndex, index)`. A note present in both the old and new set still
	 * has its measure returned, which is harmless (that measure repaints to
	 * the same appearance it already had) and keeps this method's logic a
	 * straight mirror of `setSelection`'s rather than a second, subtly
	 * different diff algorithm.
	 */
	setPlaybackCursor(noteIds: readonly NoteId[]): { staffIndex: number; index: number }[] {
		const newIds = new Set(noteIds);
		const affected = new Map<string, { staffIndex: number; index: number }>();
		for (const id of [...this.#playbackCursorNoteIds, ...newIds]) {
			const measure = this.#layout.measures.find((m) => m.notes.some((note) => note.id === id));
			if (measure) {
				affected.set(`${measure.staffIndex}:${measure.index}`, {
					staffIndex: measure.staffIndex,
					index: measure.index
				});
			}
		}
		this.#playbackCursorNoteIds = newIds;
		return [...affected.values()];
	}

	/** Repaint the whole score. The baseline the region-scoped path is measured against. */
	drawAll(): void {
		this.lastRedrawnMeasures = [];
		this.lastRedrawnRegions = [];
		this.#paintBackground({
			x: 0,
			y: 0,
			width: this.#layout.width,
			height: this.#layout.height
		});
		this.#ctx.font = `${this.#layout.fontSizePx}px "${this.#options.fontFamily}"`;
		this.#ctx.textBaseline = 'alphabetic';
		for (const measure of this.#layout.measures) {
			this.#drawOps(measure.ops);
			this.lastRedrawnMeasures.push(measure.index);
			this.lastRedrawnRegions.push(measure.region);
		}
		// Part-grouping decorations (M2 Slice 5): drawn once here, never by
		// `redrawMeasure`/`redrawMeasures`. See `LaidOutScore.partDecorations`'s
		// own comment on why they live outside every measure's own region and
		// therefore outside the region-scoped redraw path entirely.
		this.#drawOps(this.#layout.partDecorations);
	}

	/**
	 * Repaint one measure and nothing else.
	 *
	 * Clearing the measure's region wipes its staff lines, barline and (for
	 * measure 0) its clef and signatures along with its notes, and drawing its
	 * ops puts all of them back, because layout assigns every one of those to
	 * the measure that owns the pixels. Neighbouring measures are untouched
	 * because regions never overlap horizontally.
	 *
	 * `staffIndex` (M2 Slice 3, default 0) completes the `(staffIndex, index)`
	 * pair `LaidOutMeasure` now carries, so a multi-staff layout redraws
	 * exactly one staff's one measure, leaving every other staff's own
	 * measures (which may well reuse the same `index`, since each staff
	 * numbers its own measures from 0) untouched. Every call site from before
	 * this slice omits it and keeps redrawing staff 0, exactly as before.
	 */
	redrawMeasure(index: number, staffIndex = 0): void {
		this.lastRedrawnMeasures = [];
		this.lastRedrawnRegions = [];
		this.#redrawMeasureInternal(index, staffIndex);
	}

	/** Repaint several measures of one staff, e.g. when moving a selection
	 *  between them. See `redrawMeasure`'s own comment on `staffIndex`. */
	redrawMeasures(indices: readonly number[], staffIndex = 0): void {
		this.lastRedrawnMeasures = [];
		this.lastRedrawnRegions = [];
		for (const index of indices) this.#redrawMeasureInternal(index, staffIndex);
	}

	#redrawMeasureInternal(index: number, staffIndex: number): void {
		const measure = this.#layout.measures.find((m) => m.staffIndex === staffIndex && m.index === index);
		if (!measure) return;
		this.#paintBackground(measure.region);
		this.#ctx.font = `${this.#layout.fontSizePx}px "${this.#options.fontFamily}"`;
		this.#ctx.textBaseline = 'alphabetic';
		this.#drawOps(measure.ops);
		this.lastRedrawnMeasures.push(index);
		this.lastRedrawnRegions.push(measure.region);
	}

	#paintBackground(rect: Rect): void {
		if (this.#options.background === null) {
			this.#ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
			return;
		}
		this.#ctx.fillStyle = this.#options.background;
		this.#ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
	}

	#drawOps(ops: readonly DrawOp[]): void {
		const ctx = this.#ctx;
		let currentStyle = '';
		for (const op of ops) {
			// Precedence, deliberate (M4 Slice 2): a note that is both selected and
			// under the playback cursor at once paints with `playbackCursor`'s
			// colour, not `selection`'s. Playback is transient and moves on its own
			// as the piece plays, while a selection sits still until the user
			// changes it; if selection won this tie, a played-through selected note
			// would look exactly like an idle one for as long as it sounds, hiding
			// the one piece of state that is actually changing right now.
			const style =
				op.noteId !== undefined && this.#playbackCursorNoteIds.has(op.noteId)
					? this.#options.playbackCursor
					: op.noteId !== undefined && op.noteId === this.#selectedNoteId
						? this.#options.selection
						: this.#options.foreground;
			// Assigning `fillStyle`/`strokeStyle` is not free (each parses the
			// colour string), and an op list is mostly one colour, so only write
			// them on a change. Both are kept in step together since every op
			// kind uses the same `style` value, whichever of the two it paints
			// with.
			if (style !== currentStyle) {
				ctx.fillStyle = style;
				ctx.strokeStyle = style;
				currentStyle = style;
			}
			if (op.kind === 'rect') {
				ctx.fillRect(op.x, op.y, op.width, op.height);
			} else if (op.kind === 'curve') {
				ctx.lineWidth = op.thickness;
				ctx.beginPath();
				ctx.moveTo(op.x0, op.y0);
				ctx.bezierCurveTo(op.cx0, op.cy0, op.cx1, op.cy1, op.x1, op.y1);
				ctx.stroke();
			} else if (op.kind === 'text') {
				// Ordinary text, not a music glyph: swap to the label font/size for
				// this one op, then swap back, since every op around this one
				// assumes the shared Bravura font is active (set once per draw call
				// above, not per op).
				ctx.font = `${op.fontSizePx}px ${this.#options.labelFontFamily}`;
				ctx.fillText(op.text, op.x, op.y);
				ctx.font = `${this.#layout.fontSizePx}px "${this.#options.fontFamily}"`;
			} else if (op.fontSizePx !== undefined) {
				// A one-off scaled glyph (M2 Slice 5's brace, stretched to fit its
				// own two staves' span): same swap-and-restore as `text`, above.
				ctx.font = `${op.fontSizePx}px "${this.#options.fontFamily}"`;
				ctx.fillText(String.fromCodePoint(GLYPH_METRICS[op.glyph].codepoint), op.x, op.y);
				ctx.font = `${this.#layout.fontSizePx}px "${this.#options.fontFamily}"`;
			} else {
				ctx.fillText(String.fromCodePoint(GLYPH_METRICS[op.glyph].codepoint), op.x, op.y);
			}
		}
	}
}
