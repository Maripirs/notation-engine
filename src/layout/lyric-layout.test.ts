// Lyrics (M6 Slice 9): where layout puts syllables, hyphens and extender
// lines, how it widens measures and staff gaps for them, and how dynamics
// move above a staff that carries them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../io/musicxml-import.js';
import { parsePitch } from '../model/pitch.js';
import type { LyricSpec } from '../model/lyrics.js';
import { buildScore, Score, type MeasureBuildSpec, type MeasureSpec, type NoteValue } from '../model/score.js';
import { GLYPH_METRICS } from '../render/glyph-metrics.js';
import { layoutScore, relayoutMeasure } from './layout.js';
import { glyphOps, measureAt, SS, type RectOp, type TextOp } from './test-helpers.js';
import type { LaidOutMeasure, LaidOutScore } from './types.js';

const FIXTURE = readFileSync(join(import.meta.dirname, '../test/fixtures/satb-lyrics.musicxml'), 'utf8');

const textsIn = (measure: LaidOutMeasure): TextOp[] => measure.ops.filter((op): op is TextOp => op.kind === 'text');
/** Hyphens and extender lines: the only rects drawn below a staff's bottom
 *  line in these scores (no ledger lines that low, no low barlines). */
const lyricRects = (measure: LaidOutMeasure, staffTopY: number): RectOp[] =>
	measure.ops.filter((op): op is RectOp => op.kind === 'rect' && op.y > staffTopY + 4 * SS + 2 * SS);
const hyphensIn = (measure: LaidOutMeasure, staffTopY: number): RectOp[] =>
	lyricRects(measure, staffTopY).filter((r) => Math.abs(r.width - 0.65 * SS) < 1e-6);
const extendersIn = (measure: LaidOutMeasure, staffTopY: number): RectOp[] =>
	lyricRects(measure, staffTopY).filter((r) => Math.abs(r.height - 0.11 * SS) < 1e-6);
const centreOf = (measure: LaidOutMeasure, i: number): number => {
	const b = measure.notes[i]!.bounds;
	return b.x + b.width / 2;
};
/** Layout's own text-width estimate (`estimateLyricWidthSpaces`), mirrored
 *  so the tests can check gaps between estimated text extents. */
