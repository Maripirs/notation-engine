// Lossless passthrough (M6 Slice 3), one hand-written fixture per anchor kind.
//
// Each test imports a small file carrying something the model does not
// hold, checks where the payload was anchored, exports, and checks the
// payload came back at the same place (and in valid MusicXML child order),
// then re-imports and requires an equivalent score, payloads included. The
// real-corpus version of the same guarantee is `sfcc-corpus.test.ts`.

import { describe, expect, it } from 'vitest';
import {
	assertScoresEquivalent,
	EditHistory,
	parsePitch,
	Score,
	type MeasurePassthrough,
	type OpaqueElement
} from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { createImportDiagnostics, importMusicXml } from './musicxml-import.js';
import { child, children, parseXml, type XmlElement } from './xml.js';

function doc(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">\n${body}\n</score-partwise>\n`;
}

/** One single-staff part `P1`, divisions `divisions`, 4/4, treble, with
 *  `measures` as the raw inner XML of each `<measure>`. */
function onePart(measures: readonly string[], divisions = 1, partListExtra = ''): string {
	const body = measures
		.map((inner, i) => {
			const attrs =
				i === 0
					? `<attributes><divisions>${divisions}</divisions><key><fifths>0</fifths></key>` +
						`<time><beats>4</beats><beat-type>4</beat-type></time>` +
						`<clef><sign>G</sign><line>2</line></clef></attributes>`
					: '';
			return `<measure number="${i + 1}">${attrs}${inner}</measure>`;
		})
		.join('\n');
	return doc(
		`<part-list><score-part id="P1"><part-name>Voice</part-name>${partListExtra}</score-part></part-list>\n<part id="P1">${body}</part>`
	);
}

function n(step: string, duration: number, type: string, extra = '', voice = 1): string {
	return `<note><pitch><step>${step}</step><octave>5</octave></pitch><duration>${duration}</duration><voice>${voice}</voice><type>${type}</type>${extra}</note>`;
}

/** Import, export, re-import; assert the round trip is lossless and stable. */
function roundTrip(xml: string): { score: Score; exported: string; root: XmlElement } {
	const score = importMusicXml(xml);
	const exported = exportMusicXml(score);
	const reimported = importMusicXml(exported);
	assertScoresEquivalent(reimported, score);
	expect(exportMusicXml(reimported)).toBe(exported);
	return { score, exported, root: parseXml(exported) };
}

function measuresOf(root: XmlElement, partIndex = 0): XmlElement[] {
	return children(children(root, 'part')[partIndex]!, 'measure');
}

/** A measure's children as a compact `name` list, notes as `note:C`,
 *  leaving out what export adds on its own to these fixtures (the tempo mark
 *  a tempo-less source gets, and the final barline). */
function streamOf(measure: XmlElement): string[] {
	const added = (c: XmlElement): boolean =>
		c.name === 'barline' || (c.name === 'direction' && child(child(c, 'direction-type')!, 'metronome') !== undefined);
	return measure.children.filter((c) => !added(c)).map((c) => {
		if (c.name === 'note') {
			const step = child(child(c, 'pitch') ?? c, 'step')?.text ?? (child(c, 'rest') ? 'rest' : '?');
			return child(c, 'grace') ? `grace:${step}` : `note:${step}`;
		}
		if (c.name === 'backup') return `backup:${child(c, 'duration')!.text}`;
		if (c.name === 'direction') {
			const what = child(c, 'direction-type')!.children[0]!;
			return `direction:${what.name === 'words' ? what.text : what.name}`;
		}
		return c.name;
	});
}

function names(el: XmlElement): string[] {
	return el.children.map((c) => c.name);
}

