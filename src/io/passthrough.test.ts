// Lossless passthrough (M6 Slice 3), one hand-written fixture per anchor kind.
//
// Each test imports a small file carrying something the model does not
// hold, checks where the payload was anchored, and round-trips it (export,
// re-import, equivalent score, identical second export), checking the
// payload came back at the same place in valid MusicXML child order. The
// real-corpus version of the same guarantee is `corpus.test.ts`.

import { describe, expect, it } from 'vitest';
import {
	assertScoresEquivalent,
	parsePitch,
	Score,
	type MeasurePassthrough,
	type OpaqueElement
} from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { createImportDiagnostics, importMusicXml } from './musicxml-import.js';
import { doc, measuresOf, n, names, onePart, roundTrip } from './test-helpers.js';
import { child, children, parseXml, type XmlElement } from './xml.js';

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

function onsetOf(anchor: MeasurePassthrough): string {
	return `${anchor.onset.num}/${anchor.onset.den}`;
}

const notesOf = (root: XmlElement): XmlElement[] => children(measuresOf(root)[0]!, 'note');

// `OpaqueElement` and `XmlElement` are the same shape, so a parsed element is
// stored with no conversion. A compile-time check.
const _sameShape: OpaqueElement = parseXml('<x/>');
void _sameShape;

describe('passthrough on a Note', () => {
	const xml = onePart(
		[
			n(
				'C',
				1,
				'quarter',
				`<stem>up</stem><notehead>diamond</notehead><notations><tied type="start"/><articulations><staccato/><breath-mark/></articulations><fermata>angled</fermata></notations>` +
					`<lyric number="1"><syllabic>single</syllabic><text>la</text></lyric>`
			) +
				n('C', 1, 'quarter', '<notations><tied type="stop"/></notations>') +
				n('E', 1, 'quarter', '<notations><technical><fingering>3</fingering></technical></notations>') +
				n('G', 1, 'quarter', '<notations><articulations><stress/></articulations></notations>', { chord: true }) +
				`<note><rest><display-step>B</display-step><display-octave>4</display-octave></rest><duration>1</duration><voice>1</voice><type>quarter</type></note>`
		],
		1
	);

	it('keeps unowned children on their own note (chord members and rests included), re-emitted in schema order', () => {
		const { score, root } = roundTrip(xml);
		const [first, second, anchor, member, rest] = score.staves[0]!.measures[0]!.notes;
		// Only what the model does not own: the <lyric>, linked <tied> and
		// <staccato/> are the model's, leaving <articulations> cut down to
		// its breath mark; an angled fermata is not modelled.
		expect(first!.passthrough.map((e) => e.name)).toEqual(['notehead', 'notations']);
		expect(names(first!.passthrough[1]!)).toEqual(['articulations', 'fermata']);
		expect(names(first!.passthrough[1]!.children[0]!)).toEqual(['breath-mark']);
		expect(first!.articulations).toEqual(['staccato']);
		expect(first!.fermata).toBeNull();
		expect(second!.passthrough).toEqual([]);
		expect(member!.chordWithPrevious).toBe(true);
		expect(anchor!.passthrough[0]!.children[0]!.name).toBe('technical');
		expect(member!.passthrough[0]!.children[0]!.name).toBe('articulations');
		expect(rest!.passthrough.map((e) => e.name)).toEqual(['rest']);

		const written = notesOf(root);
		// <notehead> after <stem>, the model's <tied> and staccato merged into
		// the passthrough's <notations>/<articulations>, <lyric> last.
		expect(names(written[0]!)).toEqual(['pitch', 'duration', 'tie', 'voice', 'type', 'stem', 'notehead', 'notations', 'lyric']);
		expect(names(child(written[0]!, 'notations')!)).toEqual(['tied', 'articulations', 'fermata']);
		expect(names(child(child(written[0]!, 'notations')!, 'articulations')!)).toEqual(['staccato', 'breath-mark']);
		expect(names(child(written[4]!, 'rest')!)).toEqual(['display-step', 'display-octave']);
	});


	it('keeps a slur or tie end that never found its partner', () => {
		const lonely = onePart(
			[
				n('C', 1, 'quarter', '<notations><tied type="start"/><slur type="start" number="2"/></notations>').replace('<voice>', '<tie type="start"/><voice>') +
					n('D', 1, 'quarter') +
					n('E', 1, 'quarter', '<notations><slur type="stop" number="3"/></notations>') +
					n('F', 1, 'quarter')
			],
			1
		);
		const { score } = roundTrip(lonely);
		const [c, , e] = score.staves[0]!.measures[0]!.notes;
		expect(score.slurs).toHaveLength(0);
		expect(c!.tiedToId).toBeNull();
		expect(c!.passthrough.map((x) => x.name)).toEqual(['tie', 'notations']);
		expect(e!.passthrough[0]!.children.map((x) => `${x.name}:${x.attrs.type}`)).toEqual(['slur:stop']);
	});
});

