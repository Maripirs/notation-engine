import { afterEach, describe, expect, it, vi } from 'vitest';
import { layoutScore } from '../layout/index.js';
import {
	createAccidentalShowcaseScore,
	createArticulationShowcaseScore,
	createBarlineShowcaseScore,
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
import { assertScoresEquivalent, buildScore, validateMeasure, type Score } from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { createImportDiagnostics, importMusicXml } from './musicxml-import.js';
import { doc, n, onePart } from './test-helpers.js';

const rest = (duration: number, type: string) =>
	`<note><rest/><duration>${duration}</duration><voice>1</voice><type>${type}</type></note>`;

/** One part with `<attributes>` written out in full (for staves, clefs or
 *  meters `onePart` does not cover). */
function part(attributes: string, measures: readonly string[], name = 'Music'): string {
	const body = measures
		.map((inner, i) => `<measure number="${i + 1}">${i === 0 ? `<attributes>${attributes}</attributes>` : ''}${inner}</measure>`)
		.join('\n');
	return doc(`<part-list><score-part id="P1"><part-name>${name}</part-name></score-part></part-list>\n<part id="P1">${body}</part>`);
}

describe('importMusicXml: hand-written fixtures', () => {
	it('reads a one-part, single-staff score', () => {
		const xml = onePart([n('C', 4, 'quarter') + n('D', 4, 'quarter') + rest(4, 'quarter') + n('F', 4, 'quarter')], 4).replace(
			'<fifths>0</fifths>',
			'<fifths>2</fifths>'
		);
		const score = importMusicXml(xml.replace('<step>F</step>', '<step>F</step><alter>1</alter>'));
		expect(score.staves).toHaveLength(1);
		expect(score.keyFifths).toBe(2);
		expect(score.time).toEqual({ beats: 4, beatType: 4 });
		expect(score.staves[0]!.clef).toBe('treble');
		const notes = score.staves[0]!.measures[0]!.notes;
		expect(notes.map((note) => [note.value, note.durationWholes, note.isRest])).toEqual([
			['quarter', 0.25, false],
			['quarter', 0.25, false],
			['quarter', 0.25, true],
			['quarter', 0.25, false]
		]);
		expect(notes[0]!.pitch).toEqual({ step: 'C', alter: 0, octave: 5 });
		expect(notes[3]!.pitch).toEqual({ step: 'F', alter: 1, octave: 5 });
	});

	it('reads an SATB score: four staves, four clefs, named parts, a bracket group', () => {
		const voice = (id: string, clef: string) =>
			`<part id="${id}"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time>` +
			`<clef>${clef}</clef></attributes>${n('C', 4, 'whole')}</measure></part>`;
		const g2 = '<sign>G</sign><line>2</line>';
		const score = importMusicXml(
			doc(`<part-list>
				<part-group type="start" number="1"><group-symbol>bracket</group-symbol></part-group>
				${['Soprano', 'Alto', 'Tenor', 'Bass'].map((name, i) => `<score-part id="P${i + 1}"><part-name>${name}</part-name></score-part>`).join('')}
				<part-group type="stop" number="1"/>
			</part-list>
			${voice('P1', g2)}${voice('P2', g2)}${voice('P3', `${g2}<clef-octave-change>-1</clef-octave-change>`)}${voice('P4', '<sign>F</sign><line>4</line>')}`)
		);
		expect(score.staves.map((s) => s.clef)).toEqual(['treble', 'treble', 'treble8', 'bass']);
		expect(score.parts).toEqual([
			{ name: 'Soprano', staffIndices: [0] },
			{ name: 'Alto', staffIndices: [1] },
			{ name: 'Tenor', staffIndices: [2] },
			{ name: 'Bass', staffIndices: [3] },
			{ name: undefined, staffIndices: [0, 1, 2, 3] }
		]);
	});

	it('lands a mid-score key change on the right measure', () => {
		const score = importMusicXml(
			onePart([n('C', 4, 'whole'), `<attributes><key><fifths>3</fifths></key></attributes>${n('E', 4, 'whole')}`, n('G', 4, 'whole')], 1)
		);
		// Measure 0 matches the score-global key, so only measure 1 records a change.
		expect(score.staves[0]!.measures.map((m) => m.keyFifths)).toEqual([undefined, 3, undefined]);
		expect([0, 1, 2].map((m) => score.keyFifthsAt(m))).toEqual([0, 3, 3]);
	});

	it('links a tie that crosses a barline to the right pair', () => {
		const score = importMusicXml(
			onePart([
				n('C', 2, 'half') + n('G', 2, 'half', '<notations><tied type="start"/></notations>').replace('<voice>', '<tie type="start"/><voice>'),
				n('G', 2, 'half', '<notations><tied type="stop"/></notations>').replace('<voice>', '<tie type="stop"/><voice>') + n('C', 2, 'half')
			], 1)
		);
		const [m0, m1] = score.staves[0]!.measures;
		expect(m0!.notes[1]!.tiedToId).toBe(m1!.notes[0]!.id);
		expect(m0!.notes[0]!.tiedToId).toBeNull();
	});

	it('reads a triplet measure: ratio and reconstructed durations', () => {
		const tm = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
		const trip = (step: string, tuplet: string) => n(step, 1, 'eighth', `${tm}<notations><tuplet type="${tuplet}" number="1"/></notations>`);
		const score = importMusicXml(
			onePart([trip('C', 'start') + ['D', 'E', 'F', 'G'].map((s) => n(s, 1, 'eighth', tm)).join('') + trip('A', 'stop') + n('C', 6, 'half')], 3)
		);
		const notes = score.staves[0]!.measures[0]!.notes;
		expect(notes.slice(0, 6).every((note) => note.tuplet?.actualNotes === 3 && note.tuplet.normalNotes === 2)).toBe(true);
		expect(notes[0]!.durationWholes).toBeCloseTo(1 / 12, 9);
		expect(notes[6]!.tuplet).toBeNull();
		expect(notes[6]!.durationWholes).toBeCloseTo(1 / 2, 9);
	});
});

describe('importMusicXml: round-trips every showcase score', () => {
	const showcases: Record<string, () => Score> = {
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
		createChordShowcaseScore,
		createArticulationShowcaseScore,
		createFullDemoScore
	};

	it.each(Object.entries(showcases))('%s survives export -> import', (_name, make) => {
		const original = make();
		const xml = exportMusicXml(original);
		const reimported = importMusicXml(xml);
		assertScoresEquivalent(reimported, original);
		expect(exportMusicXml(reimported)).toBe(xml);
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
	const q = (staff?: number) => n('C', 1, 'quarter', '', { octave: 4, staff });
	const clef = (sign: string, line: number, number = 1) =>
		`<attributes><clef number="${number}"><sign>${sign}</sign><line>${line}</line></clef></attributes>`;
	const base = '<divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>';
	const bass = (number = 1) => `<clef number="${number}"><sign>F</sign><line>4</line></clef>`;

	it('maps <sign>C</sign> line 3 to alto and line 4 to tenor, and still falls back for C1/C2/C5', () => {
		const diagnostics = createImportDiagnostics();
		const bar = q().repeat(4);
		const score = importMusicXml(part(base + bass(), [bar, clef('C', 4) + bar, clef('C', 3) + bar, clef('C', 1) + bar]), {
			diagnostics
		});
		expect([0, 1, 2, 3].map((m) => score.clefAt(m))).toEqual(['bass', 'tenor', 'alto', 'treble']);
		expect(diagnostics.fallbacks.map((f) => `${f.kind} m${f.measureNumber}: ${f.detail}`)).toEqual(['clef m4: sign C line 1']);
	});

	it('reads a clef between notes as a change at that onset, and one at the end as a change before the barline', () => {
		const diagnostics = createImportDiagnostics();
		const xml = part(base + bass(), [q().repeat(2) + clef('C', 4) + q().repeat(2) + clef('F', 4), q().repeat(4)]);
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
		const backup = '<backup><duration>4</duration></backup>';
		const xml = part(`${base}<staves>2</staves>${bass(1)}${bass(2)}`, [
			q().repeat(4) + backup + q(2).repeat(3) + clef('C', 4, 2) + q(2),
			q().repeat(4) + backup + q(2).repeat(4)
		]);
		const score = importMusicXml(xml);
		expect(score.staves[0]!.measures[0]!.clefChanges).toEqual([]);
		expect(score.staves[1]!.measures[0]!.clefChanges).toEqual([{ onset: 0.75, clef: 'tenor' }]);
		expect([score.clefAt(1, 0), score.clefAt(1, 1)]).toEqual(['bass', 'tenor']);
		assertScoresEquivalent(importMusicXml(exportMusicXml(score)), score);
	});

	it('keeps only the later of two clefs at one onset, tallying the earlier as dropped', () => {
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(part(base + bass(), [q().repeat(2) + clef('C', 4) + clef('C', 3) + q().repeat(2)]), { diagnostics });
		expect(score.measures[0]!.clefChanges).toEqual([{ onset: 0.5, clef: 'alto' }]);
		expect(diagnostics.dropped.get('clef')).toBe(1);
	});
});

describe('importMusicXml: malformed input', () => {
	it.each([
		['XML that is not well-formed', '<score-partwise><part-list>', undefined],
		['a root that is not <score-partwise>', '<not-a-score/>', /score-partwise/],
		['a timewise score', '<score-timewise version="4.0"><measure/></score-timewise>', /score-partwise/]
	])('throws on %s', (_what, xml, message) => {
		expect(() => importMusicXml(xml)).toThrow(message);
	});
});

describe('importMusicXml: part count (M6 Slice 1)', () => {
	// Brahms "Der Abend" once imported 5 <part>s as 7 `Part`s: the `Score`
	// constructor's seed part survived next to the file's own. A two-staff
	// <part> plus a bracket <part-group> is the Brahms shape (choir + piano).
	it('yields one Part per <part> (plus the bracket group), never the constructor seed', () => {
		const measure = (staves: string) =>
			`<measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time>${staves}</attributes>${rest(4, 'whole')}</measure>`;
		const score = importMusicXml(
			doc(`<part-list>
				<part-group type="start" number="1"><group-symbol>bracket</group-symbol></part-group>
				<score-part id="P1"><part-name>Choir</part-name></score-part>
				<part-group type="stop" number="1"/>
				<score-part id="P2"><part-name>Piano</part-name></score-part>
			</part-list>
			<part id="P1">${measure('')}</part><part id="P2">${measure('<staves>2</staves>')}</part>`)
		);
		expect(score.staves).toHaveLength(3);
		expect(score.parts).toEqual([
			{ name: 'Choir', staffIndices: [0] },
			{ name: 'Piano', staffIndices: [1, 2] },
			{ name: undefined, staffIndices: [0] }
		]);
	});

	it('gives an unnamed <part> its own Part too', () => {
		const p = (id: string) => `<part id="${id}"><measure number="1"><note><rest/><duration>4</duration><type>whole</type></note></measure></part>`;
		const score = importMusicXml(doc(`<part-list><score-part id="P1"/><score-part id="P2"/></part-list>${p('P1')}${p('P2')}`));
		expect(score.parts).toEqual([{ staffIndices: [0] }, { staffIndices: [1] }]);
	});
});

describe('importMusicXml: whole-measure rests (M6 Slice 1)', () => {
	// A `<rest measure="yes"/>` between two filled measures (so it is not a
	// system's first measure), with the `<type>whole</type>` OMR output
	// carries even when the bar is shorter.
	const cases = [
		{ time: '3/4', beats: 3, beatType: 4, divisions: 1, filler: n('C', 3, 'half', '<dot/>') },
		{ time: '2/2', beats: 2, beatType: 2, divisions: 1, filler: n('C', 4, 'whole') },
		{ time: '6/8', beats: 6, beatType: 8, divisions: 2, filler: n('C', 6, 'half', '<dot/>') }
	];
	const scoreWithMeasureRest = (c: (typeof cases)[number]) => {
		const duration = (c.beats / c.beatType) * 4 * c.divisions;
		return importMusicXml(
			part(
				`<divisions>${c.divisions}</divisions><time><beats>${c.beats}</beats><beat-type>${c.beatType}</beat-type></time><clef><sign>G</sign><line>2</line></clef>`,
				[c.filler, `<note><rest measure="yes"/><duration>${duration}</duration><voice>1</voice><type>whole</type></note>`, c.filler]
			)
		);
	};

	it.each(cases)('fills a $time measure, validates, plays for the bar and round-trips', (c) => {
		const score = scoreWithMeasureRest(c);
		const measure = score.staves[0]!.measures[1]!;
		expect(measure.notes).toHaveLength(1);
		const restNote = measure.notes[0]!;
		expect([restNote.isRest, restNote.isMeasureRest, restNote.value]).toEqual([true, true, 'whole']);
		expect(restNote.durationWholes).toBeCloseTo(c.beats / c.beatType, 12);
		expect(validateMeasure(measure, score.timeAt(1)).valid).toBe(true);

		const xml = exportMusicXml(score);
		const written = xml.split('<note>')[2]!.split('</note>')[0]!;
		expect(written).toContain('<rest measure="yes"/>');
		expect(written).not.toContain('<type>');
		const reimported = importMusicXml(xml);
		assertScoresEquivalent(reimported, score);
		expect(reimported.staves[0]!.measures[1]!.notes[0]!.isMeasureRest).toBe(true);
	});

	it.each(cases)('lays a $time rest out as a whole-rest glyph centred in its measure', (c) => {
		const score = scoreWithMeasureRest(c);
		const layout = layoutScore(score);
		const laid = layout.measures.find((m) => m.staffIndex === 0 && m.index === 1)!;
		const restId = score.staves[0]!.measures[1]!.notes[0]!.id;
		const glyph = laid.ops.find((op) => op.kind === 'glyph' && op.noteId === restId);
		expect(glyph?.kind === 'glyph' && glyph.glyph).toBe('restWhole');
		// No header (not a system start, no changes), so the region's centre
		// is the bar's centre, give or take the barline's width.
		const box = laid.notes.find((note) => note.id === restId)!.bounds;
		const regionCentre = laid.region.x + laid.region.width / 2;
		expect(Math.abs(box.x + box.width / 2 - regionCentre)).toBeLessThan(layout.staffSpacePx * 0.5);
	});
});

describe('importMusicXml: no-<type> fallback (M6 Slice 1)', () => {
	const untyped = (step: string, duration: number) => `<note><pitch><step>${step}</step><octave>5</octave></pitch><duration>${duration}</duration></note>`;
	const oneMeasure = (notes: string) =>
		part('<divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time>', [notes]).replace('number="1"', 'number="7"');

	it('derives value and dots from <duration> when they map exactly', () => {
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(oneMeasure(untyped('C', 6) + untyped('D', 2) + untyped('E', 7) + untyped('F', 1)), { diagnostics });
		const measure = score.staves[0]!.measures[0]!;
		expect(measure.notes.map((note) => [note.value, note.dots])).toEqual([
			['quarter', 1],
			['eighth', 0],
			['quarter', 2],
			['16th', 0]
		]);
		expect(validateMeasure(measure, score.time).valid).toBe(true);
		expect(diagnostics.fallbacks).toEqual([]);
	});

	it('falls back to quarter only when unmappable, recording where, with no console noise', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(oneMeasure(untyped('C', 5)), { diagnostics });
		expect(score.staves[0]!.measures[0]!.notes[0]!.value).toBe('quarter');
		expect(diagnostics.fallbacks).toEqual([
			{ kind: 'note-value', partId: 'P1', measureNumber: '7', detail: 'duration 5 at divisions 4' }
		]);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('importMusicXml: drop and passthrough diagnostics (M6 Slices 1, 3)', () => {
	afterEach(() => vi.restoreAllMocks());

	const xml = onePart(
		[
			'<attributes><key><fifths>0</fifths><mode>major</mode></key><staff-details/></attributes>' +
				'<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><sound tempo="90"/></direction>' +
				'<direction><direction-type><dynamics><p/></dynamics></direction-type><sound dynamics="54"/></direction>' +
				'<direction><direction-type><wedge type="crescendo"/></direction-type></direction>' +
				'<note><grace/><pitch><step>D</step><octave>5</octave></pitch><type>eighth</type></note>' +
				n('C', 2, 'half', '<stem>up</stem><notations><articulations><staccato/></articulations><fermata/><slur type="start"/></notations><lyric><text>la</text></lyric>') +
				n('E', 2, 'half', '', { chord: true }) +
				n('D', 2, 'half', '<notations><slur type="stop"/></notations>') +
				'<florble/><print new-system="yes"/><florble reason="again"/>' +
				'<barline location="right"><bar-style>light-heavy</bar-style><ending number="1" type="stop"/></barline>'
		],
		1,
		'<score-instrument id="I1"/>'
	).replace('<part-list>', '<work><work-title>T</work-title></work><part-list>');

	it('tallies passthrough and genuine drops per element name and keeps the console quiet', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const diagnostics = createImportDiagnostics();
		importMusicXml(xml, { diagnostics });
		const sorted = (map: Map<string, number>): Record<string, number> =>
			Object.fromEntries([...map].sort(([x], [y]) => x.localeCompare(y)));
		// The only genuine loss is `<mode>`, a child of the modelled `<key>`.
		expect(sorted(diagnostics.dropped)).toEqual({ mode: 1 });
		// The tempo direction is export's own shape, so it is `Score.tempoBpm`;
		// the dynamic's `<sound>` stays payload, and the hairpin start has no
		// stop to pair with.
		expect(sorted(diagnostics.passthrough)).toEqual({
			ending: 1,
			florble: 2,
			print: 1,
			'score-instrument': 1,
			sound: 1,
			'staff-details': 1,
			wedge: 1,
			work: 1
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it('without diagnostics, warns once on a truly unknown element and stays quiet on known ones', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const score = importMusicXml(xml);
		expect(score.staves[0]!.measures[0]!.notes.filter((note) => !note.isGrace).map((note) => note.pitch?.step)).toEqual(['C', 'E', 'D']);
		const messages = warn.mock.calls.map((call) => String(call[0]));
		expect(messages.filter((m) => m.includes('florble'))).toHaveLength(1);
		for (const quiet of ['lyric', 'grace', 'articulations', 'direction', 'dynamics', 'staccato', 'wedge', 'print']) {
			expect(messages.some((m) => m.includes(quiet))).toBe(false);
		}
	});
});

describe('importMusicXml: chords (M6 Slice 2)', () => {
	it('reads <chord/> notes as chord members of the previous note', () => {
		const score = importMusicXml(
			onePart([n('C', 2, 'half') + n('E', 2, 'half', '', { chord: true }) + n('G', 2, 'half', '', { chord: true }) + n('A', 2, 'half')], 1)
		);
		const measure = score.staves[0]!.measures[0]!;
		expect(measure.notes.map((note) => note.chordWithPrevious)).toEqual([false, true, true, false]);
		expect(validateMeasure(measure, score.timeAt(0)).valid).toBe(true);
	});

	it('drops and tallies a <chord/> note with no pitched note to join', () => {
		const diagnostics = createImportDiagnostics();
		const score = importMusicXml(onePart([rest(4, 'whole') + n('E', 4, 'whole', '', { chord: true })], 1), { diagnostics });
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
		// One <chord/> per member, one full-measure <backup> per measure: the
		// members never moved the cursor.
		expect(xml.match(/<chord\/>/g)).toHaveLength(4 + 2 + 1 + 2);
		expect(xml.match(/<backup>/g)).toHaveLength(2);
		const reimported = importMusicXml(xml);
		assertScoresEquivalent(reimported, original);
		for (const measure of reimported.staves[0]!.measures) {
			expect(validateMeasure(measure, reimported.timeAt(measure.index)).valid).toBe(true);
		}
	});
});
