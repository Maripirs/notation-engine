// Export-side structure: what the emitter writes for each modelled feature.
// Well-formedness comes from parsing every export with `parseXml` (which
// rejects mismatched, unclosed and unquoted markup; see `xml.test.ts`).
// Faithfulness is covered by the round trips in `musicxml-import.test.ts`;
// these tests pin the MusicXML spelling a round trip alone cannot see.

import { describe, expect, it } from 'vitest';
import {
	createBarlineShowcaseScore,
	createDurationShowcaseScore,
	createFullDemoScore,
	createKeyTimeChangeShowcaseScore,
	createSlurShowcaseScore,
	createTwoVoiceShowcaseScore
} from '../demo-score.js';
import { assertScoresEquivalent, buildScore, parsePitch, Score } from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { importMusicXml } from './musicxml-import.js';
import { measuresOf, names } from './test-helpers.js';
import { child, childText, children, descendants, parseXml, type XmlElement } from './xml.js';

const exported = (score: Score): XmlElement => parseXml(exportMusicXml(score));
const texts = (el: XmlElement, name: string): string[] => descendants(el, name).map((e) => e.text.trim());
/** A measure's notes and backups, in stream order, as `voice/staff` or `backup`. */
const streamOf = (measure: XmlElement): string[] =>
	measure.children
		.filter((c) => c.name === 'note' || c.name === 'backup')
		.map((c) => (c.name === 'backup' ? 'backup' : `${childText(c, 'voice')}/${childText(c, 'staff') ?? '-'}`));

/** A piano score: one part over a treble and a bass staff, `measures` whole notes each. */
function pianoScore(measures: number, value: 'whole' | 'quarter' = 'whole'): Score {
	const score = new Score({ keyFifths: 0, time: { beats: 4, beatType: 4 } });
	score.appendStaff('bass');
	score.addPart([0, 1], 'Piano');
	for (let m = 0; m < measures; m++) {
		for (const [staff, octave] of [[0, 5], [1, 3]] as const) {
			const measure = score.appendMeasure(staff);
			for (const step of value === 'whole' ? ['C'] : ['C', 'D', 'E', 'F']) {
				score.appendNote(measure, { pitch: parsePitch(`${step}${octave}`), value });
			}
		}
	}
	return score;
}

