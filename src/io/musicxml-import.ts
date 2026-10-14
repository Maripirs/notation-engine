// Turning a MusicXML `score-partwise` document back into the model.
//
// This is the second half of Phase 5's format bridge. Where `musicxml-export.ts`
// is fully specified (every model field maps to one known element), import is
// not: a real-world file, and especially one produced by Audiveris' optical
// music recognition, carries far more than this model can hold, and carries the
// parts it *can* hold in shapes that vary. So the contract here is narrow and
// deliberately lax at the edges:
//
//   - It round-trips everything `exportMusicXml` emits: `import(export(score))`
//     is musically equal to `score` (see `score-equivalence.ts` for exactly
//     what "musically equal" excludes, notably cross-staff beam linkage, which
//     export has no MusicXML representation for).
//   - It reads the same subset out of a hand-written or third-party file.
//   - Anything outside that subset is kept, not dropped (M6 Slice 3): each
//     unmodelled element is stored verbatim as a passthrough payload anchored
//     where it appeared (on its `Note`, at an onset in its `Measure`, in a
//     measure's attributes or barline, or in the score header; see
//     `src/model/passthrough.ts`), and `exportMusicXml` writes it back there.
//     Which names are "modelled" is decided by the `*_OWNED` sets below, so a
//     later slice promotes an element by adding it to one and reading it.
//     What is still genuinely lost is small and listed in `ImportDiagnostics`.
//     A genuinely unrecognized element name is kept too, but `console.warn`ed
//     once, as a possible typo or newer MusicXML. The only hard errors are XML
//     that is not well-formed and a document whose root is not
//     `<score-partwise>`.
//   - Every drop, every passthrough and every lossy fallback can instead be
//     *counted* (M6 Slice 1): a caller passing `{ diagnostics }` gets a
//     per-element-name tally of what was dropped and of what was passed
//     through, plus one event per fallback, and no `console.warn` at all (the
//     caller asked to handle them). See `ImportDiagnostics` for exactly what is
//     and is not tallied. This is what the real-corpus test snapshots, so every
//     later slice that models an element shows up as that element moving out
//     of the passthrough tally.
//
// `<backup>` and `<forward>` are ignored for ordering notes. The model has no
// simultaneity to reconstruct: each `(staff, voice)` is a flat list whose notes'
// onsets are implied by cumulative duration, so bucketing every `<note>` by its
// `<staff>`/`<voice>` in document order is all the structure that is needed. A
// `<forward>` that carries a duration but no note (a rest gap some encoders
// write instead of an explicit `<note><rest/>`) is turned into a rest so the
// voice's later notes still land at the right offset; a `<backup>` is pure
// simultaneity bookkeeping and has nothing to contribute here. The one
// simultaneity the model does hold within a voice, a chord (M6 Slice 2), is
// MusicXML's own shape too: a `<chord/>` note joins the `<note>` just before
// it as a `chordWithPrevious` head and adds no time. The one thing that does
// track the time cursor is passthrough anchoring (`MeasureAnchors`): a
// `<direction>` read after a `<backup>` sits at the backed-up time.
//
// Dynamics and hairpins (M6 Slice 6) ride that same anchoring: their
// `<direction>` is anchored like any passthrough one, and once the whole part
// is read (a hairpin's stop can be measures after its start) `promoteDirections`
// turns it into model marks, keeping the rest of the element as the marks'
// `DirectionSource`, and takes it back out of the measure's passthrough.

import {
	ARTICULATIONS,
	DYNAMIC_KINDS,
	Measure,
	measureCapacityWholes,
	NO_PASSTHROUGH,
	sortDynamics,
	NOTE_VALUE_WHOLES,
	Score,
	type Articulation,
	type ClefType,
	type DirectionSource,
	type DynamicKind,
	type DynamicMark,
	type Placement,
	type Wedge,
	type WedgeKind,
	type Fermata,
	type MeasurePassthrough,
	type Note,
	type NoteId,
	type NoteValue,
	type OpaqueElement,
	type Pitch,
	type Step,
	type TimeSignature,
	type TupletRatio
} from '../model/index.js';
import { add, noteDurationQuarters, quartersToWholes, reduce, sub, ZERO, type Rational } from './rational.js';
import { child, childText, children, descendants, parseXml, type XmlElement } from './xml.js';

/**
 * What an import kept without modelling and what it lost, for a caller that
 * wants to know (a corpus regression test, a "this file had N things the
 * editor cannot show" banner).
 *
 * `passthrough` maps an element name to how many times it was kept as an
 * opaque passthrough payload (M6 Slice 3): shown by nothing, but written back
 * on export. The unit is "the topmost element kept", except that a
 * `<direction>` is tallied by its `<direction-type>` children (`dynamics`,
 * `wedge`, `words`, ...) plus its `<sound>`, a `<notations>` by its children
 * (`articulations`, `fermata`, ...), an `<attributes>` with nothing modelled
 * in it by its children (`staff-details`, ...), and a grace `<note>` once,
 * as `grace`: those are the units later slices promote, so each promotion
 * shows up as one name leaving this tally. A `<direction>`'s placement
 * metadata (`<offset>`, `<staff>`, `<voice>`) is not tallied; it belongs to
 * whatever it places.
 *
 * `dropped` counts what is genuinely lost, by the same unit. Since Slice 3
 * that is only: a `<chord/>` note with no pitched note to join (`chord`), the
 * `<unpitched>` of a percussion note (kept as a rest), sub-elements of the
 * modelled `<key>`/`<time>`/`<clef>` the model has no field for (`mode`,
 * `cancel`, `interchangeable`, ...), a `<clef>` overridden by a later one for
 * the same staff at the same onset (`clef`: never in force), and a
 * `<part-group>` spanning fewer than two staves (the model records a group as
 * a multi-staff `Part`).
 *
 * Neither tally counts what the engine regenerates from the model rather than
 * reads (`<stem>`, `<beam>`, `<accidental>`, `<backup>`; see `NOTE_OWNED`), or
 * a restatement the model normalizes away (a second `<divisions>`, several
 * `<attributes>` in one measure merged into one); the corpus round-trip test
 * lists those normalizations.
 *
 * `fallbacks` lists, in document order, every place the importer kept
 * something but had to guess (an unmappable duration read as a quarter, an
 * unrecognized clef read as treble), with where it happened.
 */
export interface ImportDiagnostics {
	readonly dropped: Map<string, number>;
	readonly passthrough: Map<string, number>;
	readonly fallbacks: ImportFallback[];
}

export interface ImportFallback {
	readonly kind: 'note-value' | 'clef';
	/** The `<part id>` and the `<measure number>` attribute, verbatim, so a
	 *  report points at the source file rather than at model indices. */
	readonly partId: string;
	readonly measureNumber: string;
	readonly detail: string;
}

export interface ImportOptions {
	/** Collect drops and fallbacks here instead of `console.warn`ing them. */
	readonly diagnostics?: ImportDiagnostics;
}

/** An empty `ImportDiagnostics`, ready to pass to `importMusicXml`. */
export function createImportDiagnostics(): ImportDiagnostics {
	return { dropped: new Map(), passthrough: new Map(), fallbacks: [] };
}

/**
 * Parse a MusicXML `score-partwise` document into a `Score`.
 *
 * Throws if `xml` is not well-formed, or if its root element is not
 * `<score-partwise>` (a `<score-timewise>` document has to be converted to
 * partwise first; nothing here does that conversion).
 */
