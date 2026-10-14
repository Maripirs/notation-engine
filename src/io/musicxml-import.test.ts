import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createAccidentalShowcaseScore,
	createBarlineShowcaseScore,
	createClefShowcaseScore,
	createCrossStaffBeamShowcaseScore,
	createDemoScore,
	createDurationShowcaseScore,
	createFullDemoScore,
	createGrandStaffShowcaseScore,
	createKeyTimeChangeShowcaseScore,
	createSatbBracketShowcaseScore,
	createSlurShowcaseScore,
	createTieShowcaseScore,
	createTwoVoiceShowcaseScore,
	createVoiceClashShowcaseScore
} from '../demo-score.js';
import { exportMusicXml } from './musicxml-export.js';
import { importMusicXml } from './musicxml-import.js';
import { assertScoresEquivalent } from '../model/index.js';

// A `score-partwise` shell so the fixtures below only have to spell out the
// part they care about. `parts` is the raw inner XML for `<part-list>` +
// `<part>`s.
function doc(parts: string): string {
	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
		`<score-partwise version="4.0">\n${parts}\n</score-partwise>\n`
	);
}

describe('importMusicXml — hand-written fixtures', () => {
	it('reads a one-part, single-staff score', () => {
		const xml = doc(`
      <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>4</divisions>
            <key><fifths>2</fifths></key>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef number="1"><sign>G</sign><line>2</line></clef>
          </attributes>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
          <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
          <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
          <note><pitch><step>F</step><alter>1</alter><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
        </measure>
      </part>`);

		const score = importMusicXml(xml);
		expect(score.staves).toHaveLength(1);
		expect(score.keyFifths).toBe(2);
		expect(score.time).toEqual({ beats: 4, beatType: 4 });
		expect(score.staves[0]!.clef).toBe('treble');

		const notes = score.staves[0]!.measures[0]!.notes;
		expect(notes).toHaveLength(4);
		expect(notes.map((n) => n.value)).toEqual(['quarter', 'quarter', 'quarter', 'quarter']);
		expect(notes[2]!.isRest).toBe(true);
		expect(notes[0]!.pitch).toEqual({ step: 'C', alter: 0, octave: 5 });
		expect(notes[3]!.pitch).toEqual({ step: 'F', alter: 1, octave: 5 });
		// Cross-check reconstructed duration against the raw <duration> (divisions 4).
		for (const note of notes) {
			expect(Math.abs(note.durationWholes * 4 * 4 - 4)).toBeLessThan(1e-6);
		}
	});

	it('reads an SATB score: four staves, four clefs, named parts, a bracket group', () => {
		const voice = (id: string, sign: string, line: string, octave = '') => `
      <part id="${id}">
        <measure number="1">
          <attributes>
            <divisions>1</divisions>
            <key><fifths>0</fifths></key>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef number="1"><sign>${sign}</sign><line>${line}</line>${octave}</clef>
          </attributes>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
        </measure>
      </part>`;
		const xml = doc(`
      <part-list>
        <part-group type="start" number="1"><group-symbol>bracket</group-symbol></part-group>
        <score-part id="P1"><part-name>Soprano</part-name></score-part>
        <score-part id="P2"><part-name>Alto</part-name></score-part>
        <score-part id="P3"><part-name>Tenor</part-name></score-part>
        <score-part id="P4"><part-name>Bass</part-name></score-part>
        <part-group type="stop" number="1"/>
      </part-list>
      ${voice('P1', 'G', '2')}
      ${voice('P2', 'G', '2')}
      ${voice('P3', 'G', '2', '<clef-octave-change>-1</clef-octave-change>')}
      ${voice('P4', 'F', '4')}`);

		const score = importMusicXml(xml);
		expect(score.staves).toHaveLength(4);
		expect(score.staves.map((s) => s.clef)).toEqual(['treble', 'treble', 'treble8', 'bass']);

		// Default part + 4 named parts + 1 group, in that order.
		expect(score.parts).toEqual([
			{ staffIndices: [0] },
			{ name: 'Soprano', staffIndices: [0] },
			{ name: 'Alto', staffIndices: [1] },
			{ name: 'Tenor', staffIndices: [2] },
			{ name: 'Bass', staffIndices: [3] },
			{ name: undefined, staffIndices: [0, 1, 2, 3] }
		]);
	});

	it('lands a mid-score key change on the right measure', () => {
		const xml = doc(`
      <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>1</divisions>
            <key><fifths>0</fifths></key>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef number="1"><sign>G</sign><line>2</line></clef>
          </attributes>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
        </measure>
        <measure number="2">
          <attributes><key><fifths>3</fifths></key></attributes>
          <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
        </measure>
        <measure number="3">
          <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
        </measure>
      </part>`);

		const score = importMusicXml(xml);
		// Measure 0's <fifths>0</fifths> equals the score-global key, so no change
		// is recorded there; measure 1 carries the change; measure 2 inherits it.
		expect(score.staves[0]!.measures[0]!.keyFifths).toBeUndefined();
		expect(score.staves[0]!.measures[1]!.keyFifths).toBe(3);
		expect(score.staves[0]!.measures[2]!.keyFifths).toBeUndefined();
		expect(score.keyFifthsAt(0)).toBe(0);
		expect(score.keyFifthsAt(1)).toBe(3);
		expect(score.keyFifthsAt(2)).toBe(3);
	});

	it('links a tie that crosses a barline to the right pair', () => {
		const xml = doc(`
      <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>2</divisions>
            <key><fifths>0</fifths></key>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef number="1"><sign>G</sign><line>2</line></clef>
          </attributes>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>half</type></note>
          <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><tie type="start"/><voice>1</voice><type>half</type><notations><tied type="start"/></notations></note>
        </measure>
        <measure number="2">
          <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><tie type="stop"/><voice>1</voice><type>half</type><notations><tied type="stop"/></notations></note>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>half</type></note>
        </measure>
      </part>`);

		const score = importMusicXml(xml);
		const source = score.staves[0]!.measures[0]!.notes[1]!;
		const target = score.staves[0]!.measures[1]!.notes[0]!;
		expect(source.tiedToId).toBe(target.id);
		expect(score.tiedFromNote(target.id)).toBe(source);
		// The unrelated C5s are not tied.
		expect(score.staves[0]!.measures[0]!.notes[0]!.tiedToId).toBeNull();
	});

	it('reads a triplet measure: ratio and reconstructed durations', () => {
		const trip = (step: string, stop = false) => `
      <note>
        <pitch><step>${step}</step><octave>5</octave></pitch>
        <duration>1</duration><voice>1</voice><type>eighth</type>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>
        <notations>${stop ? '<tuplet type="stop" number="1"/>' : '<tuplet type="start" number="1"/>'}</notations>
      </note>`;
		const xml = doc(`
      <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>3</divisions>
            <key><fifths>0</fifths></key>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef number="1"><sign>G</sign><line>2</line></clef>
          </attributes>
          ${trip('C')}${trip('D')}${trip('E')}${trip('F')}${trip('G')}${trip('A', true)}
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>6</duration><voice>1</voice><type>half</type></note>
        </measure>
      </part>`);

		const score = importMusicXml(xml);
		const notes = score.staves[0]!.measures[0]!.notes;
		expect(notes).toHaveLength(7);
		for (let i = 0; i < 6; i++) {
			expect(notes[i]!.tuplet).toEqual({ actualNotes: 3, normalNotes: 2 });
			// A tripleted eighth is 1/12 of a whole; divisions is 3, so duration is 1.
			expect(Math.abs(notes[i]!.durationWholes * 4 * 3 - 1)).toBeLessThan(1e-6);
		}
		expect(notes[6]!.tuplet).toBeNull();
		expect(Math.abs(notes[6]!.durationWholes * 4 * 3 - 6)).toBeLessThan(1e-6);
	});
});

