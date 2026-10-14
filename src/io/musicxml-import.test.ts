import { afterEach, describe, expect, it, vi } from 'vitest';
import { layoutScore } from '../layout/index.js';
import {
	createAccidentalShowcaseScore,
	createBarlineShowcaseScore,
	createArticulationShowcaseScore,
	createChordShowcaseScore,
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
import { createImportDiagnostics, importMusicXml } from './musicxml-import.js';
import { assertScoresEquivalent, buildScore, validateMeasure } from '../model/index.js';

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

		// 4 named parts + 1 group, in that order (no stray constructor seed;
		// see the part-count test below).
		expect(score.parts).toEqual([
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

describe('importMusicXml: mid-score clef changes (M5 Slice 5)', () => {
	it('round-trips a clef change on each staff of a grand staff, including the restore after it', () => {
		const original = createGrandStaffShowcaseScore();
		original.setClefRange(0, 1, 1, 'treble8');
		original.setClefRange(1, 1, 2, 'treble');
		const reimported = importMusicXml(exportMusicXml(original));
		assertScoresEquivalent(reimported, original);
		const clefsOf = (staffIndex: number) =>
			reimported.staves[staffIndex]!.measures.map((_m, i) => reimported.clefAt(i, staffIndex));
		expect(clefsOf(0).slice(0, 3)).toEqual(['treble', 'treble8', 'treble']);
		expect(clefsOf(1).slice(0, 3)).toEqual(['bass', 'treble', 'treble']);
	});

	it('reads a measure-0 clef override back as the staff\'s own initial clef', () => {
		const original = createDemoScore();
		original.setClefRange(0, 0, 0, 'bass');
		const reimported = importMusicXml(exportMusicXml(original));
		assertScoresEquivalent(reimported, original);
		expect(reimported.staves[0]!.clef).toBe('bass');
		expect(reimported.clefAt(1)).toBe('treble');
	});
});

describe('importMusicXml: C clefs and clef changes inside a measure (M6 Slice 4)', () => {
	const note = (step: string, octave: number, staff = 1) =>
		`<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type>${staff > 1 ? `<staff>${staff}</staff>` : ''}</note>`;
	const clef = (sign: string, line: number, number = 1) =>
		`<attributes><clef number="${number}"><sign>${sign}</sign><line>${line}</line></clef></attributes>`;
	const part = (measures: string, staves = 1) =>
		doc(`
      <part-list><score-part id="P1"><part-name>Tenor</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>1</divisions>
            <key><fifths>0</fifths></key>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            ${staves > 1 ? `<staves>${staves}</staves>` : ''}
            <clef number="1"><sign>F</sign><line>4</line></clef>
            ${staves > 1 ? '<clef number="2"><sign>F</sign><line>4</line></clef>' : ''}
          </attributes>
          ${measures}`);

	it('maps <sign>C</sign> line 3 to alto and line 4 to tenor, and still falls back for C1/C2/C5', () => {
		const diagnostics = createImportDiagnostics();
		const xml = part(`
          ${note('C', 4).repeat(4)}
        </measure>
        <measure number="2">${clef('C', 4)}${note('C', 4).repeat(4)}</measure>
        <measure number="3">${clef('C', 3)}${note('C', 4).repeat(4)}</measure>
        <measure number="4">${clef('C', 1)}${note('C', 4).repeat(4)}</measure>
      </part>`);
		const score = importMusicXml(xml, { diagnostics });
		expect([0, 1, 2, 3].map((m) => score.clefAt(m))).toEqual(['bass', 'tenor', 'alto', 'treble']);
		expect(diagnostics.fallbacks.map((f) => `${f.kind} m${f.measureNumber}: ${f.detail}`)).toEqual([
			'clef m4: sign C line 1'
		]);
	});

	it('reads a clef between a measure\'s notes as a change at that onset, and one at the end as a change before the barline', () => {
		const diagnostics = createImportDiagnostics();
		const xml = part(`
          ${note('C', 4).repeat(2)}${clef('C', 4)}${note('C', 4).repeat(2)}${clef('F', 4)}
        </measure>
        <measure number="2">${note('C', 4).repeat(4)}</measure>
      </part>`);
		const score = importMusicXml(xml, { diagnostics });
		expect(score.measures[0]!.clef).toBeUndefined();
		expect(score.measures[0]!.clefChanges).toEqual([
			{ onset: 0.5, clef: 'tenor' },
			{ onset: 1, clef: 'bass' }
		]);
		expect(score.clefAt(1)).toBe('bass');
		expect(diagnostics.dropped.size).toBe(0);
		assertScoresEquivalent(importMusicXml(exportMusicXml(score)), score);
	});

	it('places a second staff\'s clef by the cursor after a <backup>, and round-trips it', () => {
		const xml = part(
			`
          ${note('C', 4).repeat(4)}
          <backup><duration>4</duration></backup>
          ${note('C', 3, 2).repeat(3)}${clef('C', 4, 2)}${note('C', 4, 2)}
        </measure>
        <measure number="2">${note('C', 4).repeat(4)}<backup><duration>4</duration></backup>${note('C', 4, 2).repeat(4)}</measure>
      </part>`,
			2
		);
		const score = importMusicXml(xml);
		expect(score.staves[0]!.measures[0]!.clefChanges).toEqual([]);
		expect(score.staves[1]!.measures[0]!.clefChanges).toEqual([{ onset: 0.75, clef: 'tenor' }]);
		expect(score.clefAt(1, 1)).toBe('tenor');
		expect(score.clefAt(1, 0)).toBe('bass');
		assertScoresEquivalent(importMusicXml(exportMusicXml(score)), score);
	});

	it('keeps only the later of two clefs at one onset, tallying the earlier as dropped', () => {
		const diagnostics = createImportDiagnostics();
		const xml = part(`
          ${note('C', 4).repeat(2)}${clef('C', 4)}${clef('C', 3)}${note('C', 4).repeat(2)}
        </measure>
      </part>`);
		const score = importMusicXml(xml, { diagnostics });
		expect(score.measures[0]!.clefChanges).toEqual([{ onset: 0.5, clef: 'alto' }]);
		expect(diagnostics.dropped.get('clef')).toBe(1);
	});
});

describe('importMusicXml — tolerance for unsupported content', () => {
	afterEach(() => vi.restoreAllMocks());

	it('keeps lyrics, grace notes, articulations and dynamics out of the model quietly, warns once on a truly unknown element', () => {
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

		// The grace note is not a model note (it is passthrough since M6 Slice
		// 3); the four real quarter notes survive intact.
		const notes = score.staves[0]!.measures[0]!.notes;
		expect(notes.map((n) => n.pitch?.step)).toEqual(['C', 'D', 'E', 'F']);
		expect(notes.every((n) => n.value === 'quarter')).toBe(true);

		const messages = warn.mock.calls.map((call) => String(call[0]));
		expect(messages.some((m) => m.includes('florble'))).toBe(true);
		// The known unmodelled elements are passed through silently.
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

describe('importMusicXml: part count (M6 Slice 1)', () => {
	// Reproduces Brahms "Der Abend" importing 5 <part>s as 7 `Part`s, in
	// miniature: the `Score` constructor's seed part (`{ staffIndices: [0] }`)
	// used to survive next to the parts the file itself states. A two-staff
	// <part> plus a bracket <part-group> is the Brahms shape (choir + piano).
	it('yields one Part per <part> (plus the bracket group), never the constructor seed', () => {
		const measure = (staves: string) => `
        <measure number="1">
          <attributes>
            <divisions>1</divisions>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            ${staves}
          </attributes>
          <note><rest/><duration>4</duration><voice>1</voice><type>whole</type></note>
        </measure>`;
		const xml = doc(`
      <part-list>
        <part-group type="start" number="1"><group-symbol>bracket</group-symbol></part-group>
        <score-part id="P1"><part-name>Choir</part-name></score-part>
        <part-group type="stop" number="1"/>
        <score-part id="P2"><part-name>Piano</part-name></score-part>
      </part-list>
      <part id="P1">${measure('')}</part>
      <part id="P2">${measure('<staves>2</staves>')}</part>`);

		const score = importMusicXml(xml);
		expect(score.staves).toHaveLength(3);
		expect(score.parts).toEqual([
			{ name: 'Choir', staffIndices: [0] },
			{ name: 'Piano', staffIndices: [1, 2] },
			{ name: undefined, staffIndices: [0] }
		]);
	});

	it('gives an unnamed <part> its own Part too', () => {
		const xml = doc(`
      <part-list><score-part id="P1"/><score-part id="P2"/></part-list>
      <part id="P1"><measure number="1"><note><rest/><duration>4</duration><type>whole</type></note></measure></part>
      <part id="P2"><measure number="1"><note><rest/><duration>4</duration><type>whole</type></note></measure></part>`);
		const score = importMusicXml(xml);
		expect(score.parts).toEqual([{ staffIndices: [0] }, { staffIndices: [1] }]);
	});
});

describe('importMusicXml: whole-measure rests (M6 Slice 1)', () => {
	// Three measures: a filled one, a `<rest measure="yes"/>` one (with the
	// `<type>whole</type>` OMR output carries even when the bar is shorter),
	// and another filled one, so the rest is not a system's first measure.
	const scoreWithMeasureRest = (beats: number, beatType: number, divisions: number, filler: string) => {
		const duration = (beats / beatType) * 4 * divisions;
		return importMusicXml(
			doc(`
      <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>${divisions}</divisions>
            <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
            <clef><sign>G</sign><line>2</line></clef>
          </attributes>
          ${filler}
        </measure>
        <measure number="2">
          <note><rest measure="yes"/><duration>${duration}</duration><voice>1</voice><type>whole</type></note>
        </measure>
        <measure number="3">${filler}</measure>
      </part>`)
		);
	};
	const cases = [
		{
			time: '3/4',
			beats: 3,
			beatType: 4,
			divisions: 1,
			filler: '<note><pitch><step>C</step><octave>5</octave></pitch><duration>3</duration><voice>1</voice><type>half</type><dot/></note>'
		},
		{
			time: '2/2',
			beats: 2,
			beatType: 2,
			divisions: 1,
			filler: '<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>'
		},
		{
			time: '6/8',
			beats: 6,
			beatType: 8,
			divisions: 2,
			filler: '<note><pitch><step>C</step><octave>5</octave></pitch><duration>6</duration><voice>1</voice><type>half</type><dot/></note>'
		}
	];

	for (const c of cases) {
		it(`fills a ${c.time} measure, validates, plays for the bar and round-trips`, () => {
			const score = scoreWithMeasureRest(c.beats, c.beatType, c.divisions, c.filler);
			const measure = score.staves[0]!.measures[1]!;
			expect(measure.notes).toHaveLength(1);
			const rest = measure.notes[0]!;
			expect(rest.isRest).toBe(true);
			expect(rest.isMeasureRest).toBe(true);
			expect(rest.value).toBe('whole');
			expect(rest.durationWholes).toBeCloseTo(c.beats / c.beatType, 12);
			expect(validateMeasure(measure, score.timeAt(1)).valid).toBe(true);

			const xml = exportMusicXml(score);
			const restNote = xml.split('<note>')[2]!.split('</note>')[0]!;
			expect(restNote).toContain('<rest measure="yes"/>');
			expect(restNote).not.toContain('<type>');
			const divisions = Number(/<divisions>(\d+)<\/divisions>/.exec(xml)![1]);
			const duration = Number(/<duration>(\d+)<\/duration>/.exec(restNote)![1]);
			expect(duration / (divisions * 4)).toBeCloseTo(c.beats / c.beatType, 12);

			const reimported = importMusicXml(xml);
			assertScoresEquivalent(reimported, score);
			expect(reimported.staves[0]!.measures[1]!.notes[0]!.isMeasureRest).toBe(true);
		});
	}

	it('lays the rest out as a whole-rest glyph centred in its measure', () => {
		for (const c of cases) {
			const score = scoreWithMeasureRest(c.beats, c.beatType, c.divisions, c.filler);
			const layout = layoutScore(score);
			const laid = layout.measures.find((m) => m.staffIndex === 0 && m.index === 1)!;
			const restId = score.staves[0]!.measures[1]!.notes[0]!.id;
			const glyph = laid.ops.find((op) => op.kind === 'glyph' && op.noteId === restId);
			expect(glyph?.kind === 'glyph' && glyph.glyph).toBe('restWhole');
			const box = laid.notes.find((n) => n.id === restId)!.bounds;
			const centre = box.x + box.width / 2;
			// The measure has no header (not a system start, no changes), so
			// its own region's centre is the centre of the space between its
			// left edge and its barline, give or take the barline's width.
			const regionCentre = laid.region.x + laid.region.width / 2;
			expect(Math.abs(centre - regionCentre)).toBeLessThan(layout.staffSpacePx * 0.5);
		}
	});
});

describe('importMusicXml: no-<type> fallback (M6 Slice 1)', () => {
	const oneMeasure = (notes: string) =>
		doc(`
      <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
      <part id="P1">
        <measure number="7">
          <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
          ${notes}
        </measure>
      </part>`);

	it('derives value and dots from <duration> when they map exactly', () => {
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(
			oneMeasure(`
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>6</duration></note>
          <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration></note>
          <note><pitch><step>E</step><octave>5</octave></pitch><duration>7</duration></note>
          <note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration></note>`),
			{ diagnostics }
		);
		const notes = score.staves[0]!.measures[0]!.notes;
		expect(notes.map((n) => [n.value, n.dots])).toEqual([
			['quarter', 1],
			['eighth', 0],
			['quarter', 2],
			['16th', 0]
		]);
		expect(validateMeasure(score.staves[0]!.measures[0]!, score.time).valid).toBe(true);
		expect(diagnostics.fallbacks).toEqual([]);
	});

	it('falls back to quarter only when unmappable, recording where', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(
			oneMeasure(`<note><pitch><step>C</step><octave>5</octave></pitch><duration>5</duration></note>`),
			{ diagnostics }
		);
		expect(score.staves[0]!.measures[0]!.notes[0]!.value).toBe('quarter');
		expect(diagnostics.fallbacks).toEqual([
			{ kind: 'note-value', partId: 'P1', measureNumber: '7', detail: 'duration 5 at divisions 4' }
		]);
		// A caller collecting diagnostics gets no console noise.
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('importMusicXml: drop and passthrough diagnostics (M6 Slices 1, 3)', () => {
	it('tallies passthrough and genuine drops per element name and keeps the console quiet', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const diagnostics = createImportDiagnostics();
		importMusicXml(
			doc(`
      <work><work-title>T</work-title></work>
      <part-list><score-part id="P1"><part-name>Test</part-name><score-instrument id="I1"/></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes>
            <divisions>1</divisions>
            <key><fifths>0</fifths><mode>major</mode></key>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <staff-details/>
          </attributes>
          <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><sound tempo="90"/></direction>
          <direction><direction-type><dynamics><p/></dynamics></direction-type><sound dynamics="54"/></direction>
          <direction><direction-type><wedge type="crescendo"/></direction-type></direction>
          <note><grace/><pitch><step>D</step><octave>5</octave></pitch><type>eighth</type></note>
          <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>half</type><stem>up</stem><lyric><text>la</text></lyric><notations><articulations><staccato/></articulations><fermata/><slur type="start"/></notations></note>
          <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><type>half</type></note>
          <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><type>half</type><notations><slur type="stop"/></notations></note>
          <florble/>
          <print new-system="yes"/>
          <barline location="right"><bar-style>light-heavy</bar-style><ending number="1" type="stop"/></barline>
        </measure>
      </part>`),
			{ diagnostics }
		);
		const sorted = (map: Map<string, number>): Record<string, number> =>
			Object.fromEntries([...map].sort(([x], [y]) => x.localeCompare(y)));
		// Since M6 Slice 3 the only genuine loss here is `<mode>`: a child of
		// the modelled `<key>` the model has no field for.
		expect(sorted(diagnostics.dropped)).toEqual({ mode: 1 });
		expect(sorted(diagnostics.passthrough)).toEqual({
			// The tempo direction is exactly export's own shape in the first
			// measure, so it is `Score.tempoBpm`, not passthrough.
			// (Its staccato and fermata are modelled since M6 Slice 5.)
			dynamics: 1,
			ending: 1,
			florble: 1,
			grace: 1,
			lyric: 1,
			print: 1,
			'score-instrument': 1,
			sound: 1,
			'staff-details': 1,
			wedge: 1,
			work: 1
		});
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('importMusicXml: chords (M6 Slice 2)', () => {
	const oneMeasure = (notes: string) =>
		doc(`
      <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1">
          <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
          ${notes}
        </measure>
      </part>`);

	it('reads <chord/> notes as chord members of the previous note', () => {
		const score = importMusicXml(
			oneMeasure(`
          <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note>
          <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note>
          <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note>
          <note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>half</type></note>`)
		);
		const measure = score.staves[0]!.measures[0]!;
		expect(measure.notes.map((note) => note.chordWithPrevious)).toEqual([false, true, true, false]);
		expect(validateMeasure(measure, score.timeAt(0)).valid).toBe(true);
	});

	it('drops and tallies a <chord/> note with no pitched note to join', () => {
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(
			oneMeasure(`
          <note><rest/><duration>4</duration><type>whole</type></note>
          <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>`),
			{ diagnostics }
		);
		expect(score.staves[0]!.measures[0]!.notes).toHaveLength(1);
		expect(diagnostics.dropped.get('chord')).toBe(1);
	});

	it('round-trips chords in two voices, with ties and beams, through export', () => {
		const original = buildScore(
			[
				[
					[['E5', 'G5'], 'eighth', { voice: 1 }],
					[['D5', 'F5'], 'eighth', { voice: 1 }],
					[['C5', 'E5'], 'quarter', { voice: 1 }],
					[['B4', 'D5'], 'half', { voice: 1, tiedToNext: true }],
					[['C4', 'E4', 'G4'], 'whole', { voice: 2 }]
				],
				[
					[['B4', 'D5'], 'whole', { voice: 1 }],
					[['C4', 'E4', 'G4'], 'whole', { voice: 2 }]
				]
			],
			{ keyFifths: 0 }
		);
		const xml = exportMusicXml(original);
		// Exactly one <chord/> per member, and a single full-measure <backup>
		// per measure: the members never moved the cursor.
		expect(xml.match(/<chord\/>/g)).toHaveLength(4 + 2 + 1 + 2);
		expect(xml.match(/<backup>\s*<duration>(\d+)<\/duration>/g)).toHaveLength(2);
		const reimported = importMusicXml(xml);
		assertScoresEquivalent(reimported, original);
		for (const measure of reimported.staves[0]!.measures) {
			expect(validateMeasure(measure, reimported.timeAt(measure.index)).valid).toBe(true);
		}
	});

	it('round-trips the chord showcase', () => {
		const original = createChordShowcaseScore();
		assertScoresEquivalent(importMusicXml(exportMusicXml(original)), original);
	});

	it('round-trips the articulation showcase, marks and fermatas included (M6 Slice 5)', () => {
		const original = createArticulationShowcaseScore();
		const xml = exportMusicXml(original);
		const reimported = importMusicXml(xml);
		assertScoresEquivalent(reimported, original);
		expect(exportMusicXml(reimported)).toBe(xml);
		// Equivalence compares marks; check it would notice a lost one.
		reimported.staves[0]!.measures[0]!.notes[0]!.articulations = [];
		expect(() => assertScoresEquivalent(reimported, original)).toThrow(/articulations/);
	});
});