describe('passthrough on a Note', () => {
	const xml = onePart([
		n(
			'C',
			1,
			'quarter',
			`<stem>up</stem><notehead>diamond</notehead><notations><tied type="start"/><articulations><staccato/></articulations><fermata/></notations>` +
				`<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric>`
		) +
			n('C', 1, 'quarter', '<notations><tied type="stop"/></notations>') +
			n('E', 1, 'quarter', '<notations><technical><fingering>3</fingering></technical></notations>') +
			`<note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><notations><articulations><accent/></articulations></notations></note>` +
			`<note><rest><display-step>B</display-step><display-octave>4</display-octave></rest><duration>1</duration><voice>1</voice><type>quarter</type></note>`
	]);

	it('keeps unowned note children on the note, re-emitted in schema order', () => {
		const { score, root } = roundTrip(xml);
		const notes = score.staves[0]!.measures[0]!.notes;
		expect(notes[0]!.passthrough.map((e) => e.name)).toEqual(['notehead', 'notations', 'lyric']);
		// Only what the model does not own: the linked `<tied>` is the model's.
		expect(notes[0]!.passthrough[1]!.children.map((c) => c.name)).toEqual(['articulations', 'fermata']);
		expect(notes[1]!.passthrough).toEqual([]);

		const written = children(measuresOf(root)[0]!, 'note');
		// <notehead> after <stem>, the model's <tied> merged into the same
		// <notations> as the passthrough, <lyric> after <notations>.
		expect(names(written[0]!)).toEqual(['pitch', 'duration', 'tie', 'voice', 'type', 'stem', 'notehead', 'notations', 'lyric']);
		expect(names(child(written[0]!, 'notations')!)).toEqual(['tied', 'articulations', 'fermata']);
	});

	it('gives each chord member its own payload', () => {
		const { score } = roundTrip(xml);
		const [, , anchor, member] = score.staves[0]!.measures[0]!.notes;
		expect(member!.chordWithPrevious).toBe(true);
		expect(anchor!.passthrough[0]!.children[0]!.name).toBe('technical');
		expect(member!.passthrough[0]!.children[0]!.name).toBe('articulations');
	});

	it('merges a rest\'s display position back into the <rest> it writes', () => {
		const { score, root } = roundTrip(xml);
		const rest = score.staves[0]!.measures[0]!.notes[4]!;
		expect(rest.passthrough.map((e) => e.name)).toEqual(['rest']);
		const written = children(measuresOf(root)[0]!, 'note')[4]!;
		expect(names(child(written, 'rest')!)).toEqual(['display-step', 'display-octave']);
	});

	it('survives a transpose, clone and undo', () => {
		const score = importMusicXml(xml);
		const target = score.staves[0]!.measures[0]!.notes[2]!;
		const history = new EditHistory(score);
		history.record((s) => s.transposeNote(target.id, 1));
		const transposed = history.current.findNote(target.id)!;
		expect(transposed.pitch).toEqual(parsePitch('F5'));
		expect(transposed.passthrough).toBe(target.passthrough);
		const written = children(measuresOf(parseXml(exportMusicXml(history.current)))[0]!, 'note')[2]!;
		expect(child(child(written, 'notations')!, 'technical')).toBeDefined();
		history.undo();
		expect(exportMusicXml(history.current)).toBe(exportMusicXml(score));
	});

	it('keeps a slur or tie end that never found its partner', () => {
		const lonely = onePart([
			n('C', 1, 'quarter', '<tie type="start"/><notations><tied type="start"/><slur type="start" number="2"/></notations>') +
				n('D', 1, 'quarter') +
				n('E', 1, 'quarter', '<notations><slur type="stop" number="3"/></notations>') +
				n('F', 1, 'quarter')
		]);
		const { score } = roundTrip(lonely);
		const [c, , e] = score.staves[0]!.measures[0]!.notes;
		expect(score.slurs).toHaveLength(0);
		expect(c!.tiedToId).toBeNull();
		expect(c!.passthrough.map((x) => x.name)).toEqual(['tie', 'notations']);
		expect(e!.passthrough[0]!.children.map((x) => `${x.name}:${x.attrs.type}`)).toEqual(['slur:stop']);
	});
});

