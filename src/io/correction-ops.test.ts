// Correction ops (M6 Slice 7) against MusicXML: passthrough tie markup is
// kept consistent with the model's ties, a deleted note's own payload goes
// with it, and after every op `export` still writes MusicXML that re-imports
// as the same score (on a hand-built score and on Les Djinns, the SFCC
// board's benchmark). The model-only semantics are in
// `src/model/correction-ops.test.ts`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	assertScoresEquivalent,
	buildScore,
	EditHistory,
	noteEvents,
	parsePitch,
	type MeasureRef,
	type Score
} from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { importMusicXml } from './musicxml-import.js';
import { child, children, parseXml } from './xml.js';

function doc(measures: readonly string[]): string {
	const body = measures
		.map((inner, i) => {
			const attrs =
				i === 0
					? `<attributes><divisions>2</divisions><key><fifths>0</fifths></key>` +
						`<time><beats>4</beats><beat-type>4</beat-type></time>` +
						`<clef><sign>G</sign><line>2</line></clef></attributes>`
					: '';
			return `<measure number="${i + 1}">${attrs}${inner}</measure>`;
		})
		.join('\n');
	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n` +
		`<part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>\n` +
		`<part id="P1">${body}</part>\n</score-partwise>\n`
	);
}

function n(step: string, duration: number, type: string, extra = '', chord = false): string {
	return `<note>${chord ? '<chord/>' : ''}<pitch><step>${step}</step><octave>5</octave></pitch><duration>${duration}</duration><voice>1</voice><type>${type}</type>${extra}</note>`;
}

/** Export, re-import, and require the same score back. */
function expectRoundTrip(score: Score): string {
	const xml = exportMusicXml(score);
	assertScoresEquivalent(importMusicXml(xml), score);
	return xml;
}

const count = (xml: string, re: RegExp): number => xml.match(re)?.length ?? 0;

describe('editTie and passthrough tie markup', () => {
	it('re-adds a tie lost at a page join, stripping the stray OMR start so export writes it once', () => {
		const xml = doc([
			n('C', 2, 'quarter') + n('D', 2, 'quarter') + n('E', 2, 'quarter') +
				n('C', 2, 'quarter', '<tie type="start"/><notations><tied type="start"/></notations>'),
			// The page join lost this note's tie stop.
			n('C', 8, 'whole')
		]);
		const score = importMusicXml(xml);
		const source = score.staves[0]!.measures[0]!.notes[3]!;
		const target = score.staves[0]!.measures[1]!.notes[0]!;
		expect(source.tiedToId).toBeNull();
		expect(source.passthrough.map((e) => e.name)).toEqual(['tie', 'notations']);

		const history = new EditHistory(score);
		const result = history.record((s) => s.editTie(source.id, target.id));
		expect(result).toEqual<MeasureRef[]>([
			{ staffIndex: 0, measureIndex: 0 },
			{ staffIndex: 0, measureIndex: 1 }
		]);
		expect(history.current.findNote(source.id)!.passthrough).toEqual([]);
		const written = expectRoundTrip(history.current);
		expect(count(written, /<tie type="start"\/>/g)).toBe(1);
		expect(count(written, /<tied type="start"\/>/g)).toBe(1);
		expect(count(written, /<tie type="stop"\/>/g)).toBe(1);
		expect(importMusicXml(written).staves[0]!.measures[0]!.notes[3]!.tiedToId).not.toBeNull();

		history.undo();
		expect(exportMusicXml(history.current)).toBe(exportMusicXml(score));
	});

	it('strips a stray stop on the target when the start was the half lost', () => {
		const xml = doc([
			n('C', 2, 'quarter') + n('D', 2, 'quarter') + n('E', 2, 'quarter') + n('C', 2, 'quarter'),
			n('C', 8, 'whole', '<tie type="stop"/><notations><tied type="stop"/></notations>')
		]);
		const score = importMusicXml(xml);
		const source = score.staves[0]!.measures[0]!.notes[3]!;
		const target = score.staves[0]!.measures[1]!.notes[0]!;
		expect(target.passthrough.length).toBeGreaterThan(0);
		expect(score.editTie(source.id, target.id)).not.toBeNull();
		expect(target.passthrough).toEqual([]);
		const written = expectRoundTrip(score);
		expect(count(written, /<tie type="stop"\/>/g)).toBe(1);
		expect(count(written, /<tied type="stop"\/>/g)).toBe(1);
	});

	it('untying removes a dangling OMR tie start the model never linked', () => {
		const xml = doc([
			n('C', 2, 'quarter') + n('D', 2, 'quarter') + n('E', 2, 'quarter') +
				n('C', 2, 'quarter', '<tie type="start"/><notations><tied type="start"/><fermata>angled</fermata></notations>'),
			n('D', 8, 'whole')
		]);
		const score = importMusicXml(xml);
		const source = score.staves[0]!.measures[0]!.notes[3]!;
		expect(score.editTie(source.id, null)).not.toBeNull();
		// The unrelated payload stays; only the tie markup goes.
		expect(source.passthrough.map((e) => e.name)).toEqual(['notations']);
		expect(source.passthrough[0]!.children.map((c) => c.name)).toEqual(['fermata']);
		expect(score.editTie(source.id, null)).toBeNull();
		const written = expectRoundTrip(score);
		expect(count(written, /<tie /g)).toBe(0);
		expect(count(written, /<tied /g)).toBe(0);
	});
});

describe('deleting notes and their payloads', () => {
	it('noteToRest drops the note\'s own payload (lyric, unmatched slur end) and export stays valid', () => {
		const xml = doc([
			n('C', 2, 'quarter', '<notations><slur type="start" number="4"/></notations><lyric number="1"><syllabic>single</syllabic><text>la</text></lyric>') +
				n('D', 2, 'quarter', '<lyric number="1"><syllabic>single</syllabic><text>di</text></lyric>') +
				n('E', 4, 'half')
		]);
		const score = importMusicXml(xml);
		const [c, d] = score.staves[0]!.measures[0]!.notes;
		expect(score.noteToRest(c!.id)).not.toBeNull();
		expect(c!.passthrough).toEqual([]);
		// Lyrics are modelled since M6 Slice 9; the rest drops its own too.
		expect(c!.lyrics).toEqual([]);
		const written = expectRoundTrip(score);
		expect(count(written, /<lyric /g)).toBe(1);
		expect(count(written, /<slur /g)).toBe(0);
		expect(d!.lyrics.map((l) => l.text)).toEqual(['di']);
	});

	it('removing a chord anchor hands its source tuplet bracket to the promoted head', () => {
		const tm = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
		// Divisions 3, so a quarter-note triplet member lasts 2.
		const triplet = doc([
			n('C', 2, 'quarter', `${tm}<notations><tuplet type="start" bracket="yes"/></notations>`) +
				n('E', 2, 'quarter', tm, true) +
				n('D', 2, 'quarter', tm) +
				n('E', 2, 'quarter', `${tm}<notations><tuplet type="stop"/></notations>`) +
				n('F', 6, 'half')
		]).replace('<divisions>2</divisions>', '<divisions>3</divisions>');
		const score = importMusicXml(triplet);
		const [anchor, member] = score.staves[0]!.measures[0]!.notes;
		expect(member!.chordWithPrevious).toBe(true);
		expect(score.removeChordMember(anchor!.id)).not.toBeNull();
		const promoted = score.findNote(member!.id)!;
		expect(promoted.chordWithPrevious).toBe(false);
		expect(promoted.passthrough.flatMap((e) => e.children.map((c) => `${c.name}:${c.attrs.type}`))).toEqual([
			'tuplet:start'
		]);
		const written = expectRoundTrip(score);
		expect(count(written, /<tuplet type="start"/g)).toBe(1);
		expect(count(written, /<tuplet type="stop"/g)).toBe(1);
	});
});

describe('export after every op re-imports equivalently', () => {
	it('on a hand-built score with chords, ties, slurs, marks and a measure rest', () => {
		const built = buildScore(
			[
				[
					[['C4', 'E4', 'G4'], 'quarter', { articulations: ['staccato'] }],
					['D4', 'quarter'],
					[null, 'half']
				],
				[['F4', 'half', { tiedToNext: true }], ['F4', 'quarter'], [['A4', 'C5'], 'quarter']],
				[['B4', 'whole']]
			],
			{},
			[{ start: [0, 3], end: [1, 1] }]
		);
		const history = new EditHistory(built);
		const s = () => history.current;
		const id = (m: number, i: number) => s().measures[m]!.notes[i]!.id;
		const ops: [string, (score: Score) => unknown][] = [
			['setDuration lengthen into the rest', (x) => x.setDuration(id(0, 3), 'half', 1)],
			['setDuration shorten', (x) => x.setDuration(id(1, 1), 'eighth')],
			['noteToRest on the chord anchor', (x) => x.noteToRest(id(0, 0))],
			['addChordMember', (x) => x.addChordMember(id(2, 0), parsePitch('D5'))],
			['removeChordMember', (x) => x.removeChordMember(id(1, 4))],
			['editTie off', (x) => x.editTie(id(1, 0), null)],
			['editTie on', (x) => x.editTie(id(1, 0), id(1, 1))],
			['noteToRest', (x) => x.noteToRest(id(0, 2))],
			['restToNote', (x) => x.restToNote(id(0, 2), parsePitch('B4'))]
		];
		const snapshots: string[] = [exportMusicXml(s())];
		for (const [name, op] of ops) {
			expect(history.record(op), name).not.toBeNull();
			snapshots.push(expectRoundTrip(s()));
		}
		// Undo walks back through every intermediate export exactly.
		for (let i = ops.length - 1; i >= 0; i--) {
			history.undo();
			expect(exportMusicXml(s())).toBe(snapshots[i]);
		}
	});

	it('on Les Djinns: fix a rest, a value and a chord on page 1, round-tripping after each', () => {
		const source = readFileSync(join(import.meta.dirname, '../test/fixtures/sfcc/Faure__-_Les_djinns__Op._12.musicxml'), 'utf8');
		const score = importMusicXml(source);
		const history = new EditHistory(score);
		const original = exportMusicXml(history.current);

		// The first rest and the first chord anchor on any staff in the first
		// eight measures (page 1).
		let rest: string | undefined;
		let chordAnchor: string | undefined;
		for (const staff of history.current.staves) {
			for (const measure of staff.measures.slice(0, 8)) {
				for (const event of noteEvents(measure.notes)) {
					if (!rest && event[0]!.pitch === null) rest = event[0]!.id;
					if (!chordAnchor && event.length > 1) chordAnchor = event[0]!.id;
				}
			}
		}
		expect(rest).toBeDefined();
		expect(chordAnchor).toBeDefined();

		expect(history.record((s) => s.restToNote(rest!, parsePitch('B4')))).not.toBeNull();
		expectRoundTrip(history.current);
		expect(history.record((s) => s.noteToRest(rest!))).not.toBeNull();
		expectRoundTrip(history.current);
		// A value fix: the rest cut to an eighth, padded back to its length.
		expect(history.record((s) => s.setDuration(rest!, 'eighth'))).not.toBeNull();
		expectRoundTrip(history.current);
		expect(history.record((s) => s.removeChordMember(chordAnchor!))).not.toBeNull();
		const written = expectRoundTrip(history.current);
		// Still well-formed: the parser reads it and every part survives.
		expect(children(parseXml(written), 'part')).toHaveLength(children(parseXml(original), 'part').length);
		expect(child(parseXml(written), 'part-list')).toBeDefined();

		while (history.canUndo) history.undo();
		expect(exportMusicXml(history.current)).toBe(original);
	});
});
