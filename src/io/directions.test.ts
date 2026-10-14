// Dynamics and hairpins through MusicXML (M6 Slice 6): import promotes them
// out of passthrough into `Measure.dynamics` / `Score.wedges`, export writes
// each back into its own `<direction>` (offset, staff, sound, words and all),
// and a re-import is equivalent.

import { describe, expect, it } from 'vitest';
import { assertScoresEquivalent, buildScore, EditHistory } from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { createImportDiagnostics, importMusicXml } from './musicxml-import.js';
import { descendants, parseXml } from './xml.js';

function doc(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n${body}\n</score-partwise>\n`;
}

const ATTRS =
	'<attributes><divisions>2</divisions><key><fifths>0</fifths></key>' +
	'<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';

const quarter = (step: string) =>
	`<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>`;

/** One single-staff part with these raw measure bodies. */
function onePart(measures: readonly string[]): string {
	const body = measures.map((inner, i) => `<measure number="${i + 1}">${i === 0 ? ATTRS : ''}${inner}</measure>`).join('\n');
	return doc(`<part-list><score-part id="P1"><part-name>S</part-name></score-part></part-list>\n<part id="P1">\n${body}\n</part>`);
}

/** Import, export, re-import: equivalent, and the second export identical. */
function roundTrip(xml: string): string {
	const score = importMusicXml(xml);
	const exported = exportMusicXml(score);
	const again = importMusicXml(exported);
	assertScoresEquivalent(again, score);
	expect(exportMusicXml(again)).toBe(exported);
	return exported;
}

describe('MusicXML dynamics (M6 Slice 6)', () => {
	it('promotes a dynamic with its onset and placement, keeping the rest of its direction', () => {
		const xml = onePart([
			quarter('C') +
				'<direction placement="above"><direction-type><dynamics><mf/></dynamics></direction-type>' +
				'<offset>1</offset><staff>1</staff><sound dynamics="80"/></direction>' +
				quarter('D') +
				quarter('E') +
				quarter('F')
		]);
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(xml, { diagnostics });
		const measure = score.measures[0]!;
		expect(measure.passthrough).toHaveLength(0);
		expect(measure.dynamics).toHaveLength(1);
		const mark = measure.dynamics[0]!;
		expect(mark).toMatchObject({ kind: 'mf', onset: 0.25, placement: 'above' });
		// The kept rest: no promoted direction-type, no owned placement.
		expect(mark.source!.element.children.map((c) => c.name)).toEqual(['offset', 'staff', 'sound']);
		expect(mark.source!.element.attrs).toEqual({});
		expect(mark.source!.slot).toBe(0);
		expect(diagnostics.passthrough.get('dynamics')).toBeUndefined();
		expect(diagnostics.passthrough.get('sound')).toBe(1);

		const exported = parseXml(roundTrip(xml));
		const direction = descendants(exported, 'direction').find((d) => descendants(d, 'dynamics').length > 0)!;
		expect(direction.attrs.placement).toBe('above');
		expect(direction.children.map((c) => c.name)).toEqual(['direction-type', 'offset', 'staff', 'sound']);
		expect(descendants(direction, 'mf')).toHaveLength(1);
		expect(descendants(direction, 'offset')[0]!.text).toBe('1');
	});

	it('reads every Bravura-backed kind and leaves <other-dynamics> and two-mark <dynamics> as passthrough', () => {
		const xml = onePart([
			'<direction><direction-type><dynamics><sfzp/></dynamics></direction-type></direction>' +
				quarter('C') +
				'<direction><direction-type><dynamics><other-dynamics>mfp</other-dynamics></dynamics></direction-type></direction>' +
				quarter('D') +
				'<direction><direction-type><dynamics><f/><p/></dynamics></direction-type></direction>' +
				quarter('E') +
				'<direction><direction-type><dynamics><n/></dynamics></direction-type><direction-type><words>subito</words></direction-type></direction>' +
				quarter('F')
		]);
		const score = importMusicXml(xml);
		const measure = score.measures[0]!;
		expect(measure.dynamics.map((d) => d.kind)).toEqual(['sfzp', 'n']);
		expect(measure.passthrough).toHaveLength(2);
		// The `<words>` beside a promoted `<n/>` stays in its source.
		expect(measure.dynamics[1]!.source!.element.children.map((c) => c.name)).toEqual(['direction-type']);
		roundTrip(xml);
	});

	it('draws a dynamic on the staff its <staff> names, even when written in another staff\'s stream', () => {
		const xml = doc(
			'<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>\n<part id="P1">' +
				'<measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key>' +
				'<time><beats>1</beats><beat-type>4</beat-type></time><staves>2</staves>' +
				'<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>' +
				'<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>' +
				'<direction><direction-type><dynamics><pp/></dynamics></direction-type><staff>2</staff></direction>' +
				'<backup><duration>1</duration></backup>' +
				'<note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><voice>5</voice><type>quarter</type><staff>2</staff></note>' +
				'</measure></part>'
		);
		const score = importMusicXml(xml);
		expect(score.staves[0]!.measures[0]!.dynamics).toHaveLength(0);
		expect(score.staves[1]!.measures[0]!.dynamics.map((d) => [d.kind, d.onset])).toEqual([['pp', 0.25]]);
		roundTrip(xml);
	});
});

describe('MusicXML hairpins (M6 Slice 6)', () => {
	it('pairs overlapping hairpins by number across measures', () => {
		const xml = onePart([
			'<direction placement="below"><direction-type><wedge type="crescendo" number="1" spread="15"/></direction-type></direction>' +
				quarter('C') +
				quarter('D') +
				'<direction><direction-type><wedge type="diminuendo" number="2"/></direction-type></direction>' +
				quarter('E') +
				quarter('F'),
			quarter('G') +
				'<direction><direction-type><wedge type="stop" number="1" spread="15"/></direction-type><offset>-1</offset></direction>' +
				quarter('A') +
				quarter('B') +
				'<direction><direction-type><wedge type="stop" number="2"/></direction-type></direction>' +
				quarter('C')
		]);
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(xml, { diagnostics });
		expect(diagnostics.passthrough.get('wedge')).toBeUndefined();
		const summary = score.wedges
			.map((w) => [w.kind, w.placement, w.start.measureIndex, w.start.onset, w.stop.measureIndex, w.stop.onset])
			.sort();
		expect(summary).toEqual([
			['crescendo', 'below', 0, 0, 1, 0.25],
			['diminuendo', null, 0, 0.5, 1, 0.75]
		]);
		const cresc = score.wedges.find((w) => w.kind === 'crescendo')!;
		expect(cresc.start.source!.markAttrs).toEqual({ spread: '15' });

		// Export allocates numbers afresh; overlapping hairpins get different
		// ones, and the round trip pairs them back the same way.
		const exported = parseXml(roundTrip(xml));
		const wedges = descendants(exported, 'wedge');
		expect(wedges.map((w) => `${w.attrs.type}${w.attrs.number}`)).toEqual(['crescendo1', 'diminuendo2', 'stop1', 'stop2']);
		expect(wedges[0]!.attrs.spread).toBe('15');
	});

	it('reuses a number in time order, and pairs a start and stop in one <direction> as a zero-length hairpin', () => {
		const xml = onePart([
			'<direction><direction-type><wedge type="crescendo" number="1"/></direction-type></direction>' +
				quarter('C') +
				'<direction><direction-type><wedge type="stop" number="1"/></direction-type></direction>' +
				'<direction><direction-type><wedge type="diminuendo" number="1"/></direction-type></direction>' +
				quarter('D') +
				'<direction><direction-type><wedge type="stop" number="1"/></direction-type></direction>' +
				quarter('E') +
				'<direction placement="above"><direction-type><wedge type="crescendo"/></direction-type><direction-type><wedge type="stop"/></direction-type></direction>' +
				quarter('F')
		]);
		const score = importMusicXml(xml);
		expect(score.wedges.map((w) => [w.kind, w.start.onset, w.stop.onset])).toEqual([
			['crescendo', 0, 0.25],
			['diminuendo', 0.25, 0.5],
			['crescendo', 0.75, 0.75]
		]);
		// The zero-length pair shares one source and is written back as one
		// <direction>.
		const zero = score.wedges[2]!;
		expect(zero.start.source!.element).toBe(zero.stop.source!.element);
		const exported = parseXml(roundTrip(xml));
		expect(descendants(exported, 'direction').filter((d) => descendants(d, 'wedge').length === 2)).toHaveLength(1);
	});

	it('keeps an unpaired hairpin end, and any dynamic sharing its direction, as passthrough', () => {
		const xml = onePart([
			'<direction><direction-type><dynamics><p/></dynamics></direction-type><direction-type><wedge type="crescendo" number="3"/></direction-type></direction>' +
				quarter('C') +
				quarter('D') +
				'<direction><direction-type><wedge type="stop" number="4"/></direction-type></direction>' +
				quarter('E') +
				quarter('F')
		]);
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(xml, { diagnostics });
		expect(score.wedges).toHaveLength(0);
		expect(score.measures[0]!.dynamics).toHaveLength(0);
		expect(score.measures[0]!.passthrough).toHaveLength(2);
		expect(Object.fromEntries(diagnostics.passthrough)).toEqual({ dynamics: 1, wedge: 2 });
		roundTrip(xml);
	});
});

describe('MusicXML export of dynamics and hairpins built in code (M6 Slice 6)', () => {
	it('writes plain directions that import back to the same marks', () => {
		const score = buildScore(
			[
				{ notes: [['C4', 'half'], ['D4', 'half']], dynamics: [{ kind: 'p' }, { kind: 'sfz', onset: 0.5, placement: 'above' }] },
				[['E4', 'whole']]
			],
			{ keyFifths: 0 },
			[],
			[{ kind: 'crescendo', start: [0, 0.5], stop: [1, 1] }]
		);
		const exported = exportMusicXml(score);
		const again = importMusicXml(exported);
		expect(again.measures[0]!.dynamics.map((d) => [d.kind, d.onset, d.placement])).toEqual([
			['p', 0, null],
			['sfz', 0.5, 'above']
		]);
		expect(again.wedges.map((w) => [w.kind, w.start.measureIndex, w.start.onset, w.stop.measureIndex, w.stop.onset])).toEqual([
			['crescendo', 0, 0.5, 1, 1]
		]);
		expect(again.measures[0]!.passthrough).toHaveLength(0);
		expect(exportMusicXml(again)).toBe(exported);
	});

	it('survives an edit and its undo unchanged', () => {
		const xml = onePart([
			'<direction><direction-type><dynamics><f/></dynamics></direction-type></direction>' +
				'<direction><direction-type><wedge type="diminuendo"/></direction-type></direction>' +
				quarter('C') +
				quarter('D') +
				quarter('E') +
				'<direction><direction-type><wedge type="stop"/></direction-type></direction>' +
				quarter('F')
		]);
		const history = new EditHistory(importMusicXml(xml));
		const before = exportMusicXml(history.current);
		history.record((s) => s.transposeNote(s.measures[0]!.notes[1]!.id, 1));
		expect(history.current.wedges).toHaveLength(1);
		expect(history.current.measures[0]!.dynamics).toHaveLength(1);
		history.undo();
		expect(exportMusicXml(history.current)).toBe(before);
	});
});