describe('passthrough at a Measure onset', () => {
	const words = (text: string, extra = ''): string =>
		`<direction><direction-type><words>${text}</words></direction-type>${extra}</direction>`;

	it('anchors a direction between notes at its onset and writes it back there', () => {
		const xml = onePart([
			words('start') + n('C', 1, 'quarter') + words('beat 2') + n('D', 1, 'quarter') + n('E', 2, 'half') + words('end', '<offset>1</offset>')
		]);
		const { score, root } = roundTrip(xml);
		const anchors = score.staves[0]!.measures[0]!.passthrough;
		expect(anchors.map(onsetOf)).toEqual(['0/1', '1/4', '1/1']);
		expect(streamOf(measuresOf(root)[0]!)).toEqual([
			'attributes',
			'direction:start',
			'note:C',
			'direction:beat 2',
			'note:D',
			'note:E',
			'direction:end'
		]);
	});

	it('keeps each direction in its voice stream across <backup>, including one inside a longer note', () => {
		const xml = onePart(
			[
				n('C', 4, 'half', '', 1) +
					n('D', 4, 'half', '', 1) +
					'<backup><duration>8</duration></backup>' +
					words('voice 2 start') +
					n('E', 2, 'quarter', '', 2) +
					words('voice 2 beat 2') +
					n('F', 6, 'half', '<dot/>', 2) +
					// Back up into the middle of voice 2's dotted half: a mark at
					// beat 3, where no note of voice 2 starts.
					'<backup><duration>4</duration></backup>' +
					words('mid')
			],
			2
		);
		const { score, root } = roundTrip(xml);
		const anchors = score.staves[0]!.measures[0]!.passthrough;
		expect(anchors.map((a) => `${a.voice}@${onsetOf(a)}`)).toEqual(['2@0/1', '2@1/4', '2@1/2']);
		expect(streamOf(measuresOf(root)[0]!)).toEqual([
			'attributes',
			'note:C',
			'note:D',
			'backup:8',
			'direction:voice 2 start',
			'note:E',
			'direction:voice 2 beat 2',
			'note:F',
			// Voice 2 ended at 4/4; the beat-3 mark is reached by backing up.
			'backup:4',
			'direction:mid'
		]);
	});

	it('writes a grace note back in front of the note it ornaments', () => {
		const xml = onePart([
			n('C', 1, 'quarter') +
				`<note><grace slash="yes"/><pitch><step>A</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type></note>` +
				n('G', 1, 'quarter') +
				n('E', 2, 'half')
		]);
		const diagnostics = createImportDiagnostics();
		importMusicXml(xml, { diagnostics });
		expect(diagnostics.passthrough.get('grace')).toBe(1);
		expect(diagnostics.dropped.size).toBe(0);
		const { score, root } = roundTrip(xml);
		expect(score.staves[0]!.measures[0]!.notes.map((note) => note.pitch!.step)).toEqual(['C', 'G', 'E']);
		expect(streamOf(measuresOf(root)[0]!)).toEqual(['attributes', 'note:C', 'grace:A', 'note:G', 'note:E']);
	});

	it('leads the measure with a <print>, and keeps <harmony>/<sound> in place', () => {
		const xml = onePart([
			n('C', 4, 'whole'),
			`<print new-system="yes"/>` +
				`<harmony><root><root-step>F</root-step></root><kind>major</kind></harmony>` +
				n('F', 2, 'half') +
				`<sound dynamics="80"/>` +
				n('A', 2, 'half')
		]);
		const { root } = roundTrip(xml);
		expect(streamOf(measuresOf(root)[1]!)).toEqual(['print', 'harmony', 'note:F', 'sound', 'note:A']);
	});

	it('rescales an <offset> when the part needs finer divisions than it was read at', () => {
		// Built in code: one quarter-division anchor, then a sixteenth note
		// forces divisions 4, so the offset of 1 (a quarter) must become 4.
		const score = new Score();
		const measure = score.appendMeasure(0);
		score.appendNote(measure, { pitch: parsePitch('C5'), value: '16th' });
		score.appendNote(measure, { pitch: parsePitch('D5'), value: '16th' });
		score.appendNote(measure, { pitch: parsePitch('E5'), value: 'eighth' });
		score.appendNote(measure, { pitch: parsePitch('F5'), value: 'half', dots: 1 });
		const direction = parseXml(
			'<direction><direction-type><words>later</words></direction-type><offset>1</offset></direction>'
		);
		measure.passthrough = [{ element: direction, onset: { num: 1, den: 4 }, voice: 1, lead: false, divisions: 1 }];
		const exported = exportMusicXml(score);
		const written = children(measuresOf(parseXml(exported))[0]!, 'direction').find((d) => child(d, 'offset'))!;
		expect(child(written, 'offset')!.text).toBe('4');
		assertScoresEquivalent(importMusicXml(exported), score);
	});
});

