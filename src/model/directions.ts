// Dynamics and hairpins (M6 Slice 6): staff-anchored directions at an onset.
//
// A dynamic mark (pp, mf, sfz, ...) and a crescendo/diminuendo hairpin
// ("wedge", MusicXML's name) are not properties of any one note: MusicXML
// writes them as `<direction>` elements in a measure's element stream, at the
// time cursor where they appear, and a hairpin's start and stop are two such
// directions, often measures (and systems) apart. The model follows that
// shape:
//
//   - `DynamicMark`s live on the `Measure` of the staff they are drawn on
//     (`Measure.dynamics`), each at an onset from the measure's downbeat.
//   - `Wedge`s live on the `Score` (`Score.wedges`), like `Slur`s, because one
//     spans measures: a start position and a stop position, each a (measure,
//     onset) pair on one staff. Positions rather than note ids, since MusicXML
//     anchors a hairpin to a time, not to a note (a stop very often falls at a
//     measure's end, where there is no note at all), and a position survives
//     every edit op that exists (transposition, marks) unchanged.
//
// Lossless round trip: a `<direction>` carries more than the mark (an
// `<offset>`, a `<staff>`, a `<voice>`, a `<sound dynamics>`, `<words>` in a
// second `<direction-type>`, attributes like a hairpin's `spread`). Rather than
// modelling all of that, each mark read from a file keeps a `DirectionSource`:
// the source `<direction>` with the promoted `<direction-type>` cut out, plus
// where it was cut from. Export puts the mark's regenerated `<direction-type>`
// back into that slot, so a save writes the same element, and an edit to the
// mark itself (its kind, its placement) is what changes.

import type { OpaqueElement } from './passthrough.js';

/**
 * A dynamic, named exactly as MusicXML's `<dynamics>` children are (so import
 * and export need no table). Bravura has one combined glyph for each, so the
 * set is "everything the font draws as one mark": the p and f ladders, the
 * mezzo pair, the sforzando/rinforzando family, the forte-piano combinations,
 * niente and `pf`. MusicXML's `<other-dynamics>` (free text such as "mfp") is
 * not modelled: its `<direction>` stays passthrough.
 */
export type DynamicKind =
	| 'pppppp'
	| 'ppppp'
	| 'pppp'
	| 'ppp'
	| 'pp'
	| 'p'
	| 'mp'
	| 'mf'
	| 'f'
	| 'ff'
	| 'fff'
	| 'ffff'
	| 'fffff'
	| 'ffffff'
	| 'sf'
	| 'sfz'
	| 'sffz'
	| 'sfp'
	| 'sfpp'
	| 'sfzp'
	| 'fp'
	| 'fz'
	| 'rf'
	| 'rfz'
	| 'pf'
	| 'n';

/** Every `DynamicKind`, softest to loudest for the plain ladder, then the
 *  accent and combination kinds. Import uses it as the set of names it owns. */
export const DYNAMIC_KINDS: readonly DynamicKind[] = Object.freeze([
	'pppppp',
	'ppppp',
	'pppp',
	'ppp',
	'pp',
	'p',
	'mp',
	'mf',
	'f',
	'ff',
	'fff',
	'ffff',
	'fffff',
	'ffffff',
	'sf',
	'sfz',
	'sffz',
	'sfp',
	'sfpp',
	'sfzp',
	'fp',
	'fz',
	'rf',
	'rfz',
	'pf',
	'n'
]);

/**
 * Which side of the staff a direction is drawn on: MusicXML's `placement`
 * attribute. `null` (on a mark) means "not stated", which layout reads as the
 * engraving default, below the staff. Choral scores routinely put dynamics
 * above a vocal staff (the space below is the lyrics'), and OMR states that
 * explicitly, so it is kept rather than recomputed.
 */
export type Placement = 'above' | 'below';