export function importMusicXml(xml: string, options: ImportOptions = {}): Score {
	const root = parseXml(xml);
	if (root.name !== 'score-partwise') {
		const hint =
			root.name === 'score-timewise'
				? ' (score-timewise is not supported; convert it to score-partwise first)'
				: '';
		throw new Error(`importMusicXml: expected a <score-partwise> root element, got <${root.name}>${hint}`);
	}

	const report = new ImportReporter(options.diagnostics);
	const score = new Score();

	// Top-level metadata (`<work>`, `<identification>`, `<defaults>`,
	// `<credit>`, ...) has no model field; it is kept verbatim, in order, as the
	// score header. MusicXML only allows these before `<part-list>`, which is
	// where export writes them back.
	const header: OpaqueElement[] = [];
	for (const el of root.children) {
		if (el.name === 'part-list' || el.name === 'part') continue;
		header.push(el);
		report.keep(el.name);
	}
	if (header.length > 0) score.headerPassthrough = Object.freeze(header);

	// --- Part list: names and bracket/brace groupings -----------------------
	const partNameById = new Map<string, string>();
	const scorePartOrder: string[] = [];
	interface GroupSpan {
		readonly symbol: 'brace' | 'bracket';
		readonly firstScorePartIndex: number;
		readonly lastScorePartIndex: number;
		readonly passthrough: readonly OpaqueElement[];
	}
	const groupSpans: GroupSpan[] = [];
	const openGroups = new Map<
		string,
		{ symbol: 'brace' | 'bracket'; firstScorePartIndex: number; passthrough: readonly OpaqueElement[] }
	>();
	// A `<score-part>`'s and a `<part-group>`'s unowned children (instrument
	// and MIDI definitions, abbreviations, a group name), kept on the `Part`
	// each becomes. Export regenerates the ids, names and group symbol itself.
	const partPassthroughById = new Map<string, readonly OpaqueElement[]>();
	const keepUnowned = (el: XmlElement, owned: string): readonly OpaqueElement[] => {
		const kept = el.children.filter((c) => c.name !== owned);
		for (const c of kept) report.keep(c.name);
		return kept.length > 0 ? Object.freeze(kept) : NO_PASSTHROUGH;
	};

	const partListEl = child(root, 'part-list');
	if (partListEl) {
		for (const el of partListEl.children) {
			if (el.name === 'score-part') {
				const id = el.attrs.id ?? '';
				scorePartOrder.push(id);
				const name = childText(el, 'part-name');
				if (name !== undefined && name !== '') partNameById.set(id, name);
				partPassthroughById.set(id, keepUnowned(el, 'part-name'));
			} else if (el.name === 'part-group') {
				const number = el.attrs.number ?? '1';
				if (el.attrs.type === 'start') {
					const symbol: 'brace' | 'bracket' =
						childText(el, 'group-symbol') === 'brace' ? 'brace' : 'bracket';
					const passthrough = keepUnowned(el, 'group-symbol');
					openGroups.set(number, { symbol, firstScorePartIndex: scorePartOrder.length, passthrough });
				} else if (el.attrs.type === 'stop') {
					const open = openGroups.get(number);
					if (open) {
						openGroups.delete(number);
						groupSpans.push({
							symbol: open.symbol,
							firstScorePartIndex: open.firstScorePartIndex,
							lastScorePartIndex: scorePartOrder.length - 1,
							passthrough: open.passthrough
						});
					}
				}
			}
		}
	}

	// --- Staves: one Staff per <staves> count, clefs from the first <attributes> --
	interface PartInfo {
		readonly id: string;
		readonly baseStaffIndex: number;
		readonly staffCount: number;
		readonly divisions: number;
		readonly el: XmlElement;
	}
	const partEls = children(root, 'part');
	const partInfos: PartInfo[] = [];
	let nextStaffIndex = 0;

	for (const partEl of partEls) {
		const id = partEl.attrs.id ?? '';
		const firstAttrs = firstMeasureAttributes(partEl);
		const staffCount = Math.max(1, intText(firstAttrs && childText(firstAttrs, 'staves'), 1));
		const divisions = Math.max(1, intText(firstAttrs && childText(firstAttrs, 'divisions'), 1));
		const baseStaffIndex = nextStaffIndex;

		for (let k = 0; k < staffCount; k++) {
			// staves[0] already exists (the Score constructor makes it); every
			// other staff, across every part, is appended here.
			if (baseStaffIndex + k >= score.staves.length) score.appendStaff();
		}
		nextStaffIndex += staffCount;

		if (firstAttrs) {
			// The first clef per staff is the staff's initial clef; a later one
			// in measure 0 is a mid-measure change (see `applyAttributeChanges`).
			const seen = new Set<number>();
			for (const clefEl of children(firstAttrs, 'clef')) {
				const k = Math.max(1, intText(clefEl.attrs.number, 1)) - 1;
				const staff = score.staves[baseStaffIndex + k];
				if (staff && !seen.has(k)) {
					seen.add(k);
					report.at(id, firstMeasureNumber(partEl));
					staff.clef = mapClef(clefEl, report);
				}
			}
		}

		partInfos.push({ id, baseStaffIndex, staffCount, divisions, el: partEl });
	}
	const partInfoById = new Map(partInfos.map((info) => [info.id, info]));

	// --- Score-global key / time / tempo ----------------------------------
	const firstPartInfo = partInfos[0];
	if (firstPartInfo) {
		const attrs = firstMeasureAttributes(firstPartInfo.el);
		const keyEl = attrs && child(attrs, 'key');
		const fifths = keyEl && childText(keyEl, 'fifths');
		if (fifths !== undefined && fifths !== null) score.keyFifths = intText(fifths, 0);
		const timeEl = attrs && child(attrs, 'time');
		const time = timeEl ? parseTime(timeEl) : undefined;
		if (time) score.time = time;
	}
	const tempo = findTempo(root);
	if (tempo !== undefined) score.tempoBpm = tempo.bpm;

	// --- Recreate the part grouping --------------------------------------
	// Same order the export writes it: one `Part` per <score-part> that has a
	// matching <part> (each an addPart with its own staff indices, named when
	// the file names it), then every <part-group> span (an unnamed addPart
	// over every staff it covers). This reproduces a showcase's `score.parts`
	// shape exactly; `score-equivalence.ts` ignores the synthetic "Part N"
	// names export invents for unnamed staves, so re-adding them here is
	// harmless and keeps this loop rule-free.
	//
	// The `Score` constructor seeds one default part (`{ staffIndices: [0] }`)
	// so a hand-built single-staff score has a part without asking. An import
	// states its own parts, so that seed is dropped first, the same thing
	// `Score.clone` does. Leaving it in is what made a 5-part file (Brahms
	// "Der Abend") come back as 7 `Part`s: the seed, the 5 real parts and the
	// bracket group. The part-group itself is a `Part` on purpose (it is how
	// the model records a bracket; see `computePartGroupDecorations`), so the
	// honest count for such a file is 5 instrument parts plus 1 group.
	const staffIndicesOfScorePart = (scorePartIndex: number): number[] => {
		const info = partInfoById.get(scorePartOrder[scorePartIndex] ?? '');
		return info ? range(info.baseStaffIndex, info.staffCount) : [];
	};
	if (scorePartOrder.some((id) => partInfoById.has(id))) score.parts.length = 0;
	for (let i = 0; i < scorePartOrder.length; i++) {
		const staffIndices = staffIndicesOfScorePart(i);
		if (staffIndices.length === 0) continue;
		const id = scorePartOrder[i]!;
		score.addPart(staffIndices, partNameById.get(id), partPassthroughById.get(id));
	}
	for (const span of groupSpans) {
		const staffIndices: number[] = [];
		for (let i = span.firstScorePartIndex; i <= span.lastScorePartIndex; i++) {
			staffIndices.push(...staffIndicesOfScorePart(i));
		}
		staffIndices.sort((a, b) => a - b);
		if (staffIndices.length > 0) score.addPart(staffIndices, undefined, span.passthrough);
		// A group of one staff is no group to the model (export only writes
		// `<part-group>` for a `Part` of two or more staves), so it is a
		// genuine loss, its passthrough with it.
		if (staffIndices.length < 2) report.drop('part-group');
	}

	// --- Measures, notes, barlines, key/time changes ---------------------
	const builtNotes: BuiltNoteRecord[] = [];

	for (const info of partInfos) {
		const measureEls = children(info.el, 'measure');
		const measureCount = measureEls.length;
		// `<divisions>` is normally stated once, in measure 0, but a tolerant
		// reader honours a later restatement too.
		let divisions = info.divisions;
		// `<direction>`s carrying a dynamic or hairpin end, promoted once the
		// whole part is read (`promoteDirections`).
		const candidates: DirectionCandidate[] = [];

		for (let m = 0; m < measureCount; m++) {
			const measureEl = measureEls[m]!;
			const isLastMeasure = m === measureCount - 1;
			report.at(info.id, measureEl.attrs.number ?? String(m + 1));

			// One Measure object per staff this part owns, at this column.
			const measureObjs: Measure[] = [];
			for (let k = 0; k < info.staffCount; k++) {
				measureObjs.push(score.appendMeasure(info.baseStaffIndex + k));
			}

			// Key/time/clef first, from every `<attributes>` wherever it sits,
			// since a measure rest's length below depends on the time in force.
			// An `<attributes>` carrying nothing the model owns is not read here
			// at all: it is positional passthrough, handled in document order.
			const attributesExtras: OpaqueElement[] = [];
			for (const attrs of children(measureEl, 'attributes')) {
				if (!attrs.children.some((c) => ATTRIBUTES_OWNED.has(c.name))) continue;
				const restated = childText(attrs, 'divisions');
				if (restated !== undefined) divisions = Math.max(1, intText(restated, divisions));
				applyAttributeChanges(attrs, measureObjs, m, score);
				for (const c of attrs.children) {
					if (ATTRIBUTES_OWNED.has(c.name)) tallyOwnedAttributeChildren(c, report);
					else {
						attributesExtras.push(c);
						report.keep(c.name);
					}
				}
			}
			if (attributesExtras.length > 0) measureObjs[0]!.attributesPassthrough = Object.freeze(attributesExtras);

			const barlineExtras: OpaqueElement[] = [];
			for (const barlineEl of children(measureEl, 'barline')) {
				const kept = applyBarline(barlineEl, measureObjs, isLastMeasure);
				if (kept) {
					barlineExtras.push(kept);
					if (kept === barlineEl) report.keep('barline');
					else for (const c of kept.children) report.keep(c.name);
				}
			}
			if (barlineExtras.length > 0) measureObjs[0]!.barlinePassthrough = Object.freeze(barlineExtras);

			// Notes, forward-gaps and positional passthrough, in document order.
			// `chordState.last` is the last `<note>` built in this measure, which
			// a following `<chord/>` note joins (M6 Slice 2); anything else
			// between the two (a `<forward>`, a `<backup>`) breaks the chain.
			const chordState: ChordState = { last: null };
			const anchors = new MeasureAnchors(info, measureObjs, divisions);
			// Measure 0's first `<clef>` per staff is that staff's initial clef,
			// already read by the staves pass; `applyClefs` skips it.
			const initialClefPending = new Set<number>(m === 0 ? measureObjs.map((_, k) => k) : []);
			for (const el of measureEl.children) {
				if (el.name === 'note') {
					if (child(el, 'grace')) {
						// A grace note takes no time and the model has none (M6 Slice
						// 8), so it is kept whole, verbatim, in front of the note
						// that follows it in its own voice. A grace chord's
						// `<chord/>` members carry `<grace>` too and go the same way.
						chordState.last = null;
						anchors.grace(el);
						report.keep('grace');
						continue;
					}
					const built = buildNote(el, info, measureObjs, m, divisions, builtNotes, score, report, chordState);
					anchors.sourceTime(el, divisions);
					if (built) anchors.noteBuilt(built.k, built.note);
				} else if (el.name === 'forward') {
					chordState.last = null;
					const gap = synthesizeForwardRest(el, info, measureObjs, divisions, score, report);
					anchors.moved(el, divisions, 1);
					if (gap) anchors.noteBuilt(gap.k, gap.note);
				} else if (el.name === 'backup') {
					chordState.last = null;
					anchors.moved(el, divisions, -1);
				} else if (el.name === 'attributes') {
					if (el.children.some((c) => ATTRIBUTES_OWNED.has(c.name))) {
						applyClefs(el, measureObjs, anchors.position(), initialClefPending, report);
						anchors.endLead();
					} else {
						anchors.item(el);
						if (el.children.length === 0) report.keep('attributes');
						for (const c of el.children) report.keep(c.name);
					}
				} else if (el.name === 'barline') {
					anchors.endLead();
				} else if (
					tempo !== undefined &&
					info === partInfos[0] &&
					m === 0 &&
					isPlainTempoDirection(el, tempo)
				) {
					// The tempo direction exactly as export writes it (a quarter
					// `<metronome>` plus its `<sound tempo>`, nothing else), in the
					// first measure of the first part, where export writes it: it
					// is all `Score.tempoBpm`, which export regenerates, so it is
					// owned, not passed through. Passing it through would make every
					// export -> import of a built score gain a payload, and the
					// next export skip its own (equal) tempo mark for it.
					anchors.endLead();
				} else {
					// Everything else in a measure (`<direction>`, `<print>`,
					// `<sound>`, `<harmony>`, ...) is unmodelled, so it is kept at
					// the onset it appeared at. A name not even MusicXML knows is
					// kept too, but worth a warning.
					anchors.item(el);
					const pieces = el.name === 'direction' ? directionPieces(el) : null;
					if (pieces) candidates.push({ element: el, m, measureObjs, pieces, order: candidates.length });
					else if (el.name === 'direction') tallyDirection(el, report);
					else report.keep(el.name);
					if (!KNOWN_MEASURE_PASSTHROUGH.has(el.name)) report.unrecognized(el.name, 'measure');
				}
			}
			anchors.finish();
		}
		promoteDirections(candidates, info, score, report);
	}

	linkTies(builtNotes, score);
	linkSlurs(builtNotes, score);
	for (const record of builtNotes) finalizeNotePassthrough(record, score, report);

	return score;
}

