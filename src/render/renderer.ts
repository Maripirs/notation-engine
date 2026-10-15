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

import { regionForMeasureBoundary } from '../layout/region-for-measure-boundary.js';
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
	/**
	 * Translucent fill painted over the whole region of every measure in the
	 * current measure range (M5 Slice 4). A background tint, not an ink
	 * colour, and deliberately a pale blue distinct from both `selection` and
	 * `playbackCursor`: see `#paintMeasureRangeTint`'s own comment on why.
	 */
	readonly measureRange?: string;
	/**
	 * Fill colour for a seam marker strip (M5 Slice 6, see `setSeamMarkers`).
	 * Translucent so the barline it sits on still shows through, and a red
	 * distinct from every other highlight colour here, since a seam is a
	 * host annotation, not an editing state.
	 */
	readonly seamMarker?: string;
}

/** One measure boundary to mark (M5 Slice 6). See `regionForMeasureBoundary`
 *  for exactly which boundary `boundaryIndex` names. */
export interface SeamMarker {
	readonly staffIndex: number;
	readonly boundaryIndex: number;
}

/** A contiguous run of measures on one staff (M5 Slice 4), inclusive at both
 *  ends. `from`/`to` are staff-local measure indices (`LaidOutMeasure.index`)
 *  and may be passed in either order; `CanvasRenderer.setMeasureRange`
 *  normalizes them so `from <= to`. */
export interface MeasureRange {
	readonly staffIndex: number;
	readonly from: number;
	readonly to: number;
}

