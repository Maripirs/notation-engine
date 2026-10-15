// Shared MusicXML test fixtures for the `src/io` tests: a document shell, a
// one-part builder, a note builder and an import -> export -> import round
// trip. Test-only; nothing in the engine imports this.

import { expect } from 'vitest';
import { assertScoresEquivalent, type Score } from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { importMusicXml } from './musicxml-import.js';
import { children, parseXml, type XmlElement } from './xml.js';

/** A `score-partwise` document around `body` (part list plus parts). */
export function doc(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n${body}\n</score-partwise>\n`;
}

/** One single-staff part `P1` in C major, 4/4, treble clef, with `measures`
 *  as the raw inner XML of each `<measure>`. */
export function onePart(measures: readonly string[], divisions = 2, partListExtra = ''): string {
	const attrs =
		`<attributes><divisions>${divisions}</divisions><key><fifths>0</fifths></key>` +
		`<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`;
	const body = measures.map((inner, i) => `<measure number="${i + 1}">${i === 0 ? attrs : ''}${inner}</measure>`).join('\n');
	return doc(
		`<part-list><score-part id="P1"><part-name>Voice</part-name>${partListExtra}</score-part></part-list>\n<part id="P1">${body}</part>`
	);
}

export interface NoteOptions {
	voice?: number;
	octave?: number;
	chord?: boolean;
	staff?: number;
}

/** A pitched `<note>`; `extra` is appended after `<type>`. */
export function n(step: string, duration: number, type: string, extra = '', options: NoteOptions = {}): string {
	const { voice = 1, octave = 5, chord = false, staff } = options;
	return (
		`<note>${chord ? '<chord/>' : ''}<pitch><step>${step}</step><octave>${octave}</octave></pitch>` +
		`<duration>${duration}</duration><voice>${voice}</voice><type>${type}</type>` +
		`${staff === undefined ? '' : `<staff>${staff}</staff>`}${extra}</note>`
	);
}

/** Import, export, re-import: the re-import is equivalent and a second
 *  export is identical to the first. */
export function roundTrip(xml: string): { score: Score; exported: string; root: XmlElement } {
	const score = importMusicXml(xml);
	const exported = exportMusicXml(score);
	const reimported = importMusicXml(exported);
	assertScoresEquivalent(reimported, score);
	expect(exportMusicXml(reimported)).toBe(exported);
	return { score, exported, root: parseXml(exported) };
}

/** The `<measure>`s of a parsed document's `partIndex`th part. */
export function measuresOf(root: XmlElement, partIndex = 0): XmlElement[] {
	return children(children(root, 'part')[partIndex]!, 'measure');
}

/** An element's child names, in order. */
export function names(el: XmlElement): string[] {
	return el.children.map((c) => c.name);
}