/**
 * Whether `el` is a `<direction>` saying nothing but the score's tempo, in the
 * one shape export writes: `<direction-type><metronome>` with a plain
 * `quarter` `<beat-unit>` and the tempo's `<per-minute>`, and optionally a
 * `<sound tempo>` with the same value. Its attributes (`placement`) are not
 * looked at; they are presentation export regenerates.
 */
function isPlainTempoDirection(el: XmlElement, tempo: { readonly bpm: number; readonly source: XmlElement }): boolean {
	if (el.name !== 'direction') return false;
	let metronomeSeen = false;
	for (const c of el.children) {
		if (c.name === 'direction-type') {
			if (c.children.length !== 1 || c.children[0] !== tempo.source || metronomeSeen) return false;
			const metronome = c.children[0]!;
			const names = metronome.children.map((m) => m.name).join(',');
			if (names !== 'beat-unit,per-minute' || childText(metronome, 'beat-unit') !== 'quarter') return false;
			if (Object.keys(metronome.attrs).length > 0) return false;
			metronomeSeen = true;
		} else if (c.name === 'sound') {
			if (c.children.length > 0 || Object.keys(c.attrs).join(',') !== 'tempo') return false;
			if (Number.parseFloat(c.attrs.tempo!) !== tempo.bpm) return false;
		} else {
			return false;
		}
	}
	return metronomeSeen;
}

// --- Positional passthrough ---------------------------------------------------

/** A positional payload while its measure is still being read; `onset` in
 *  quarters (this file's time unit), `k` the staff within the part. */
interface PendingAnchor {
	readonly element: XmlElement;
	/** The stream to fall back to if no note follows before the next
	 *  `<backup>`/`<forward>` or the measure's end. */
	fallback: { readonly k: number; readonly voice: number } | null;
	k: number;
	voice: number;
	onset: Rational;
	readonly lead: boolean;
}

/**
 * Anchors a measure's positional passthrough (`MeasurePassthrough`) while the
 * measure is read in document order.
 *
 * It tracks two clocks. The *source* cursor is MusicXML's own: every note's
 * `<duration>` (chord members and grace notes excepted) moves it forward, a
 * `<backup>` back, a `<forward>` forward. The *model* clock is per `(staff,
 * voice)` stream: the exact length of the model events appended to it so far.
 * An element right after a note is anchored at that note's stream's model
 * clock, i.e. "just after that event", which stays right even when an OMR
 * `<duration>` disagrees with the `<type>` the model trusts; only an element
 * after a `<backup>`/`<forward>` needs the source cursor. Either way export
 * writes it back so that re-import computes the same anchor.
 *
 * The stream is the previous note's when nothing moved the cursor since; after
 * a `<backup>`/`<forward>` (or before any note) it is the next note's, if one
 * follows before the cursor moves again, else the previous note's (an element
 * export wrote after a stream via `<backup>`), else staff 1 voice 1 in a
 * measure with no notes at all. These are exactly the places export writes a
 * stream's elements, so a re-import lands each in the same stream. A grace
 * note is the exception: it is a note, so it goes in its
 * own `<staff>`/`<voice>` stream, at that stream's current model clock, which
 * is exactly the onset of the note it ornaments. `finish` then moves anything
 * whose voice has no notes in that measure onto a stream that does, since
 * export can only write an element inside a stream it walks.
 */
class MeasureAnchors {
	readonly #items: PendingAnchor[] = [];
	readonly #streamClock = new Map<string, Rational>();
	readonly #waitingForNote: PendingAnchor[] = [];
	#sourceCursor: Rational = ZERO;
	#previous: { readonly k: number; readonly voice: number } | null = null;
	#movedSincePrevious = false;
	#lead = true;

	constructor(
		private readonly info: { baseStaffIndex: number; staffCount: number },
		private readonly measureObjs: readonly Measure[],
		private readonly divisions: number
	) {}