/**
 * The part of a source `<direction>` the model does not hold, kept so export
 * can write the same element back around a modelled mark (see this file's
 * header).
 *
 * `element` is the source `<direction>` with every promoted `<direction-type>`
 * removed, and without its `placement` attribute when a mark owns that
 * (`DynamicMark.placement`, `Wedge.placement`). Several marks read from one
 * `<direction>` (a `<dynamics>` and a hairpin start side by side, or the
 * start and stop of a zero-length hairpin, which Audiveris writes) share one
 * `element` object, and export writes them back as one `<direction>`:
 * identity is the grouping, which `Score.clone` keeps since a source is
 * immutable and shared. `slot` is the index, among the *source* direction's
 * children, of the `<direction-type>` this mark was read from, so export can
 * interleave the regenerated ones with what `element` kept in their original
 * order. `divisions` is the `<divisions>` in force where it was read (an
 * `<offset>` inside is counted in it; see `MeasurePassthrough.divisions`).
 * `markAttrs` are the promoted `<dynamics>`/`<wedge>` element's own
 * attributes the model does not read (a hairpin's `spread`, a
 * `default-y`), written back on the regenerated one.
 */
export interface DirectionSource {
	readonly element: OpaqueElement;
	readonly slot: number;
	readonly divisions: number;
	readonly markAttrs: Readonly<Record<string, string>>;
}

/**
 * A dynamic mark at `onset` (wholes from its measure's downbeat) on the staff
 * of the `Measure` holding it. `voice` is the voice stream export writes it in
 * (MusicXML has no stream-free way to place a direction), not a claim that
 * the dynamic applies to one voice only: playback applies it to the whole
 * staff. Immutable; an edit replaces `Measure.dynamics` wholesale.
 */
export interface DynamicMark {
	readonly kind: DynamicKind;
	readonly onset: number;
	readonly placement: Placement | null;
	readonly voice: number;
	readonly source: DirectionSource | null;
}

export type WedgeKind = 'crescendo' | 'diminuendo';

/** One end of a `Wedge`: a position on the wedge's staff. `voice` and
 *  `source` are export's, as on `DynamicMark`. */
export interface WedgeEnd {
	readonly measureIndex: number;
	/** Wholes from that measure's downbeat. May equal the measure's length
	 *  (the usual "to the barline" stop). */
	readonly onset: number;
	readonly voice: number;
	readonly source: DirectionSource | null;
}

/**
 * A crescendo or diminuendo hairpin on staff `staffIndex`, from `start` to
 * `stop` (never before it; equal for the zero-length hairpins OMR sometimes
 * reports, which layout draws nothing for). `placement` is the start
 * direction's, the side the whole hairpin is drawn on. MusicXML's wedge
 * `number` (which pairs a start with its stop when hairpins overlap) is not
 * held: the pairing *is* this object, and export allocates numbers afresh.
 * Immutable; an edit replaces the entry in `Score.wedges`.
 */
export interface Wedge {
	readonly kind: WedgeKind;
	readonly staffIndex: number;
	readonly placement: Placement | null;
	readonly start: WedgeEnd;
	readonly stop: WedgeEnd;
}

/** The empty `Measure.dynamics`, shared (and frozen) so the common case costs
 *  no allocation per measure. */
export const NO_DYNAMICS: readonly DynamicMark[] = Object.freeze([]);

/** `marks` sorted by onset (stable, so marks at one onset keep their order),
 *  the order `Measure.dynamics` is kept in. */
export function sortDynamics(marks: readonly DynamicMark[]): readonly DynamicMark[] {
	return marks.length === 0 ? NO_DYNAMICS : [...marks].sort((a, b) => a.onset - b.onset);
}

/** Whether position `a` (measure index, onset) comes strictly before `b`. */
export function positionBefore(
	a: { readonly measureIndex: number; readonly onset: number },
	b: { readonly measureIndex: number; readonly onset: number }
): boolean {
	return a.measureIndex < b.measureIndex || (a.measureIndex === b.measureIndex && a.onset < b.onset - 1e-9);
}
