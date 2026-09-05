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

import { buildScore, TRIPLET, type NoteId, type Score } from './model/score.js';

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
 * Slice 4's accidental showcase: same-measure repeat suppression, the
 * reverting case that must *not* be suppressed, and the tight-spacing
 * collision clearance, all in C major (`keyFifths: 0`) so every accidental
 * drawn here is one the key signature does not already supply (unlike the
 * other showcases' G major, where an F-sharp needs no accidental at all).
 */
export function createAccidentalShowcaseScore(): Score {
	return buildScore(
		[
			[
				// F-sharp, restated (suppressed: same alter, same step, still in
				// force), then F-natural (a real change, drawn), then F-sharp again
				// (a real change back, drawn once more rather than staying
				// suppressed just because it matches the very first note).
				['F#5', 'quarter'],
				['F#5', 'quarter'],
				['F5', 'quarter'],
				['F#5', 'quarter']
			],
			[
				// Filler rests bring the measure up to 4/4 before the pair this
				// measure exists to show: C4, a 64th, draws a ledger line one line
				// below the staff and claims barely more horizontal room than that
				// ledger line's own ink reaches. C-sharp 4 right after it needs a
				// sharp (C major has none), which without this slice's collision
				// clearance would print on top of that ledger line.
				[null, 'half'],
				[null, 'quarter'],
				[null, 'eighth'],
				[null, '16th'],
				[null, '32nd'],
				['C4', '64th'],
				['C#4', '64th']
			]
		],
		{ keyFifths: 0, time: { beats: 4, beatType: 4 } }
	);
}

/**
 * Slice 5's tie showcase: a same-measure tie and a tie crossing a barline, in
 * G major 4/4 like the other showcases (so the tied notes' own accidentals,
 * where they have one, are exercised the same way the rest of the demo is).
 */
export function createTieShowcaseScore(): Score {
	return buildScore(
		[
			[
				// Same-measure tie: two quarter D5s tied into one continuous
				// duration, followed by a plain half note so the measure still
				// fills 4/4.
				['D5', 'quarter', { tiedToNext: true }],
				['D5', 'quarter'],
				['E5', 'half']
			],
			[
				// Tie across the barline: the second half of the previous measure
				// (F#5) ties into the downbeat of this one. G major spells F#5
				// with no accidental of its own, so this also shows a tie that
				// does not have to dodge one.
				[null, 'half'],
				['F#5', 'half', { tiedToNext: true }]
			],
			[
				['F#5', 'quarter'],
				['G5', 'quarter'],
				['A5', 'half']
			]
		],
		{ keyFifths: 1, time: { beats: 4, beatType: 4 } }
	);
}

/** Copy every note of `source`'s measures onto the end of `score`, preserving
 *  each note's full spec, including any tie. The showcases are built as
 *  standalone scores (so their own unit tests can lay them out and validate
 *  them in isolation) and then folded onto the single score `npm run dev`
 *  actually renders; this is the fold, shared by every showcase
 *  `createFullDemoScore` appends.
 *
 * A tie's target gets a brand new id once copied (ids are assigned by the
 * destination `score`, not carried over from `source`), so ties are wired up
 * in a second pass here, the same reason `buildScore` resolves
 * `extra.tiedToNext` in one: a source note copied before its tie's target is
 * copied has nothing yet to point at. */
function appendMeasures(score: Score, source: Score): void {
	const copiedIdOf = new Map<NoteId, NoteId>();
	for (const measure of source.measures) {
		const copy = score.appendMeasure();
		for (const note of measure.notes) {
			const copiedNote = score.appendNote(copy, {
				pitch: note.pitch,
				value: note.value,
				dots: note.dots,
				tuplet: note.tuplet ?? undefined
			});
			copiedIdOf.set(note.id, copiedNote.id);
		}
	}
	for (const measure of source.measures) {
		for (const note of measure.notes) {
			if (note.tiedToId === null) continue;
			score.setTie(copiedIdOf.get(note.id)!, copiedIdOf.get(note.tiedToId)!);
		}
	}
}

/**
 * What `npm run dev` actually shows: the Phase 0 fixture followed by Slice 1's
 * duration showcase, Slice 4's accidental showcase and Slice 5's tie
 * showcase, so a human can see all three render without disturbing
 * `createDemoScore`'s frozen shape (see the comment on it above).
 */
export function createFullDemoScore(): Score {
	const score = createDemoScore();
	appendMeasures(score, createDurationShowcaseScore());
	appendMeasures(score, createAccidentalShowcaseScore());
	appendMeasures(score, createTieShowcaseScore());
	return score;
}