const roughWidth = (text: string): number =>
	[...text].reduce((em, ch) => {
		if (/[ijl.,;:'!| ]/.test(ch)) return em + 0.25;
		if (/[ftrI\-()]/.test(ch)) return em + 0.33;
		if (/[mwMW]/.test(ch)) return em + 0.85;
		if (/[A-Z]/.test(ch)) return em + 0.68;
		return em + 0.55;
	}, 0) *
	2 *
	SS;

function lay(measures: readonly (MeasureSpec | MeasureBuildSpec)[], systemWidthPx?: number): { score: Score; layout: LaidOutScore } {
	const score = buildScore(measures, { keyFifths: 0 });
	return { score, layout: layoutScore(score, { staffSpacePx: SS, systemWidthPx }) };
}

const sing = (text: string, syllabic: LyricSpec['syllabic'] = 'single', more: Partial<LyricSpec> = {}): { lyrics: LyricSpec[] } => ({
	lyrics: [{ text, syllabic, ...more }]
});

type StaffNote = readonly [pitch: string, value: NoteValue, lyrics?: readonly LyricSpec[]];

/** A score with one staff per entry, each `[pitch, value, lyrics?]` per
 *  measure, for the multi-staff cases `buildScore` does not express. */
function staves(rows: readonly (readonly (readonly StaffNote[])[])[]): Score {
	const score = new Score({ keyFifths: 0 });
	rows.forEach((measures, staffIndex) => {
		if (staffIndex > 0) score.appendStaff();
		for (const notes of measures) {
			const measure = score.appendMeasure(staffIndex);
			for (const [pitch, value, lyrics] of notes) score.appendNote(measure, { pitch: parsePitch(pitch), value, lyrics });
		}
	});
	return score;
}

describe('layout: lyric syllables (M6 Slice 9)', () => {
	it('centres a syllable under its notehead, on a baseline below the staff', () => {
		const { layout } = lay([[['G4', 'half', sing('la')], ['E5', 'half', sing('sol')]]]);
		const measure = layout.measures[0]!;
		const [la, sol] = textsIn(measure);
		expect(la).toMatchObject({ text: 'la', align: 'center', fontSizePx: 2 * SS });
		expect(la!.x).toBeCloseTo(centreOf(measure, 0), 6);
		expect(sol!.x).toBeCloseTo(centreOf(measure, 1), 6);
		// One baseline for the line, at least 4.6 spaces under the bottom line.
		expect(sol!.y).toBe(la!.y);
		expect(la!.y).toBeGreaterThanOrEqual(layout.staffTopY + 8.6 * SS - 1e-6);
		// The measure's region covers the text, descenders included.
		expect(measure.region.y + measure.region.height).toBeGreaterThanOrEqual(la!.y + 0.3 * 2 * SS);
	});

	it('stacks two verses, verse 1 nearest the staff, whatever order they are written in', () => {
		const { layout } = lay([
			[['C5', 'whole', { lyrics: [{ verse: '2', text: 'two' }, { verse: '1', text: 'one' }] }]],
			[['D5', 'whole', { lyrics: [{ verse: '1', text: 'uno' }] }]]
		]);
		const one = textsIn(layout.measures[0]!).find((t) => t.text === 'one')!;
		const two = textsIn(layout.measures[0]!).find((t) => t.text === 'two')!;
		const uno = textsIn(layout.measures[1]!)[0]!;
		expect(two.y - one.y).toBeCloseTo(2.6 * SS, 6);
		expect(uno.y).toBe(one.y);
	});

	it('lowers the verse line under low ink, for the whole row', () => {
		const plain = lay([[['C5', 'whole', sing('a')]], [['C5', 'whole', sing('b')]]]).layout;
		const low = lay([[['C5', 'whole', sing('a')]], [['C4', 'quarter', sing('b')], ['A3', 'quarter', sing('c')], ['G3', 'half', sing('d')]]]).layout;
		const [a] = textsIn(low.measures[0]!);
		const [b] = textsIn(low.measures[1]!);
		expect(a!.y).toBe(b!.y);
		expect(a!.y).toBeGreaterThan(textsIn(plain.measures[0]!)[0]!.y);
		const ink = low.measures[1]!.inkExtent!.bottom;
		expect(a!.y - 1.45 * SS).toBeGreaterThanOrEqual(ink + 0.9 * SS - 1e-6);
	});

	it('draws an elision as one text joined by an undertie', () => {
		const { layout } = lay([[['C5', 'whole', sing('sing', 'single', { elisions: [{ text: 'a', syllabic: 'single' }] })]]]);
		expect(textsIn(layout.measures[0]!)[0]!.text).toBe('sing‿a');
	});
});

describe('layout: hyphens and extenders (M6 Slice 9)', () => {
	it('centres a hyphen between two syllables of a word, and repeats it across a long gap', () => {
		const { layout } = lay([
			[['C5', 'quarter', sing('Al', 'begin')], ['D5', 'quarter', sing('le', 'end')], ['E5', 'half', sing('ho', 'begin')]],
			[['F5', 'whole']],
			[['G5', 'whole']],
			[['A5', 'whole', sing('sa', 'end')]]
		]);
		const top = layout.staffTopY;
		const [al, le] = textsIn(layout.measures[0]!);
		const short = hyphensIn(layout.measures[0]!, top);
		expect(short.length).toBeGreaterThanOrEqual(1);
		const first = short[0]!;
		const gapLeft = al!.x + roughWidth('Al') / 2;
		const gapRight = le!.x - roughWidth('le') / 2;
		expect(first.x + first.width / 2).toBeCloseTo((gapLeft + gapRight) / 2, 0);
		expect(first.y).toBeLessThan(al!.y);
		// "ho - sa" spans three barlines: several hyphens, each inside the
		// measure that owns it.
		const long = [0, 1, 2, 3].flatMap((i) => hyphensIn(layout.measures[i]!, top).map((h) => ({ i, h })));
		expect(long.length).toBeGreaterThanOrEqual(4);
		for (const { i, h } of long) {
			const region = layout.measures[i]!.region;
			expect(h.x).toBeGreaterThanOrEqual(region.x);
			expect(h.x + h.width).toBeLessThanOrEqual(region.x + region.width);
		}
	});

	it('runs an extender from a left-aligned syllable to the end of its melisma, cut at the barline', () => {
		const { layout } = lay([
			[['C5', 'half', sing('light,', 'single', { extend: 'start' })], ['D5', 'quarter'], ['B4', 'quarter']],
			[['A4', 'half'], ['G4', 'half', sing('let')]]
		]);
		const top = layout.staffTopY;
		const [light] = textsIn(layout.measures[0]!);
		const head = layout.measures[0]!.notes[0]!.bounds;
		expect(light!.align).toBe('left');
		expect(light!.x).toBeCloseTo(head.x + 0.3 * SS, 6);
		const [piece0] = extendersIn(layout.measures[0]!, top);
		const [piece1] = extendersIn(layout.measures[1]!, top);
		expect(piece0!.x).toBeCloseTo(light!.x + roughWidth('light,') + 0.25 * SS, 6);
		// The first piece reaches the barline, the second starts there and
		// stops at the A4's right edge, the melisma's last note.
		expect(piece0!.x + piece0!.width).toBeCloseTo(piece1!.x, 6);
		const a4 = layout.measures[1]!.notes[0]!.bounds;
		expect(piece1!.x + piece1!.width).toBeCloseTo(a4.x + a4.width - 0.3 * SS, 6);
		expect(piece1!.y + piece1!.height).toBeCloseTo(light!.y, 6);
	});

	it('ends an extender at an explicit extend stop, and draws none for a one-note "melisma"', () => {
		const { layout } = lay([
			[
				['C5', 'quarter', sing('ah', 'single', { extend: 'start' })],
				['D5', 'quarter', { lyrics: [{ text: '', extend: 'stop' }] }],
				['E5', 'quarter'],
				['F5', 'quarter', sing('oh', 'single', { extend: 'start' })]
			],
			[['G5', 'whole', sing('end')]]
		]);
		const top = layout.staffTopY;
		const extenders = extendersIn(layout.measures[0]!, top);
		expect(extenders).toHaveLength(1);
		const d5 = layout.measures[0]!.notes[1]!.bounds;
		expect(extenders[0]!.x + extenders[0]!.width).toBeCloseTo(d5.x + d5.width - 0.3 * SS, 6);
	});

	it('continues a hyphen and an extender across a system break (the SATB fixture)', () => {
		const score = importMusicXml(FIXTURE);
		// At 1200px the first system ends after measure 4, splitting "ev-'ry".
		const broken = layoutScore(score, { staffSpacePx: SS, systemWidthPx: 1200 });
		const sopranoSystems = broken.systems.filter((s) => s.staffIndex === 0);
		expect(sopranoSystems.map((s) => s.measureIndices)).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]]);
		const m = (index: number) => measureAt(broken, 0, index);
		const [top1, top2] = sopranoSystems.map((s) => s.topY);
		// Verse 1 and 2 each end the system with "ev -"/"glad -", and start the
		// next with "- 'ry"/"- ness": one hyphen before each continuing syllable.
		const evEnd = hyphensIn(m(3), top1!);
		const ev = textsIn(m(3)).find((t) => t.text === 'ev')!;
		expect(evEnd.some((h) => h.x > ev.x && Math.abs(h.y + h.height / 2 - (ev.y - 0.6 * SS)) < 1e-6)).toBe(true);
		const ry = textsIn(m(4)).find((t) => t.text === "'ry")!;
		const before = hyphensIn(m(4), top2!).filter((h) => h.x < ry.x && Math.abs(h.y + h.height / 2 - (ry.y - 0.6 * SS)) < 1e-6);
		expect(before).toHaveLength(1);
		expect(before[0]!.x).toBeGreaterThanOrEqual(m(4).region.x);
		// Both verses do it.
		expect(hyphensIn(m(4), top2!).filter((h) => h.x < ry.x)).toHaveLength(2);

		// At 900px the break falls after measure 3, inside "light,"'s melisma:
		// its extender runs to the end of the system and resumes under the G4.
		const melisma = layoutScore(score, { staffSpacePx: SS, systemWidthPx: 900 });
		const sm = (index: number) => measureAt(melisma, 0, index);
		const [s1, s2] = melisma.systems.filter((s) => s.staffIndex === 0);
		expect(s1!.measureIndices).toEqual([0, 1, 2]);
		const end = extendersIn(sm(2), s1!.topY);
		expect(end).toHaveLength(2);
		for (const piece of end) expect(piece.x + piece.width).toBeCloseTo(sm(2).region.x + sm(2).region.width - 0.5 * SS, 6);
		const resumed = extendersIn(sm(3), s2!.topY);
		expect(resumed).toHaveLength(2);
		const g4 = sm(3).notes[0]!.bounds;
		for (const piece of resumed) {
			expect(piece.x).toBeCloseTo(g4.x, 6);
			expect(piece.x + piece.width).toBeCloseTo(g4.x + g4.width - 0.3 * SS, 6);
		}
	});
});