describe('passthrough at a Measure onset', () => {
	const words = (text: string, extra = ''): string => `<direction><direction-type><words>${text}</words></direction-type>${extra}</direction>`;

	it('anchors a direction between notes at its onset and writes it back there', () => {
		const xml = onePart(
			[words('start') + n('C', 1, 'quarter') + words('beat 2') + n('D', 1, 'quarter') + n('E', 2, 'half') + words('end', '<offset>1</offset>')],
			1
		);
		const { score, root } = roundTrip(xml);
		expect(score.staves[0]!.measures[0]!.passthrough.map(onsetOf)).toEqual(['0/1', '1/4', '1/1']);
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
		const v2 = { voice: 2 };
		const xml = onePart([
			n('C', 4, 'half') +
				n('D', 4, 'half') +
				'<backup><duration>8</duration></backup>' +
				words('voice 2 start') +
				n('E', 2, 'quarter', '', v2) +
				words('voice 2 beat 2') +
				n('F', 6, 'half', '<dot/>', v2) +
				// Back up into voice 2's dotted half: a mark at beat 3, where
				// no note of voice 2 starts.
				'<backup><duration>4</duration></backup>' +
				words('mid')
		]);
		const { score, root } = roundTrip(xml);
		expect(score.staves[0]!.measures[0]!.passthrough.map((a) => `${a.voice}@${onsetOf(a)}`)).toEqual(['2@0/1', '2@1/4', '2@1/2']);
		expect(streamOf(measuresOf(root)[0]!)).toEqual([
			'attributes',
			'note:C',
			'note:D',
			'backup:8',
			'direction:voice 2 start',
			'note:E',
			'direction:voice 2 beat 2',
			'note:F',
			'backup:4',
			'direction:mid'
		]);
	});

	it('writes a grace chord (not modelled) back in front of the note it ornaments', () => {
		const grace = (step: string, chord: boolean): string =>
			`<note><grace slash="yes"/>${chord ? '<chord/>' : ''}<pitch><step>${step}</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type></note>`;
		const xml = onePart([n('C', 1, 'quarter') + grace('A', false) + grace('C', true) + n('G', 1, 'quarter') + n('E', 2, 'half')], 1);
		const diagnostics = createImportDiagnostics();
		importMusicXml(xml, { diagnostics });
		expect(diagnostics.passthrough.get('grace')).toBe(2);
		expect(diagnostics.dropped.size).toBe(0);
		const { score, root } = roundTrip(xml);
		expect(score.staves[0]!.measures[0]!.notes.map((note) => note.pitch!.step)).toEqual(['C', 'G', 'E']);
		expect(streamOf(measuresOf(root)[0]!)).toEqual(['attributes', 'note:C', 'grace:A', 'grace:C', 'note:G', 'note:E']);
	});

	it('leads the measure with a <print>, and keeps <harmony>/<sound> in place', () => {
		const xml = onePart(
			[
				n('C', 4, 'whole'),
				`<print new-system="yes"/><harmony><root><root-step>F</root-step></root><kind>major</kind></harmony>` +
					n('F', 2, 'half') +
					`<sound dynamics="80"/>` +
					n('A', 2, 'half')
			],
			1
		);
		const { root } = roundTrip(xml);
		expect(streamOf(measuresOf(root)[1]!)).toEqual(['print', 'harmony', 'note:F', 'sound', 'note:A']);
	});

	it('rescales an <offset> when the part needs finer divisions than it was read at', () => {
		// One quarter-division anchor, then a sixteenth note forces divisions
		// 4, so the offset of 1 (a quarter) must become 4.
		const score = new Score();
		const measure = score.appendMeasure(0);
		for (const [pitch, value, dots] of [['C5', '16th', 0], ['D5', '16th', 0], ['E5', 'eighth', 0], ['F5', 'half', 1]] as const) {
			score.appendNote(measure, { pitch: parsePitch(pitch), value, dots });
		}
		const direction = parseXml('<direction><direction-type><words>later</words></direction-type><offset>1</offset></direction>');
		measure.passthrough = [{ element: direction, onset: { num: 1, den: 4 }, voice: 1, lead: false, divisions: 1 }];
		const exported = exportMusicXml(score);
		const written = children(measuresOf(parseXml(exported))[0]!, 'direction').find((d) => child(d, 'offset'))!;
		expect(child(written, 'offset')!.text).toBe('4');
		assertScoresEquivalent(importMusicXml(exported), score);
	});
});

