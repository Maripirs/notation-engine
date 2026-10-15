// Lyrics (M6 Slice 9): the syllables sung on a note, one per verse line.
//
// MusicXML writes a lyric as a `<lyric>` child of the `<note>` it is sung on,
// one per verse (`number="1"`, `number="2"`, ...), each holding one syllable:
// its text, where it sits in its word (`<syllabic>`: a whole word, or the
// first, a middle or the last syllable of a hyphenated one) and whether an
// extender line follows it through a melisma (`<extend>`). The model keeps
// exactly that shape on `Note.lyrics`: per note, per verse, no score-level
// span list, because nothing about a lyric spans notes in the file. The
// hyphens and extender lines that do span notes are an engraving consequence
// layout derives (a `begin`/`middle` syllable is followed by a hyphen up to the
// verse's next syllable; an extender runs to the end of the melisma), so they
// need no storage and survive every edit op that exists.
//
// Chords: MusicXML puts a chord's lyric on one of its `<note>`s (the first, in
// every encoder this engine has seen). A lyric stays on the head it was read
// from, like an articulation (M6 Slice 5), so a round trip writes it back
// there; layout reads the event's union (`eventLyrics`).
//
// Lossless round trip: a `<lyric>` carries much the model does not interpret
// (`placement`, `default-y`, `relative-x`, `justify`, `name`, `color`, font
// attributes and `xml:lang` on a `<text>`, an `<end-line/>`, ...). The model's
// fields and that formatting interleave (the font attributes sit *on* the
// `<text>` the model reads), so instead of a cut-down residual each lyric read
// from a file keeps its whole source element (`Lyric.source`), and export
// writes that back verbatim whenever reading it again gives the lyric's
// current fields, i.e. whenever nothing changed the lyric. No op edits a lyric
// yet; the one that does gets a regenerated `<lyric>` that keeps the source's
// attributes (see `musicxml-export.ts`). A `<lyric>` the model cannot hold at
// all (`<humming>`, `<laughing>`, or content out of the schema's order) is
// never promoted: it stays in `Note.passthrough`, the pre-Slice-9 path.
//
// Playback ignores lyrics: the engine synthesizes pitches, it does not sing.

import type { OpaqueElement } from './passthrough.js';

/** Where a syllable sits in its word (MusicXML `<syllabic>`): a whole word,
 *  or the first, a middle or the last syllable of a hyphenated one. */
export type Syllabic = 'single' | 'begin' | 'middle' | 'end';

/**
 * An extender (MusicXML `<extend>`): the line after a word's last syllable
 * held through a melisma. `'start'` (on the sung syllable), `'continue'` and
 * `'stop'` are MusicXML's `type`s; `'untyped'` is a bare `<extend/>`, which
 * encoders write on the sung syllable to mean "start". Layout only needs to
 * know that a syllable starts one and, optionally, which note a `'stop'`
 * names as the end (see `Lyric`).
 */
export type LyricExtend = 'start' | 'stop' | 'continue' | 'untyped';

/** One syllable of an elision (see `Lyric.elisions`). */
export interface ElidedSyllable {
	readonly syllabic: Syllabic;
	readonly text: string;
}

/**
 * One verse's syllable on one note. Immutable, so a clone may share it.
 *
 * `text` is `''` for an extend-only lyric (`<lyric><extend type="stop"/>`,
 * which some encoders write on the melisma's later notes): it draws nothing
 * itself but marks where its verse's extender ends.
 */
export interface Lyric {
	/** The verse line (MusicXML `number`), verbatim: `'1'` when unstated.
	 *  Ordered by `compareVerses`; verse 1's line sits nearest the staff. */
	readonly verse: string;
	/** `'single'` when unstated, MusicXML's own default. */
	readonly syllabic: Syllabic;
	readonly text: string;
	/**
	 * Further syllables sung on the same note after `text` (MusicXML
	 * `<elision>`, e.g. "sing_a" in one beat), each with its own syllabic.
	 * Drawn joined by an undertie. Empty for the usual single syllable.
	 */
	readonly elisions: readonly ElidedSyllable[];
	readonly extend: LyricExtend | null;
	/** The `<lyric>` this was read from (see the file comment), or `null` for
	 *  a lyric built in code, which export writes from the fields alone. */
	readonly source: OpaqueElement | null;
}

/** The empty `Note.lyrics`, shared (and frozen) so the common case costs no
 *  allocation per note. */
export const NO_LYRICS: readonly Lyric[] = Object.freeze([]);

