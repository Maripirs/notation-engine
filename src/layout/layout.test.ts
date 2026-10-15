import { describe, expect, it } from 'vitest';
import {
	createAccidentalShowcaseScore,
	createBarlineShowcaseScore,
	createChordShowcaseScore,
	createClefShowcaseScore,
	createCrossStaffBeamShowcaseScore,
	createDemoScore,
	createDurationShowcaseScore,
	createGrandStaffShowcaseScore,
	createKeyTimeChangeShowcaseScore,
	createSatbBracketShowcaseScore,
	createSlurShowcaseScore,
	createTieShowcaseScore,
	createTwoVoiceShowcaseScore,
	createVoiceClashShowcaseScore
} from '../demo-score.js';
import { parsePitch } from '../model/pitch.js';
import {
	buildScore,
	type ClefType,
	type MeasureBuildSpec,
	type MeasureSpec,
	type NoteValue,
	type Score,
	TRIPLET,
	validateMeasure
} from '../model/score.js';
import { ENGRAVING_DEFAULTS as ED, GLYPH_METRICS } from '../render/glyph-metrics.js';
import type { GlyphName } from '../render/glyph-metrics.js';
import { layoutScore, relayoutMeasure } from './layout.js';
import { glyphOps, measureAt, SS, twoStaffScore, type CurveOp, type GlyphOp, type RectOp } from './test-helpers.js';
import type { DrawOp, LaidOutMeasure, LaidOutScore } from './types.js';

const NOTE_VALUES: readonly NoteValue[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];
const OPTS = { staffSpacePx: SS };
/** The demo score casts off into systems [0, 1] and [2, 3] at this width. */
const NARROW = { staffSpacePx: 11, systemWidthPx: 700 };

/** Glyph names an ops list draws, in order. */
const glyphsOf = (ops: readonly DrawOp[]) => ops.flatMap((op) => (op.kind === 'glyph' ? [op.glyph] : []));
const countOf = (ops: readonly DrawOp[], name: GlyphName) => glyphsOf(ops).filter((g) => g === name).length;
const hasFlag = (ops: readonly DrawOp[]) => glyphsOf(ops).some((g) => g.startsWith('flag'));
const findGlyph = (ops: readonly DrawOp[], name: GlyphName) =>
	ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.glyph === name);
const findCurve = (ops: readonly DrawOp[]) => ops.find((op): op is CurveOp => op.kind === 'curve');
const curvesOf = (ops: readonly DrawOp[]) => ops.filter((op) => op.kind === 'curve');
const rectsOf = (ops: readonly DrawOp[]) => ops.filter((op): op is RectOp => op.kind === 'rect');

// At `SS`, each kind of rect has a thickness nothing else shares, so these
// identify stems, beams, ledger lines and barlines without knowing positions.
const stemRects = (ops: readonly DrawOp[]) => rectsOf(ops).filter((op) => Math.abs(op.width - ED.stemThickness * SS) < 0.001);
const beamRects = (ops: readonly DrawOp[]) => rectsOf(ops).filter((op) => Math.abs(op.height - ED.beamThickness * SS) < 0.001);
const ledgerRects = (ops: readonly DrawOp[]) =>
	rectsOf(ops).filter((op) => Math.abs(op.height - ED.legerLineThickness * SS) < 0.001);
const barlineRects = (ops: readonly DrawOp[]) => rectsOf(ops).filter((op) => Math.abs(op.height - 4 * SS) < 0.001);
const noteheadYs = (ops: readonly DrawOp[]) => glyphOps(ops, 'noteheadBlack').map((op) => op.y);

const lay = (measures: readonly (MeasureSpec | MeasureBuildSpec)[], keyFifths = 0) =>
	layoutScore(buildScore(measures, { keyFifths }), OPTS);
const overlaps = (a: { x: number; width: number }, b: { x: number; width: number }) =>
	a.x < b.x + b.width && b.x < a.x + a.width;
const noteX = (score: Score, measure: LaidOutMeasure, index: number) =>
	measure.notes.find((n) => n.id === score.measures[0]!.notes[index]!.id)!.bounds.x;
const noteheadWidth = GLYPH_METRICS.noteheadBlack.advance * SS;

/** Asserts every curve in `measure` stays within its region vertically. */
function expectCurvesInside(measure: LaidOutMeasure) {
	for (const curve of measure.ops.filter((op): op is CurveOp => op.kind === 'curve')) {
		for (const y of [curve.y0, curve.cy0, curve.cy1, curve.y1]) {
			expect(y).toBeGreaterThanOrEqual(measure.region.y - 0.001);
			expect(y).toBeLessThanOrEqual(measure.region.y + measure.region.height + 0.001);
		}
	}
}

describe('demo showcases', () => {
	it.each([
		['duration', createDurationShowcaseScore],
		['accidental', createAccidentalShowcaseScore],
		['tie', createTieShowcaseScore],
		['slur', createSlurShowcaseScore],
		['key/time change', createKeyTimeChangeShowcaseScore],
		['barline', createBarlineShowcaseScore],
		['two-voice', createTwoVoiceShowcaseScore],
		['clef', createClefShowcaseScore],
		['grand staff', createGrandStaffShowcaseScore],
		['SATB bracket', createSatbBracketShowcaseScore],
		['cross-staff beam', createCrossStaffBeamShowcaseScore],
		['chord', createChordShowcaseScore]
	])('%s showcase: every measure fills its time signature and the score lays out', (_name, create) => {
		const score = create();
		for (const staff of score.staves) {
			for (const measure of staff.measures) {
				expect(validateMeasure(measure, score.timeAt(measure.index, measure.staffIndex)).valid).toBe(true);
			}
		}
		expect(() => layoutScore(score)).not.toThrow();
	});

	it("voice-clash showcase lays out (its second measure's voice 2 is deliberately short)", () => {
		expect(() => layoutScore(createVoiceClashShowcaseScore())).not.toThrow();
	});
});

describe('layoutScore', () => {
	it('lays every note out and keeps ids addressable', () => {
		const ids = layoutScore(createDemoScore()).measures.flatMap((m) => m.notes.map((n) => n.id));
		expect(ids).toHaveLength(13);
		expect(new Set(ids).size).toBe(13);
	});

	it('gives measures disjoint horizontal bands and keeps every drawn pixel inside its own', () => {
		// The precondition that makes region-scoped redraw safe at all.
		const layout = layoutScore(createDemoScore());
		for (let i = 1; i < layout.measures.length; i++) {
			expect(overlaps(layout.measures[i - 1]!.region, layout.measures[i]!.region)).toBe(false);
		}
		for (const { ops, notes, region } of layout.measures) {
			for (const op of ops.filter((o) => o.kind === 'rect' || o.kind === 'glyph')) {
				expect(op.x).toBeGreaterThanOrEqual(region.x - 0.001);
				expect(op.y).toBeGreaterThanOrEqual(region.y - 0.001);
				expect(op.y).toBeLessThanOrEqual(region.y + region.height + 0.001);
			}
			for (const note of notes) {
				expect(note.bounds.x).toBeGreaterThanOrEqual(region.x - 0.001);
				expect(note.bounds.x + note.bounds.width).toBeLessThanOrEqual(region.x + region.width + 0.001);
			}
		}
	});

	it('gives every measure its own staff lines', () => {
		const layout = layoutScore(createDemoScore());
		for (const measure of layout.measures) {
			const lines = rectsOf(measure.ops).filter((op) => Math.abs(op.width - measure.region.width) < 0.001);
			expect(lines).toHaveLength(5);
		}
	});

	it('draws ledger lines only for notes off the staff', () => {
		expect(ledgerRects(lay([[['B4', 'quarter']]]).measures[0]!.ops)).toHaveLength(0);
		expect(ledgerRects(lay([[['C4', 'quarter']]]).measures[0]!.ops)).toHaveLength(1);
	});

	it('states clef, key and time in the first measure; a later system repeats clef and key only', () => {
		// Header glyphs belong to a measure so clearing its region and redrawing
		// its ops puts them back.
		const layout = layoutScore(createDemoScore(), NARROW);
		const [first, mid, systemStart] = [0, 1, 2].map((i) => glyphsOf(layout.measures[i]!.ops));
		expect(first).toEqual(expect.arrayContaining(['gClef', 'accidentalSharp', 'timeSig4']));
		expect(systemStart).toEqual(expect.arrayContaining(['gClef', 'accidentalSharp']));
		expect(systemStart).not.toContain('timeSig4');
		expect(mid).not.toContain('gClef');
	});
});