describe('importMusicXml — round-trips every showcase score', () => {
	const showcases: Record<string, () => import('../model/index.js').Score> = {
		createDemoScore,
		createDurationShowcaseScore,
		createAccidentalShowcaseScore,
		createTieShowcaseScore,
		createSlurShowcaseScore,
		createKeyTimeChangeShowcaseScore,
		createBarlineShowcaseScore,
		createTwoVoiceShowcaseScore,
		createVoiceClashShowcaseScore,
		createClefShowcaseScore,
		createGrandStaffShowcaseScore,
		createSatbBracketShowcaseScore,
		createCrossStaffBeamShowcaseScore,
		createFullDemoScore
	};

	for (const [name, make] of Object.entries(showcases)) {
		it(`${name} survives export -> import`, () => {
			const original = make();
			const reimported = importMusicXml(exportMusicXml(original));
			assertScoresEquivalent(reimported, original);
		});
	}
});

describe('importMusicXml — tolerance for unsupported content', () => {
	afterEach(() => vi.restoreAllMocks());

	it('drops lyrics, grace notes, articulations and dynamics, warns once on a truly unknown element', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const xml = doc(`
      <part-list><score-part id="P1"><part-name>Test</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>1</divisions>
            <key><fifths>0</fifths></key>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef number="1"><sign>G</sign><line>2</line></clef>
          </attributes>
          <direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type><sound dynamics="54"/></direction>
          <note><grace/><pitch><step>D</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type></note>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><lyric number="1"><syllabic>single</syllabic><text>la</text></lyric><notations><articulations><staccato/></articulations></notations></note>
          <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
          <florble reason="testing">ignored</florble>
          <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
          <note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
        </measure>
      </part>`);

		const score = importMusicXml(xml);

		// The grace note is gone; the four real quarter notes survive intact.
		const notes = score.staves[0]!.measures[0]!.notes;
		expect(notes.map((n) => n.pitch?.step)).toEqual(['C', 'D', 'E', 'F']);
		expect(notes.every((n) => n.value === 'quarter')).toBe(true);

		const messages = warn.mock.calls.map((call) => String(call[0]));
		expect(messages.some((m) => m.includes('florble'))).toBe(true);
		// The known-irrelevant elements are dropped silently.
		for (const quiet of ['lyric', 'grace', 'articulations', 'direction', 'dynamics', 'staccato']) {
			expect(messages.some((m) => m.includes(quiet))).toBe(false);
		}
		// Warned exactly once for florble even though it could be seen repeatedly.
		expect(messages.filter((m) => m.includes('florble'))).toHaveLength(1);
	});
});

describe('importMusicXml — malformed input', () => {
	it('throws on XML that is not well-formed', () => {
		expect(() => importMusicXml('<score-partwise><part-list>')).toThrow();
	});

	it('throws a clear error when the root is not <score-partwise>', () => {
		expect(() => importMusicXml('<not-a-score/>')).toThrow(/score-partwise/);
		expect(() => importMusicXml('<score-timewise version="4.0"><measure/></score-timewise>')).toThrow(
			/score-partwise/
		);
	});
});
