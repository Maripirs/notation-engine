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
	/** Ink colour for staff, glyphs and stems. */
	readonly foreground?: string;
	/**
	 * Colour painted over a region before redrawing it. `null` uses
	 * `clearRect` instead, for a canvas layered over something else.
	 */
	readonly background?: string | null;
	/** Ink colour for the ops belonging to the selected note. */
	readonly selection?: string;
}

const DEFAULTS = {
	fontFamily: BRAVURA_FAMILY,
	foreground: '#111111',
	background: '#ffffff',
	selection: '#c2410c'
} as const;

export class CanvasRenderer {
	readonly #ctx: CanvasRenderingContext2D;
	readonly #options: Required<CanvasRendererOptions>;
	#layout: LaidOutScore;
	#selectedNoteId: NoteId | null = null;

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
			foreground: options.foreground ?? DEFAULTS.foreground,
			background: options.background === undefined ? DEFAULTS.background : options.background,
			selection: options.selection ?? DEFAULTS.selection
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
	 * Change the selection, returning the measure indices whose appearance
	 * changed so the caller can redraw exactly those. Selection is a render-time
	 * concern, not a model one: nothing about the music changes when a user
	 * clicks a note.
	 */
	setSelection(noteId: NoteId | null): number[] {
		if (noteId === this.#selectedNoteId) return [];
		const affected = new Set<number>();
		for (const id of [this.#selectedNoteId, noteId]) {
			if (id === null) continue;
			const measure = this.#layout.measures.find((m) => m.notes.some((note) => note.id === id));
			if (measure) affected.add(measure.index);
		}
		this.#selectedNoteId = noteId;
		return [...affected];
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
	}

	/**
	 * Repaint one measure and nothing else.
	 *
	 * Clearing the measure's region wipes its staff lines, barline and (for
	 * measure 0) its clef and signatures along with its notes, and drawing its
	 * ops puts all of them back, because layout assigns every one of those to
	 * the measure that owns the pixels. Neighbouring measures are untouched
	 * because regions never overlap horizontally.
	 */
	redrawMeasure(index: number): void {
		this.lastRedrawnMeasures = [];
		this.lastRedrawnRegions = [];
		this.#redrawMeasureInternal(index);
	}

	/** Repaint several measures, e.g. when moving a selection between them. */
	redrawMeasures(indices: readonly number[]): void {
		this.lastRedrawnMeasures = [];
		this.lastRedrawnRegions = [];
		for (const index of indices) this.#redrawMeasureInternal(index);
	}

	#redrawMeasureInternal(index: number): void {
		const measure = this.#layout.measures.find((m) => m.index === index);
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
			const style =
				op.noteId !== undefined && op.noteId === this.#selectedNoteId
					? this.#options.selection
					: this.#options.foreground;
			// Assigning `fillStyle` is not free (it parses the colour string), and
			// an op list is mostly one colour, so only write it on a change.
			if (style !== currentStyle) {
				ctx.fillStyle = style;
				currentStyle = style;
			}
			if (op.kind === 'rect') {
				ctx.fillRect(op.x, op.y, op.width, op.height);
			} else {
				ctx.fillText(String.fromCodePoint(GLYPH_METRICS[op.glyph].codepoint), op.x, op.y);
			}
		}
	}
}