describe('relayoutMeasure', () => {
	it('rebuilds one measure in place and leaves the others as the same objects', () => {
		const score = createDemoScore();
		const layout = layoutScore(score);
		score.transposeNote(score.measures[1]!.notes[0]!.id, 1);
		const updated = relayoutMeasure(score, layout, 1)!;
		expect(updated).not.toBeNull();
		for (const index of [0, 2, 3]) expect(updated.measures[index]).toBe(layout.measures[index]);
		expect(updated.measures[1]).not.toBe(layout.measures[1]);
		const before = layout.measures[1]!.region;
		const after = updated.measures[1]!.region;
		for (const key of ['x', 'y', 'width', 'height'] as const) expect(after[key]).toBeCloseTo(before[key], 6);
	});

	it.each([
		['moves the rest of the system (a width change)', (score: Score) => (score.measures[1]!.notes[0]!.value = 'whole')],
		[
			'overflows the canvas vertically',
			(score: Score) => {
				for (let i = 0; i < 24; i++) score.transposeNote(score.measures[1]!.notes[0]!.id, 1);
			}
		]
	])('refuses when the edit %s', (_name, edit) => {
		const score = createDemoScore();
		const layout = layoutScore(score);
		edit(score);
		expect(relayoutMeasure(score, layout, 1)).toBeNull();
	});

	it('redraws a measure opening a later system, keeping its clef and key signature', () => {
		const score = createDemoScore();
		const layout = layoutScore(score, NARROW);
		expect(layout.systems[1]!.measureIndices).toEqual([2, 3]);
		score.transposeNote(score.measures[2]!.notes[0]!.id, 1);
		const updated = relayoutMeasure(score, layout, 2, NARROW)!;
		for (const index of [0, 1, 3]) expect(updated.measures[index]).toBe(layout.measures[index]);
		expect(glyphsOf(updated.measures[2]!.ops)).toEqual(expect.arrayContaining(['gClef', 'accidentalSharp']));
	});

	it("never touches another staff's measures, even when staff-local indices collide", () => {
		const score = twoStaffScore();
		const layout = layoutScore(score);
		const touched = score.transposeNote(score.staves[1]!.measures[1]!.notes[0]!.id, 1);
		expect(touched).toBe(1);
		const updated = relayoutMeasure(score, layout, touched!, {}, 1)!;
		expect(updated).not.toBeNull();
		for (const m of updated.measures) {
			const before = measureAt(layout, m.staffIndex, m.index);
			if (m.staffIndex === 1 && m.index === 1) expect(m).not.toBe(before);
			else expect(m).toBe(before);
		}
	});
});

describe('systems and spacing', () => {
	it('casts off onto stacked systems at the same left margin, never past the width budget', () => {
		const layout = layoutScore(createDemoScore(), NARROW);
		expect(layout.systems.map((s) => s.measureIndices)).toEqual([
			[0, 1],
			[2, 3]
		]);
		expect(layout.measures[2]!.region.x).toBeCloseTo(layout.measures[0]!.region.x, 6);
		expect(layout.systems[1]!.topY).toBeGreaterThan(layout.systems[0]!.topY);
		for (const measure of layout.measures) expect(measure.region.width).toBeLessThanOrEqual(NARROW.systemWidthPx);
	});

	it('justifies every system but the last to fill systemWidthPx', () => {
		const layout = layoutScore(createDemoScore(), NARROW);
		expect(layout.systems[0]!.spacingScale).toBeGreaterThan(1);
		expect(layout.systems[1]!.spacingScale).toBe(1);
		expect(layout.width).toBeCloseTo(NARROW.systemWidthPx, 1);
		const span = (system: number) => {
			const ms = layout.measures.filter((m) => layout.systems[system]!.measureIndices.includes(m.index));
			const left = Math.min(...ms.map((m) => m.region.x));
			return { left, width: Math.max(...ms.map((m) => m.region.x + m.region.width)) - left };
		};
		expect(span(0).width).toBeCloseTo(NARROW.systemWidthPx - 2 * span(0).left, 1);
		expect(span(1).width).toBeLessThan(span(0).width);
	});

	it.each([
		['fits within systemWidthPx', { staffSpacePx: 11, systemWidthPx: 2000 }],
		['omits systemWidthPx', { staffSpacePx: 11 }]
	])('lays out as one unjustified system when the score %s', (_name, options) => {
		const layout = layoutScore(createDemoScore(), options);
		const single = layoutScore(createDemoScore(), { staffSpacePx: 11 });
		expect(layout.systems.map((s) => s.measureIndices)).toEqual([[0, 1, 2, 3]]);
		expect(layout.systems[0]!.spacingScale).toBe(1);
		expect(layout.width).toBeCloseTo(single.width, 6);
		for (let i = 0; i < single.measures.length; i++) expect(layout.measures[i]!.region).toEqual(single.measures[i]!.region);
	});

	it('gives longer notes more room, growing sub-linearly with duration', () => {
		// A second note's own advance: the width difference between one and two notes.
		const advance = (value: NoteValue) => lay([[['C4', value], ['C4', value]]]).measures[0]!.region.width - lay([[['C4', value]]]).measures[0]!.region.width;
		const advances = NOTE_VALUES.map(advance);
		for (let i = 1; i < advances.length; i++) expect(advances[i]!).toBeLessThan(advances[i - 1]!);
		// A whole lasts 8 eighths but gets well under 4x the room.
		expect(advances[0]!).toBeLessThan(advances[3]! * 4);
	});

	it.each(NOTE_VALUES)('gives a triplet %s less room than a plain one', (value) => {
		// Holds even for a 64th: the spacing curve does not clamp below its reference duration.
		const straight = lay([[['C4', value]]]);
		const triplet = lay([[['C4', value, { tuplet: TRIPLET }]]]);
		expect(triplet.measures[0]!.region.width).toBeLessThan(straight.measures[0]!.region.width);
	});
});

describe('duration rendering', () => {
	const NOTEHEAD_FOR: Readonly<Record<NoteValue, GlyphName>> = {
		whole: 'noteheadWhole',
		half: 'noteheadHalf',
		quarter: 'noteheadBlack',
		eighth: 'noteheadBlack',
		'16th': 'noteheadBlack',
		'32nd': 'noteheadBlack',
		'64th': 'noteheadBlack'
	};
	const REST_FOR: Readonly<Record<NoteValue, GlyphName>> = {
		whole: 'restWhole',
		half: 'restHalf',
		quarter: 'restQuarter',
		eighth: 'rest8th',
		'16th': 'rest16th',
		'32nd': 'rest32nd',
		'64th': 'rest64th'
	};
	// C4 stems up, so any flag is an Up flag.
	const FLAG_UP_FOR: Readonly<Partial<Record<NoteValue, string>>> = {
		eighth: 'flag8thUp',
		'16th': 'flag16thUp',
		'32nd': 'flag32ndUp',
		'64th': 'flag64thUp'
	};

	it.each(NOTE_VALUES)('draws the %s notehead, its flag if any, and its rest', (value) => {
		const glyphs = glyphsOf(lay([[['C4', value]]]).measures[0]!.ops);
		expect(glyphs).toContain(NOTEHEAD_FOR[value]);
		const flag = FLAG_UP_FOR[value];
		if (flag) expect(glyphs).toContain(flag);
		else expect(glyphs.some((g) => g.startsWith('flag'))).toBe(false);
		expect(glyphsOf(lay([[[null, value]]]).measures[0]!.ops)).toContain(REST_FOR[value]);
	});

	it.each([
		['C4', 'quarter', 1],
		['C4', 'eighth', 2],
		['C4', 'whole', 2],
		[null, 'quarter', 1]
	] as const)('draws augmentation dots for %s %s with %i dot(s)', (pitch, value, dots) => {
		expect(countOf(lay([[[pitch, value, { dots }]]]).measures[0]!.ops, 'augmentationDot')).toBe(dots);
	});

	it('nudges a dot into the space above when its note sits on a line', () => {
		const dotAndHead = (pitch: string) => {
			const ops = lay([[[pitch, 'quarter', { dots: 1 }]]]).measures[0]!.ops;
			return { dot: findGlyph(ops, 'augmentationDot')!.y, head: findGlyph(ops, 'noteheadBlack')!.y };
		};
		const onLine = dotAndHead('B4');
		expect(onLine.dot).toBeLessThan(onLine.head);
		const inSpace = dotAndHead('D4');
		expect(inSpace.dot).toBeCloseTo(inSpace.head, 6);
	});
});