describe('layout: lyric spacing (M6 Slice 9)', () => {
	it('widens a measure so neighbouring syllables keep a gap, a hyphen\'s worth inside a word', () => {
		const words: MeasureSpec = [
			['C5', 'eighth', sing('Wonderful')],
			['D5', 'eighth', sing('marvellous')],
			['E5', 'eighth', sing('ex', 'begin')],
			['F5', 'eighth', sing('traordinary', 'end')],
			['G5', 'half']
		];
		const bare = lay([words.map(([p, v]) => [p, v] as const)]).layout.measures[0]!;
		const sung = lay([words]).layout.measures[0]!;
		expect(sung.region.width).toBeGreaterThan(bare.region.width + 10 * SS);
		const texts = textsIn(sung);
		for (let i = 1; i < texts.length; i++) {
			const gap = texts[i]!.x - roughWidth(texts[i]!.text) / 2 - (texts[i - 1]!.x + roughWidth(texts[i - 1]!.text) / 2);
			expect(gap).toBeGreaterThan(i === 3 ? 1.2 * SS : 0.4 * SS);
		}
		// Every syllable stays inside its measure's band.
		const first = texts[0]!;
		expect(first.x - roughWidth(first.text) / 2).toBeGreaterThan(sung.region.x);
		const last = texts[texts.length - 1]!;
		expect(last.x + roughWidth(last.text) / 2).toBeLessThan(sung.region.x + sung.region.width);
	});

	it('leaves a measure with short syllables at its natural width', () => {
		const notes: MeasureSpec = [['C5', 'quarter'], ['D5', 'quarter'], ['E5', 'quarter'], ['F5', 'quarter']];
		const bare = lay([notes]).layout.measures[0]!;
		const sung = lay([notes.map(([p, v]) => [p, v, sing('la')] as const)]).layout.measures[0]!;
		expect(sung.region.width).toBeCloseTo(bare.region.width, 6);
	});

	it('widens every staff alike, so homophonic staves stay aligned', () => {
		const rhythm: [string, NoteValue][] = [['C5', 'eighth'], ['D5', 'eighth'], ['E5', 'quarter'], ['F5', 'half']];
		const score = staves([
			[rhythm.map(([p, v], i) => [p, v, [{ text: ['Hallelujah', 'everybody', 'sing', 'now'][i]! }]] as const)],
			[rhythm.map(([p, v]) => [p, v] as const)]
		]);
		const layout = layoutScore(score, { staffSpacePx: SS });
		const [upper, lower] = [0, 1].map((s) => measureAt(layout, s, 0));
		for (let i = 0; i < 4; i++) expect(centreOf(lower!, i)).toBeCloseTo(centreOf(upper!, i), 6);
		const plain = layoutScore(staves([[rhythm.map(([p, v]) => [p, v] as const)]]), { staffSpacePx: SS }).measures[0]!;
		expect(centreOf(lower!, 3) - centreOf(lower!, 0)).toBeGreaterThan(centreOf(plain, 3) - centreOf(plain, 0) + 5 * SS);
	});
});

