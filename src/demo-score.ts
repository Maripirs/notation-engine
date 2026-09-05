// The Phase 0 fixture score.
//
// One score, used by the demo page, the unit tests and the redraw benchmark, so
// that what a human sees on screen is literally what the region-scoped-redraw
// proof asserts about and what the timings were measured on. Four measures in
// G major, 4/4, chosen to exercise every part of Phase 0's engraving: all four
// supported durations, a rest, a flagged eighth pair, ledger lines above and
// below the staff, and a note (F sharp) whose accidental the key signature
// already covers so nothing is drawn for it.
//
// This fixture's exact shape (four measures, thirteen notes) is load-bearing
// for tests elsewhere: region-scoped redraw call counts, multi-system
// casting-off assertions, hit-test coordinates. `createDemoScore` therefore
// stays frozen; Slice 1's new durations get their own measures below, folded
// into what the browser demo shows via `createFullDemoScore` instead of into
// this fixture.

import { buildScore, TRIPLET, type Score } from './model/score.js';

export function createDemoScore(): Score {
	return buildScore(
		[
			[
				['G4', 'quarter'],
				['B4', 'quarter'],
				['D5', 'half']
			],
			[
				['E5', 'quarter'],
				['F#5', 'quarter'],
				['G5', 'quarter'],
				['A5', 'quarter']
			],
			[
				['G5', 'eighth'],
				['F#5', 'eighth'],
				['E5', 'quarter'],
				['D5', 'half']
			],
			[
				['C4', 'half'],
				[null, 'half']
			]
		],
		{ keyFifths: 1, time: { beats: 4, beatType: 4 } }
	);
}

/**
 * Slice 1's duration-model showcase, extended by Slice 2 with a third measure
 * of beamed eighths. Three measures, still in G major 4/4, that between them
 * draw every duration value Slice 1 added (16th, 32nd, 64th), a double-dotted
 * and a single-dotted note, a full measure of triplets, and (Slice 2) a
 * measure of plain eighth-note pairs so a human looking at `npm run dev` sees
 * an actual beam, not stacked individual flags.
 *
 * Each measure's notes are chosen to sum to exactly the time signature's
 * capacity (`validateMeasure` passes on all three), the same discipline a real
 * score needs and the thing this slice's capacity check exists to catch when
 * it is violated by mistake.
 */
export function createDurationShowcaseScore(): Score {
	return buildScore(
		[
			[
				// In 64ths (4/4's capacity is 64/64): the double-dotted quarter is
				// 28, the eighth 8, the 16th 4, the 32nd 2, the 64th 1, summing to
				// 43. The rests fill the remaining 21 (a quarter's 16, a 16th's 4,
				// a 64th's 1) out to a full 64.
				//
				// This measure is also, unplanned but instructive, Slice 2's first
				// beaming example: the eighth lands alone in its beat and keeps its
				// individual flag, while the 16th/32nd/64th land together in the
				// next beat and beam, with a secondary beam over the 16th+32nd pair
				// and a tertiary beam over the 32nd+64th pair.
				['G4', 'quarter', { dots: 2 }],
				['A4', 'eighth'],
				['B4', '16th'],
				['C5', '32nd'],
				['D5', '64th'],
				[null, 'quarter'],
				[null, '16th'],
				[null, '64th']
			],
			[
				// Two groups of three triplet quarters, each group taking the time
				// of two quarters, fill the measure the way a written "3" over each
				// group's bracket would in real notation (the bracket itself is a
				// later slice; the duration math is this one's). Quarters are never
				// beam-eligible, so this measure has no beaming to demonstrate.
				['F#5', 'quarter', { tuplet: TRIPLET }],
				['E5', 'quarter', { tuplet: TRIPLET }],
				['D5', 'quarter', { tuplet: TRIPLET }],
				['C5', 'quarter', { tuplet: TRIPLET }],
				['B4', 'quarter', { tuplet: TRIPLET }],
				['A4', 'quarter', { tuplet: TRIPLET }]
			],
			[
				// An ascending then descending scale in plain eighths: eight notes,
				// each pair sharing a quarter-note beat, so 4/4's beat-based
				// grouping (Slice 2) draws four separate two-note beams rather than
				// one beam across the whole bar. The clean, single-level case
				// `flag8thUp`/`flag8thDown`'s glyphs at the top of this file exist
				// to draw when there is no beamable neighbour, here rendered as a
				// beam instead.
				['G4', 'eighth'],
				['A4', 'eighth'],
				['B4', 'eighth'],
				['C5', 'eighth'],
				['D5', 'eighth'],
				['C5', 'eighth'],
				['B4', 'eighth'],
				['A4', 'eighth']
			]
		],
		{ keyFifths: 1, time: { beats: 4, beatType: 4 } }
	);
}

/**
 * What `npm run dev` actually shows: the Phase 0 fixture followed by Slice 1's
 * duration showcase, so a human can see the new durations render without
 * disturbing `createDemoScore`'s frozen shape (see the comment on it above).
 */
export function createFullDemoScore(): Score {
	const score = createDemoScore();
	const showcase = createDurationShowcaseScore();
	for (const measure of showcase.measures) {
		const copy = score.appendMeasure();
		for (const note of measure.notes) {
			score.appendNote(copy, {
				pitch: note.pitch,
				value: note.value,
				dots: note.dots,
				tuplet: note.tuplet ?? undefined
			});
		}
	}
	return score;
}