describe('beaming', () => {
	// Pitches stay on the staff and in C major, so no ledger or accidental ink.
	it.each([
		['beams two eighths sharing a 4/4 beat', [['D4', 'eighth'], ['E4', 'eighth']], 4, 0, 2, 1],
		[
			'does not beam two eighths split by a beat boundary, even with no rest between them',
			[[null, 'quarter'], [null, 'eighth', { dots: 1 }], ['D4', 'eighth'], ['E4', 'eighth']],
			4,
			2,
			2,
			0
		],
		[
			'groups six eighths by the dotted-quarter beat in 6/8',
			[['D4', 'eighth'], ['E4', 'eighth'], ['F4', 'eighth'], ['G4', 'eighth'], ['A4', 'eighth'], ['B4', 'eighth']],
			6,
			0,
			6,
			2
		],
		[
			'breaks a group at a rest, leaving a flagged singleton',
			[['D4', 'eighth'], ['E4', 'eighth'], [null, 'eighth'], ['F4', 'eighth'], ['G4', 'quarter'], ['A4', 'quarter']],
			4,
			1,
			5,
			1
		],
		['adds a secondary beam over just the 16ths of an eighth-16th-16th group', [['D4', 'eighth'], ['E4', '16th'], ['F4', '16th']], 4, 0, 3, 2]
	] as const)('%s', (_name, notes, beats, flags, stems, beams) => {
		const time = beats === 6 ? { beats: 6, beatType: 8 } : { beats: 4, beatType: 4 };
		const ops = layoutScore(buildScore([notes as MeasureSpec], { time }), OPTS).measures[0]!.ops;
		expect(glyphsOf(ops).filter((g) => g.startsWith('flag'))).toHaveLength(flags);
		expect(stemRects(ops)).toHaveLength(stems);
		expect(beamRects(ops)).toHaveLength(beams);
	});

	it('groups beams by the new time signature after a mid-score change', () => {
		const sixEighths: MeasureSpec = ['D4', 'E4', 'F4', 'G4', 'A4', 'B4'].map((p) => [p, 'eighth'] as const);
		const layout = layoutScore(buildScore([sixEighths, { notes: sixEighths, time: { beats: 6, beatType: 8 } }]), OPTS);
		expect(beamRects(layout.measures[0]!.ops)).toHaveLength(3);
		expect(beamRects(layout.measures[1]!.ops)).toHaveLength(2);
	});
});

describe('stem direction', () => {
	it.each([
		['C4', 'Up'],
		['E4', 'Up'],
		['A4', 'Up'],
		['B4', 'Down'], // on the middle line: this engine's tie-break
		['C5', 'Down'],
		['F5', 'Down'],
		['A5', 'Down']
	])('gives a lone %s an %s-stem', (pitch, direction) => {
		expect(glyphsOf(lay([[[pitch, 'eighth']]]).measures[0]!.ops)).toContain(`flag8th${direction}`);
	});

	it.each([
		// G4s alone would stem up; E5 is the farthest note and wins.
		['the farthest note over the average', ['G4', 'G4', 'E5'], 'down'],
		// G4 and D5 tie for farthest; A4 tips the majority below.
		['a farthest-note tie by majority', ['G4', 'A4', 'D5'], 'up'],
		// Farthest and majority both tie: the on-the-line convention, down.
		['the down-stem convention when everything ties', ['G4', 'D5'], 'down']
	] as const)('picks a beamed group direction by %s', (_name, pitches, direction) => {
		// 6/8 keeps three eighths in one beam group.
		const score = buildScore([pitches.map((p) => [p, 'eighth'] as const)], { time: { beats: 6, beatType: 8 } });
		const ops = layoutScore(score, OPTS).measures[0]!.ops;
		const stems = stemRects(ops);
		expect(stems).toHaveLength(pitches.length);
		const beamSide = stems.map((s) => (direction === 'up' ? s.y : s.y + s.height));
		for (const y of beamSide) expect(y).toBeCloseTo(beamSide[0]!, 6);
		if (direction === 'up') expect(beamSide[0]).toBeLessThan(Math.min(...noteheadYs(ops)));
		else expect(beamSide[0]).toBeGreaterThan(Math.max(...noteheadYs(ops)));
	});
});

describe('accidentals', () => {
	it.each([
		['omits a sharp the key already implies', 1, [[['F#5', 'quarter']]], [1], [0]],
		['draws a natural against the key', 1, [[['F5', 'quarter']]], [1], [1]],
		['suppresses a repeated accidental later in the measure', 0, [[['F#5', 'quarter'], ['G4', 'quarter'], ['F#5', 'quarter']]], [1], [0]],
		['redraws whenever the alter changes, even back', 0, [[['F#5', 'quarter'], ['F5', 'quarter'], ['F#5', 'quarter']]], [2], [1]],
		['resets the carry-over at the barline', 0, [[['F#5', 'quarter']], [['F#5', 'quarter']]], [1, 1], [0, 0]]
	] as const)('%s', (_name, keyFifths, measures, sharps, naturals) => {
		// Counts include the key signature's own glyphs.
		const layout = lay(measures as unknown as MeasureSpec[], keyFifths);
		expect(layout.measures.map((m) => countOf(m.ops, 'accidentalSharp'))).toEqual(sharps);
		expect(layout.measures.map((m) => countOf(m.ops, 'accidentalNatural'))).toEqual(naturals);
	});

	it.each([
		// C4 64th's ledger line is wider than its own advance: without clearance
		// the next note's sharp would overlap it.
		['the previous note in its voice', [['C4', '64th'], ['C#4', '64th']]],
		// A stemless whole C4 in voice 1; voice 2's C#5 at the same onset is far
		// from a second, so only the accidental clearance path engages.
		['another voice at the same onset', [['C4', 'whole', { voice: 1 }], ['C#5', 'quarter', { voice: 2 }]]]
	] as const)("pushes an accidental exactly the minimum clearance past %s's ledger line", (_name, notes) => {
		const ops = lay([notes as unknown as MeasureSpec]).measures[0]!.ops;
		const ledger = ledgerRects(ops).sort((a, b) => a.x - b.x)[0]!;
		expect(findGlyph(ops, 'accidentalSharp')!.x - (ledger.x + ledger.width)).toBeCloseTo(0.9 * SS, 5);
	});
});

describe('ties and slurs', () => {
	const slurred = (notes: MeasureSpec, end = 3) => buildScore([notes], {}, [{ start: [0, 0], end: [0, end] }]);
	const run = (pitches: readonly string[]): MeasureSpec => [...pitches.map((p) => [p, 'eighth'] as const), [null, 'half']];

	it('draws one level curve for a tie within a measure', () => {
		const ops = lay([[['C4', 'quarter', { tiedToNext: true }], ['C4', 'quarter'], ['D4', 'half']]]).measures[0]!.ops;
		expect(curvesOf(ops)).toHaveLength(1);
		const curve = findCurve(ops)!;
		expect(curve.y0).toBeCloseTo(curve.y1, 6);
		expect(curve.x0).toBeLessThan(curve.x1);
	});

	it('starts and ends a slur clear of its first and last noteheads', () => {
		const layout = layoutScore(slurred(run(['G4', 'A4', 'B4', 'C5'])));
		const { ops, notes } = layout.measures[0]!;
		expect(curvesOf(ops)).toHaveLength(1);
		const curve = findCurve(ops)!;
		expect(curve.x0).toBeGreaterThan(notes[0]!.bounds.x + notes[0]!.bounds.width);
		expect(curve.x1).toBeLessThan(notes[3]!.bounds.x);
	});

	it.each([
		['a tie on a stem-up note curves below', buildScore([[['C4', 'quarter', { tiedToNext: true }], ['C4', 'quarter']]]), 'below'],
		['a tie on a stem-down note curves above', buildScore([[['A5', 'quarter', { tiedToNext: true }], ['A5', 'quarter']]]), 'above'],
		['a slur over notes mostly below the middle line curves below', slurred(run(['G4', 'A4', 'B4', 'C5'])), 'below'],
		['a slur over notes mostly above the middle line curves above', slurred(run(['C5', 'D5', 'E5', 'G5'])), 'above']
	] as const)('%s, inside its own measure region', (_name, score, side) => {
		const measure = layoutScore(score).measures[0]!;
		const curve = findCurve(measure.ops)!;
		if (side === 'below') expect(Math.min(curve.cy0 - curve.y0, curve.cy1 - curve.y1)).toBeGreaterThan(0);
		else expect(Math.max(curve.cy0 - curve.y0, curve.cy1 - curve.y1)).toBeLessThan(0);
		expectCurvesInside(measure);
	});

	it('splits a tie across a barline into two halves that meet at one height, each in its own measure', () => {
		const layout = layoutScore(buildScore([[['C4', 'half'], ['C4', 'half', { tiedToNext: true }]], [['C4', 'whole']]]));
		const [first, second] = layout.measures;
		expect(curvesOf(first!.ops)).toHaveLength(1);
		expect(curvesOf(second!.ops)).toHaveLength(1);
		const outgoing = findCurve(first!.ops)!;
		const incoming = findCurve(second!.ops)!;
		expect(outgoing.x1).toBeLessThanOrEqual(first!.region.x + first!.region.width + 0.001);
		expect(incoming.x0).toBeGreaterThanOrEqual(second!.region.x - 0.001);
		expect(outgoing.y0).toBeCloseTo(incoming.y1, 6);
	});

	it('splits a slur across barlines at one roof height, with a flat pass-through in a middle measure', () => {
		const q = (pitches: string[]): MeasureSpec => pitches.map((p) => [p, 'quarter'] as const);
		const score = buildScore(
			[q(['C4', 'D4', 'E4', 'F4']), q(['G4', 'A4', 'B4', 'C5']), q(['D5', 'E5', 'F5', 'G5'])],
			{},
			[{ start: [0, 3], end: [2, 1] }]
		);
		const [m0, m1, m2] = layoutScore(score).measures;
		for (const m of [m0!, m1!, m2!]) expect(curvesOf(m.ops)).toHaveLength(1);
		const [outgoing, middle, incoming] = [m0!, m1!, m2!].map((m) => findCurve(m.ops)!);
		expect(outgoing!.x1).toBeLessThanOrEqual(m0!.region.x + m0!.region.width + 0.001);
		expect(incoming!.x0).toBeGreaterThanOrEqual(m2!.region.x - 0.001);
		expect(middle!.x0).toBeCloseTo(m1!.region.x, 6);
		expect(middle!.y0).toBeCloseTo(middle!.y1, 6);
		expect(outgoing!.y1).toBeCloseTo(middle!.y0, 6);
		expect(middle!.y1).toBeCloseTo(incoming!.y0, 6);
	});

	it.each([
		['a tie', buildScore([[['C4', 'quarter', { tiedToNext: true }], ['C4', 'quarter'], ['D4', 'quarter'], ['E4', 'quarter']]])],
		['a slur', slurred([['G4', 'eighth'], ['A4', 'eighth'], ['B4', 'eighth'], ['C5', 'eighth'], ['D5', 'quarter'], ['E4', 'quarter']])]
	])('keeps %s through a scoped relayout of its measure', (_name, score) => {
		const layout = layoutScore(score);
		const last = score.measures[0]!.notes.at(-1)!;
		const updated = relayoutMeasure(score, layout, score.transposeNote(last.id, 1)!);
		expect(updated).not.toBeNull();
		expect(curvesOf(updated!.measures[0]!.ops)).toHaveLength(1);
	});

	it('draws a slur on a non-zero staff in that staff only', () => {
		const score = buildScore([[['C4', 'quarter']]]);
		score.appendStaff('bass');
		const measure = score.appendMeasure(1);
		const noteIds = ['C3', 'D3', 'E3', 'F3'].map((p) => score.appendNote(measure, { pitch: parsePitch(p), value: 'quarter' }).id);
		score.addSlur(noteIds[0]!, noteIds[3]!);
		const layout = layoutScore(score);
		expect(curvesOf(measureAt(layout, 1, 0).ops)).toHaveLength(1);
		expect(curvesOf(measureAt(layout, 0, 0).ops)).toHaveLength(0);
	});
});