	/** The onset (quarters) an element read right now is anchored at, the same
	 *  rule `item` applies: the previous note's stream clock when nothing has
	 *  moved the cursor since, else the source cursor. An owned
	 *  `<attributes>`'s clefs are placed by it (M6 Slice 4). */
	position(): Rational {
		if (this.#previous && !this.#movedSincePrevious) return this.#clock(this.#previous.k, this.#previous.voice);
		return this.#sourceCursor;
	}

	/** Nothing read so far makes a later element "lead" any more. */
	endLead(): void {
		this.#lead = false;
	}

	/**
	 * A positional element at the current position. Only a `<print>` can lead:
	 * anything else at the very start of a measure is simply at onset 0 in the
	 * first stream, which is also where export writes it, so it reads back the
	 * same; a "lead" direction would read back as an onset-0 one.
	 */
	item(element: XmlElement): void {
		const lead = this.#lead && element.name === 'print';
		const pending: PendingAnchor = { element, fallback: this.#previous, k: 0, voice: 1, onset: ZERO, lead };
		this.#items.push(pending);
		if (lead) return;
		if (this.#previous && !this.#movedSincePrevious) {
			pending.k = this.#previous.k;
			pending.voice = this.#previous.voice;
			pending.onset = this.#clock(this.#previous.k, this.#previous.voice);
		} else {
			pending.onset = this.#sourceCursor;
			this.#waitingForNote.push(pending);
		}
	}

	/** Waiting anchors with a previous note settle on its stream. */
	#settleWaitingOnFallback(): void {
		const stillWaiting: PendingAnchor[] = [];
		for (const pending of this.#waitingForNote) {
			if (pending.fallback) {
				pending.k = pending.fallback.k;
				pending.voice = pending.fallback.voice;
			} else {
				stillWaiting.push(pending);
			}
		}
		this.#waitingForNote.length = 0;
		this.#waitingForNote.push(...stillWaiting);
	}

	/** A grace note, in its own stream at that stream's clock. */
	grace(element: XmlElement): void {
		this.#lead = false;
		const k = Math.min(Math.max(1, intText(childText(element, 'staff'), 1)) - 1, this.info.staffCount - 1);
		const voice = Math.max(1, intText(childText(element, 'voice'), 1));
		this.#items.push({ element, fallback: null, k, voice, onset: this.#clock(k, voice), lead: false });
	}

	/** Advance the source cursor past a `<note>` (its own `<duration>`). */
	sourceTime(noteEl: XmlElement, divisions: number): void {
		this.#lead = false;
		if (child(noteEl, 'chord')) return;
		const duration = intText(childText(noteEl, 'duration'), 0);
		if (duration > 0) this.#sourceCursor = add(this.#sourceCursor, reduce({ num: duration, den: divisions }));
	}

	/** A `<backup>` (`sign` -1) or `<forward>` (+1) moved the source cursor. */
	moved(el: XmlElement, divisions: number, sign: 1 | -1): void {
		this.#lead = false;
		this.#movedSincePrevious = true;
		this.#settleWaitingOnFallback();
		const duration = intText(childText(el, 'duration'), 0);
		if (duration <= 0) return;
		const next = (sign > 0 ? add : sub)(this.#sourceCursor, reduce({ num: duration, den: divisions }));
		this.#sourceCursor = next.num < 0 ? ZERO : next;
	}

	/** A model note (or `<forward>` rest) was appended to staff `k`. */
	noteBuilt(k: number, note: Note): void {
		this.#lead = false;
		if (!note.chordWithPrevious) {
			this.#streamClock.set(`${k}:${note.voice}`, add(this.#clock(k, note.voice), noteDurationQuarters(note)));
		}
		for (const pending of this.#waitingForNote) {
			pending.k = k;
			pending.voice = note.voice;
		}
		this.#waitingForNote.length = 0;
		this.#previous = { k, voice: note.voice };
		this.#movedSincePrevious = false;
	}

	/** Settle every anchor onto its staff's `Measure`. */
	finish(): void {
		if (this.#items.length === 0) return;
		this.#settleWaitingOnFallback();
		const perStaff: MeasurePassthrough[][] = this.measureObjs.map(() => []);
		for (const pending of this.#items) {
			if (!pending.lead) this.#settleStream(pending);
			perStaff[pending.k]!.push({
				element: pending.element,
				onset: quartersToWholes(pending.onset),
				voice: pending.voice,
				lead: pending.lead,
				divisions: this.divisions
			});
		}
		perStaff.forEach((items, k) => {
			if (items.length > 0) this.measureObjs[k]!.passthrough = Object.freeze(items);
		});
	}

	/** Move an anchor whose voice has no notes on its staff in this measure to
	 *  the first stream export will actually walk: that staff's first voice,
	 *  else the first staff of the part with any notes. */
	#settleStream(pending: PendingAnchor): void {
		const own = this.measureObjs[pending.k]!.notes;
		if (own.some((note) => note.voice === pending.voice)) return;
		if (own.length > 0) {
			pending.voice = own[0]!.voice;
			return;
		}
		const k = this.measureObjs.findIndex((measure) => measure.notes.length > 0);
		if (k === -1) return;
		pending.k = k;
		pending.voice = this.measureObjs[k]!.notes[0]!.voice;
	}

	#clock(k: number, voice: number): Rational {
		return this.#streamClock.get(`${k}:${voice}`) ?? ZERO;
	}
}

// --- Dynamics and hairpins (M6 Slice 6) ------------------------------------

/** One promotable `<direction-type>` inside a `<direction>`. */
type DirectionPiece =
	| { readonly slot: number; readonly kind: 'dynamic'; readonly dynamic: DynamicKind; readonly markAttrs: Readonly<Record<string, string>> }
	| {
			readonly slot: number;
			readonly kind: 'wedge';
			readonly type: WedgeKind | 'stop';
			readonly number: string;
			readonly markAttrs: Readonly<Record<string, string>>;
	  };

/** A `<direction>` with at least one promotable piece, while its part is read. */
interface DirectionCandidate {
	readonly element: XmlElement;
	readonly m: number;
	readonly measureObjs: readonly Measure[];
	readonly pieces: readonly DirectionPiece[];
	/** Document order within the part, the tie-break for hairpin pairing. */
	readonly order: number;
}

const DYNAMIC_OWNED: ReadonlySet<string> = new Set<string>(DYNAMIC_KINDS);

/**
 * The `<direction-type>`s of `directionEl` the model can hold, or `null` for
 * none. A `<direction-type>` is promoted only in the one shape that maps
 * exactly: a single child, either a `<dynamics>` holding exactly one empty
 * element of a modelled kind (`<p/>`; an `<other-dynamics>` text, or two marks
 * in one `<dynamics>`, stay passthrough), or a `<wedge>` whose `type` is
 * `crescendo`, `diminuendo` or `stop` (a `continue` stays passthrough). Any
 * other `<direction-type>` beside it (`<words>`, ...) stays in the
 * `DirectionSource`.
 */
function directionPieces(directionEl: XmlElement): DirectionPiece[] | null {
	const pieces: DirectionPiece[] = [];
	directionEl.children.forEach((c, slot) => {
		if (c.name !== 'direction-type' || c.children.length !== 1 || Object.keys(c.attrs).length > 0) return;
		const mark = c.children[0]!;
		if (mark.name === 'dynamics') {
			const only = mark.children.length === 1 ? mark.children[0]! : undefined;
			if (!only || !DYNAMIC_OWNED.has(only.name) || only.children.length > 0 || only.text.trim() !== '') return;
			if (Object.keys(only.attrs).length > 0) return;
			pieces.push({ slot, kind: 'dynamic', dynamic: only.name as DynamicKind, markAttrs: mark.attrs });
		} else if (mark.name === 'wedge') {
			const type = mark.attrs.type;
			if (type !== 'crescendo' && type !== 'diminuendo' && type !== 'stop') return;
			if (mark.children.length > 0) return;
			const { type: _type, number = '1', ...markAttrs } = mark.attrs;
			pieces.push({ slot, kind: 'wedge', type, number, markAttrs });
		}
	});
	return pieces.length > 0 ? pieces : null;
}

/**
 * Turn a part's candidate `<direction>`s into `DynamicMark`s and `Wedge`s,
 * once the whole part has been read and anchored.
 *
 * Each candidate was anchored by `MeasureAnchors` like any passthrough
 * element, so its onset, stream and divisions are read off that entry, which
 * is then removed: what the model holds is no longer passthrough. A dynamic is
 * drawn on the staff its `<staff>` names (the stream it was written in can be
 * another staff's: a piano's `<direction><staff>2</staff>` usually follows
 * staff-1 notes), defaulting to the stream's staff.
 *
 * Hairpins pair start to stop by `number` (default 1) within the part, in
 * time order (measure, onset, then document order), which also pairs the
 * zero-length hairpins Audiveris writes as a start and a stop in one
 * `<direction>`. A start whose number is still open leaves the earlier start
 * unpaired; an unpaired start or stop cannot be modelled, so its whole
 * `<direction>` (with any dynamic beside it) stays passthrough, exactly as
 * before this slice.
 */
function promoteDirections(
	candidates: readonly DirectionCandidate[],
	info: { readonly baseStaffIndex: number; readonly staffCount: number },
	score: Score,
	report: ImportReporter
): void {
	if (candidates.length === 0) return;

	// Where each candidate was anchored.
	interface Anchored {
		readonly candidate: DirectionCandidate;
		readonly k: number;
		readonly anchor: MeasurePassthrough;
		/** Staff within the part the marks are drawn on. */
		readonly displayK: number;
		readonly onset: number;
	}
	const anchoredList: Anchored[] = [];
	for (const candidate of candidates) {
		const k = candidate.measureObjs.findIndex((measure) => measure.passthrough.some((a) => a.element === candidate.element));
		if (k === -1) continue;
		const anchor = candidate.measureObjs[k]!.passthrough.find((a) => a.element === candidate.element)!;
		const staffText = childText(candidate.element, 'staff');
		const displayK =
			staffText === undefined ? k : Math.min(Math.max(1, intText(staffText, 1)), info.staffCount) - 1;
		anchoredList.push({ candidate, k, anchor, displayK, onset: anchor.onset.num / anchor.onset.den });
	}

	// Pair hairpin ends by number, in time order.
	type WedgeRef = { readonly at: Anchored; readonly piece: Extract<DirectionPiece, { kind: 'wedge' }> };
	const ends: WedgeRef[] = [];
	for (const at of anchoredList) {
		for (const piece of at.candidate.pieces) if (piece.kind === 'wedge') ends.push({ at, piece });
	}
	ends.sort(
		(a, b) =>
			a.at.candidate.m - b.at.candidate.m ||
			a.at.onset - b.at.onset ||
			a.at.candidate.order - b.at.candidate.order ||
			a.piece.slot - b.piece.slot
	);
	const open = new Map<string, WedgeRef>();
	const pairs: [WedgeRef, WedgeRef][] = [];
	const paired = new Set<WedgeRef>();
	for (const end of ends) {
		if (end.piece.type !== 'stop') {
			open.set(end.piece.number, end);
			continue;
		}
		const start = open.get(end.piece.number);
		if (!start) continue;
		open.delete(end.piece.number);
		pairs.push([start, end]);
		paired.add(start);
		paired.add(end);
	}
	const rejected = new Set<DirectionCandidate>();
	for (const end of ends) if (!paired.has(end)) rejected.add(end.at.candidate);
	// A rejected direction keeps all its pieces, so a hairpin with one end in
	// it cannot be modelled either: reject its other end's direction too,
	// until nothing changes (rare chains of shared directions).
	for (let changed = rejected.size > 0; changed; ) {
		changed = false;
		for (const [start, stop] of pairs) {
			const a = rejected.has(start.at.candidate);
			const b = rejected.has(stop.at.candidate);
			if (a !== b) {
				rejected.add(a ? stop.at.candidate : start.at.candidate);
				changed = true;
			}
		}
	}

	// Build each promoted direction's source and marks.
	const sourceOf = new Map<DirectionPiece, DirectionSource>();
	const placementOf = new Map<DirectionCandidate, Placement | null>();
	const promotedByMeasure = new Map<Measure, Set<XmlElement>>();
	const newDynamics = new Map<Measure, DynamicMark[]>();
	for (const at of anchoredList) {
		const { candidate } = at;
		if (rejected.has(candidate)) {
			tallyDirection(candidate.element, report);
			continue;
		}
		// A dynamic or a hairpin start owns the direction's `placement`; a
		// bare stop leaves it in the source, where it changes nothing drawn.
		const ownsPlacement = candidate.pieces.some((p) => p.kind === 'dynamic' || p.type !== 'stop');
		const placementAttr = candidate.element.attrs.placement;
		const placement: Placement | null =
			ownsPlacement && (placementAttr === 'above' || placementAttr === 'below') ? placementAttr : null;
		placementOf.set(candidate, placement);
		const slots = new Set(candidate.pieces.map((p) => p.slot));
		let attrs = candidate.element.attrs;
		if (placement !== null) {
			const { placement: _placement, ...rest } = attrs;
			attrs = rest;
		}
		const element: OpaqueElement = Object.freeze({
			...candidate.element,
			attrs: Object.freeze(attrs),
			children: Object.freeze(candidate.element.children.filter((_, i) => !slots.has(i))),
			// A `<direction>` has no character data of its own, only the
			// indentation between children, which would read as content once
			// every child is cut out (and export regenerates indentation).
			text: ''
		});
		// A direction holding nothing but one mark (and, in a multi-staff part,
		// its `<staff>`) is exactly what export writes for a mark with no
		// source, so it gets none: a score built in code then round-trips to
		// the same model, and a later edit of the mark is not tied to a stale
		// wrapper.
		const plain =
			candidate.pieces.length === 1 &&
			Object.keys(candidate.pieces[0]!.markAttrs).length === 0 &&
			Object.keys(attrs).length === 0 &&
			element.children.every((c) => c.name === 'staff' && info.staffCount > 1 && intText(c.text, 0) === at.displayK + 1) &&
			element.children.length === (info.staffCount > 1 ? 1 : 0);
		for (const piece of candidate.pieces) {
			if (plain) continue;
			sourceOf.set(piece, Object.freeze({ element, slot: piece.slot, divisions: at.anchor.divisions, markAttrs: piece.markAttrs }));
		}
		tallyDirection(element, report);

		const holder = candidate.measureObjs[at.k]!;
		const promoted = promotedByMeasure.get(holder) ?? new Set();
		promoted.add(candidate.element);
		promotedByMeasure.set(holder, promoted);

		const target = candidate.measureObjs[at.displayK]!;
		const voice = voiceOnStaff(target, at.k === at.displayK ? at.anchor.voice : undefined);
		for (const piece of candidate.pieces) {
			if (piece.kind !== 'dynamic') continue;
			const list = newDynamics.get(target) ?? [];
			list.push(Object.freeze({ kind: piece.dynamic, onset: at.onset, placement, voice, source: sourceOf.get(piece) ?? null }));
			newDynamics.set(target, list);
		}
	}

	for (const [measure, promoted] of promotedByMeasure) {
		const kept = measure.passthrough.filter((a) => !promoted.has(a.element));
		measure.passthrough = kept.length > 0 ? Object.freeze(kept) : NO_PASSTHROUGH;
	}
	for (const [measure, marks] of newDynamics) measure.dynamics = Object.freeze(sortDynamics([...measure.dynamics, ...marks]));

	// Hairpins: drawn on the start's staff; each end's stream is on that
	// staff, the one export writes both ends from.
	const wedges: Wedge[] = [];
	for (const [start, stop] of pairs) {
		if (rejected.has(start.at.candidate) || rejected.has(stop.at.candidate)) continue;
		const displayK = start.at.displayK;
		const staffIndex = info.baseStaffIndex + displayK;
		const end = (ref: WedgeRef) => {
			const measure = ref.at.candidate.measureObjs[displayK]!;
			return Object.freeze({
				measureIndex: ref.at.candidate.m,
				onset: ref.at.onset,
				voice: voiceOnStaff(measure, ref.at.k === displayK ? ref.at.anchor.voice : undefined),
				source: sourceOf.get(ref.piece) ?? null
			});
		};
		wedges.push(
			Object.freeze({
				kind: start.piece.type as WedgeKind,
				staffIndex,
				placement: placementOf.get(start.at.candidate) ?? null,
				start: end(start),
				stop: end(stop)
			})
		);
	}
	score.wedges.push(...wedges);
}

/** `preferred` if `measure` has notes in that voice, else its first voice
 *  (1 when it has none): the stream export writes a mark on this staff in. */
function voiceOnStaff(measure: Measure, preferred: number | undefined): number {
	if (preferred !== undefined && measure.notes.some((note) => note.voice === preferred)) return preferred;
	return measure.notes[0]?.voice ?? preferred ?? 1;
}

// --- Attributes: mid-score and per-part key/time changes ---------------------

/**
 * Apply an `<attributes>`'s `<clef>`s at `onsetQuarters`, the onset a
 * positional element at the same point would be anchored at
 * (`MeasureAnchors.position`), which is also where export writes a change
 * back (M6 Slice 4).
 *
 * A `<clef>` is per staff, addressed by its `number` attribute (1-based within
 * the part, default 1). At onset 0 it is the measure's downbeat clef,
 * `Measure.clef` (M5 Slice 5); later it is a `Measure.clefChanges` entry, so
 * the notes before it keep the clef they were written in. A clef at the
 * measure's very end, OMR's usual spelling of a change for the next downbeat,
 * is such an entry too: layout draws it before the barline, and the next
 * measure inherits it through `Score.clefAt`. Two clefs for one staff at one
 * onset leave the later one; the earlier, never in force, is tallied dropped.
 */
function applyClefs(
	attrs: XmlElement,
	measureObjs: readonly Measure[],
	onsetQuarters: Rational,
	initialClefPending: Set<number>,
	report: ImportReporter
): void {
	const onsetRational = quartersToWholes(onsetQuarters);
	const onset = onsetRational.num / onsetRational.den;
	for (const clefEl of children(attrs, 'clef')) {
		const k = Math.max(1, intText(clefEl.attrs.number, 1)) - 1;
		const measure = measureObjs[k];
		if (!measure) continue;
		if (initialClefPending.delete(k)) continue;
		const clef = mapClef(clefEl, report);
		if (onset === 0) {
			if (measure.clef !== undefined) report.drop('clef');
			measure.clef = clef;
			continue;
		}
		const kept = measure.clefChanges.filter((change) => Math.abs(change.onset - onset) > 1e-9);
		if (kept.length < measure.clefChanges.length) report.drop('clef');
		measure.clefChanges = [...kept, { onset, clef }].sort((a, b) => a.onset - b.onset);
	}
}

/**
 * Apply a measure's `<attributes>` key/time/clef to the model.
 *
 * At measure 0 an `<attributes>` only records a *change* when its value differs
 * from the score-global one (this is how a per-staff key like the grand-staff
 * showcase's Eb-major bass under a D-major score comes back). At any later
 * measure, a `<key>`/`<time>` present at all is a change, recorded verbatim on
 * every staff of the part.
 *
 * A `<clef>` is not read here: since M6 Slice 4 it can sit anywhere in the
 * measure, so `applyClefs` reads it in document order, where its onset is
 * known.
 */
function applyAttributeChanges(
	attrs: XmlElement,
	measureObjs: readonly Measure[],
	measureIndex: number,
	score: Score
): void {
	const keyEl = child(attrs, 'key');
	if (keyEl) {
		const fifthsText = childText(keyEl, 'fifths');
		if (fifthsText !== undefined) {
			const fifths = intText(fifthsText, 0);
			if (measureIndex !== 0 || fifths !== score.keyFifths) {
				for (const measure of measureObjs) measure.keyFifths = fifths;
			}
		}
	}
	const timeEl = child(attrs, 'time');
	if (timeEl) {
		const time = parseTime(timeEl);
		if (time && (measureIndex !== 0 || !timeSignaturesEqual(time, score.time))) {
			for (const measure of measureObjs) measure.time = time;
		}
	}
}

// --- Barlines --------------------------------------------------------------

/**
 * Map a `<barline>` onto `Measure.startBarline` / `Measure.endBarline`, and
 * return what of it the model did not take, for `Measure.barlinePassthrough`:
 * `undefined` when the model took all of it, the barline itself when it took
 * nothing (a `dashed` or `heavy` bar-style, a left barline that opens no
 * repeat), or a copy with only the unowned children (an `<ending>` or
 * `<fermata>` beside a bar-style the model did read) otherwise. `repeat` is
 * owned only when the model holds the repeat it states: a `light-light`
 * barline with a backward repeat reads as `'double'`, and its `<repeat>`
 * stays passthrough rather than being lost.
 *
 * A right-side `light-heavy` with no repeat is a `'final'` barline, but only
 * when it is *not* the staff's last measure: the model leaves the last
 * measure's `endBarline` unset and `Score.endBarlineAt` defaults it to
 * `'final'`, so writing it explicitly there would make an otherwise-equal
 * round-trip compare unequal. Its bar-style is owned either way, since export
 * writes that final barline back.
 */
function applyBarline(
	barlineEl: XmlElement,
	measureObjs: readonly Measure[],
	isLastMeasure: boolean
): XmlElement | undefined {
	const location = barlineEl.attrs.location ?? 'right';
	const repeatDirection = child(barlineEl, 'repeat')?.attrs.direction;
	const barStyle = childText(barlineEl, 'bar-style');
	let ownsStyle = false;
	let ownsRepeat = false;

	if (location === 'left') {
		if (repeatDirection === 'forward') {
			for (const measure of measureObjs) measure.startBarline = 'repeatStart';
			ownsStyle = true;
			ownsRepeat = true;
		}
	} else if (location === 'right') {
		if (barStyle === 'light-light') {
			for (const measure of measureObjs) measure.endBarline = 'double';
			ownsStyle = true;
		} else if (barStyle === 'light-heavy' && repeatDirection === 'backward') {
			for (const measure of measureObjs) measure.endBarline = 'repeatEnd';
			ownsStyle = true;
			ownsRepeat = true;
		} else if (barStyle === 'light-heavy') {
			if (!isLastMeasure) for (const measure of measureObjs) measure.endBarline = 'final';
			ownsStyle = true;
		}
	}

	if (!ownsStyle) return barlineEl;
	const kept = barlineEl.children.filter(
		(c) => !(c.name === 'bar-style' || (ownsRepeat && c.name === 'repeat'))
	);
	if (kept.length === 0) return undefined;
	return Object.freeze({ ...barlineEl, children: Object.freeze(kept) });
}

// --- Notes --------------------------------------------------------------

// What the model owns, per container. Anything not owned is passthrough (M6
// Slice 3), so a later slice promotes an element by adding its name here and
// reading it. "Owned" includes *regenerated*: an element export re-derives
// from the model on its own (`<stem>`, `<beam>`), whose source copy is
// therefore not information the model lost, and which must not also be passed
// through or export would write it twice.

/** `<measure>` children with a known, deliberate passthrough home; any other
 *  unread name is passed through too, but warned about as unrecognized. */
const KNOWN_MEASURE_PASSTHROUGH: ReadonlySet<string> = new Set([
	'direction',
	'print',
	'sound',
	'harmony',
	'figured-bass',
	'grouping',
	'link',
	'bookmark',
	'listening'
]);

/** `<attributes>` children read into the model. */
const ATTRIBUTES_OWNED: ReadonlySet<string> = new Set(['divisions', 'key', 'time', 'clef', 'staves']);

/** What the model reads out of each owned attribute; anything else inside
 *  one (`<mode>`, `<cancel>`, `<interchangeable>`, ...) is a genuine loss. */
const OWNED_ATTRIBUTE_CONTENT: Readonly<Record<string, ReadonlySet<string>>> = {
	key: new Set(['fifths']),
	time: new Set(['beats', 'beat-type']),
	clef: new Set(['sign', 'line', 'clef-octave-change'])
};

/** `<note>` children the model reads, merges (`rest`, `notations`, `tie`:
 *  see `finalizeNotePassthrough`) or regenerates (`stem`, `beam`,
 *  `accidental`). `grace` never gets this far (a grace note is passed through
 *  whole), and `unpitched` is the one dropped child. */
const NOTE_OWNED: ReadonlySet<string> = new Set([
	'chord',
	'pitch',
	'unpitched',
	'rest',
	'duration',
	'tie',
	'voice',
	'type',
	'dot',
	'time-modification',
	'staff',
	'notations',
	'grace',
	'stem',
	'beam',
	'accidental'
]);

/** `<note>` children passed through as a matter of course; anything else
 *  unread is passed through too, but warned about as unrecognized. */
const KNOWN_NOTE_PASSTHROUGH: ReadonlySet<string> = new Set([
	'cue',
	'instrument',
	'footnote',
	'level',
	'notehead',
	'notehead-text',
	'lyric',
	'play',
	'listen'
]);

const NOTE_VALUES: readonly NoteValue[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];

/** The note a following `<chord/>` note joins: the last `<note>` built in
 *  the current measure, with where it landed. */
interface ChordState {
	last: {
		readonly measure: Measure;
		readonly k: number;
		readonly staffIndex: number;
		readonly voice: number;
		readonly pitched: boolean;
	} | null;
}

/** Build one non-grace `<note>`; returns it and the staff (within the part)
 *  it landed on, or `null` if it was dropped. */
function buildNote(
	noteEl: XmlElement,
	info: { baseStaffIndex: number; staffCount: number },
	measureObjs: readonly Measure[],
	measureIndex: number,
	divisions: number,
	builtNotes: BuiltNoteRecord[],
	score: Score,
	report: ImportReporter,
	chordState: ChordState
): { readonly k: number; readonly note: Note } | null {
	// `<chord/>` (M6 Slice 2): this note is another head of the previous
	// `<note>`'s chord. It joins that note's measure and voice outright,
	// rather than trusting its own `<staff>`/`<voice>`: MusicXML requires them
	// to agree, and the model's chord membership is defined by voice, so a
	// disagreeing encoder must not split one chord across two voices. With no
	// pitched note to join (the first note of a measure, or after a rest or a
	// grace note), or with no pitch of its own (a rest or unpitched head),
	// there is no chord to put it in; it is dropped and tallied as `chord`,
	// the one remaining way that count can be nonzero.
	const isChordMember = child(noteEl, 'chord') !== undefined;
	const anchor = isChordMember ? chordState.last : null;
	if (isChordMember && (!anchor || !anchor.pitched || !child(noteEl, 'pitch'))) {
		report.drop('chord');
		report.warnOnce('chord', 'importMusicXml: <chord/> note with no pitched note to join; dropping it');
		return null;
	}

	const staffNumber = Math.max(1, intText(childText(noteEl, 'staff'), 1));
	const ownK = Math.min(staffNumber - 1, measureObjs.length - 1);
	const k = anchor ? anchor.k : ownK;
	const targetMeasure = anchor ? anchor.measure : measureObjs[k] ?? measureObjs[0];
	if (!targetMeasure) return null;
	const globalStaffIndex = anchor ? anchor.staffIndex : info.baseStaffIndex + k;
	const voice = anchor ? anchor.voice : Math.max(1, intText(childText(noteEl, 'voice'), 1));
	const chordWithPrevious = anchor !== null;

	let pitch: Pitch | null = null;
	const restEl = child(noteEl, 'rest');
	if (!restEl) {
		const pitchEl = child(noteEl, 'pitch');
		if (pitchEl) {
			pitch = {
				step: (childText(pitchEl, 'step') ?? 'C') as Step,
				alter: Number.parseFloat(childText(pitchEl, 'alter') ?? '0') || 0,
				octave: intText(childText(pitchEl, 'octave'), 4)
			};
		} else if (child(noteEl, 'unpitched')) {
			// `<unpitched>` (percussion) has no model form; the note survives
			// as a rest, and the instrument line it sat on is lost.
			report.drop('unpitched');
		}
	}

	const timeModEl = child(noteEl, 'time-modification');
	let tuplet: TupletRatio | undefined;
	if (timeModEl) {
		const actualNotes = intText(childText(timeModEl, 'actual-notes'), 1);
		const normalNotes = intText(childText(timeModEl, 'normal-notes'), 1);
		if (actualNotes !== normalNotes) tuplet = { actualNotes, normalNotes };
	}

	const statedDots = Math.min(2, children(noteEl, 'dot').length) as 0 | 1 | 2;
	const notationsEls = children(noteEl, 'notations');
	const marks = readMarks(notationsEls);

	let note: Note;
	// `<rest measure="yes"/>` (M6 Slice 1): a rest that fills its measure
	// whatever the time signature. Its `<type>`, when present, is ignored on
	// purpose: OMR output writes `<type>whole</type>` on a 3/4 bar's measure
	// rest (Brahms "Der Abend" does, 392 times), and reading that literally
	// would make the bar a quarter too long. The duration it fills comes from
	// the time signature in force here, already applied to this measure by the
	// `<attributes>` pass above, rather than from `<duration>`, so a measure
	// rest always validates; see `NoteSpec.measureRestWholes` for the shape.
	if (restEl && restEl.attrs.measure === 'yes') {
		const measureRestWholes = measureCapacityWholes(score.timeAt(measureIndex, globalStaffIndex));
		note = score.appendNote(targetMeasure, {
			pitch: null,
			value: 'whole',
			voice,
			measureRestWholes,
			articulations: marks.articulations,
			fermata: marks.fermata
		});
	} else {
		const typeText = childText(noteEl, 'type');
		const { value, dots } =
			typeText !== undefined && isNoteValue(typeText)
				? { value: typeText, dots: statedDots }
				: deriveValueFromDuration(childText(noteEl, 'duration'), divisions, tuplet, statedDots, report, typeText);
		note = score.appendNote(targetMeasure, {
			pitch,
			value,
			voice,
			dots,
			tuplet,
			chordWithPrevious,
			articulations: marks.articulations,
			fermata: marks.fermata
		});
	}
	// A member keeps pointing a further `<chord/>` at the same chord: the
	// measure, staff and voice are the anchor's either way.
	chordState.last = { measure: targetMeasure, k, staffIndex: globalStaffIndex, voice, pitched: pitch !== null };

	// Tie state: `<tie>` is authoritative; fall back to `<notations><tied>`
	// only when there is no `<tie>` at all.
	let tieStart = false;
	let tieStop = false;
	const tieEls = children(noteEl, 'tie');
	if (tieEls.length > 0) {
		tieStart = tieEls.some((t) => t.attrs.type === 'start');
		tieStop = tieEls.some((t) => t.attrs.type === 'stop');
	} else {
		for (const notationsEl of notationsEls) {
			for (const tied of children(notationsEl, 'tied')) {
				if (tied.attrs.type === 'start') tieStart = true;
				if (tied.attrs.type === 'stop') tieStop = true;
			}
		}
	}

	const slurStarts: SlurEnd[] = [];
	const slurStops: SlurEnd[] = [];
	for (const notationsEl of notationsEls) {
		for (const slur of children(notationsEl, 'slur')) {
			const end: SlurEnd = { number: intText(slur.attrs.number, 1), el: slur, paired: false };
			if (slur.attrs.type === 'start') slurStarts.push(end);
			else if (slur.attrs.type === 'stop') slurStops.push(end);
		}
	}

	builtNotes.push({
		id: note.id,
		note,
		el: noteEl,
		staffIndex: globalStaffIndex,
		voice,
		pitch,
		tieStart,
		tieStop,
		slurStarts,
		slurStops,
		ownedMarks: marks.owned
	});
	return { k, note };
}

/** `<articulations>` children the model reads (M6 Slice 5); any other kind
 *  (`breath-mark`, `caesura`, `spiccato`, `stress`, ...) stays passthrough. */
const ARTICULATION_OWNED: ReadonlySet<string> = new Set<string>(ARTICULATIONS);

/**
 * The articulations and fermata a note's `<notations>` carry, and the exact
 * elements they were read from (`owned`), which `finalizeNotePassthrough`
 * then leaves out of the payload. Owned by identity rather than by name so a
 * duplicate the model cannot hold (a second `<staccato/>`, a second
 * `<fermata>` on one note) stays passthrough instead of being lost. A
 * fermata is read only in its normal shape (empty text or `normal`); an
 * angled, square or other shape is not modelled and stays passthrough whole.
 * The marks' own XML attributes (`placement`, `default-y`, a marcato's
 * `type="up"`) are not kept: layout decides placement by engraving rule, the
 * same loss as on every other modelled element (plan.md Slice 3 log).
 */
function readMarks(notationsEls: readonly XmlElement[]): {
	readonly articulations: readonly Articulation[];
	readonly fermata: Fermata | null;
	readonly owned: ReadonlySet<XmlElement>;
} {
	const articulations: Articulation[] = [];
	let fermata: Fermata | null = null;
	let owned: Set<XmlElement> | undefined;
	for (const notationsEl of notationsEls) {
		for (const c of notationsEl.children) {
			if (c.name === 'articulations') {
				for (const a of c.children) {
					if (!ARTICULATION_OWNED.has(a.name)) continue;
					const kind = a.name as Articulation;
					if (articulations.includes(kind)) continue;
					articulations.push(kind);
					(owned ??= new Set()).add(a);
				}
			} else if (c.name === 'fermata' && fermata === null) {
				const shape = c.text.trim();
				const type = c.attrs.type ?? 'upright';
				if ((shape !== '' && shape !== 'normal') || (type !== 'upright' && type !== 'inverted')) continue;
				fermata = type;
				(owned ??= new Set()).add(c);
			}
		}
	}
	return { articulations, fermata, owned: owned ?? NO_OWNED_MARKS };
}

const NO_OWNED_MARKS: ReadonlySet<XmlElement> = new Set();

/**
 * Settle a built note's `Note.passthrough` once ties and slurs are linked
 * (they decide what is still unowned): every `<note>` child the model does
 * not own, in source order, plus
 *
 *   - a `<rest>`'s children (`<display-step>`/`<display-octave>`, an
 *     engraver's manual rest height), as a bare `<rest>` export merges into
 *     the one it writes;
 *   - each `<notations>` cut down to what the model does not own: everything
 *     but `<tied>` and `<slur>` (both read), except that a `<tied>`/`<slur>`
 *     end that found no partner, or a `continue`/`let-ring` one, is kept,
 *     since export regenerates only the ties and slurs the model holds. A
 *     `<notations>` left empty is not kept; export writes the model's own.
 *     The articulations and fermata `readMarks` took are left out too (M6
 *     Slice 5), an `<articulations>` cut down to its unread kinds;
 *     `<tuplet>` is kept too: the model holds the ratio (`<time-modification>`)
 *     but not where a bracket starts and stops, so export writes the source's
 *     brackets back and regenerates its own only for a run with none;
 *   - a `<tie>` end the model did not link, for the same reason.
 *
 * Kept elements are the parser's own frozen nodes, shared, not copied; only a
 * cut-down `<notations>`/`<rest>` is a new (frozen) node.
 */
function finalizeNotePassthrough(record: BuiltNoteRecord, score: Score, report: ImportReporter): void {
	const note = record.note;
	const tieStartLinked = note.tiedToId !== null;
	const tieStopLinked = score.tiedFromNote(note.id) !== undefined;
	const tieEndOwned = (type: string | undefined): boolean =>
		(type === 'start' && tieStartLinked) || (type === 'stop' && tieStopLinked);

	let kept: OpaqueElement[] | undefined;
	const keep = (el: OpaqueElement): void => {
		(kept ??= []).push(el);
	};

	for (const c of record.el.children) {
		if (!NOTE_OWNED.has(c.name)) {
			keep(c);
			report.keep(c.name);
			if (!KNOWN_NOTE_PASSTHROUGH.has(c.name)) report.unrecognized(c.name, 'note');
		} else if (c.name === 'rest') {
			if (c.children.length === 0) continue;
			const { measure: _measure, ...attrs } = c.attrs;
			keep(Object.freeze({ name: 'rest', attrs: Object.freeze(attrs), children: c.children, text: '' }));
			for (const d of c.children) report.keep(d.name);
		} else if (c.name === 'tie') {
			if (tieEndOwned(c.attrs.type)) continue;
			keep(c);
			report.keep('tie');
		} else if (c.name === 'notations') {
			const unowned: OpaqueElement[] = [];
			for (const n of c.children) {
				if (n.name === 'tied' && tieEndOwned(n.attrs.type)) continue;
				if (n.name === 'slur' && isPairedSlur(record, n)) continue;
				if (record.ownedMarks.has(n)) continue;
				if (n.name === 'articulations' && n.children.some((a) => record.ownedMarks.has(a))) {
					// Cut down to the kinds the model does not hold; export merges
					// the rest back into the `<articulations>` it writes.
					const rest = n.children.filter((a) => !record.ownedMarks.has(a));
					if (rest.length > 0) unowned.push(Object.freeze({ ...n, children: Object.freeze(rest) }));
					continue;
				}
				unowned.push(n);
			}
			if (unowned.length === 0) continue;
			keep(Object.freeze({ ...c, children: Object.freeze(unowned) }));
			for (const n of unowned) report.keep(n.name);
		}
	}
	if (kept) note.passthrough = Object.freeze(kept);
}

function isPairedSlur(record: BuiltNoteRecord, slurEl: XmlElement): boolean {
	for (const end of record.slurStarts) if (end.el === slurEl) return end.paired;
	for (const end of record.slurStops) if (end.el === slurEl) return end.paired;
	return false;
}

/**
 * Tally a passed-through `<direction>` by what it carries: each
 * `<direction-type>` child by name (`dynamics`, `wedge`, `words`,
 * `metronome`, ...), plus its `<sound>`. Its placement metadata (`<offset>`,
 * `<staff>`, `<voice>`) is not tallied; see `ImportDiagnostics`.
 */
function tallyDirection(directionEl: XmlElement, report: ImportReporter): void {
	for (const c of directionEl.children) {
		if (c.name === 'direction-type') {
			for (const t of c.children) report.keep(t.name);
		} else if (c.name === 'sound') {
			report.keep('sound');
		}
	}
}

/** Tally what an owned `<key>`/`<time>`/`<clef>` carried that the model has
 *  no field for: those are lost, the element itself is not. */
function tallyOwnedAttributeChildren(el: XmlElement, report: ImportReporter): void {
	const read = OWNED_ATTRIBUTE_CONTENT[el.name];
	if (!read) return;
	for (const c of el.children) if (!read.has(c.name)) report.drop(c.name);
}

/**
 * A `<forward>` with a duration but no note: a rest gap in the current voice.
 * Synthesized as a real rest so the voice's later notes keep their offset.
 * Anything whose duration does not map to a note value (with dots) falls back
 * to a quarter rest via `deriveValueFromDuration`, which warns once.
 */
function synthesizeForwardRest(
	forwardEl: XmlElement,
	info: { baseStaffIndex: number; staffCount: number },
	measureObjs: readonly Measure[],
	divisions: number,
	score: Score,
	report: ImportReporter
): { readonly k: number; readonly note: Note } | null {
	const durationText = childText(forwardEl, 'duration');
	if (durationText === undefined) return null;
	const staffNumber = Math.max(1, intText(childText(forwardEl, 'staff'), 1));
	const k = Math.min(staffNumber - 1, measureObjs.length - 1);
	const targetMeasure = measureObjs[k] ?? measureObjs[0];
	if (!targetMeasure) return null;
	const voice = Math.max(1, intText(childText(forwardEl, 'voice'), 1));
	const { value, dots } = deriveValueFromDuration(durationText, divisions, undefined, 0, report);
	return { k, note: score.appendNote(targetMeasure, { pitch: null, value, voice, dots }) };
}

// --- Ties and slurs, resolved once every note exists ----------------------

/** One `<slur type="start|stop">` on a built note; `paired` once
 *  `linkSlurs` matched it, so an unpaired one is passed through instead. */
interface SlurEnd {
	readonly number: number;
	readonly el: XmlElement;
	paired: boolean;
}

type BuiltNoteRecord = {
	readonly id: NoteId;
	readonly note: Note;
	readonly el: XmlElement;
	readonly staffIndex: number;
	readonly voice: number;
	readonly pitch: Pitch | null;
	readonly tieStart: boolean;
	readonly tieStop: boolean;
	readonly slurStarts: readonly SlurEnd[];
	readonly slurStops: readonly SlurEnd[];
	/** The `<articulations>` children and `<fermata>` read into the model
	 *  (`readMarks`), left out of the note's passthrough. */
	readonly ownedMarks: ReadonlySet<XmlElement>;
};

/**
 * Where every drop, passthrough, warning and fallback goes. With a
 * caller-supplied `ImportDiagnostics` it only records (counts and events, no
 * console noise, since the caller asked to handle them itself); without one
 * it keeps the importer's original behaviour exactly: silent drops and
 * passthrough, and one `console.warn` per distinct unrecognized name, chord,
 * clef or fallback.
 *
 * `at` sets the source location (part id, measure number) that a fallback
 * event records; the measure loop updates it as it walks, which is cheaper
 * than threading a location through every helper that might fall back.
 */
class ImportReporter {
	readonly #diagnostics: ImportDiagnostics | undefined;
	readonly #warned = new Set<string>();
	#partId = '';
	#measureNumber = '';

