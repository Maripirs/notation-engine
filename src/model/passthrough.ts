// Lossless passthrough (M6 Slice 3): what the model keeps but does not model.
//
// This engine is model-native: import builds a `Score`, export re-serializes
// from the `Score`. Anything the model has no field for (dynamics, hairpins,
// articulations, lyrics, `<print>`, `<staff-details>`, `<identification>`, a
// grace note, ...) would otherwise vanish on the first import -> edit -> save
// round trip, which for an OMR draft means silently stripping it. The human's
// call (plan.md, M6 "Fidelity decision") was: model the common things, and keep
// everything else as an opaque payload, anchored where it appeared, that export
// writes back verbatim. Later M6 slices "promote" an element by teaching the
// importer to read it into a real model field; the importer then simply stops
// handing it to passthrough, so nothing here has to change for that.
//
// A payload is anchored at one of four places, each the narrowest owner that
// can re-emit it in the right spot and that an edit naturally carries along:
//
//   - `Note.passthrough`: unmodelled children of one `<note>` (`<lyric>`,
//     `<notehead>`, `<cue>`, `<notations>` holding only what the model does
//     not own, an unmatched `<tie>`, ...). It rides on the `Note`, so a
//     transpose keeps it, a chord member keeps its own, and deleting a note
//     (Slice 7) drops exactly its own payload with it.
//   - `Measure.passthrough`: whole `<measure>` children positioned in time
//     (`<direction>`, `<print>`, `<harmony>`, `<sound>`, `<figured-bass>`, a
//     grace `<note>`, an `<attributes>` holding nothing the model owns, ...),
//     each with the onset and voice stream it sat in; see `MeasurePassthrough`.
//   - `Measure.attributesPassthrough` / `Measure.barlinePassthrough`: the
//     unowned children of an `<attributes>`/`<barline>` the model *does* read
//     (a `<staff-details>` next to a `<clef>`, an `<ending>` on a final
//     barline), merged back into the one export writes.
//   - `Score.headerPassthrough` and `Part.passthrough`: the score header
//     (`<work>`, `<identification>`, `<defaults>`, `<credit>`, ...) and the
//     unowned children of a `<score-part>` / `<part-group>`.
//
// Payloads are immutable trees, so `Score.clone` (every undo snapshot) shares
// them by reference instead of copying: cloning a score with thousands of
// payloads costs one array copy per owner, not a deep walk.

/**
 * One opaque XML element: the same shape as `src/io/xml.ts`'s `XmlElement`, by
 * design, so the parser's frozen nodes are stored here as-is with no
 * conversion (TypeScript's structural typing makes one assignable to the
 * other). It is declared again here rather than imported because the model
 * layer depends on nothing else in the engine; `io` may depend on `model`,
 * never the reverse. A serialized string was the other option, but it would
 * cost a reparse every time a later slice (or the equivalence check) wants to
 * look inside a payload, and promotion is exactly "look inside a payload".
 *
 * As in `XmlElement`, character data is one `text` per element: MusicXML has
 * no mixed content, so the only text an element with children carries is
 * indentation, which export regenerates.
 */
export interface OpaqueElement {
	readonly name: string;
	readonly attrs: Readonly<Record<string, string>>;
	readonly children: readonly OpaqueElement[];
	readonly text: string;
}

/** An exact non-negative fraction, `num / den`, always reduced, `den > 0`. */
export interface Fraction {
	readonly num: number;
	readonly den: number;
}

/**
 * A `<measure>` child anchored in time.
 *
 * MusicXML places a `<direction>` (or `<harmony>`, a grace note, ...) at the
 * running time cursor where it appears in the measure's element stream, and
 * the stream is per voice, stitched together with `<backup>`/`<forward>`. The
 * model has no such stream (each voice is a flat note list), so the anchor
 * records the two things export needs to put the element back at the same
 * moment: `onset` (exact, from the measure's downbeat) and the `(staff,
 * voice)` stream it sat in (the staff is the `Measure` holding the anchor;
 * `voice` is here). Export walks each stream's events and writes an anchored
 * element just before the event at its onset, after the last event when it
 * sits at the stream's end, or (an onset inside a longer event) via `<backup>`
 * after the stream. The element's own `<staff>`/`<voice>`/`<offset>` children
 * stay inside it untouched: they are payload, not anchor.
 *
 * Which stream: a grace `<note>` is in its own `<staff>`/`<voice>`; anything
 * else is in the stream of the nearest `<note>` before it in the measure (the
 * next one, if none came before). That keeps an element in the stream it was
 * read from and makes re-import of an export land it at the same anchor.
 */