describe('key and time changes', () => {
	const keyChange = (from: number, to: number, systemWidthPx?: number) =>
		layoutScore(
			buildScore([[['G4', 'half'], ['A4', 'half']], { notes: [['G4', 'half'], ['A4', 'half']], keyFifths: to }, [['G4', 'whole']]], {
				keyFifths: from
			}),
			{ staffSpacePx: 11, systemWidthPx }
		);

	it.each([
		['restates the whole new key, no clef', 1, 2, 2, 0],
		['cancels a dropped sharp with a natural', 1, 0, 0, 1],
		['cancels only the dropped sharp, keeping the shared one', 2, 1, 1, 1]
	])('at a key change it %s', (_name, from, to, sharps, naturals) => {
		const layout = keyChange(from, to);
		const ops = layout.measures[1]!.ops;
		expect(countOf(ops, 'accidentalSharp')).toBe(sharps);
		expect(countOf(ops, 'accidentalNatural')).toBe(naturals);
		expect(glyphsOf(ops)).not.toContain('gClef');
		// The next measure has no change of its own and restates nothing.
		expect(glyphsOf(layout.measures[2]!.ops)).toEqual(['noteheadWhole']);
	});

	it("shows the changed key and clef when the change opens a new system", () => {
		const layout = keyChange(1, 2, 1);
		expect(layout.systems[1]!.measureIndices).toEqual([1]);
		const glyphs = glyphsOf(layout.measures[1]!.ops);
		expect(glyphs).toContain('gClef');
		expect(glyphs.filter((g) => g === 'accidentalSharp')).toHaveLength(2);
	});

	it('draws the new time signature where the time changes', () => {
		const q = (n: number): MeasureSpec => ['C4', 'D4', 'E4', 'F4'].slice(0, n).map((p) => [p, 'quarter'] as const);
		const layout = layoutScore(buildScore([q(4), { notes: q(3), time: { beats: 3, beatType: 4 } }]));
		expect(glyphsOf(layout.measures[0]!.ops)).toContain('timeSig4');
		expect(glyphsOf(layout.measures[1]!.ops)).toEqual(expect.arrayContaining(['timeSig3', 'timeSig4']));
	});
});

describe('barline types', () => {
	const thin = ED.thinBarlineThickness * SS;
	const thick = ED.thickBarlineThickness * SS;
	const repeatDots = (ops: readonly DrawOp[]) => glyphOps(ops, 'repeatDot');
	const sortedBars = (ops: readonly DrawOp[]) => barlineRects(ops).sort((a, b) => a.x - b.x);

	it.each([
		['normal (mid-score default)', [[['G4', 'quarter']], [['G4', 'quarter']]], [thin]],
		['double', [{ notes: [['G4', 'quarter']], endBarline: 'double' }, [['G4', 'quarter']]], [thin, thin]],
		['final (automatic at the end)', [[['G4', 'quarter']]], [thin, thick]],
		['final (explicit)', [{ notes: [['G4', 'quarter']], endBarline: 'final' }], [thin, thick]],
		['double overriding the automatic final', [{ notes: [['G4', 'quarter']], endBarline: 'double' }], [thin, thin]]
	] as const)('draws a %s barline', (_name, measures, widths) => {
		const bars = sortedBars(lay(measures as unknown as MeasureBuildSpec[]).measures[0]!.ops);
		expect(bars.map((b) => b.width)).toEqual(widths.map((w) => expect.closeTo(w, 6)));
		if (bars.length === 2) expect(bars[1]!.x - (bars[0]!.x + bars[0]!.width)).toBeLessThan(SS);
	});

	it('draws a repeatEnd as two stacked dots then a thick line, even with no matching repeatStart', () => {
		const layout = lay([{ notes: [['G4', 'quarter']], endBarline: 'repeatEnd' }, [['G4', 'quarter']]]);
		const ops = layout.measures[0]!.ops;
		const bars = barlineRects(ops);
		expect(bars.map((b) => b.width)).toEqual([expect.closeTo(thick, 6)]);
		const dots = repeatDots(ops);
		expect(dots).toHaveLength(2);
		for (const dot of dots) expect(dot.x).toBeLessThan(bars[0]!.x);
		expect(dots[0]!.x).toBeCloseTo(dots[1]!.x, 6);
		// Straddling the middle line.
		const middleY = layout.staffTopY + 2 * SS;
		expect(Math.min(dots[0]!.y, dots[1]!.y)).toBeLessThan(middleY);
		expect(Math.max(dots[0]!.y, dots[1]!.y)).toBeGreaterThan(middleY);
	});

	it('draws a repeatStart as a thick line then dots at the left edge of the measure it opens', () => {
		const layout = lay([[['G4', 'quarter']], { notes: [['G4', 'quarter']], startBarline: 'repeatStart' }, [['G4', 'quarter']]]);
		// The boundary belongs to the measure that opens the repeat.
		expect(barlineRects(layout.measures[0]!.ops)).toHaveLength(0);
		const ops = layout.measures[1]!.ops;
		const [opening] = sortedBars(ops);
		expect(opening!.width).toBeCloseTo(thick, 6);
		expect(opening!.x).toBeCloseTo(layout.measures[1]!.region.x, 3);
		expect(repeatDots(ops)).toHaveLength(2);
		for (const dot of repeatDots(ops)) expect(dot.x).toBeGreaterThan(opening!.x);
	});
});