describe('exportMusicXml', () => {
	it('writes a single-part partwise document for createFullDemoScore', () => {
		const score = createFullDemoScore();
		const xml = exportMusicXml(score);
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
		expect(xml).toContain('<!DOCTYPE score-partwise PUBLIC');
		const root = parseXml(xml);
		expect([root.name, root.attrs.version]).toEqual(['score-partwise', '4.0']);
		// The model's default unnamed single-staff part: one <part>, no group.
		expect(children(root, 'part')).toHaveLength(1);
		expect(descendants(root, 'part-group')).toHaveLength(0);
		expect(texts(root, 'part-name')).toEqual(['Part 1']);
		expect(measuresOf(root)).toHaveLength(score.measures.length);
		expect(descendants(root, 'note')).toHaveLength(score.measures.reduce((sum, m) => sum + m.notes.length, 0));
		expect(Number(texts(root, 'divisions')[0])).toSatisfy((d: number) => Number.isInteger(d) && d > 0);
		expect(texts(root, 'fifths')[0]).toBe(String(score.keyFifthsAt(0, 0)));
		expect([texts(root, 'beats')[0], texts(root, 'beat-type')[0]]).toEqual([String(score.time.beats), String(score.time.beatType)]);
	});

	it('emits a fresh minimal <attributes> at each mid-score key/time change', () => {
		const measures = measuresOf(exported(createKeyTimeChangeShowcaseScore()));
		const attrs = measures.map((m) => child(m, 'attributes')).filter((a) => a !== undefined);
		expect(attrs.map(names)).toEqual([['divisions', 'key', 'time', 'clef'], ['key'], ['time']]);
		expect(texts(attrs[0]!, 'fifths')).toEqual(['1']);
		expect(texts(child(measures[1]!, 'attributes')!, 'fifths')).toEqual(['2']);
		expect(texts(child(measures[3]!, 'attributes')!, 'beats')).toEqual(['3']);
	});

	it('maps every barline type to the right markup', () => {
		const barlines = (score: Score) =>
			measuresOf(exported(score)).map((m) =>
				children(m, 'barline')
					.map((b) => [b.attrs.location, childText(b, 'bar-style'), child(b, 'repeat')?.attrs.direction ?? '-'].join(' '))
					.join('; ')
			);
		// Double, ordinary (no <barline>), repeat start, repeat end.
		expect(barlines(createBarlineShowcaseScore()).slice(0, 4)).toEqual([
			'right light-light -',
			'',
			'left heavy-light forward',
			'right light-heavy backward'
		]);
		// A one-measure score resolves its own last boundary to `final`.
		expect(barlines(buildScore([[['C4', 'whole']]]))).toEqual(['right light-heavy -']);
	});

	it('emits triplet time-modification, one tuplet bracket and whole-number durations', () => {
		const tripletMeasure = measuresOf(exported(createDurationShowcaseScore()))[1]!;
		expect(descendants(tripletMeasure, 'time-modification').map((tm) => `${childText(tm, 'actual-notes')}:${childText(tm, 'normal-notes')}`)).toEqual(
			Array(6).fill('3:2')
		);
		expect(descendants(tripletMeasure, 'tuplet').map((t) => t.attrs.type)).toEqual(['start', 'stop']);
		for (const duration of texts(tripletMeasure, 'duration')) expect(duration).toMatch(/^\d+$/);
	});

	it('emits primary <beam> begin/continue/end across a clean beamed run', () => {
		const measures = measuresOf(exported(createDurationShowcaseScore()));
		// Measure 1 beams the 16th/32nd/64th together; measure 3 is four plain
		// eighth-note beats, so begin/end pairs with no continue.
		expect(texts(measures[0]!, 'beam')).toEqual(['begin', 'continue', 'end']);
		expect(texts(measures[2]!, 'beam')).toEqual(Array(4).fill(['begin', 'end']).flat());
		expect(descendants(measures[0]!, 'beam').every((b) => b.attrs.number === '1')).toBe(true);
	});

	it('emits <slur> spans from score.slurs', () => {
		const notes = children(measuresOf(exported(createSlurShowcaseScore()))[0]!, 'note');
		expect(descendants(notes[0]!, 'slur')[0]!.attrs).toEqual({ type: 'start', number: '1' });
		expect(descendants(notes[3]!, 'slur')[0]!.attrs).toEqual({ type: 'stop', number: '1' });
	});

	it('emits a multi-staff part as one <part> with <staves>, per-staff <clef>, <staff> and a <backup> between', () => {
		const root = exported(pianoScore(1, 'quarter'));
		expect(children(root, 'part').map((p) => p.attrs.id)).toEqual(['P1']);
		expect(descendants(root, 'part-group')).toHaveLength(0);
		expect(texts(root, 'part-name')).toEqual(['Piano']);
		const measure = measuresOf(root)[0]!;
		const attrs = child(measure, 'attributes')!;
		expect(childText(attrs, 'staves')).toBe('2');
		expect(children(attrs, 'clef').map((c) => c.attrs.number)).toEqual(['1', '2']);
		expect(streamOf(measure)).toEqual([...Array(4).fill('1/1'), 'backup', ...Array(4).fill('1/2')]);
		expect(texts(child(measure, 'backup')!, 'duration')).toEqual(['4']);
	});

	it('separates two voices with a full-measure <backup>', () => {
		const measure = measuresOf(exported(createTwoVoiceShowcaseScore()))[0]!;
		expect(streamOf(measure)).toEqual(['1/-', '1/-', 'backup', ...Array(8).fill('2/-')]);
		expect(texts(child(measure, 'backup')!, 'duration')).toEqual(['8']);
	});

	it('emits a per-staff <clef> in a minimal <attributes> wherever a staff\'s resolved clef changes (M5 Slice 5)', () => {
		// The bass staff switches to treble for measure 1 only; measure 2's
		// restore is a change back, measure 3 is no change at all.
		const score = pianoScore(4);
		score.setClefRange(1, 1, 1, 'treble');
		const xml = exportMusicXml(score);
		const clefs = measuresOf(parseXml(xml)).map((m) =>
			descendants(m, 'clef').map((c) => `${c.attrs.number}:${childText(c, 'sign')}`)
		);
		expect(clefs).toEqual([['1:G', '2:F'], ['2:G'], ['2:F'], []]);
		expect(names(child(measuresOf(parseXml(xml))[1]!, 'attributes')!)).toEqual(['clef']);

		const reimported = importMusicXml(xml);
		assertScoresEquivalent(reimported, score);
		expect([0, 1, 2, 3].map((m) => reimported.clefAt(m, 1))).toEqual(['bass', 'treble', 'bass', 'bass']);
		expect([0, 1, 2, 3].map((m) => reimported.clefAt(m, 0))).toEqual(['treble', 'treble', 'treble', 'treble']);
	});

	it('writes alto and tenor as C clefs on lines 3 and 4, and a clef change inside a note by backing up (M6 Slice 4)', () => {
		const score = buildScore(
			[
				{
					notes: [
						['C4', 'quarter'],
						['C4', 'quarter'],
						['C4', 'half']
					],
					// One change before the third note, one inside the half note.
					clefChanges: [
						{ onset: 0.5, clef: 'tenor' },
						{ onset: 0.75, clef: 'bass' }
					]
				},
				{ notes: [['C4', 'whole']], clef: 'alto' }
			],
			{ clef: 'bass' }
		);
		const xml = exportMusicXml(score);
		const [first, second] = measuresOf(parseXml(xml));
		const stream = first!.children
			.filter((c) => c.name !== 'direction' && c.name !== 'barline')
			.map((c) => {
				if (c.name === 'attributes') return descendants(c, 'clef').map((cl) => `clef:${childText(cl, 'sign')}${childText(cl, 'line')}`).join(',');
				return c.name === 'backup' ? `backup:${childText(c, 'duration')}` : c.name;
			});
		// Tenor before the third note; bass reached by backing up a quarter
		// from the half note's end.
		expect(stream).toEqual(['clef:F4', 'note', 'note', 'clef:C4', 'note', 'backup:1', 'clef:F4']);
		expect(descendants(second!, 'clef').map((c) => `${childText(c, 'sign')}${childText(c, 'line')}`)).toEqual(['C3']);
		const reimported = importMusicXml(xml);
		assertScoresEquivalent(reimported, score);
		expect(reimported.measures[0]!.clefChanges).toEqual(score.measures[0]!.clefChanges);
	});
});