export interface MeasurePassthrough {
	readonly element: OpaqueElement;
	/** Time from the measure's downbeat, in whole notes. */
	readonly onset: Fraction;
	/** The voice stream on this anchor's staff it is written in. */
	readonly voice: number;
	/**
	 * A `<print>` (e.g. `new-system`) that appeared before anything else in the
	 * measure (its `<attributes>`, barlines and notes); export writes it first
	 * again, ahead of the attributes it conventionally precedes. Only a
	 * `<print>`: any other element at the very start is just at onset 0 in the
	 * first stream, where export writes it back anyway.
	 */
	readonly lead: boolean;
	/**
	 * The `<divisions>` in force where it was read. A `<direction>`'s `<offset>`
	 * (or a `<figured-bass>`'s `<duration>`) is counted in divisions, so export
	 * either writes the part with a `<divisions>` this divides (its default) or
	 * rescales those values.
	 */
	readonly divisions: number;
}

/** The shared empty payload list; every owner starts with it. */
export const NO_PASSTHROUGH: readonly never[] = Object.freeze([]);

/**
 * A canonical string for an element, for equality checks (`score-equivalence`)
 * rather than for output: attributes sorted, the indentation-only text of an
 * element with children ignored (export re-indents), a leaf's text verbatim.
 *
 * With `divisions`, any `<offset>` or `<duration>` value inside is written as
 * the exact fraction of a whole note it means, so the same direction read at
 * divisions 24 and re-exported at 48 (offset 6, then 12) compares equal.
 */
export function opaqueElementKey(element: OpaqueElement, divisions?: number): string {
	const attrs = Object.keys(element.attrs)
		.sort()
		.map((key) => ` ${key}=${JSON.stringify(element.attrs[key])}`)
		.join('');
	let body: string;
	if (element.children.length > 0) {
		body = element.children.map((c) => opaqueElementKey(c, divisions)).join('');
	} else if (divisions !== undefined && (element.name === 'offset' || element.name === 'duration')) {
		body = divisionValueKey(element.text, divisions);
	} else {
		body = JSON.stringify(element.text);
	}
	return `<${element.name}${attrs}>${body}</${element.name}>`;
}

function divisionValueKey(text: string, divisions: number): string {
	const value = Number(text.trim());
	if (!Number.isInteger(value)) return JSON.stringify(text);
	// value / (divisions * 4) wholes, reduced.
	let a = Math.abs(value);
	let b = divisions * 4;
	while (b !== 0) [a, b] = [b, a % b];
	const g = a === 0 ? 1 : a;
	return `${value / g}/${(divisions * 4) / g}`;
}

/**
 * A note's payload (`Note.passthrough`) with some markup filtered out (M6
 * Slice 7's correction ops): `drop` is asked about every top-level element
 * (`inNotations: false`, e.g. a bare `<tie>`) and every child of a
 * `<notations>` (`inNotations: true`, e.g. a `<tied>` or `<tuplet>`). A
 * `<notations>` left with no children is dropped whole, since export writes
 * its own when the model has something to state. Returns `payload` itself
 * (no allocation) when nothing matched, so an edit that strips nothing leaves
 * the shared, immutable payload untouched; otherwise a fresh frozen list with
 * fresh frozen `<notations>` nodes where they were cut down.
 */
export function withoutNoteMarkup(
	payload: readonly OpaqueElement[],
	drop: (element: OpaqueElement, inNotations: boolean) => boolean
): readonly OpaqueElement[] {
	let changed = false;
	const kept: OpaqueElement[] = [];
	for (const element of payload) {
		if (drop(element, false)) {
			changed = true;
			continue;
		}
		if (element.name === 'notations') {
			const children = element.children.filter((c) => !drop(c, true));
			if (children.length !== element.children.length) {
				changed = true;
				if (children.length > 0) kept.push(Object.freeze({ ...element, children: Object.freeze(children) }));
				continue;
			}
		}
		kept.push(element);
	}
	if (!changed) return payload;
	return kept.length === 0 ? NO_PASSTHROUGH : Object.freeze(kept);
}

/**
 * `payload` without tie markup of `type` (`'start'`, `'stop'`, or both when
 * omitted): a bare `<tie type>` and a `<notations><tied type>`. A note's
 * payload only ever holds a tie end the model did *not* link (an OMR tie that
 * found no partner, e.g. at a page join; see `finalizeNotePassthrough` in the
 * importer), so a correction op that links or clears a tie at that end strips
 * the stray markup too, or export would write the end twice (or write one the
 * user just removed).
 */
export function withoutTieMarkup(payload: readonly OpaqueElement[], type?: 'start' | 'stop'): readonly OpaqueElement[] {
	return withoutNoteMarkup(
		payload,
		(element, inNotations) =>
			(inNotations ? element.name === 'tied' : element.name === 'tie') &&
			(type === undefined || element.attrs.type === type)
	);
}