describe('two voices in one staff', () => {
	// Voice 1: two halves. Voice 2: four eighths then a half. Shared onset
	// columns at 0, 1/8, 1/4, 3/8 and 1/2.
	const halfAgainstEighths: MeasureSpec = [
		['D4', 'half', { voice: 1 }],
		['E4', 'half', { voice: 1 }],
		['C4', 'eighth', { voice: 2 }],
		['D4', 'eighth', { voice: 2 }],
		['E4', 'eighth', { voice: 2 }],
		['F4', 'eighth', { voice: 2 }],
		['G4', 'half', { voice: 2 }]
	];

	it('aligns two voices on a shared onset column', () => {
		const score = buildScore([halfAgainstEighths]);
		const measure = layoutScore(score, OPTS).measures[0]!;
		// Voice 2 carries a one-notehead clash nudge from onset 0 (D4 against
		// C4), so the two onset-1/2 notes differ by exactly that.
		expect(noteX(score, measure, 6) - noteX(score, measure, 1)).toBeCloseTo(noteheadWidth, 6);
	});

	it('sizes a shared column by the wider voice, not the sum', () => {
		const without = lay([halfAgainstEighths.slice(0, 6)]).measures[0]!.region.width;
		const withTail = lay([halfAgainstEighths]).measures[0]!.region.width;
		expect(withTail).toBeCloseTo(without, 6);
	});

	it("does not double-count both voices' advances when justifying a system", () => {
		const filler: MeasureSpec = [['C4', 'whole']];
		const score = buildScore([halfAgainstEighths, filler, filler, filler]);
		const natural = layoutScore(score, { staffSpacePx: SS, systemWidthPx: 5000 });
		expect(natural.systems[0]!.spacingScale).toBe(1);
		const naturalWidth = natural.measures[0]!.region.width;
		const layout = layoutScore(score, { staffSpacePx: SS, systemWidthPx: 500 });
		expect(layout.systems[0]!.measureIndices).toEqual([0]);
		// Shared columns sum to 7+5+5+5+7 = 29 spaces, not the 41 summing every
		// note would give. 16 is the default padding on each side.
		const expectedScale = 1 + (500 - 2 * 16 - naturalWidth) / (29 * SS);
		expect(layout.systems[0]!.spacingScale).toBeCloseTo(expectedScale, 6);
	});

	it('beams each voice independently, even when they interleave in the notes array', () => {
		const ops = lay([
			[
				['C4', 'eighth', { voice: 2 }],
				['G4', 'quarter', { voice: 1 }],
				['D4', 'eighth', { voice: 2 }],
				['A4', 'quarter', { voice: 1 }],
				['E4', 'eighth', { voice: 2 }],
				['F4', 'eighth', { voice: 2 }]
			]
		]).measures[0]!.ops;
		expect(hasFlag(ops)).toBe(false);
		expect(beamRects(ops)).toHaveLength(2);
		expect(stemRects(ops)).toHaveLength(6);
	});

	it('stems odd voices up and even voices down, against what pitch alone would pick', () => {
		const score = buildScore([
			[
				['C5', 'eighth', { voice: 1 }],
				['C4', 'eighth', { voice: 2 }],
				['D5', 'eighth', { voice: 3 }],
				['D4', 'eighth', { voice: 4 }]
			]
		]);
		const ops = layoutScore(score, OPTS).measures[0]!.ops;
		const flagFor = (id: string) => ops.find((op): op is GlyphOp => op.kind === 'glyph' && op.noteId === id && op.glyph.startsWith('flag'))?.glyph;
		expect(score.measures[0]!.notes.map((n) => flagFor(n.id))).toEqual(['flag8thUp', 'flag8thDown', 'flag8thUp', 'flag8thDown']);
	});

	it("overrides a beamed group's direction per voice", () => {
		const score = buildScore([
			[
				['C5', 'eighth', { voice: 1 }],
				['D5', 'eighth', { voice: 1 }],
				['C4', 'eighth', { voice: 2 }],
				['D4', 'eighth', { voice: 2 }]
			]
		]);
		const ops = layoutScore(score, OPTS).measures[0]!.ops;
		expect(beamRects(ops)).toHaveLength(2);
		const stems = stemRects(ops);
		const ofVoice = (voice: number) => stems.filter((s) => score.findNote(s.noteId!)!.voice === voice);
		const heads = noteheadYs(ops);
		const up = ofVoice(1).map((s) => s.y);
		const down = ofVoice(2).map((s) => s.y + s.height);
		expect(up[0]).toBeCloseTo(up[1]!, 6);
		expect(Math.max(...up)).toBeLessThan(Math.min(...heads));
		expect(down[0]).toBeCloseTo(down[1]!, 6);
		expect(Math.min(...down)).toBeGreaterThan(Math.max(...heads));
	});

	it('spreads rests sharing an onset apart by voice, a lone rest staying centred', () => {
		const voice = (v: number, pitches: string[]) => [
			[null, 'quarter', { voice: v }] as const,
			...pitches.map((p) => [p, 'quarter', { voice: v }] as const)
		];
		const layout = lay([[...voice(1, ['G4', 'A4', 'B4']), ...voice(2, ['C4', 'D4', 'E4']), ...voice(3, ['F4', 'G4', 'A4'])]]);
		const rests = glyphOps(layout.measures[0]!.ops, 'restQuarter');
		expect(rests).toHaveLength(3);
		for (const rest of rests) expect(rest.x).toBeCloseTo(rests[0]!.x, 6);
		const [v1, v2, v3] = rests.map((r) => r.y - layout.staffTopY);
		const solo = lay([[[null, 'quarter']]]);
		const lone = glyphOps(solo.measures[0]!.ops, 'restQuarter')[0]!.y - solo.staffTopY;
		// Voice 3 steps further up than voice 1, rather than landing on it.
		expect(v3!).toBeLessThan(v1!);
		expect(v1!).toBeLessThan(lone);
		expect(lone).toBeLessThan(v2!);
	});
});

describe('voice-to-voice collision avoidance', () => {
	it.each([2, 3])("nudges voice %i a notehead's width right of voice 1 a second away at the same onset", (other) => {
		const score = buildScore([[['E4', 'quarter', { voice: 1 }], ['D4', 'quarter', { voice: other }]]]);
		const measure = layoutScore(score, OPTS).measures[0]!;
		expect(noteX(score, measure, 1) - noteX(score, measure, 0)).toBeCloseTo(noteheadWidth, 6);
	});

	it('never moves voice 1, even when voice 2 is written first', () => {
		const soloX = lay([[['E4', 'quarter']]]).measures[0]!.notes[0]!.bounds.x;
		const score = buildScore([[['D4', 'quarter', { voice: 2 }], ['E4', 'quarter', { voice: 1 }]]]);
		const measure = layoutScore(score, OPTS).measures[0]!;
		expect(noteX(score, measure, 1)).toBeCloseTo(soloX, 6);
		expect(noteX(score, measure, 0) - noteX(score, measure, 1)).toBeCloseTo(noteheadWidth, 6);
	});

	it('does not nudge voices further apart than a second, or a second already cleared by column spacing', () => {
		const apart = buildScore([[['C4', 'quarter', { voice: 1 }], ['G4', 'quarter', { voice: 2 }]]]);
		const apartMeasure = layoutScore(apart, OPTS).measures[0]!;
		expect(noteX(apart, apartMeasure, 0)).toBeCloseTo(noteX(apart, apartMeasure, 1), 6);

		const later = buildScore([[['C4', 'quarter', { voice: 1 }], [null, 'quarter', { voice: 2 }], ['B3', 'quarter', { voice: 2 }]]]);
		const laterMeasure = layoutScore(later, OPTS).measures[0]!;
		expect(noteX(later, laterMeasure, 2) - noteX(later, laterMeasure, 0)).toBeGreaterThan(noteheadWidth);
	});
});

