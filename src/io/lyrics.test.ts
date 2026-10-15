// Lyrics through MusicXML (M6 Slice 9): import promotes `<lyric>` out of the
// note's passthrough into `Note.lyrics`, export writes it back after
// `<notations>` (verbatim when unchanged), and a re-import is equivalent.
// Exercised on the hand-written SATB fixture (the SFCC corpus has no lyrics)
// and on a small file full of `<lyric>` formatting the model does not read.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertScoresEquivalent, buildScore, EditHistory, opaqueElementKey, type Note } from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { createImportDiagnostics, importMusicXml } from './musicxml-import.js';
import { child, children, descendants, parseXml, type XmlElement } from './xml.js';

const FIXTURE = readFileSync(join(import.meta.dirname, '../test/fixtures/satb-lyrics.musicxml'), 'utf8');

function doc(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n${body}\n</score-partwise>\n`;
}

const ATTRS =
	'<attributes><divisions>2</divisions><key><fifths>0</fifths></key>' +
	'<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';

function onePart(measures: readonly string[]): string {
	const body = measures.map((inner, i) => `<measure number="${i + 1}">${i === 0 ? ATTRS : ''}${inner}</measure>`).join('\n');
	return doc(`<part-list><score-part id="P1"><part-name>S</part-name></score-part></part-list>\n<part id="P1">\n${body}\n</part>`);
}

const note = (step: string, lyrics: string, extra = '') =>
	`<note>${extra}<pitch><step>${step}</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type>${lyrics}</note>`;

/** Every `<lyric>` in document order, canonically keyed. */
function lyricKeys(root: XmlElement): string[] {
	return descendants(root, 'lyric').map((el) => opaqueElementKey(el));
}

function roundTrip(xml: string) {
	const score = importMusicXml(xml);
	const exported = exportMusicXml(score);
	const again = importMusicXml(exported);
	assertScoresEquivalent(again, score);
	expect(exportMusicXml(again)).toBe(exported);
	return { score, exported, root: parseXml(exported) };
}

/** The lyric-bearing notes of a staff, as `text(verse,syllabic[,extend])`. */
function sung(notes: readonly Note[]): string[] {
	return notes.flatMap((n) =>
		n.lyrics.map((l) => `${l.text}${l.elisions.map((e) => `_${e.text}`).join('')}(${l.verse},${l.syllabic}${l.extend ? `,${l.extend}` : ''})`)
	);
}

describe('MusicXML lyrics: the SATB fixture (M6 Slice 9)', () => {
	it('promotes every <lyric> into the model, none left as passthrough', () => {
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(FIXTURE, { diagnostics });
		expect(diagnostics.passthrough.get('lyric')).toBeUndefined();
		expect(score.staves).toHaveLength(4);
		const all = score.staves.flatMap((s) => s.measures.flatMap((m) => m.notes));
		expect(all.reduce((n, note) => n + note.lyrics.length, 0)).toBe(descendants(parseXml(FIXTURE), 'lyric').length);
		for (const n of all) expect(n.passthrough.some((el) => el.name === 'lyric')).toBe(false);

		const soprano = score.staves[0]!.measures;
		expect(sung(soprano[0]!.notes)).toEqual([
			'Al(1,begin)',
			'Hal(2,begin)',
			'le(1,middle)',
			'le(2,middle)',
			'lu(1,middle)',
			'lu(2,middle)',
			'ia,(1,end)',
			'jah,(2,end)'
		]);
		// The melisma's extender starts on "light," and an extend-only lyric
		// marks a stop; an elision keeps both syllables on one note.
		expect(sung(soprano[2]!.notes)).toContain('light,(1,single,start)');
		expect(sung(soprano[5]!.notes)).toEqual([
			'and(1,single)',
			'the(2,single)',
			'sing(1,single,start)',
			'earth(2,single,start)',
			'(1,single,stop)',
			'(2,single,stop)',
			'in_a(1,single)',
			'to(2,single)'
		]);
		// The fixture's lyrics are in the plain shape export writes, so none
		// needs its source kept.
		expect(all.flatMap((n) => n.lyrics).every((l) => l.source === null)).toBe(true);
	});

	it('round-trips losslessly: the same <lyric> elements, in order, and an equivalent re-import', () => {
		const { root } = roundTrip(FIXTURE);
		expect(lyricKeys(root)).toEqual(lyricKeys(parseXml(FIXTURE)));
		// Written after <notations>/<beam>, as the schema orders them.
		for (const noteEl of descendants(root, 'note')) {
			const names = noteEl.children.map((c) => c.name);
			const firstLyric = names.indexOf('lyric');
			if (firstLyric === -1) continue;
			expect(names.slice(firstLyric).every((name) => name === 'lyric')).toBe(true);
		}
	});

	it('survives a transpose and its undo', () => {
		const history = new EditHistory(importMusicXml(FIXTURE));
		const before = exportMusicXml(history.current);
		const target = history.current.staves[0]!.measures[2]!.notes[0]!;
		history.record((s) => s.transposeNote(target.id, 1));
		expect(history.current.findNote(target.id)!.lyrics.map((l) => l.text)).toEqual(['morn', 'ev']);
		history.undo();
		expect(exportMusicXml(history.current)).toBe(before);
	});
});

describe('MusicXML lyrics: formatting the model does not read (M6 Slice 9)', () => {
	const formatted =
		'<lyric number="1" name="verse" default-y="-80" relative-x="2" placement="below" justify="left" color="#000000">' +
		'<syllabic>begin</syllabic><text font-style="italic" xml:lang="la">Glo</text></lyric>' +
		'<lyric><text>bare</text></lyric>';
	const xml = onePart([
		note('C', formatted) +
			note('D', '<lyric number="1"><syllabic>end</syllabic><text>ri</text><extend type="start" default-y="-82"/><end-line/></lyric>') +
			note('E', '<lyric number="1"><extend type="continue"/></lyric><lyric number="2"><humming/></lyric>') +
			note('F', '<lyric number="1"><laughing/></lyric><lyric number="3"><text>x</text></lyric><lyric number="3"><text>dup</text></lyric>'),
		note('G', '') +
			note('E', '<lyric number="1"><text>member</text></lyric>', '<chord/>') +
			note('A', '<lyric number="1"><syllabic>single</syllabic><text>sing</text><elision>_</elision><syllabic>single</syllabic><text>a</text></lyric>') +
			note('B', '<lyric number="1"><syllabic>single</syllabic><text>end</text></lyric>') +
			note('C', '')
	]);

	it('promotes the syllable forms, keeps their source, and leaves the rest as passthrough', () => {
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(xml, { diagnostics });
		// <humming>, <laughing>, and a second lyric for a verse the note
		// already has (the unnumbered one is verse 1 too) are not held.
		expect(diagnostics.passthrough.get('lyric')).toBe(4);
		const [first, second] = score.staves[0]!.measures;
		const notes = first!.notes;
		expect(sung([notes[0]!])).toEqual(['Glo(1,begin)']);
		expect(notes[0]!.lyrics[0]!.source).not.toBeNull();
		expect(notes[1]!.lyrics[0]).toMatchObject({ text: 'ri', syllabic: 'end', extend: 'start' });
		expect(notes[1]!.lyrics[0]!.source).not.toBeNull();
		expect(notes[2]!.lyrics.map((l) => [l.verse, l.text, l.extend])).toEqual([['1', '', 'continue']]);
		expect(notes[3]!.lyrics.map((l) => [l.verse, l.text])).toEqual([['3', 'x']]);
		// A lyric a source puts on a chord member stays on that member.
		const chord = second!.notes;
		expect(chord[0]!.lyrics).toEqual([]);
		expect(chord[1]!.chordWithPrevious).toBe(true);
		expect(chord[1]!.lyrics.map((l) => l.text)).toEqual(['member']);
		expect(chord[2]!.lyrics[0]).toMatchObject({ text: 'sing', elisions: [{ text: 'a', syllabic: 'single' }] });
	});

	it('writes every <lyric> back with its formatting intact', () => {
		const { root, score } = roundTrip(xml);
		const source = parseXml(xml);
		// The same lyric elements, verbatim. Only their order on one note can
		// change: the promoted verse 3 is written ahead of the <laughing> one
		// the model does not hold.
		expect(lyricKeys(root).sort()).toEqual(lyricKeys(source).sort());
		const order = (r: XmlElement) => descendants(r, 'note').map((n) => children(n, 'lyric').map((l) => l.attrs.number ?? '-').join(','));
		expect(order(source)[3]).toBe('1,3,3');
		expect(order(root)[3]).toBe('3,1,3');
		// The member's lyric is written on the member.
		const memberEl = descendants(root, 'note').find((n) => child(n, 'chord'))!;
		expect(children(memberEl, 'lyric').map((l) => child(l, 'text')?.text)).toEqual(['member']);
		expect(score.staves[0]!.measures[1]!.notes[1]!.lyrics).toHaveLength(1);
	});
});

describe('MusicXML lyrics: a score built in code (M6 Slice 9)', () => {
	it('exports plain <lyric> elements that re-import to the same model', () => {
		const score = buildScore([
			[
				['C4', 'quarter', { lyrics: [{ text: 'Hal', syllabic: 'begin' }, { verse: '2', text: 'Sing' }] }],
				['D4', 'quarter', { lyrics: [{ text: 'le', syllabic: 'middle' }] }],
				['E4', 'quarter', { lyrics: [{ text: 'lu', syllabic: 'end', extend: 'start' }] }],
				['F4', 'quarter', { lyrics: [{ text: 'in', elisions: [{ text: 'a', syllabic: 'single' }] }] }]
			]
		]);
		const exported = exportMusicXml(score);
		const again = importMusicXml(exported);
		assertScoresEquivalent(again, score);
		const lyricEls = descendants(parseXml(exported), 'lyric');
		expect(lyricEls.map((l) => l.attrs.number)).toEqual(['1', '2', '1', '1', '1']);
		expect(lyricEls[3]!.children.map((c) => c.name)).toEqual(['syllabic', 'text', 'extend']);
		expect(lyricEls[3]!.children[2]!.attrs.type).toBe('start');
		expect(lyricEls[4]!.children.map((c) => c.name)).toEqual(['syllabic', 'text', 'elision', 'syllabic', 'text']);
		expect(again.measures[0]!.notes.flatMap((n) => n.lyrics).every((l) => l.source === null)).toBe(true);
	});

	it('noteToRest drops the note\'s lyrics from the export; removeChordMember moves them to the new anchor', () => {
		const score = buildScore([
			[
				[['C4', 'E4'], 'half', { lyrics: [{ text: 'Glo', syllabic: 'begin' }] }],
				['D4', 'half', { lyrics: [{ text: 'ry', syllabic: 'end' }] }]
			]
		]);
		const [anchor, member, d] = score.measures[0]!.notes;
		score.removeChordMember(anchor!.id);
		expect(score.findNote(member!.id)!.lyrics.map((l) => l.text)).toEqual(['Glo']);
		score.noteToRest(d!.id);
		const root = parseXml(exportMusicXml(score));
		const notes = descendants(root, 'note');
		expect(notes.map((n) => children(n, 'lyric').length)).toEqual([1, 0]);
		expect(child(child(notes[0]!, 'pitch')!, 'step')!.text).toBe('E');
		assertScoresEquivalent(importMusicXml(exportMusicXml(score)), score);
	});
});
