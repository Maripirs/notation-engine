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

/**
 * Slice 6's slur showcase: a short ascending-then-descending run slurred
 * entirely within one measure (the common case, 3-4 notes), and a second
 * slur crossing the barline into the next measure, so `npm run dev` shows
 * both the single-segment and the split-into-per-measure-segments cases.
 * Still G major 4/4 like the other showcases.
 */
export function createSlurShowcaseScore(): Score {
	return buildScore(
		[
			[
				// G4..C5, four notes, slurred as one phrase; D5 and E5 fill out
				// the measure without joining the slur.
				['G4', 'eighth'],
				['A4', 'eighth'],
				['B4', 'eighth'],
				['C5', 'eighth'],
				['D5', 'quarter'],
				['E5', 'quarter']
			],
			[
				// A second slur starts on this measure's D5 (the last note above)
				// and ends on this measure's G5, crossing the barline in between.
				['F#5', 'quarter'],
				['G5', 'quarter'],
				['A5', 'half']
			]
		],
		{ keyFifths: 1, time: { beats: 4, beatType: 4 } },
		[
			{ start: [0, 0], end: [0, 3] }, // G4..C5, within measure 0
			{ start: [0, 4], end: [1, 1] } // D5 (measure 0) into G5 (measure 1)
		]
	);
}

/**
 * Slice 7's key/time-change showcase: a key change (G major -> D major, one
 * more sharp) partway through, then a time change (4/4 -> 3/4) further along,
 * each landing at its own measure and announced there by an inline courtesy
 * signature (see `layoutMeasure`'s key/time-change handling). Still starts in
 * G major 4/4 like the other showcases.
 */
export function createKeyTimeChangeShowcaseScore(): Score {
	return buildScore(
		[
			[
				['G4', 'quarter'],
				['A4', 'quarter'],
				['B4', 'quarter'],
				['C5', 'quarter']
			],
			{
				// Key change to D major (2 sharps): F# carries straight over from
				// G major, C# is the accidental the key signature newly implies.
				keyFifths: 2,
				notes: [
					['D5', 'quarter'],
					['C5', 'quarter'],
					['B4', 'quarter'],
					['A4', 'quarter']
				]
			},
			[
				['G4', 'quarter'],
				['A4', 'quarter'],
				['B4', 'quarter'],
				['C5', 'quarter']
			],
			{
				// Time change to 3/4, still in D major (no key field here, so it
				// carries forward unchanged per `Score.keyFifthsAt`'s walk-back).
				time: { beats: 3, beatType: 4 },
				notes: [
					['D5', 'quarter'],
					['E5', 'quarter'],
					['F#5', 'quarter']
				]
			}
		],
		{ keyFifths: 1, time: { beats: 4, beatType: 4 } }
	);
}

/**
 * Slice 8's barline showcase: a double barline marking a section boundary,
 * then (after a plain measure) a repeat-start/repeat-end pair around a short
 * repeated phrase. Still G major 4/4 like the other showcases. `'normal'` and
 * `'final'` need no showcase measure of their own: every ordinary boundary in
 * this demo is already `'normal'` by default, and the whole demo's true last
 * measure already draws `'final'` the same way it always has.
 *
 * The plain measure between the double barline and the repeat start is not
 * padding: `Score.endBarlineAt` resolves a boundary to `'repeatStart'`
 * whenever the *following* measure opens with one, regardless of what the
 * *preceding* measure's own `endBarline` asked for (see its own comment for
 * why that precedence is correct). Putting the double barline directly before
 * the repeat-start measure would silently lose the double barline to that
 * rule; the plain measure keeps the two marks on two different boundaries so
 * both actually render.
 */