describe('clefs', () => {
	const CLEF_GLYPHS: ReadonlySet<GlyphName> = new Set<GlyphName>(['gClef', 'fClef', 'gClef8vb', 'cClef']);
	const clefOpsOf = (ops: readonly DrawOp[]) => ops.filter((op): op is GlyphOp => op.kind === 'glyph' && CLEF_GLYPHS.has(op.glyph));
	const clefNames = (ops: readonly DrawOp[]) => clefOpsOf(ops).map((op) => op.glyph);
	const layClef = (clef: ClefType, measures: readonly (MeasureSpec | MeasureBuildSpec)[], keyFifths = 0, systemWidthPx?: number) =>
		layoutScore(buildScore(measures, { clef, keyFifths }), { staffSpacePx: SS, systemWidthPx });
	const fourQuarters = (pitch: string): MeasureSpec => [0, 1, 2, 3].map(() => [pitch, 'quarter'] as const);
	const inlineChange = (onset: number, clef: ClefType) => [
		{ notes: fourQuarters('C4'), clefChanges: [{ onset, clef }] },
		[['C4', 'whole']] as MeasureSpec
	];
	const scaledClefRight = (layout: LaidOutScore, clef: GlyphOp) =>
		clef.x + GLYPH_METRICS.cClef.advance * SS * (clef.fontSizePx! / layout.fontSizePx);

	it.each([
		['treble', 'E4', 'B4', 'F5'],
		['bass', 'G2', 'D3', 'A3'],
		['treble8', 'E4', 'B4', 'F5']
	] as const)('puts %s bottom, middle and top line notes a line apart', (clef, bottom, middle, top) => {
		const layout = layClef(clef, [[[bottom, 'quarter'], [middle, 'quarter'], [top, 'quarter']]]);
		const [bottomY, middleY, topY] = noteheadYs(layout.measures[0]!.ops);
		expect(middleY! - topY!).toBeCloseTo(2 * SS, 6);
		expect(bottomY! - middleY!).toBeCloseTo(2 * SS, 6);
	});

	it.each([
		['treble', 5, 'gClef'],
		['treble8', 5, 'gClef8vb'],
		['bass', -1, 'fClef'],
		['alto', 2, 'cClef'],
		['tenor', 1, 'cClef']
	] as const)('puts middle C in %s %i spaces below the top line, under a %s', (clef, spacesBelowTop, glyph) => {
		const layout = layClef(clef, [[['C4', 'quarter']]]);
		const ops = layout.measures[0]!.ops;
		expect(noteheadYs(ops)[0]! - layout.staffTopY).toBeCloseTo(spacesBelowTop * SS, 6);
		expect(clefNames(ops)).toEqual([glyph]);
		const ledgers = ledgerRects(ops);
		if (spacesBelowTop >= 0 && spacesBelowTop <= 4) {
			// A C clef centres on middle C's line, which needs no ledger.
			expect(clefOpsOf(ops)[0]!.y - layout.staffTopY).toBeCloseTo(spacesBelowTop * SS, 6);
			expect(ledgers).toHaveLength(0);
		} else {
			expect(ledgers).toHaveLength(1);
			if (spacesBelowTop < 0) expect(ledgers[0]!.y).toBeLessThan(layout.staffTopY);
		}
	});

	it.each([
		// Half staff spaces down from the top line, per accidental in written
		// order, transcribed from MuseScore's `clefTable` rather than this
		// engine's own table. Tenor sharps start low instead of zigzagging high.
		['alto', 7, 'accidentalSharp', [1, 4, 0, 3, 6, 2, 5]],
		['alto', -7, 'accidentalFlat', [5, 2, 6, 3, 7, 4, 8]],
		['tenor', 7, 'accidentalSharp', [6, 2, 5, 1, 4, 0, 3]],
		['tenor', -7, 'accidentalFlat', [3, 0, 4, 1, 5, 2, 6]],
		['treble', 7, 'accidentalSharp', [0, 3, -1, 2, 5, 1, 4]],
		['treble', -7, 'accidentalFlat', [4, 1, 5, 2, 6, 3, 7]],
		['treble8', 3, 'accidentalSharp', [0, 3, -1]],
		['bass', 7, 'accidentalSharp', [2, 5, 1, 4, 7, 3, 6]],
		['bass', -7, 'accidentalFlat', [6, 3, 7, 4, 8, 5, 9]]
	] as const)('places %s key signature %i at the standard positions', (clef, keyFifths, glyph, halfSpaces) => {
		const layout = layClef(clef, [[[null, 'quarter']]], keyFifths);
		const ys = glyphOps(layout.measures[0]!.ops, glyph).map((op) => Math.round(((op.y - layout.staffTopY) / (SS / 2)) * 1e6) / 1e6);
		expect(ys).toEqual(halfSpaces);
	});

	it('draws a smaller change clef inline at a mid-system change, and none at a later unchanged measure', () => {
		const layout = lay([[['C4', 'quarter']], { notes: [['C4', 'quarter']], clef: 'bass' }, [['C4', 'quarter']]]);
		expect(layout.systems[0]!.measureIndices).toEqual([0, 1, 2]);
		const [header] = clefOpsOf(layout.measures[0]!.ops);
		expect(header!.glyph).toBe('gClef');
		expect(header!.fontSizePx).toBeUndefined();
		const changes = clefOpsOf(layout.measures[1]!.ops);
		expect(changes.map((op) => op.glyph)).toEqual(['fClef']);
		expect(changes[0]!.fontSizePx!).toBeLessThan(layout.fontSizePx);
		expect(clefOpsOf(layout.measures[2]!.ops)).toEqual([]);
		// The same C4 moves from below the staff to above it.
		const [trebleLedger] = ledgerRects(layout.measures[0]!.ops);
		const [bassLedger] = ledgerRects(layout.measures[1]!.ops);
		expect(trebleLedger!.y).toBeGreaterThan(layout.staffTopY + 4 * SS);
		expect(bassLedger!.y).toBeLessThan(layout.staffTopY);
	});

	it.each([
		['a measure clef change', 'treble' as ClefType, [[['C4', 'half'], ['D4', 'half']], { notes: [['C4', 'half'], ['D4', 'half']], clef: 'bass' }, [['C4', 'whole']]], 'fClef'],
		['an inline clef change', 'bass' as ClefType, [...inlineChange(0.5, 'tenor'), [['C4', 'whole']]], 'cClef']
	] as const)('shows the clef carried by %s full size in every later system header', (_name, clef, measures, glyph) => {
		const layout = layClef(clef, measures as unknown as MeasureBuildSpec[], 0, 1);
		for (const index of [1, 2]) {
			expect(layout.systems[index]!.measureIndices).toEqual([index]);
			const clefs = clefOpsOf(layout.measures[index]!.ops);
			expect(clefs.map((op) => op.glyph)).toEqual([glyph]);
			expect(clefs[0]!.fontSizePx).toBeUndefined();
		}
	});

	it("draws a key signature at a clef change in the new clef's positions", () => {
		const layout = layoutScore(buildScore([[['G4', 'quarter']], { notes: [['F#3', 'quarter']], clef: 'bass' }], { keyFifths: 1 }), {
			staffSpacePx: SS,
			systemWidthPx: 1
		});
		const ops = layout.measures[1]!.ops;
		expect(findGlyph(ops, 'accidentalSharp')!.y).toBeCloseTo(noteheadYs(ops)[0]!, 6);
	});

	it('restores the earlier clef with its own change clef where a range reverts', () => {
		const score = buildScore([[['C4', 'quarter']], [['C4', 'quarter']], [['C4', 'quarter']], [['C4', 'quarter']]]);
		score.setClefRange(0, 1, 2, 'treble8');
		const layout = layoutScore(score, OPTS);
		expect([1, 2, 3].map((i) => clefNames(layout.measures[i]!.ops))).toEqual([['gClef8vb'], [], ['gClef']]);
	});

	it('lays out a clef change inside a measure: a smaller clef in a widened gap, later notes in the new clef', () => {
		const layout = layClef('bass', inlineChange(0.5, 'tenor'));
		const ops = layout.measures[0]!.ops;
		const heads = glyphOps(ops, 'noteheadBlack');
		expect(heads.map((h) => (h.y - layout.staffTopY) / SS)).toEqual([-1, -1, 1, 1].map((v) => expect.closeTo(v, 6)));
		const clefs = clefOpsOf(ops);
		expect(clefs.map((op) => op.glyph)).toEqual(['fClef', 'cClef']);
		const change = clefs[1]!;
		expect(change.fontSizePx!).toBeLessThan(layout.fontSizePx);
		expect(change.x).toBeGreaterThan(heads[1]!.x + noteheadWidth);
		expect(heads[2]!.x).toBeGreaterThan(scaledClefRight(layout, change));
		expect(heads[2]!.x - heads[1]!.x).toBeGreaterThan(heads[1]!.x - heads[0]!.x + 2 * SS);
		expect(heads[3]!.x - heads[2]!.x).toBeCloseTo(heads[1]!.x - heads[0]!.x, 6);
		// The next measure inherits tenor without a clef of its own.
		expect(clefOpsOf(layout.measures[1]!.ops)).toEqual([]);
		expect(glyphOps(layout.measures[1]!.ops, 'noteheadWhole')[0]!.y - layout.staffTopY).toBeCloseTo(SS, 6);
	});

	it("draws a change at the measure's very end before the barline", () => {
		const layout = layClef('bass', inlineChange(1, 'alto'));
		const ops = layout.measures[0]!.ops;
		const heads = glyphOps(ops, 'noteheadBlack');
		for (const head of heads) expect(head.y).toBeCloseTo(layout.staffTopY - SS, 6);
		const change = clefOpsOf(ops)[1]!;
		expect(change.glyph).toBe('cClef');
		expect(change.x).toBeGreaterThan(heads[3]!.x);
		const region = layout.measures[0]!.region;
		expect(change.x).toBeLessThan(region.x + region.width);
		expect(glyphOps(layout.measures[1]!.ops, 'noteheadWhole')[0]!.y - layout.staffTopY).toBeCloseTo(2 * SS, 6);
	});

	it('pushes an accidental right after a change clef clear of it, positioned in the new clef', () => {
		const layout = layClef('bass', [{ notes: [['C4', 'half'], ['C#4', 'half']], clefChanges: [{ onset: 0.5, clef: 'tenor' }] }]);
		const ops = layout.measures[0]!.ops;
		const sharp = findGlyph(ops, 'accidentalSharp')!;
		expect(sharp.x).toBeGreaterThanOrEqual(scaledClefRight(layout, clefOpsOf(ops)[1]!) - 1e-6);
		expect(sharp.y).toBeCloseTo(layout.staffTopY + SS, 6);
	});

	it("decides stem direction by each note's own clef across a change", () => {
		// B3 is above bass's middle line (down) but below alto's (up).
		const layout = layClef('bass', [{ notes: [['B3', 'half'], ['B3', 'half']], clefChanges: [{ onset: 0.5, clef: 'alto' }] }]);
		const ops = layout.measures[0]!.ops;
		const heads = glyphOps(ops, 'noteheadHalf');
		const stems = stemRects(ops);
		expect(stems[0]!.y + stems[0]!.height).toBeGreaterThan(heads[0]!.y + SS);
		expect(stems[1]!.y).toBeLessThan(heads[1]!.y - SS);
	});

	it.each([
		['a measure clef change', 'treble' as ClefType, [[['C4', 'quarter']], { notes: [['C4', 'quarter']], clef: 'bass' }], 1, ['fClef']],
		['an inline clef change', 'bass' as ClefType, inlineChange(0.5, 'tenor'), 0, ['fClef', 'cClef']]
	] as const)('keeps a measure with %s self-contained for scoped redraw', (_name, clef, measures, index, clefs) => {
		const score = buildScore(measures as unknown as MeasureBuildSpec[], { clef });
		const layout = layoutScore(score, OPTS);
		score.transposeNote(score.measures[index]!.notes.at(-1)!.id, 2);
		const updated = relayoutMeasure(score, layout, index, OPTS);
		expect(updated).not.toBeNull();
		expect(clefNames(updated!.measures[index]!.ops)).toEqual(clefs);
	});
});