describe('layout: lyrics and the staves around them (M6 Slice 9)', () => {
	const tune = (lyrics: boolean, verses = 1): readonly (readonly StaffNote[])[] => [
		[
			['C5', 'half', lyrics ? Array.from({ length: verses }, (_, v) => ({ verse: String(v + 1), text: 'la' })) : undefined],
			['D5', 'half']
		]
	];

	it('grows the gap below a staff with lyrics, per verse line, and leaves its barlines unjoined', () => {
		const tops = (score: Score) => layoutScore(score, { staffSpacePx: SS }).systems.map((s) => s.topY);
		const [p0, p1] = tops(staves([tune(false), tune(false)]));
		const [a0, a1] = tops(staves([tune(true), tune(false)]));
		const [b0, b1] = tops(staves([tune(true, 2), tune(false)]));
		expect(p1! - p0!).toBeCloseTo(10 * SS, 6);
		expect(a1! - a0!).toBeGreaterThan(p1! - p0!);
		expect(b1! - b0! - (a1! - a0!)).toBeCloseTo(2.6 * SS, 0);

		const layout = layoutScore(staves([tune(true), tune(false)]), { staffSpacePx: SS });
		const [upper, lower] = [0, 1].map((s) => measureAt(layout, s, 0));
		const [t0, t1] = layout.systems.map((s) => s.topY);
		// The lyrics clear the next staff's region with room to spare.
		expect(upper!.region.y + upper!.region.height).toBeLessThan(lower!.region.y);
		expect(lower!.region.y - (upper!.region.y + upper!.region.height)).toBeGreaterThan(3 * SS);
		// The barline (the rightmost, tallest-thin rect) stops at the staff.
		const barline = (m: LaidOutMeasure) =>
			m.ops.filter((op): op is RectOp => op.kind === 'rect' && op.height >= 4 * SS - 1e-6).sort((a, b) => b.x - a.x)[0]!;
		expect(barline(upper!).y + barline(upper!).height).toBeCloseTo(t0! + 4 * SS, 6);
		expect(barline(lower!).y).toBeCloseTo(t1!, 6);
		// Without lyrics the barline still joins the two staves.
		const joined = layoutScore(staves([tune(false), tune(false)]), { staffSpacePx: SS });
		const j0 = measureAt(joined, 0, 0);
		expect(barline(j0).y + barline(j0).height).toBeGreaterThan(joined.systems[0]!.topY + 6 * SS);
	});

	it('moves unplaced dynamics and hairpins above a staff with lyrics; an explicit below goes under the text', () => {
		const glyphs = (layout: LaidOutScore, name: 'dynamicPiano' | 'dynamicForte') => layout.measures.flatMap((m) => glyphOps(m.ops, name));
		const withLyrics = buildScore(
			[
				{ notes: [['C5', 'half', sing('la')], ['D5', 'half', sing('la')]], dynamics: [{ kind: 'p' }, { kind: 'f', onset: 0.5, placement: 'below' }] },
				[['E5', 'whole', sing('la')]]
			],
			{ keyFifths: 0 },
			[],
			[{ kind: 'crescendo', start: [0, 0], stop: [1, 0.5] }]
		);
		const layout = layoutScore(withLyrics, { staffSpacePx: SS });
		const [p] = glyphs(layout, 'dynamicPiano');
		const [f] = glyphs(layout, 'dynamicForte');
		expect(p!.y).toBeLessThan(layout.staffTopY);
		const text = textsIn(layout.measures[0]!)[0]!;
		expect(f!.y - GLYPH_METRICS.dynamicForte.bBoxNE[1] * SS).toBeGreaterThan(text.y);
		const hairpin = layout.measures[0]!.ops.filter((op) => op.kind === 'curve');
		expect(hairpin.length).toBeGreaterThan(0);
		for (const line of hairpin) if (line.kind === 'curve') expect(line.y0).toBeLessThan(layout.staffTopY);
	});
});