export function createBarlineShowcaseScore(): Score {
	return buildScore(
		[
			{
				// A double barline: no repeat, just a visible section break.
				endBarline: 'double',
				notes: [
					['G4', 'quarter'],
					['A4', 'quarter'],
					['B4', 'quarter'],
					['C5', 'quarter']
				]
			},
			[
				['D5', 'quarter'],
				['E5', 'quarter'],
				['F#5', 'quarter'],
				['G5', 'quarter']
			],
			{
				// Opens the repeated section: a thick line then two dots, at this
				// measure's own start.
				startBarline: 'repeatStart',
				notes: [
					['G5', 'quarter'],
					['F#5', 'quarter'],
					['E5', 'quarter'],
					['D5', 'quarter']
				]
			},
			{
				// Closes it: two dots then a thick line, at this measure's own end.
				endBarline: 'repeatEnd',
				notes: [
					['D5', 'quarter'],
					['E5', 'quarter'],
					['F#5', 'quarter'],
					['G5', 'quarter']
				]
			}
		],
		{ keyFifths: 1, time: { beats: 4, beatType: 4 } }
	);
}

/**
 * M2 Slice 1's two-voice showcase: two measures in G major 4/4, still
 * consistent with the other showcases, that between them exercise every
 * piece of this slice's scope. `MeasureSpec`'s literal stays one flat array
 * per measure (voice 1's notes written first, then voice 2's; `extra.voice`
 * marks which is which) since layout groups by voice itself and never needs
 * the two voices' tuples interleaved token-for-token to read correctly.
 *
 * Measure 1 is the task's own suggested case, "a half-note voice against a
 * running eighth-note voice": voice 1 is two half notes (G4, C5), voice 2 is
 * eight running eighths. This exercises three things at once. Onset-aligned
 * columns: voice 2's eighths land on their own shared column at every
 * eighth-note onset, and voice 1's second half note (onset 0.5) lands on
 * whichever of those columns falls at the same position, not wherever voice
 * 1's own first note's advance alone would have put it. Independent
 * per-voice beaming: voice 2's eight eighths still beam into four
 * quarter-beat pairs exactly as a single beamed voice would, unaffected by
 * voice 1's much slower notes sharing the measure. And the stem-direction
 * override actually overriding pitch, not just agreeing with it by
 * coincidence: C5 (voice 1) sits above the middle line, where the ordinary
 * pitch rule would pick a down-stem, but voice 1 is forced up regardless;
 * every one of voice 2's eighths sits below the middle line, where the
 * pitch rule would pick up-stems, but voice 2 is forced down regardless.
 * F4 is deliberately avoided in voice 2's line so this measure's only
 * accidental-adjacent concern is the two voices' own independent per-voice
 * accidental tracking, not a G-major sharp.
 *
 * Measure 2 exercises the rest-offset convention: both voices open with a
 * quarter rest at the very same onset (0), which without a per-voice offset
 * would print the two rest glyphs on top of each other; with it, voice 1's
 * rest shifts up and voice 2's shifts down, visibly clearing each other.
 *
 * Not validated against `validateMeasure`/`measureDurationWholes` the way
 * every earlier showcase's measures are: both of those sum a measure's
 * notes across *all* voices (see `measureDurationWholes`'s own doc comment,
 * written for a single voice), so a fully-valid two-voice 4/4 measure like
 * either one here sums to 2 wholes of "duration" by that formula and would
 * incorrectly fail a capacity check that was never updated for more than one
 * voice. That gap is real and left open by this slice (multi-voice measure
 * capacity is out of its scope, only note/beam/stem/rest layout is), flagged
 * here rather than silently worked around with a validation call that would
 * have failed for reasons unrelated to what this showcase demonstrates.
 */