	constructor(diagnostics: ImportDiagnostics | undefined) {
		this.#diagnostics = diagnostics;
	}

	at(partId: string, measureNumber: string): void {
		this.#partId = partId;
		this.#measureNumber = measureNumber;
	}

	/** A known element, genuinely lost. */
	drop(name: string): void {
		const dropped = this.#diagnostics?.dropped;
		if (dropped) dropped.set(name, (dropped.get(name) ?? 0) + 1);
	}

	/** An element kept as an opaque passthrough payload. */
	keep(name: string): void {
		const passthrough = this.#diagnostics?.passthrough;
		if (passthrough) passthrough.set(name, (passthrough.get(name) ?? 0) + 1);
	}

	/** An element name this importer has no bucket for. It is passed through
	 *  like any other unmodelled element (the caller tallies that), but worth
	 *  a warning, since it may be a typo or newer MusicXML. */
	unrecognized(name: string, container: string): void {
		this.warnOnce(name, `importMusicXml: passing through unrecognized <${name}> inside <${container}>`);
	}

	/** Something kept, but guessed. `warnKey` dedupes the console form, which
	 *  stays one generic message per kind; the recorded event is per site. */
	fallback(kind: ImportFallback['kind'], warnKey: string, message: string, detail: string): void {
		this.#diagnostics?.fallbacks.push({
			kind,
			partId: this.#partId,
			measureNumber: this.#measureNumber,
			detail
		});
		this.warnOnce(warnKey, message);
	}

	warnOnce(key: string, message: string): void {
		if (this.#diagnostics || this.#warned.has(key)) return;
		this.#warned.add(key);
		console.warn(message);
	}
}