describe('multi-staff systems', () => {
	/** Treble over bass, one measure each. */
	function twoStaves(treble: MeasureSpec = [['C5', 'quarter']], bass: MeasureSpec = [['C3', 'quarter']]) {
		const score = buildScore([treble], { clef: 'treble' });
		score.appendStaff('bass');
		const measure = score.appendMeasure(1);
		for (const [pitch, value] of bass as readonly (readonly [string, NoteValue])[]) {
			score.appendNote(measure, { pitch: parsePitch(pitch), value });
		}
		return score;
	}
	const topOf = (layout: LaidOutScore, staffIndex: number) => layout.systems.find((s) => s.staffIndex === staffIndex)!.topY;
	const thinBarline = (ops: readonly DrawOp[]) => rectsOf(ops).find((r) => Math.abs(r.width - ED.thinBarlineThickness * SS) < 0.01)!;

	it('stacks staves tightly at a fixed offset, in non-overlapping bands', () => {
		const score = twoStaves();
		const layout = layoutScore(score, OPTS);
		const offset = topOf(layout, 1) - topOf(layout, 0);
		expect(offset).toBeGreaterThan(4 * SS);
		// Tighter than two independently padded single-staff layouts.
		const solo0 = layoutScore(buildScore([[['C5', 'quarter']]], { clef: 'treble' }), OPTS);
		const solo1 = layoutScore(buildScore([[['C3', 'quarter']]], { clef: 'bass' }), OPTS);
		expect(offset).toBeLessThan(solo0.height + solo1.height);
		const [m0, m1] = [measureAt(layout, 0, 0), measureAt(layout, 1, 0)];
		expect(m1.region.y).toBeGreaterThanOrEqual(m0.region.y + m0.region.height - 0.001);
		// A third identical staff repeats the same offset.
		score.appendStaff('bass');
		score.appendNote(score.appendMeasure(2), { pitch: parsePitch('C3'), value: 'quarter' });
		const three = layoutScore(score, OPTS);
		expect(topOf(three, 1) - topOf(three, 0)).toBeCloseTo(offset, 6);
		expect(topOf(three, 2) - topOf(three, 1)).toBeCloseTo(offset, 6);
	});

	it("keeps a lone staff's barline exactly the staff's height", () => {
		const layout = layoutScore(buildScore([[['C4', 'quarter'], ['D4', 'quarter']]]), OPTS);
		const barline = thinBarline(layout.measures[0]!.ops);
		expect(barline.y).toBeCloseTo(layout.staffTopY, 6);
		expect(barline.height).toBeCloseTo(4 * SS, 6);
	});

	it('draws a shared end barline as one segment per staff, meeting across the gap without overlap', () => {
		const layout = layoutScore(twoStaves([['C5', 'quarter'], ['D5', 'quarter']], [['C3', 'quarter'], ['D3', 'quarter']]), OPTS);
		const [m0, m1] = [measureAt(layout, 0, 0), measureAt(layout, 1, 0)];
		const [b0, b1] = [thinBarline(m0.ops), thinBarline(m1.ops)];
		expect(b1.x).toBeCloseTo(b0.x, 6);
		expect(b0.y).toBeCloseTo(layout.staffTopY, 6);
		expect(b0.height).toBeGreaterThan(4 * SS);
		expect(b1.height).toBeGreaterThan(4 * SS);
		// A small neutral strip between the segments keeps the regions apart.
		expect(b1.y).toBeGreaterThanOrEqual(b0.y + b0.height - 0.001);
		expect(b1.y - (b0.y + b0.height)).toBeLessThan(5);
		expect(m0.region.y + m0.region.height).toBeGreaterThanOrEqual(b0.y + b0.height - 0.001);
		expect(m1.region.y).toBeLessThanOrEqual(b1.y + 0.001);
		expect(m0.region.y + m0.region.height).toBeLessThanOrEqual(m1.region.y + 0.001);
	});

	it('pads a narrower staff to the wider one so barlines align, without moving its notes', () => {
		const eighths: MeasureSpec = ['C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5', 'C6'].map((p) => [p, 'eighth'] as const);
		const layout = layoutScore(twoStaves(eighths, [['C3', 'whole']]), OPTS);
		const [m0, m1] = [measureAt(layout, 0, 0), measureAt(layout, 1, 0)];
		expect(m1.region.x + m1.region.width).toBeCloseTo(m0.region.x + m0.region.width, 6);
		expect(findGlyph(m1.ops, 'noteheadWhole')!.x).toBeLessThan(m1.region.x + m1.region.width / 2);
	});

	it('draws each staff its own clef and key signature', () => {
		const score = buildScore([[['D5', 'quarter']]], { clef: 'treble', keyFifths: 2 });
		score.appendStaff('bass');
		const measure = score.appendMeasure(1);
		measure.keyFifths = -3;
		score.appendNote(measure, { pitch: parsePitch('Eb3'), value: 'quarter' });
		const layout = layoutScore(score, OPTS);
		const summary = (ops: readonly DrawOp[]) => [
			glyphsOf(ops).filter((g) => g === 'gClef' || g === 'fClef'),
			countOf(ops, 'accidentalSharp'),
			countOf(ops, 'accidentalFlat')
		];
		expect(summary(measureAt(layout, 0, 0).ops)).toEqual([['gClef'], 2, 0]);
		expect(summary(measureAt(layout, 1, 0).ops)).toEqual([['fClef'], 0, 3]);
	});

	describe('sharing system breaks between a sparse and a dense staff (M6 Slice 10)', () => {
		/** Whole notes over sixteenths, eight measures: the dense staff sets
		 *  every column's width, so casting off on the sparse one overflowed. */
		function sparseOverDense(): Score {
			const score = buildScore(Array.from({ length: 8 }, (): MeasureSpec => [['C5', 'whole']]), { keyFifths: 0 });
			score.appendStaff('bass');
			for (let i = 0; i < 8; i++) {
				const dense = score.appendMeasure(1);
				for (let n = 0; n < 16; n++) score.appendNote(dense, { pitch: parsePitch(n % 2 ? 'C3' : 'E3'), value: '16th' });
			}
			return score;
		}
		const WIDTH = { staffSpacePx: SS, systemWidthPx: 900 };
		const rows = (layout: LaidOutScore, staffIndex: number) =>
			layout.systems.filter((s) => s.staffIndex === staffIndex);

		it('breaks every staff at the same measures, filling each system without running past it', () => {
			const layout = layoutScore(sparseOverDense(), WIDTH);
			const systems = rows(layout, 0);
			expect(systems.length).toBeGreaterThan(1);
			expect(rows(layout, 1).map((s) => s.measureIndices)).toEqual(systems.map((s) => s.measureIndices));
			expect(layout.width).toBeLessThanOrEqual(WIDTH.systemWidthPx + 0.001);
			for (const [i, system] of systems.entries()) {
				const last = system.measureIndices.at(-1)!;
				const right = (staffIndex: number) => measureAt(layout, staffIndex, last).region;
				expect(right(1).x + right(1).width).toBeCloseTo(right(0).x + right(0).width, 6);
				// Justified to the right margin, except the last system.
				if (i < systems.length - 1) expect(right(0).x + right(0).width).toBeCloseTo(WIDTH.systemWidthPx - layout.measures[0]!.region.x, 0);
			}
		});

		it('keeps an edit on the narrower staff scoped, matching a full layout', () => {
			const score = sparseOverDense();
			const layout = layoutScore(score, WIDTH);
			const touched = score.transposeNote(score.staves[0]!.measures[1]!.notes[0]!.id, 1)!;
			const updated = relayoutMeasure(score, layout, touched, WIDTH, 0);
			expect(updated).not.toBeNull();
			const full = measureAt(layoutScore(score, WIDTH), 0, touched);
			const scoped = measureAt(updated!, 0, touched);
			for (const key of ['x', 'y', 'width', 'height'] as const) expect(scoped.region[key]).toBeCloseTo(full.region[key], 6);
			expect(findGlyph(scoped.ops, 'noteheadWhole')!.x).toBeCloseTo(findGlyph(full.ops, 'noteheadWhole')!.x, 6);
		});
	});

	it('rejects a score whose staves disagree on measure count', () => {
		const score = buildScore([[['C4', 'quarter']]]);
		score.appendStaff('bass');
		score.appendMeasure(1);
		score.appendMeasure(1);
		expect(() => layoutScore(score, OPTS)).toThrow(/measures/);
	});
});

