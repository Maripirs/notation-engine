// Repeats and voltas through MusicXML (M6 Slice 12): `<ending>` and a
// backward `<repeat times>` read into the model and written back.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertScoresEquivalent, type Measure } from '../model/index.js';
import { child, children, type XmlElement } from './xml.js';
import { measuresOf, n, names, onePart, roundTrip } from './test-helpers.js';

const FIXTURE = readFileSync(join(import.meta.dirname, '../test/fixtures/repeats-voltas.musicxml'), 'utf8');

/** A measure's volta fields, compactly: `"1|1."` for a start, `"stop"` for an end. */
function voltaOf(measure: Measure): string[] {
	const out: string[] = [];
	if (measure.endingStart) out.push(`${measure.endingStart.numbers.join(',')}|${measure.endingStart.text ?? ''}`);
	if (measure.endingEnd) out.push(measure.endingEnd.kind);
	return out;
}

/** Every `<ending>` in an exported part, as `number/type/text`. */
function endingsIn(root: XmlElement): string[] {
	return measuresOf(root).flatMap((m) =>
		children(m, 'barline').flatMap((b) => children(b, 'ending').map((e) => `${e.attrs.number}/${e.attrs.type}/${e.text}`))
	);
}

describe('voltas and repeat counts', () => {
	it('reads the fixture into per-measure endings and round-trips it', () => {
		const { score, root } = roundTrip(FIXTURE);
		const measures = score.staves[0]!.measures;
		expect(measures.map(voltaOf)).toEqual([
			[],
			[],
			['1|1.'],
			['stop'],
			['2|2.', 'discontinue'],
			[],
			['1,2|1.-2.', 'stop'],
			['3|', 'discontinue'],
			[]
		]);
		expect(measures.map((m) => m.repeatTimes ?? null)).toEqual([null, null, null, null, null, null, 3, null, null]);
		expect(measures.every((m) => m.barlinePassthrough.length === 0)).toBe(true);
		expect(endingsIn(root)).toEqual([
			'1/start/1.',
			'1/stop/',
			'2/start/2.',
			'2/discontinue/',
			'1, 2/start/1.-2.',
			'1, 2/stop/',
			'3/start/',
			'3/discontinue/'
		]);
		// An attribute the model does not interpret rides along on the ending.
		expect(child(child(measuresOf(root)[2]!, 'barline')!, 'ending')!.attrs['default-y']).toBe('40');
		expect(child(children(measuresOf(root)[6]!, 'barline').at(-1)!, 'repeat')!.attrs).toEqual({ direction: 'backward', times: '3' });
		assertScoresEquivalent(score.clone(), score);
	});

	// Each measure's barlines: a left one as written, or `R` + the inner XML
	// of a right one. `kept` is how many stay passthrough, `modelled` how many
	// measures hold a volta field.
	it.each([
		['a start never closed', [`<barline location="left"><ending number="1" type="start"/></barline>`, '', ''], 1, 0],
		[
			'numbers that do not match',
			[`<barline location="left"><ending number="1" type="start"/></barline>`, `R<ending number="2" type="stop"/>`, ''],
			2,
			0
		],
		[
			'a start interrupted by another',
			[
				`<barline location="left"><ending number="1" type="start"/></barline>`,
				`<barline location="left"><ending number="2" type="start"/></barline>`,
				`R<ending number="2" type="discontinue"/>`
			],
			1,
			2
		],
		['a start on a right barline', [`R<ending number="1" type="start"/>`, `R<ending number="1" type="stop"/>`, ''], 2, 0]
	])('keeps a malformed ending as passthrough: %s', (_label, barlines, kept, modelled) => {
		const xml = onePart(
			barlines.map((b, i) => {
				const isRight = b.startsWith('R');
				return (isRight ? '' : b) + n('CDE'[i]!, 4, 'whole') + (isRight ? `<barline location="right">${b.slice(1)}</barline>` : '');
			}),
			1
		);
		const { score, root } = roundTrip(xml);
		const measures = score.staves[0]!.measures;
		expect(measures.flatMap((m) => m.barlinePassthrough)).toHaveLength(kept);
		expect(measures.filter((m) => m.endingStart || m.endingEnd)).toHaveLength(modelled);
		expect(endingsIn(root)).toHaveLength(barlines.filter((b) => b !== '').length);
	});

	it.each([
		[
			'an ending on a plain barline is written with no bar-style',
			`<barline location="left"><ending number="1" type="start"/></barline>`,
			`<barline location="right"><ending number="1" type="discontinue"/></barline>`,
			['ending'],
			['ending']
		],
		[
			'an unread bar-style and a fermata beside an ending stay in schema order',
			`<barline location="left"><bar-style>dashed</bar-style><ending number="1" type="start"/></barline>`,
			`<barline location="right"><bar-style>light-light</bar-style><fermata/><ending number="1" type="stop"/></barline>`,
			['bar-style', 'ending'],
			['bar-style', 'fermata', 'ending']
		]
	])('%s', (_label, left, right, leftNames, rightNames) => {
		const { score, root } = roundTrip(onePart([left + n('C', 4, 'whole') + right, n('D', 4, 'whole')], 1));
		expect(voltaOf(score.staves[0]!.measures[0]!)).toHaveLength(2);
		const [leftBarline, rightBarline] = children(measuresOf(root)[0]!, 'barline');
		expect(names(leftBarline!)).toEqual(leftNames);
		expect(names(rightBarline!)).toEqual(rightNames);
	});
});