describe('passthrough in measure attributes and barlines', () => {
	it('merges <staff-details>/<transpose> into the written <attributes> in schema order', () => {
		const xml = onePart([
			n('C', 4, 'whole'),
			`<attributes><clef><sign>F</sign><line>4</line></clef><staff-details><staff-lines>5</staff-lines></staff-details><transpose><chromatic>-2</chromatic></transpose></attributes>` +
				n('C', 4, 'whole')
		]);
		const { score, root } = roundTrip(xml);
		expect(score.staves[0]!.measures[1]!.attributesPassthrough.map((e) => e.name)).toEqual(['staff-details', 'transpose']);
		expect(names(child(measuresOf(root)[1]!, 'attributes')!)).toEqual(['clef', 'staff-details', 'transpose']);
	});

	it('keeps an <attributes> with nothing modelled in it where it was, mid-measure', () => {
		const xml = onePart([
			n('C', 2, 'half') + `<attributes><measure-style><slash type="start"/></measure-style></attributes>` + n('D', 2, 'half')
		]);
		const { score, root } = roundTrip(xml);
		expect(score.staves[0]!.measures[0]!.passthrough.map(onsetOf)).toEqual(['1/2']);
		expect(streamOf(measuresOf(root)[0]!)).toEqual(['attributes', 'note:C', 'attributes', 'note:D']);
	});

	it('merges an <ending> into the barline the model writes, and keeps a barline it cannot read', () => {
		const xml = onePart([
			n('C', 4, 'whole') + `<barline location="right"><bar-style>dashed</bar-style></barline>`,
			n('D', 4, 'whole') +
				`<barline location="right"><bar-style>light-heavy</bar-style><ending number="1" type="stop"/><repeat direction="backward"/></barline>`,
			n('E', 4, 'whole')
		]);
		const { score, root } = roundTrip(xml);
		expect(score.endBarlineAt(1)).toBe('repeatEnd');
		expect(score.staves[0]!.measures[0]!.barlinePassthrough[0]!.children.map((c) => c.text)).toEqual(['dashed']);
		const [first, second] = measuresOf(root);
		expect(names(child(first!, 'barline')!)).toEqual(['bar-style']);
		expect(names(child(second!, 'barline')!)).toEqual(['bar-style', 'ending', 'repeat']);
	});
});

describe('passthrough in the score header and part list', () => {
	it('writes <work>/<identification> before <part-list> and part extras inside <score-part>', () => {
		const xml = onePart(
			[n('C', 4, 'whole')],
			1,
			`<score-instrument id="P1-I1"><instrument-name>Voice</instrument-name></score-instrument><part-abbreviation>V.</part-abbreviation><midi-instrument id="P1-I1"><midi-program>53</midi-program></midi-instrument>`
		).replace(
			'<part-list>',
			'<work><work-title>Der Abend</work-title></work><identification><encoding><software>Audiveris</software></encoding></identification><part-list>'
		);
		const { score, root } = roundTrip(xml);
		expect(score.headerPassthrough.map((e) => e.name)).toEqual(['work', 'identification']);
		expect(names(root)).toEqual(['work', 'identification', 'part-list', 'part']);
		const scorePart = child(child(root, 'part-list')!, 'score-part')!;
		expect(names(scorePart)).toEqual(['part-name', 'part-abbreviation', 'score-instrument', 'midi-instrument']);
	});

	it('keeps a <group-name> on the bracket group', () => {
		const parts = ['S', 'A', 'T'];
		const xml = doc(
			`<part-list><part-group type="start" number="1"><group-name>Choir</group-name><group-symbol>bracket</group-symbol></part-group>` +
				parts.map((p) => `<score-part id="${p}"><part-name>${p}</part-name></score-part>`).join('') +
				`<part-group type="stop" number="1"/></part-list>` +
				parts
					.map(
						(p) =>
							`<part id="${p}"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${n('C', 4, 'whole')}</measure></part>`
					)
					.join('')
		);
		const { root } = roundTrip(xml);
		expect(names(child(child(root, 'part-list')!, 'part-group')!)).toEqual(['group-name', 'group-symbol']);
	});
});

describe('the tempo mark', () => {
	it('is written once: a source tempo with words is passed through and export adds none', () => {
		const xml = onePart([
			`<direction><direction-type><words>Andante</words></direction-type><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>72</per-minute></metronome></direction-type><sound tempo="72"/></direction>` +
				n('C', 4, 'whole')
		]);
		const { score, exported } = roundTrip(xml);
		expect(score.tempoBpm).toBe(72);
		expect(exported.match(/<metronome>/g)).toHaveLength(1);
	});

	it('is model-owned in export\'s own shape, so a built score gains no payload', () => {
		const score = new Score({ tempoBpm: 96 });
		score.appendNote(score.appendMeasure(0), { pitch: parsePitch('C5'), value: 'whole' });
		const reimported = importMusicXml(exportMusicXml(score));
		expect(reimported.staves[0]!.measures[0]!.passthrough).toEqual([]);
		expect(reimported.tempoBpm).toBe(96);
	});
});

function onsetOf(anchor: MeasurePassthrough): string {
	return `${anchor.onset.num}/${anchor.onset.den}`;
}

// Keep the type import honest: `OpaqueElement` and `XmlElement` are the same
// shape, so a parsed element is stored with no conversion.
const _sameShape: OpaqueElement = parseXml('<x/>');
void _sameShape;