/** What `Note`/`buildScore` accept for a lyric: everything but `text`
 *  optional (verse `'1'`, `'single'`, no elision, extender or source). */
export interface LyricSpec {
	readonly verse?: string;
	readonly syllabic?: Syllabic;
	readonly text: string;
	readonly elisions?: readonly ElidedSyllable[];
	readonly extend?: LyricExtend | null;
	readonly source?: OpaqueElement | null;
}

/** A frozen `Lyric` from a spec, defaults filled in. */
export function makeLyric(spec: LyricSpec): Lyric {
	return Object.freeze({
		verse: spec.verse ?? '1',
		syllabic: spec.syllabic ?? 'single',
		text: spec.text,
		elisions: spec.elisions && spec.elisions.length > 0 ? Object.freeze(spec.elisions.map((e) => Object.freeze({ ...e }))) : NO_ELISIONS,
		extend: spec.extend ?? null,
		source: spec.source ?? null
	});
}

const NO_ELISIONS: readonly ElidedSyllable[] = Object.freeze([]);

/** `specs` as a note's frozen lyric list (the shared empty one when none). A
 *  list this module already froze (a clone sharing a note's `lyrics`) is
 *  returned as-is: it and every lyric in it are immutable. */
export function normalizeLyrics(specs: readonly (Lyric | LyricSpec)[] | undefined): readonly Lyric[] {
	if (!specs || specs.length === 0) return NO_LYRICS;
	if (Object.isFrozen(specs) && specs.every((spec) => Object.isFrozen(spec) && 'source' in spec)) {
		return specs as readonly Lyric[];
	}
	return Object.freeze(specs.map(makeLyric));
}

/**
 * Verse order: numeric verses by value (so `'10'` follows `'9'`), before any
 * non-numeric name (MusicXML's `number` is a token, and some encoders write
 * `'verse1'` or `'chorus'`), which sort by string.
 */
export function compareVerses(a: string, b: string): number {
	const na = /^\d+$/.test(a) ? Number(a) : null;
	const nb = /^\d+$/.test(b) ? Number(b) : null;
	if (na !== null && nb !== null) return na - nb;
	if (na !== null) return -1;
	if (nb !== null) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The text a lyric draws: its syllable, then each elided one, joined by an
 *  undertie (U+203F), the usual typeset elision mark. */
export function lyricDisplayText(lyric: Lyric): string {
	if (lyric.elisions.length === 0) return lyric.text;
	return [lyric.text, ...lyric.elisions.map((e) => e.text)].join('‿');
}

/** Whether the word continues after this lyric's (last) syllable, i.e. a
 *  hyphen follows it. */
export function lyricContinuesWord(lyric: Lyric): boolean {
	const last = lyric.elisions.length > 0 ? lyric.elisions[lyric.elisions.length - 1]!.syllabic : lyric.syllabic;
	return last === 'begin' || last === 'middle';
}

/** Whether this lyric sings a syllable that starts an extender line. */
export function lyricStartsExtender(lyric: Lyric): boolean {
	return lyric.text !== '' && lyric.extend !== null && lyric.extend !== 'stop';
}

/**
 * The lyrics of one event (a note, or every head of a chord as `noteEvents`
 * groups them): one per verse, the first head's in event order winning when
 * two heads carry the same verse, sorted by verse. What layout draws.
 */
export function eventLyrics(event: readonly { readonly lyrics: readonly Lyric[] }[]): readonly Lyric[] {
	if (event.length === 1) {
		const own = event[0]!.lyrics;
		return own.length < 2 ? own : [...own].sort((a, b) => compareVerses(a.verse, b.verse));
	}
	const byVerse = new Map<string, Lyric>();
	for (const head of event) for (const lyric of head.lyrics) if (!byVerse.has(lyric.verse)) byVerse.set(lyric.verse, lyric);
	if (byVerse.size === 0) return NO_LYRICS;
	return [...byVerse.values()].sort((a, b) => compareVerses(a.verse, b.verse));
}

/**
 * `into` plus each lyric of `from` whose verse `into` lacks, for a correction
 * op that folds one chord head into another (`removeChordMember`): a verse
 * both carry keeps `into`'s syllable, the one that was drawn.
 */
export function mergeLyrics(into: readonly Lyric[], from: readonly Lyric[]): readonly Lyric[] {
	if (from.length === 0) return into;
	const extra = from.filter((lyric) => !into.some((own) => own.verse === lyric.verse));
	if (extra.length === 0) return into;
	return Object.freeze([...into, ...extra]);
}
