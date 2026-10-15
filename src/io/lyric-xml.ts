// `<lyric>` <-> `Lyric` (M6 Slice 9), shared by import and export.
//
// Import promotes a `<lyric>` it can read (`readLyric`) and keeps the element
// as the lyric's `source`; export writes that source back verbatim exactly
// when reading it again still gives the lyric's fields (`lyricElement`), so a
// round trip loses none of the formatting the model does not interpret. Both
// directions go through the one reader here, so "unchanged" means the same
// thing on both sides.

import {
	makeLyric,
	opaqueElementKey,
	type ElidedSyllable,
	type Lyric,
	type LyricExtend,
	type OpaqueElement,
	type Syllabic
} from '../model/index.js';

/** `<lyric>` children after the syllable content that the source element
 *  (`Lyric.source`) carries and the model does not interpret. */
const LYRIC_TRAILERS: ReadonlySet<string> = new Set(['end-line', 'end-paragraph', 'footnote', 'level']);

/** One `<lyric>` as a `Lyric` (see the importer's `readLyrics` for the forms
 *  promoted), or `null` when its content is not a form the model holds. */
export function readLyric(el: OpaqueElement): Lyric | null {
	const content = el.children.filter((c) => !LYRIC_TRAILERS.has(c.name));
	// Trailers must really trail: one followed by content is out of order.
	const firstTrailer = el.children.findIndex((c) => LYRIC_TRAILERS.has(c.name));
	if (firstTrailer !== -1 && el.children.slice(firstTrailer).some((c) => !LYRIC_TRAILERS.has(c.name))) return null;
	let i = 0;
	const syllables: { syllabic: Syllabic; text: string }[] = [];
	const readSyllable = (): boolean => {
		let syllabic: Syllabic = 'single';
		if (content[i]?.name === 'syllabic') {
			const value = content[i]!.text.trim();
			if (!isSyllabic(value)) return false;
			syllabic = value;
			i++;
		}
		if (content[i]?.name !== 'text') return false;
		syllables.push({ syllabic, text: content[i]!.text });
		i++;
		return true;
	};
	if (content[0]?.name !== 'extend') {
		if (!readSyllable()) return null;
		while (content[i]?.name === 'elision') {
			i++;
			if (!readSyllable()) return null;
		}
	}
	let extend: LyricExtend | null = null;
	if (content[i]?.name === 'extend') {
		const type = content[i]!.attrs.type;
		if (type === undefined) extend = 'untyped';
		else if (type === 'start' || type === 'stop' || type === 'continue') extend = type;
		else return null;
		i++;
	}
	if (i !== content.length || (syllables.length === 0 && extend === null)) return null;
	const [first, ...elided] = syllables;
	const lyric = makeLyric({
		verse: el.attrs.number ?? '1',
		syllabic: first?.syllabic ?? 'single',
		text: first?.text ?? '',
		elisions: elided,
		extend,
		source: null
	});
	// A `<lyric>` saying exactly what export writes from the fields alone
	// keeps no source (the M6 Slice 6 rule for directions), so a score built
	// in code exports, re-imports and compares equal; anything more (an
	// attribute, formatting on `<text>`, an `<end-line/>`, an unstated
	// `number` or `<syllabic>`) is kept.
	if (opaqueElementKey(lyricElement(lyric)) === opaqueElementKey(el)) return lyric;
	return makeLyric({ ...lyric, source: el });
}

function isSyllabic(value: string): value is Syllabic {
	return value === 'single' || value === 'begin' || value === 'middle' || value === 'end';
}

/**
 * The `<lyric>` export writes for `lyric`: its `source` verbatim when that
 * still reads as the lyric (always, until an op edits lyrics), else one
 * regenerated from the fields, keeping the source's attributes (with
 * `number` restated) and trailing children (`<end-line>`, ...) so an edited
 * syllable keeps its placement and formatting.
 */
export function lyricElement(lyric: Lyric): OpaqueElement {
	const { source } = lyric;
	if (source) {
		const reread = readLyric(source);
		if (reread && sameLyric(reread, lyric)) return source;
	}
	const leaf = (name: string, text: string): OpaqueElement => ({ name, attrs: {}, children: [], text });
	const children: OpaqueElement[] = [];
	const syllable = (syllabic: Syllabic, text: string): void => {
		children.push(leaf('syllabic', syllabic), leaf('text', text));
	};
	if (lyric.text !== '' || lyric.elisions.length > 0) {
		syllable(lyric.syllabic, lyric.text);
		for (const elided of lyric.elisions) {
			children.push(leaf('elision', ''));
			syllable(elided.syllabic, elided.text);
		}
	}
	if (lyric.extend !== null) {
		children.push({ name: 'extend', attrs: lyric.extend === 'untyped' ? {} : { type: lyric.extend }, children: [], text: '' });
	}
	if (source) children.push(...source.children.filter((c) => LYRIC_TRAILERS.has(c.name)));
	return { name: 'lyric', attrs: { ...source?.attrs, number: lyric.verse }, children, text: '' };
}

function sameLyric(a: Lyric, b: Lyric): boolean {
	const sameElisions = (x: readonly ElidedSyllable[], y: readonly ElidedSyllable[]): boolean =>
		x.length === y.length && x.every((e, i) => e.syllabic === y[i]!.syllabic && e.text === y[i]!.text);
	return (
		a.verse === b.verse &&
		a.syllabic === b.syllabic &&
		a.text === b.text &&
		a.extend === b.extend &&
		sameElisions(a.elisions, b.elisions)
	);
}