describe('layout: lyrics in a scoped relayout (M6 Slice 9)', () => {
	it('re-lays a transposed sung note in place, identical to a fresh layout', () => {
		const { score, layout } = lay([
			[['C5', 'half', sing('Al', 'begin')], ['D5', 'half', sing('le', 'middle')]],
			[['E5', 'half', sing('lu', 'middle')], ['C5', 'half', sing('ia', 'end', { extend: 'start' })]],
			[['B4', 'whole']]
		]);
		const target = score.measures[1]!.notes[0]!;
		score.transposeNote(target.id, 1);
		const scoped = relayoutMeasure(score, layout, 1, { staffSpacePx: SS });
		expect(scoped).not.toBeNull();
		const fresh = layoutScore(score, { staffSpacePx: SS });
		expect(scoped!.measures[1]!.ops.filter((op) => op.kind === 'text' || op.kind === 'rect').length).toBe(
			fresh.measures[1]!.ops.filter((op) => op.kind === 'text' || op.kind === 'rect').length
		);
		expect(textsIn(scoped!.measures[1]!)).toEqual(textsIn(fresh.measures[1]!));
		expect(lyricRects(scoped!.measures[1]!, scoped!.staffTopY)).toEqual(lyricRects(fresh.measures[1]!, fresh.staffTopY));
	});

	it('falls back to a full layout when an edit removes a verse line from a row', () => {
		const score = buildScore([[['C5', 'whole', { lyrics: [{ text: 'a' }, { verse: '2', text: 'b' }] }]], [['D5', 'whole', sing('c')]]]);
		const layout = layoutScore(score, { staffSpacePx: SS });
		const only = score.measures[0]!.notes[0]!;
		score.noteToRest(only.id);
		expect(relayoutMeasure(score, layout, 0, { staffSpacePx: SS })).toBeNull();
		// The fresh layout has one verse line left.
		expect(layoutScore(score, { staffSpacePx: SS }).systems[0]!.lyricVerses).toEqual(['1']);
	});

	it('falls back when a moved syllable would leave another measure\'s hyphen piece stale', () => {
		const { score, layout } = lay([
			[['C5', 'half'], ['E5', 'half', sing('Hal', 'begin')]],
			[['F5', 'whole']],
			[['G5', 'whole', sing('le', 'end')]]
		]);
		expect(hyphensIn(layout.measures[1]!, layout.staffTopY).length + hyphensIn(layout.measures[2]!, layout.staffTopY).length).toBeGreaterThan(0);
		// A sharp moves the E5's head right, so the hyphens towards "le" move.
		const e5 = score.measures[0]!.notes[1]!;
		e5.pitch = { ...e5.pitch!, alter: 1 };
		expect(relayoutMeasure(score, layout, 0, { staffSpacePx: SS })).toBeNull();
	});
});