describe('part grouping decorations', () => {
	/** `staffCount` treble staves of `measuresPerStaff` one-quarter measures, with `parts` registered in order. */
	function stavesWithParts(staffCount: number, parts: readonly (readonly [number[], string?])[], measuresPerStaff = 1) {
		const score = buildScore(Array.from({ length: measuresPerStaff }, (): MeasureSpec => [['C4', 'quarter']]));
		for (let staffIndex = 1; staffIndex < staffCount; staffIndex++) {
			score.appendStaff('treble');
			for (let i = 0; i < measuresPerStaff; i++) {
				score.appendNote(score.appendMeasure(staffIndex), { pitch: parsePitch('C4'), value: 'quarter' });
			}
		}
		for (const [staffIndices, name] of parts) score.addPart(staffIndices, name);
		return score;
	}
	const textsOf = (ops: readonly DrawOp[]) => ops.flatMap((op) => (op.kind === 'text' ? [op.text] : []));
	const topOf = (layout: LaidOutScore, staffIndex: number) => layout.systems.find((s) => s.staffIndex === staffIndex)!.topY;

	it("draws a brace whose ink spans a two-staff part's outer height", () => {
		const layout = layoutScore(stavesWithParts(2, [[[0, 1], 'Piano']]), OPTS);
		expect(glyphsOf(layout.partDecorations)).toEqual(['brace']);
		const brace = findGlyph(layout.partDecorations, 'brace')!;
		const scale = brace.fontSizePx! / (4 * SS);
		expect(brace.y - GLYPH_METRICS.brace.bBoxNE[1] * SS * scale).toBeCloseTo(topOf(layout, 0), 6);
		expect(brace.y - GLYPH_METRICS.brace.bBoxSW[1] * SS * scale).toBeCloseTo(topOf(layout, 1) + 4 * SS, 6);
	});

	it("assembles a bracket for three or more staves, spanning exactly their outer height", () => {
		const layout = layoutScore(stavesWithParts(4, [[[0, 1, 2, 3], 'Choir']]), OPTS);
		expect(glyphsOf(layout.partDecorations)).toEqual(['bracketTop', 'bracketBottom']);
		const hookHeight = GLYPH_METRICS.bracketTop.bBoxNE[1] * SS;
		const top = findGlyph(layout.partDecorations, 'bracketTop')!;
		const bottom = findGlyph(layout.partDecorations, 'bracketBottom')!;
		const spine = rectsOf(layout.partDecorations)[0]!;
		expect(top.y - hookHeight).toBeCloseTo(topOf(layout, 0), 6);
		expect(bottom.y + hookHeight).toBeCloseTo(topOf(layout, 3) + 4 * SS, 6);
		expect(spine.y).toBeCloseTo(top.y, 6);
		expect(spine.y + spine.height).toBeCloseTo(bottom.y, 6);
	});

	it.each([
		['a single-staff part', 2, [[0], 'Solo']],
		// Non-contiguous groups are a documented scope cut: no glyph, but the name still labels.
		['a non-contiguous part', 3, [[0, 2], 'Divisi']]
	] as const)('draws no brace or bracket for %s, only its label', (_name, staffCount, part) => {
		const layout = layoutScore(stavesWithParts(staffCount, [part as unknown as [number[], string]]), OPTS);
		expect(glyphsOf(layout.partDecorations)).toEqual([]);
		expect(textsOf(layout.partDecorations)).toEqual([part[1]]);
	});

	it('labels a part at the first system only, but repeats its brace at every system', () => {
		const layout = layoutScore(stavesWithParts(2, [[[0, 1], 'Piano']], 6), { staffSpacePx: SS, systemWidthPx: 90 });
		const systemCount = layout.systems.filter((s) => s.staffIndex === 0).length;
		expect(systemCount).toBeGreaterThan(1);
		expect(textsOf(layout.partDecorations)).toEqual(['Piano']);
		expect(glyphsOf(layout.partDecorations).filter((g) => g === 'brace')).toHaveLength(systemCount);
	});

	it('draws nothing and reserves no header column for unnamed single-staff parts', () => {
		expect(layoutScore(createDemoScore(), OPTS).partDecorations).toEqual([]);
		expect(layoutScore(createGrandStaffShowcaseScore()).partDecorations).toEqual([]);
		const plain = layoutScore(stavesWithParts(2, []), OPTS);
		const named = layoutScore(stavesWithParts(2, [[[0], 'Solo']]), OPTS);
		expect(named.measures[0]!.region.x).toBeGreaterThan(plain.measures[0]!.region.x);
	});
});

describe('cross-staff beaming', () => {
	const setup = () => {
		const score = createCrossStaffBeamShowcaseScore();
		const layout = layoutScore(score, OPTS);
		return { score, layout, treble: measureAt(layout, 0, 1), bass: measureAt(layout, 1, 1) };
	};

	it("covers both staves' reach into the gap without overlapping regions or leaking into neighbours", () => {
		const { score, layout, treble, bass } = setup();
		expect(treble.region.y + treble.region.height).toBeLessThanOrEqual(bass.region.y + 0.001);
		// Each side's ink genuinely extends past its own staff band.
		expect(treble.region.y + treble.region.height).toBeGreaterThan(topOf(layout, 0) + 4 * SS + 10);
		expect(bass.region.y).toBeLessThan(topOf(layout, 1) - 10);
		// Every column's shared barline already reaches the gap, so scoping is
		// proved by where the beamed notes' ink is drawn, not by region height.
		const beam = score.crossStaffBeams[0]!;
		const hasBeamInk = (m: LaidOutMeasure) => m.ops.some((op) => 'noteId' in op && op.noteId !== undefined && beam.noteIds.includes(op.noteId));
		expect(hasBeamInk(treble)).toBe(true);
		expect(hasBeamInk(bass)).toBe(true);
		for (const [staff, index] of [[0, 0], [0, 2], [1, 0], [1, 2]] as const) {
			expect(hasBeamInk(measureAt(layout, staff, index))).toBe(false);
		}
	});

	it('draws one beam segment per side, meeting where they face the gap', () => {
		const { treble, bass } = setup();
		const [up] = beamRects(treble.ops);
		const [down] = beamRects(bass.ops);
		expect(beamRects(treble.ops)).toHaveLength(1);
		expect(beamRects(bass.ops)).toHaveLength(1);
		expect(Math.abs(up!.y + up!.height - down!.y)).toBeLessThan(3);
	});

	it('repaints one half on a scoped edit, the join staying put and the other half untouched', () => {
		const { score, layout, treble, bass } = setup();
		const gapEdge = (m: LaidOutMeasure) => {
			const [beam] = beamRects(m.ops);
			return beam!.y + beam!.height;
		};
		const before = gapEdge(treble);
		const touched = score.transposeNote(score.staves[0]!.measures[1]!.notes[0]!.id, 1);
		const updated = relayoutMeasure(score, layout, touched!, OPTS, 0)!;
		expect(updated).not.toBeNull();
		expect(gapEdge(measureAt(updated, 0, 1))).toBeCloseTo(before, 6);
		expect(measureAt(updated, 1, 1)).toBe(bass);
	});

	function topOf(layout: LaidOutScore, staffIndex: number) {
		return layout.systems.find((s) => s.staffIndex === staffIndex)!.topY;
	}
});