describe('passthrough in measure attributes and barlines', () => {
	it('merges <staff-details>/<transpose> into the written <attributes> in schema order', () => {
		const xml = onePart(
			[
				n('C', 4, 'whole'),
				`<attributes><clef><sign>F</sign><line>4</line></clef><staff-details><staff-lines>5</staff-lines></staff-details><transpose><chromatic>-2</chromatic></transpose></attributes>` +
					n('C', 4, 'whole')
			],
			1
		);
		const { score, root } = roundTrip(xml);
		expect(score.staves[0]!.measures[1]!.attributesPassthrough.map((e) => e.name)).toEqual(['staff-details', 'transpose']);
		expect(names(child(measuresOf(root)[1]!, 'attributes')!)).toEqual(['clef', 'staff-details', 'transpose']);
	});

	it('keeps an <attributes> with nothing modelled in it where it was, mid-measure', () => {
		const xml = onePart([n('C', 2, 'half') + `<attributes><measure-style><slash type="start"/></measure-style></attributes>` + n('D', 2, 'half')], 1);
		const { score, root } = roundTrip(xml);
		expect(score.staves[0]!.measures[0]!.passthrough.map(onsetOf)).toEqual(['1/2']);
		expect(streamOf(measuresOf(root)[0]!)).toEqual(['attributes', 'note:C', 'attributes', 'note:D']);
	});

	it('merges an unpaired <ending> into the barline the model writes, and keeps a barline it cannot read', () => {
		const xml = onePart(
			[
				n('C', 4, 'whole') + `<barline location="right"><bar-style>dashed</bar-style></barline>`,
				n('D', 4, 'whole') +
					`<barline location="right"><bar-style>light-heavy</bar-style><ending number="1" type="stop"/><repeat direction="backward"/></barline>`,
				n('E', 4, 'whole')
			],
			1
		);
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
			'<work><work-title>Evening Song</work-title></work><identification><encoding><software>Audiveris</software></encoding></identification><part-list>'
		);
		const { score, root } = roundTrip(xml);
		expect(score.headerPassthrough.map((e) => e.name)).toEqual(['work', 'identification']);
		expect(names(root)).toEqual(['work', 'identification', 'part-list', 'part']);
		expect(names(child(child(root, 'part-list')!, 'score-part')!)).toEqual(['part-name', 'part-abbreviation', 'score-instrument', 'midi-instrument']);
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
		const xml = onePart(
			[
				`<direction><direction-type><words>Andante</words></direction-type><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>72</per-minute></metronome></direction-type><sound tempo="72"/></direction>` +
					n('C', 4, 'whole')
			],
			1
		);
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

describe('articulations and fermatas (M6 Slice 5): promoted out of passthrough', () => {
	it('reads the modelled kinds into the note, keeps the rest as passthrough, and writes both back as one element', () => {
		const diagnostics = createImportDiagnostics();
		const xml = onePart(
			[
				n('C', 1, 'quarter', '<notations><articulations><accent placement="above"/><staccato placement="below"/><caesura/></articulations></notations>') +
					n('D', 1, 'quarter', '<notations><articulations><strong-accent type="up"/><tenuto/></articulations><fermata type="inverted"/></notations>') +
					n('E', 1, 'quarter', '<notations><articulations><staccatissimo/><detached-legato/></articulations></notations>') +
					`<note><rest/><duration>1</duration><voice>1</voice><type>quarter</type><notations><fermata type="upright"/></notations></note>`
			],
			1
		);
		const [c, d, e, rest] = importMusicXml(xml, { diagnostics }).staves[0]!.measures[0]!.notes;
		// Stored in `ARTICULATIONS` order, whatever the source order.
		expect(c!.articulations).toEqual(['staccato', 'accent']);
		expect(d!.articulations).toEqual(['tenuto', 'strong-accent']);
		expect(d!.fermata).toBe('inverted');
		expect(e!.articulations).toEqual(['staccatissimo', 'detached-legato']);
		expect(rest!.fermata).toBe('upright');
		// Only the caesura is left over, in a cut-down `<articulations>`.
		expect(c!.passthrough.map((el) => el.name)).toEqual(['notations']);
		expect(names(c!.passthrough[0]!.children[0]!)).toEqual(['caesura']);
		expect([d, e, rest].every((note) => note!.passthrough.length === 0)).toBe(true);
		expect(diagnostics.passthrough.get('articulations')).toBe(1);
		expect(diagnostics.passthrough.has('fermata')).toBe(false);

		const notationsOf = (i: number): XmlElement => child(notesOf(roundTrip(xml).root)[i]!, 'notations')!;
		expect(names(child(notationsOf(0), 'articulations')!)).toEqual(['staccato', 'accent', 'caesura']);
		expect(names(notationsOf(1))).toEqual(['articulations', 'fermata']);
		expect(child(notationsOf(1), 'fermata')!.attrs.type).toBe('inverted');
		expect(child(notationsOf(3), 'fermata')!.attrs.type).toBe('upright');
	});

	it('keeps a mark on the chord member it was written on', () => {
		const xml = onePart(
			[n('C', 1, 'quarter') + n('E', 1, 'quarter', '<notations><articulations><staccato/></articulations><fermata/></notations>', { chord: true }) + n('D', 3, 'half', '<dot/>')],
			1
		);
		const { score, root } = roundTrip(xml);
		const [anchor, member] = score.staves[0]!.measures[0]!.notes;
		expect(anchor!.articulations).toEqual([]);
		expect(member!.articulations).toEqual(['staccato']);
		expect(member!.fermata).toBe('upright');
		const written = notesOf(root);
		expect(child(written[0]!, 'notations')).toBeUndefined();
		expect(names(child(written[1]!, 'notations')!)).toEqual(['articulations', 'fermata']);
	});

	it('leaves a duplicate mark and a non-normal fermata shape in passthrough rather than losing them', () => {
		const xml = onePart([n('C', 4, 'whole', '<notations><articulations><staccato/><staccato/></articulations><fermata>square</fermata><fermata/></notations>')], 1);
		const { score, root } = roundTrip(xml);
		const note = score.staves[0]!.measures[0]!.notes[0]!;
		expect(note.articulations).toEqual(['staccato']);
		expect(note.fermata).toBe('upright');
		const notations = child(notesOf(root)[0]!, 'notations')!;
		expect(names(child(notations, 'articulations')!)).toEqual(['staccato', 'staccato']);
		expect(children(notations, 'fermata').map((f) => f.text)).toEqual(['', 'square']);
	});

	it('round-trips a whole-measure rest with a fermata', () => {
		const { score } = roundTrip(
			onePart([`<note><rest measure="yes"/><duration>4</duration><voice>1</voice><notations><fermata type="upright"/></notations></note>`], 1)
		);
		const rest = score.staves[0]!.measures[0]!.notes[0]!;
		expect([rest.isMeasureRest, rest.fermata]).toEqual([true, 'upright']);
	});
});