export function createTwoVoiceShowcaseScore(): Score {
	return buildScore(
		[
			[
				['G4', 'half', { voice: 1 }],
				['C5', 'half', { voice: 1 }],
				['C4', 'eighth', { voice: 2 }],
				['D4', 'eighth', { voice: 2 }],
				['E4', 'eighth', { voice: 2 }],
				['G4', 'eighth', { voice: 2 }],
				['A4', 'eighth', { voice: 2 }],
				['G4', 'eighth', { voice: 2 }],
				['E4', 'eighth', { voice: 2 }],
				['D4', 'eighth', { voice: 2 }]
			],
			[
				[null, 'quarter', { voice: 1 }],
				['G4', 'quarter', { voice: 1 }],
				['A4', 'quarter', { voice: 1 }],
				['B4', 'quarter', { voice: 1 }],
				[null, 'quarter', { voice: 2 }],
				['C4', 'quarter', { voice: 2 }],
				['D4', 'quarter', { voice: 2 }],
				['E4', 'quarter', { voice: 2 }]
			]
		],
		{ keyFifths: 1, time: { beats: 4, beatType: 4 } }
	);
}

/** Copy every note of `source`'s measures onto the end of `score`, preserving
 *  each note's full spec, including any tie or slur. The showcases are built
 *  as standalone scores (so their own unit tests can lay them out and
 *  validate them in isolation) and then folded onto the single score
 *  `npm run dev` actually renders; this is the fold, shared by every showcase
 *  `createFullDemoScore` appends.
 *
 * A tie's target, and a slur's two ends, all get brand new ids once copied
 * (ids are assigned by the destination `score`, not carried over from
 * `source`), so both are wired up in a second pass here, the same reason
 * `buildScore` resolves `extra.tiedToNext` and a `SlurSpec` in one: a source
 * note copied before the note(s) it points at are copied has nothing yet to
 * point at. */
function appendMeasures(score: Score, source: Score): void {
	const copiedIdOf = new Map<NoteId, NoteId>();
	for (const measure of source.measures) {
		const copy = score.appendMeasure();
		// A per-measure key/time change is already an absolute value (not a
		// delta from the source score's own initial one), so it carries over
		// unchanged regardless of where this showcase lands in the combined
		// score or what key/time was already in force there.
		copy.keyFifths = measure.keyFifths;
		copy.time = measure.time;
		// Same reasoning as keyFifths/time above: a barline choice is already an
		// absolute value with no score-wide default to reinterpret, so it
		// carries over unchanged. The one exception, an *unset* endBarline on
		// the source's own last measure, is not something to special-case here:
		// once folded in, that measure is no longer the combined score's last
		// measure (unless this happens to be the final showcase appended), so
		// `Score.endBarlineAt`'s own default naturally resolves it to 'normal'
		// instead of 'final', exactly as it would for any other measure that
		// stopped being the score's last one.
		copy.endBarline = measure.endBarline;
		copy.startBarline = measure.startBarline;
		for (const note of measure.notes) {
			const copiedNote = score.appendNote(copy, {
				pitch: note.pitch,
				value: note.value,
				dots: note.dots,
				tuplet: note.tuplet ?? undefined,
				voice: note.voice
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
	for (const slur of source.slurs) {
		score.addSlur(copiedIdOf.get(slur.startNoteId)!, copiedIdOf.get(slur.endNoteId)!);
	}
}

/**
 * What `npm run dev` actually shows: the Phase 0 fixture followed by Slice 1's
 * duration showcase, Slice 4's accidental showcase, Slice 5's tie showcase,
 * Slice 6's slur showcase, Slice 7's key/time-change showcase, Slice 8's
 * barline showcase and M2 Slice 1's two-voice showcase, so a human can see
 * all seven render without disturbing `createDemoScore`'s frozen shape (see
 * the comment on it above).
 */
export function createFullDemoScore(): Score {
	const score = createDemoScore();
	appendMeasures(score, createDurationShowcaseScore());
	appendMeasures(score, createAccidentalShowcaseScore());
	appendMeasures(score, createTieShowcaseScore());
	appendMeasures(score, createSlurShowcaseScore());
	appendMeasures(score, createKeyTimeChangeShowcaseScore());
	appendMeasures(score, createBarlineShowcaseScore());
	appendMeasures(score, createTwoVoiceShowcaseScore());
	return score;
}