/**
 * For every note that starts a tie, find the next note in the same staff and
 * voice with an equal pitch that carries a tie-stop, and wire the two through
 * `Score.setTie`. Mirrors `buildScore`'s forward-resolution loop.
 */
function linkTies(builtNotes: readonly BuiltNoteRecord[], score: Score): void {
	for (let i = 0; i < builtNotes.length; i++) {
		const source = builtNotes[i]!;
		if (!source.tieStart || source.pitch === null) continue;
		for (let j = i + 1; j < builtNotes.length; j++) {
			const candidate = builtNotes[j]!;
			if (candidate.staffIndex !== source.staffIndex || candidate.voice !== source.voice) continue;
			if (candidate.pitch === null || !pitchesMatch(candidate.pitch, source.pitch)) continue;
			if (!candidate.tieStop) continue;
			score.setTie(source.id, candidate.id);
			break;
		}
	}
}

/**
 * Pair `<slur type="start">`/`<slur type="stop">` by their `number`, per staff,
 * with a stack per number (so a reused or nested number still pairs
 * innermost-first), and hand each pair to `Score.addSlur`. Each paired end is
 * marked, so `finalizeNotePassthrough` keeps the unpaired ones.
 */
function linkSlurs(builtNotes: readonly BuiltNoteRecord[], score: Score): void {
	for (let staffIndex = 0; staffIndex < score.staves.length; staffIndex++) {
		const stackByNumber = new Map<number, { readonly id: NoteId; readonly end: SlurEnd }[]>();
		for (const note of builtNotes) {
			if (note.staffIndex !== staffIndex) continue;
			// Stops before starts on the same note: a note can close one slur and
			// open another under the same number.
			for (const stop of note.slurStops) {
				const start = stackByNumber.get(stop.number)?.pop();
				if (start === undefined) continue;
				score.addSlur(start.id, note.id);
				start.end.paired = true;
				stop.paired = true;
			}
			for (const end of note.slurStarts) {
				const stack = stackByNumber.get(end.number) ?? [];
				stack.push({ id: note.id, end });
				stackByNumber.set(end.number, stack);
			}
		}
	}
}

