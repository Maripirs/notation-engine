// Correction ops (M6 Slice 7) against MusicXML: passthrough tie markup is
// kept consistent with the model's ties, a deleted note's own payload goes
// with it, and after every op `export` still writes MusicXML that re-imports
// as the same score (on a hand-built score, and on Les Djinns from the
// local-only corpus when `NOTATION_CORPUS_DIR` points at it, see
// `sfcc-corpus.test.ts`). The model-only semantics are in
// `src/model/correction-ops.test.ts`.

import { existsSync, readFileSync } from 'node:fs';
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
import { n, onePart } from './test-helpers.js';
import { child, children, parseXml } from './xml.js';

/** One 4/4 part at divisions 2 (or `divisions`). */
const doc = (measures: readonly string[], divisions = 2): string => onePart(measures, divisions);

/** `n` with a `<tie>` (which sits before `<voice>`) and its `<tied>`. */
const tied = (step: string, duration: number, type: string, tie: 'start' | 'stop', extra = ''): string =>
	n(step, duration, type, `<notations><tied type="${tie}"/>${extra}</notations>`).replace('<voice>', `<tie type="${tie}"/><voice>`);

/** Export, re-import, and require the same score back. */
function expectRoundTrip(score: Score): string {
	const xml = exportMusicXml(score);
	assertScoresEquivalent(importMusicXml(xml), score);
	return xml;
}

const count = (xml: string, re: RegExp): number => xml.match(re)?.length ?? 0;

/** Les Djinns in the local-only corpus, or `undefined` when it is not there. */
const DJINNS = ((dir) => {
	const path = dir && join(dir, 'Faure__-_Les_djinns__Op._12.musicxml');
	return path && existsSync(path) ? path : undefined;
})(process.env.NOTATION_CORPUS_DIR);

describe('editTie and passthrough tie markup', () => {
	const lead = n('C', 2, 'quarter') + n('D', 2, 'quarter') + n('E', 2, 'quarter');

	it.each([
		// The page join lost the stop: the stray OMR start sits on the source.
		['a lost stop, stripping the stray start', [lead + tied('C', 2, 'quarter', 'start'), n('C', 8, 'whole')]],
		// The start was the half lost: the stray stop sits on the target.
		['a lost start, stripping the stray stop', [lead + n('C', 2, 'quarter'), tied('C', 8, 'whole', 'stop')]]
	])('re-adds a tie broken by %s so export writes it once', (_what, measures) => {
		const score = importMusicXml(doc(measures));
		const source = score.staves[0]!.measures[0]!.notes[3]!;
		const target = score.staves[0]!.measures[1]!.notes[0]!;
		expect(source.tiedToId).toBeNull();
		expect(source.passthrough.length + target.passthrough.length).toBeGreaterThan(0);

		const history = new EditHistory(score);
		expect(history.record((s) => s.editTie(source.id, target.id))).toEqual<MeasureRef[]>([
			{ staffIndex: 0, measureIndex: 0 },
			{ staffIndex: 0, measureIndex: 1 }
		]);
		expect(history.current.findNote(source.id)!.passthrough).toEqual([]);
		expect(history.current.findNote(target.id)!.passthrough).toEqual([]);
		const written = expectRoundTrip(history.current);
		for (const re of [/<tie type="start"\/>/g, /<tied type="start"\/>/g, /<tie type="stop"\/>/g, /<tied type="stop"\/>/g]) {
			expect(count(written, re)).toBe(1);
		}
		expect(importMusicXml(written).staves[0]!.measures[0]!.notes[3]!.tiedToId).not.toBeNull();

		history.undo();
		expect(exportMusicXml(history.current)).toBe(exportMusicXml(score));
	});

	it('untying removes a dangling OMR tie start the model never linked', () => {
		const score = importMusicXml(doc([lead + tied('C', 2, 'quarter', 'start', '<fermata>angled</fermata>'), n('D', 8, 'whole')]));
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
				n('E', 2, 'quarter', tm, { chord: true }) +
				n('D', 2, 'quarter', tm) +
				n('E', 2, 'quarter', `${tm}<notations><tuplet type="stop"/></notations>`) +
				n('F', 6, 'half')
		], 3);
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

	it.skipIf(!DJINNS)('on Les Djinns: fix a rest, a value and a chord on page 1, round-tripping after each', () => {
		const source = readFileSync(DJINNS!, 'utf8');
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

		let written = original;
		for (const op of [
			(s: Score) => s.restToNote(rest!, parsePitch('B4')),
			(s: Score) => s.noteToRest(rest!),
			// A value fix: the rest cut to an eighth, padded back to its length.
			(s: Score) => s.setDuration(rest!, 'eighth'),
			(s: Score) => s.removeChordMember(chordAnchor!)
		]) {
			expect(history.record(op)).not.toBeNull();
			written = expectRoundTrip(history.current);
		}
		// Still well-formed: the parser reads it and every part survives.
		expect(children(parseXml(written), 'part')).toHaveLength(children(parseXml(original), 'part').length);
		expect(child(parseXml(written), 'part-list')).toBeDefined();

		while (history.canUndo) history.undo();
		expect(exportMusicXml(history.current)).toBe(original);
	});
});