const DEFAULTS = {
	fontFamily: BRAVURA_FAMILY,
	labelFontFamily: 'sans-serif',
	foreground: '#111111',
	background: '#ffffff',
	selection: '#c2410c',
	playbackCursor: '#0369a1',
	measureRange: 'rgba(37, 99, 235, 0.12)',
	seamMarker: 'rgba(220, 38, 38, 0.45)'
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
	/** The current measure range (M5 Slice 4), always stored normalized
	 *  (`from <= to`), or `null` when no range is active. */
	#measureRange: MeasureRange | null = null;
	/** The host's seam marker list (M5 Slice 6), exactly as last handed to
	 *  `setSeamMarkers`. Kept alongside `#seamStrips` so a `setLayout` can
	 *  re-resolve the same boundaries against the new geometry. */
	#seamMarkers: readonly SeamMarker[] = [];
	/** `#seamMarkers` resolved to strips against the current layout, with
	 *  boundaries that do not exist in it dropped. Cached rather than resolved
	 *  per paint so a region-scoped redraw stays a cheap rect intersection per
	 *  marker, not a measure search per marker. */
	#seamStrips: readonly Rect[] = [];

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
			playbackCursor: options.playbackCursor ?? DEFAULTS.playbackCursor,
			measureRange: options.measureRange ?? DEFAULTS.measureRange,
			seamMarker: options.seamMarker ?? DEFAULTS.seamMarker
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
		this.#seamStrips = this.#resolveSeamStrips();
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

	get measureRange(): MeasureRange | null {
		return this.#measureRange;
	}

	/**
	 * Change the measure range (M5 Slice 4), returning the `(staffIndex,
	 * index)` pairs whose membership changed so the caller can redraw exactly
	 * those. `null` clears the range. `from`/`to` may arrive in either order
	 * (a drag leftwards from its anchor produces `from > to`) and are
	 * normalized here, so callers never have to.
	 *
	 * Same diff-and-return shape as `setSelection` and `setPlaybackCursor`
	 * above, with one deliberate difference: this returns *only* the
	 * symmetric difference of the old and new member sets, not their union.
	 * Those two can afford the union because they touch a handful of
	 * measures at most; a range can span a whole staff, and growing a
	 * twenty-measure range by one bar should repaint one measure, not
	 * twenty-one. A measure that stays in the range keeps its tint, so
	 * repainting it would be pure waste. Pairs are deduplicated by
	 * `staffIndex:index` and limited to measures that actually exist in the
	 * current layout, so an out-of-bounds `to` never yields a pair
	 * `redrawMeasure` would silently ignore anyway. Setting the same range
	 * again returns `[]`.
	 */
	setMeasureRange(range: MeasureRange | null): { staffIndex: number; index: number }[] {
		const next =
			range === null
				? null
				: {
						staffIndex: range.staffIndex,
						from: Math.min(range.from, range.to),
						to: Math.max(range.from, range.to)
					};
		const members = (r: MeasureRange | null): Set<string> => {
			const keys = new Set<string>();
			if (r === null) return keys;
			for (const m of this.#layout.measures) {
				if (m.staffIndex === r.staffIndex && m.index >= r.from && m.index <= r.to) {
					keys.add(`${m.staffIndex}:${m.index}`);
				}
			}
			return keys;
		};
		const before = members(this.#measureRange);
		const after = members(next);
		this.#measureRange = next;
		const affected: { staffIndex: number; index: number }[] = [];
		for (const m of this.#layout.measures) {
			const key = `${m.staffIndex}:${m.index}`;
			if (before.has(key) !== after.has(key)) affected.push({ staffIndex: m.staffIndex, index: m.index });
		}
		return affected;
	}

	get seamMarkers(): readonly SeamMarker[] {
		return this.#seamMarkers;
	}

	/**
	 * Replace the seam marker list (M5 Slice 6): a thin vertical strip at each
	 * listed measure boundary, laid over the score. `[]` clears them. Takes
	 * effect on the next `drawAll()`, the same way `partDecorations` only ever
	 * paint there; unlike `setSelection`/`setMeasureRange` there are no
	 * affected measures to return, because a strip reaches outside every
	 * measure's region (into the margin at a system start or the final
	 * barline), so no set of `redrawMeasure` calls could fully erase a removed
	 * one. Seams are set rarely (once per loaded scan mapping, say), so a full
	 * repaint is the honest cost.
	 *
	 * Markers are render state only, like the selection: never part of the
	 * model, never persisted, never exported. Boundaries that do not exist in
	 * the current layout are kept in the list but simply not drawn, and every
	 * `setLayout` re-resolves the list against the new geometry, so markers
	 * follow a rescale or a re-cast without the host calling this again.
	 *
	 * Like `partDecorations`, strips live outside every measure's own `ops`
	 * and `region`, so a marker never inflates a region. Unlike
	 * `partDecorations`, a strip does overlap measure regions (it straddles
	 * the barline it marks), so `redrawMeasure`/`redrawMeasures` must not just
	 * leave markers alone: after repainting a measure they repaint the part of
	 * every strip that falls inside that measure's region, clipped to it. The
	 * part outside is never cleared, so it never needs repainting either.
	 */
	setSeamMarkers(boundaries: readonly SeamMarker[]): void {
		this.#seamMarkers = boundaries.map(({ staffIndex, boundaryIndex }) => ({ staffIndex, boundaryIndex }));
		this.#seamStrips = this.#resolveSeamStrips();
	}

	#resolveSeamStrips(): Rect[] {
		const strips: Rect[] = [];
		for (const { staffIndex, boundaryIndex } of this.#seamMarkers) {
			const strip = regionForMeasureBoundary(this.#layout, staffIndex, boundaryIndex);
			if (strip) strips.push(strip);
		}
		return strips;
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
			if (this.#inMeasureRange(measure.staffIndex, measure.index)) this.#paintMeasureRangeTint(measure.region);
			this.#drawOps(measure.ops);
			this.lastRedrawnMeasures.push(measure.index);
			this.lastRedrawnRegions.push(measure.region);
		}
		// Part-grouping decorations (M2 Slice 5): drawn once here, never by
		// `redrawMeasure`/`redrawMeasures`. See `LaidOutScore.partDecorations`'s
		// own comment on why they live outside every measure's own region and
		// therefore outside the region-scoped redraw path entirely.
		this.#drawOps(this.#layout.partDecorations);
		// Seam markers (M5 Slice 6): last, over every measure's ink, so a strip
		// reads as an annotation laid on top of the barline it marks.
		if (this.#seamStrips.length > 0) {
			this.#ctx.fillStyle = this.#options.seamMarker;
			for (const strip of this.#seamStrips) this.#ctx.fillRect(strip.x, strip.y, strip.width, strip.height);
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
		if (this.#inMeasureRange(staffIndex, index)) this.#paintMeasureRangeTint(measure.region);
		this.#ctx.font = `${this.#layout.fontSizePx}px "${this.#options.fontFamily}"`;
		this.#ctx.textBaseline = 'alphabetic';
		this.#drawOps(measure.ops);
		this.#paintSeamStripsWithin(measure.region);
		this.lastRedrawnMeasures.push(index);
		this.lastRedrawnRegions.push(measure.region);
	}

	/**
	 * Repaint the part of every seam strip that overlaps `region` (M5 Slice 6),
	 * after that region was just cleared and repainted. A strip is a plain
	 * rectangle, so "clipped to the region" is a rectangle intersection, not a
	 * canvas clip path: every call this makes stays inside `region`, keeping
	 * a scoped redraw's "touches no pixel outside the measure" property exact.
	 * Painted fresh over a freshly cleared background, so a translucent
	 * `seamMarker` colour never accumulates across repeated redraws.
	 */
	#paintSeamStripsWithin(region: Rect): void {
		let styled = false;
		for (const strip of this.#seamStrips) {
			const left = Math.max(strip.x, region.x);
			const right = Math.min(strip.x + strip.width, region.x + region.width);
			const top = Math.max(strip.y, region.y);
			const bottom = Math.min(strip.y + strip.height, region.y + region.height);
			if (right <= left || bottom <= top) continue;
			if (!styled) {
				this.#ctx.fillStyle = this.#options.seamMarker;
				styled = true;
			}
			this.#ctx.fillRect(left, top, right - left, bottom - top);
		}
	}

	#inMeasureRange(staffIndex: number, index: number): boolean {
		const range = this.#measureRange;
		return range !== null && range.staffIndex === staffIndex && index >= range.from && index <= range.to;
	}

	/**
	 * Tint one range measure's region (M5 Slice 4): a translucent fill laid
	 * over the freshly painted background and *under* the measure's ops, so
	 * every ink op still draws on top at full strength.
	 *
	 * A background fill rather than an ink recolour, deliberately. Note
	 * selection and the playback cursor both recolour ink (see `#drawOps`),
	 * so a third ink colour would compete with them for the same pixels and
	 * need its own precedence rule; a background tint occupies a different
	 * layer entirely, so a selected or cursor-highlighted note inside the
	 * range keeps its own ink colour and the range still reads as a range.
	 * It stays region-scoped for the same reason the background does: it
	 * fills exactly `measure.region`, and regions never overlap.
	 */
	#paintMeasureRangeTint(rect: Rect): void {
		this.#ctx.fillStyle = this.#options.measureRange;
		this.#ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
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
				if (op.align === 'center') {
					// A lyric syllable (M6 Slice 9), centred on its note by the real
					// text metrics; every other op draws left-aligned.
					const previous = ctx.textAlign;
					ctx.textAlign = 'center';
					ctx.fillText(op.text, op.x, op.y);
					ctx.textAlign = previous;
				} else {
					ctx.fillText(op.text, op.x, op.y);
				}
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