// --- Small parsers / helpers -------------------------------------------------

const CLEF_SIGNATURES: ReadonlyArray<{
	readonly sign: string;
	readonly line: string;
	readonly octaveChange?: string;
	readonly clef: ClefType;
}> = [
	{ sign: 'G', line: '2', clef: 'treble' },
	{ sign: 'G', line: '2', octaveChange: '-1', clef: 'treble8' },
	{ sign: 'F', line: '4', clef: 'bass' },
	// The two C clefs the model draws (M6 Slice 4). Soprano (C1), mezzo (C2)
	// and baritone (C5) still fall back to treble, reported.
	{ sign: 'C', line: '3', clef: 'alto' },
	{ sign: 'C', line: '4', clef: 'tenor' }
];

function mapClef(clefEl: XmlElement, report: ImportReporter): ClefType {
	const sign = childText(clefEl, 'sign') ?? '';
	const line = childText(clefEl, 'line') ?? '';
	const octaveChange = childText(clefEl, 'clef-octave-change');
	const normalizedOctave = octaveChange === undefined || octaveChange === '0' ? undefined : octaveChange;
	for (const candidate of CLEF_SIGNATURES) {
		if (candidate.sign === sign && candidate.line === line && candidate.octaveChange === normalizedOctave) {
			return candidate.clef;
		}
	}
	report.fallback(
		'clef',
		`clef:${sign}/${line}/${octaveChange ?? ''}`,
		`importMusicXml: unrecognized clef <sign>${sign}</sign><line>${line}</line>; defaulting to treble`,
		`sign ${sign} line ${line}${octaveChange === undefined ? '' : ` octave-change ${octaveChange}`}`
	);
	return 'treble';
}

