// Grace notes through MusicXML (M6 Slice 8): import reads `<grace>` into the
// model (slash and steal/make times kept), export writes each grace right
// before its principal in its own voice stream with no `<duration>`, and a
// re-import is equivalent.

import { describe, expect, it } from 'vitest';
import { ACCIACCATURA, APPOGGIATURA, assertScoresEquivalent, buildScore } from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { createImportDiagnostics, importMusicXml } from './musicxml-import.js';
import { child, children, descendants, parseXml, type XmlElement } from './xml.js';

function doc(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n${body}\n</score-partwise>\n`;
}

const ATTRS =
	'<attributes><divisions>2</divisions><key><fifths>0</fifths></key>' +
	'<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';

const note = (step: string, duration: number, type: string, voice = 1) =>
	`<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${duration}</duration><voice>${voice}</voice><type>${type}</type></note>`;
const grace = (step: string, attrs: string, type = 'eighth', voice = 1, extra = '') =>
	`<note><grace${attrs}/><pitch><step>${step}</step><octave>5</octave></pitch><voice>${voice}</voice><type size="cue">${type}</type><stem>up</stem>${extra}</note>`;

function onePart(measures: readonly string[]): string {
	const body = measures.map((inner, i) => `<measure number="${i + 1}">${i === 0 ? ATTRS : ''}${inner}</measure>`).join('\n');
	return doc(`<part-list><score-part id="P1"><part-name>S</part-name></score-part></part-list>\n<part id="P1">\n${body}\n</part>`);
}

/** Each `<note>` of a measure as `grace:STEP` / `note:STEP`, plus backups. */
function stream(measure: XmlElement): string[] {
	return measure.children
		.filter((c) => c.name === 'note' || c.name === 'backup')
		.map((c) =>
			c.name === 'backup'
				? 'backup'
				: `${child(c, 'grace') ? 'grace' : 'note'}:${child(child(c, 'pitch') ?? c, 'step')?.text ?? 'rest'}`
		);
}

function roundTrip(xml: string) {
	const score = importMusicXml(xml);
	const exported = exportMusicXml(score);
	const again = importMusicXml(exported);
	assertScoresEquivalent(again, score);
	expect(exportMusicXml(again)).toBe(exported);
	return { score, root: parseXml(exported) };
}

describe('MusicXML grace notes (M6 Slice 8)', () => {
	it('reads <grace> into the model with its slash and steal/make times', () => {
		const xml = onePart([
			grace('D', ' slash="yes"') +
				note('C', 2, 'quarter') +
				grace('A', ' steal-time-following="30" make-time="1"', '16th') +
				note('G', 2, 'quarter') +
				note('E', 4, 'half')
		]);
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(xml, { diagnostics });
		expect(diagnostics.passthrough.get('grace')).toBeUndefined();
		const notes = score.measures[0]!.notes;
		expect(notes.map((n) => `${n.pitch!.step}${n.isGrace ? 'g' : ''}`)).toEqual(['Dg', 'C', 'Ag', 'G', 'E']);
		expect(notes[0]!.grace).toEqual(ACCIACCATURA);
		expect(notes[0]!.value).toBe('eighth');
		expect(notes[2]!.grace).toEqual({ slash: false, stealTimePrevious: null, stealTimeFollowing: 30, makeTime: 1 / 8 });
		expect(notes[2]!.value).toBe('16th');
	});

	it('writes each grace before its principal with no <duration>, and reads it back the same', () => {
		const xml = onePart([
			grace('D', ' slash="yes"') +
				note('C', 2, 'quarter') +
				grace('A', ' steal-time-following="30" make-time="1"', '16th') +
				note('G', 2, 'quarter') +
				note('E', 4, 'half')
		]);
		const { root } = roundTrip(xml);
		const measure = descendants(root, 'measure')[0]!;
		expect(stream(measure)).toEqual(['grace:D', 'note:C', 'grace:A', 'note:G', 'note:E']);
		const graces = children(measure, 'note').filter((n) => child(n, 'grace'));
		for (const g of graces) expect(child(g, 'duration')).toBeUndefined();
		expect(child(graces[0]!, 'grace')!.attrs).toEqual({ slash: 'yes' });
		expect(child(graces[1]!, 'grace')!.attrs).toEqual({ 'steal-time-following': '30', 'make-time': '1' });
		expect(child(graces[0]!, 'stem')!.text).toBe('up');
	});

	it('beams a run of grace eighths and 16ths as one group', () => {
		const xml = onePart([grace('B', ' slash="no"', '16th') + grace('D', ' slash="no"', '16th') + note('C', 8, 'whole')]);
		const { root } = roundTrip(xml);
		const graces = descendants(root, 'note').filter((n) => child(n, 'grace'));
		expect(graces.map((g) => child(g, 'beam')?.text)).toEqual(['begin', 'end']);
	});

	it('keeps a grace with no principal at the end of its measure, and a grace in a second voice in its stream', () => {
		const xml = onePart([
			note('C', 8, 'whole') + grace('B', ' slash="yes"') + '<backup><duration>8</duration></backup>' + grace('F', '', 'eighth', 2) + note('E', 8, 'whole', 2)
		]);
		const { score, root } = roundTrip(xml);
		expect(score.measures[0]!.notes.filter((n) => n.isGrace).map((n) => n.voice)).toEqual([1, 2]);
		expect(stream(descendants(root, 'measure')[0]!)).toEqual(['note:C', 'grace:B', 'backup', 'grace:F', 'note:E']);
	});

	it('pairs a slur from a grace note to its principal', () => {
		const xml = onePart([
			grace('A', '', 'eighth', 1, '<notations><slur type="start" number="1"/></notations>') +
				note('A', 2, 'quarter').replace('</type>', '</type><notations><slur type="stop" number="1"/></notations>') +
				note('G', 6, 'half')
		]);
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(xml, { diagnostics });
		expect(score.slurs).toHaveLength(1);
		expect(score.findNote(score.slurs[0]!.startNoteId)!.isGrace).toBe(true);
		expect(diagnostics.passthrough.get('slur')).toBeUndefined();
		roundTrip(xml);
	});

	it('round-trips a built score with graces', () => {
		const score = buildScore([
			[['D5', 'eighth', { grace: ACCIACCATURA }], ['C5', 'half'], ['F4', '16th', { grace: APPOGGIATURA }], ['G4', 'half']]
		]);
		const again = importMusicXml(exportMusicXml(score));
		assertScoresEquivalent(again, score);
	});
});