function parseTime(timeEl: XmlElement): TimeSignature | undefined {
	const beatsText = childText(timeEl, 'beats');
	const beatTypeText = childText(timeEl, 'beat-type');
	if (beatsText === undefined || beatTypeText === undefined) return undefined;
	const beats = Number.parseInt(beatsText, 10);
	const beatType = Number.parseInt(beatTypeText, 10);
	if (!Number.isFinite(beats) || !Number.isFinite(beatType) || beatType <= 0) return undefined;
	return { beats, beatType };
}

/**
 * The tempo, in quarter-note BPM, from the first `<metronome><per-minute>`
 * anywhere in the document, or failing that the first `<sound tempo="...">`.
 * First one found wins; `undefined` if the document states none. The
 * `<direction>`/`<sound>` it came from is still passed through verbatim like
 * every other one (since M6 Slice 3; it may carry `<words>` too), and export
 * skips writing its own tempo direction when passthrough already states the
 * model's tempo (`passthroughTempo` there mirrors this search).
 */
function findTempo(root: XmlElement): { readonly bpm: number; readonly source: XmlElement } | undefined {
	for (const metronome of descendants(root, 'metronome')) {
		const perMinute = childText(metronome, 'per-minute');
		if (perMinute !== undefined) {
			const bpm = Number.parseFloat(perMinute);
			if (Number.isFinite(bpm)) return { bpm, source: metronome };
		}
	}
	for (const sound of descendants(root, 'sound')) {
		if (sound.attrs.tempo !== undefined) {
			const bpm = Number.parseFloat(sound.attrs.tempo);
			if (Number.isFinite(bpm)) return { bpm, source: sound };
		}
	}
	return undefined;
}

/**
 * Recover a value and dot count for a `<note>` (or `<forward>` gap) that has
 * no `<type>` (a tolerant path; every file `exportMusicXml` writes carries
 * `<type>`). `wholes` is `duration / (divisions * 4)`, un-scaled by any tuplet
 * ratio, and the value whose dotted duration matches within 1e-6 wins.
 *
 * `statedDots` is the note's own `<dot>` count. When it is nonzero only that
 * many dots are tried, since the file said so. When it is zero the dots are
 * derived too (fewest first: plain, then one dot, then two): an untyped note
 * usually has no `<dot>` either, and a 3/8 duration with no other clue is a
 * dotted quarter, not "unmappable". Nothing matching means a `quarter`
 * fallback, reported with the offending duration so a corpus run can list
 * every genuinely unmappable case (e.g. a 5/8 gap no single note spells).
 *
 * Also the path for a `<type>` the model has no value for (`breve`, `128th`,
 * ...): `unsupportedType` names it in the report, since "no type" would
 * misdescribe the source.
 */
function deriveValueFromDuration(
	durationText: string | undefined,
	divisions: number,
	tuplet: TupletRatio | undefined,
	statedDots: 0 | 1 | 2,
	report: ImportReporter,
	unsupportedType?: string
): { value: NoteValue; dots: 0 | 1 | 2 } {
	if (durationText !== undefined && divisions > 0) {
		let wholes = Number.parseFloat(durationText) / (divisions * 4);
		if (Number.isFinite(wholes)) {
			if (tuplet) wholes *= tuplet.actualNotes / tuplet.normalNotes;
			const dotCandidates: readonly (0 | 1 | 2)[] = statedDots > 0 ? [statedDots] : [0, 1, 2];
			for (const dots of dotCandidates) {
				const dotMultiplier = 2 - 2 ** -dots;
				for (const value of NOTE_VALUES) {
					if (Math.abs(NOTE_VALUE_WHOLES[value] * dotMultiplier - wholes) < 1e-6) return { value, dots };
				}
			}
		}
	}
	report.fallback(
		'note-value',
		'note-value-fallback',
		'importMusicXml: a <note> had no usable <type> and no duration that maps to a note value; using quarter',
		`${unsupportedType === undefined ? '' : `unsupported <type>${unsupportedType}</type>, `}duration ${
			durationText?.trim() ?? '(none)'
		} at divisions ${divisions}${
			tuplet ? ` in a ${tuplet.actualNotes}:${tuplet.normalNotes} tuplet` : ''
		}`
	);
	return { value: 'quarter', dots: statedDots };
}

function isNoteValue(text: string): text is NoteValue {
	return (NOTE_VALUES as readonly string[]).includes(text);
}

function pitchesMatch(a: Pitch, b: Pitch): boolean {
	return a.step === b.step && a.alter === b.alter && a.octave === b.octave;
}

function timeSignaturesEqual(a: TimeSignature, b: TimeSignature): boolean {
	return a.beats === b.beats && a.beatType === b.beatType;
}

function intText(text: string | null | undefined, fallback: number): number {
	if (text === undefined || text === null) return fallback;
	const parsed = Number.parseInt(text, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function range(start: number, count: number): number[] {
	return Array.from({ length: count }, (_, i) => start + i);
}

function firstMeasureNumber(partEl: XmlElement): string {
	return child(partEl, 'measure')?.attrs.number ?? '1';
}

/**
 * Measure 0's attributes, every `<attributes>` block of it merged into one
 * (children in document order), so a lookup finds the first `<key>`,
 * `<divisions>`, ... wherever it sits. Audiveris writes measure 1's `<key>`
 * in a second block after `<divisions>`/`<time>`/`<clef>`; reading only the
 * first block made the score-global key 0 and recorded the real key as a
 * measure-0 change instead, which an export -> import round trip then
 * "fixed", so the two imports compared unequal.
 */
function firstMeasureAttributes(partEl: XmlElement): XmlElement | undefined {
	const firstMeasure = child(partEl, 'measure');
	const blocks = firstMeasure ? children(firstMeasure, 'attributes') : [];
	if (blocks.length <= 1) return blocks[0];
	return { name: 'attributes', attrs: {}, children: blocks.flatMap((b) => b.children), text: '' };
}
