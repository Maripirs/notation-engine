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

import { parsePitch } from './model/pitch.js';
import { ACCIACCATURA, APPOGGIATURA, buildScore, Score, TRIPLET, type NoteId, type NoteValue } from './model/score.js';

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
 * Validated against `validateMeasure` the way every earlier showcase's
 * measures are (see the M2 scoping-recheck test that walks both of this
 * showcase's measures): `validateMeasure` was originally written summing a
 * measure's notes across *all* voices (`measureDurationWholes`'s own doc
 * comment is explicit that it means a single voice), so a fully-valid
 * two-voice 4/4 measure like either one here summed to 2 wholes of "duration"
 * by that formula and incorrectly failed a capacity check that had never been
 * updated for more than one voice. That gap has since been closed:
 * `validateMeasure` now groups a measure's notes by `Note.voice` and checks
 * each voice's own sum against the time signature's capacity independently,
 * so both of this showcase's measures (each voice here separately a full bar
 * of its own) validate correctly.
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

/**
 * M2 Slice 2's voice-collision showcase: two measures in G major 4/4,
 * exercising this slice's two collision-avoidance paths in isolation from
 * each other.
 *
 * Measure 1 is a run of parallel seconds, voice 2 shadowing voice 1 one
 * diatonic step below at every single beat (E5/D5, D5/C5, C5/B4, D5/C5):
 * without this slice, all four pairs would print their noteheads directly
 * on top of each other, since a second apart is exactly the interval two
 * noteheads cannot both occupy at the same x without visibly merging. Each
 * pair instead resolves to voice 2 nudged one notehead's width right of
 * voice 1, the plain "same or adjacent beat" case
 * `secondIntervalClashShift` exists for; the nudge is deliberately
 * recomputed fresh at every beat here (not just applied once and left),
 * showing it holds up across a whole passage, not only a single isolated
 * clash.
 *
 * Measure 2 isolates the other path: voice 1's C4 whole note (no stem, a
 * whole note never gets one, keeping this measure's ink the ledger line's
 * alone) against voice 2's C#5 quarter at the very same onset, an octave
 * and a half away, nowhere near a second, so the notehead nudge above
 * never engages here. G major already has an F#, but not a C#, so voice
 * 2's sharp still needs drawing; without this slice's cross-voice
 * `previousInkRight`, it would check only its own (nonexistent, first-note)
 * previous ink and land with no clearance from voice 1's ledger line
 * sharing the same x.
 */
export function createVoiceClashShowcaseScore(): Score {
	return buildScore(
		[
			[
				['E5', 'quarter', { voice: 1 }],
				['D5', 'quarter', { voice: 1 }],
				['C5', 'quarter', { voice: 1 }],
				['D5', 'quarter', { voice: 1 }],
				['D5', 'quarter', { voice: 2 }],
				['C5', 'quarter', { voice: 2 }],
				['B4', 'quarter', { voice: 2 }],
				['C5', 'quarter', { voice: 2 }]
			],
			[
				['C4', 'whole', { voice: 1 }],
				['C#5', 'quarter', { voice: 2 }]
			]
		],
		{ keyFifths: 1, time: { beats: 4, beatType: 4 } }
	);
}

/**
 * M2 Slice 3's clef showcase: one `Score` with three staves, one per new
 * clef (treble, bass, treble8), each notating the exact same short phrase (a
 * one-octave scale, C4 up to C5), so a human looking at the rendered PNG can
 * see how the same written pitches land in very different places under each
 * clef: middle C sits on a ledger line below the treble/treble8 staff and in
 * the middle of the bass staff, while the octave's top C sits in the third
 * space of a treble staff and requires two ledger lines above a bass one.
 *
 * Built directly against `Score`'s own `appendStaff`/`appendMeasure`/
 * `appendNote` calls rather than `buildScore`'s compact per-staff literal:
 * `buildScore` only ever populates one implicit staff (this slice
 * deliberately did not extend its literal syntax to a multi-staff shape,
 * since nothing outside this one showcase needs to build a multi-staff score
 * by hand yet), so a genuinely multi-staff fixture goes through the same
 * lower-level calls `buildScore` itself uses internally.
 *
 * Deliberately *not* folded into `createFullDemoScore`/`npm run dev`'s single
 * combined score the way every other showcase is: doing so would need
 * `appendMeasures` to merge a multi-staff source score into a (so far
 * always single-staff) destination, real work with no payoff for this
 * slice's own scope, whose acceptance criteria only ask for a demo that
 * *shows* the three clefs rendering correctly, not one that stacks them
 * alongside the rest of the frozen demo fixture. Per this slice's own scope
 * note, it is "fine, and probably correct" for the demo to render staves
 * like this rather than build real multi-staff system stacking (M2 Slice
 * 4's job); this is verified instead by rasterizing `layoutScore` on this
 * function's own three-staff score directly through node-canvas and
 * inspecting the PNG by eye, this repo's usual no-browser-automation
 * approach for anything visual.
 */
export function createClefShowcaseScore(): Score {
	const score = new Score({ keyFifths: 0, time: { beats: 4, beatType: 4 } });
	// `Score`'s own constructor already creates staff 0 as a plain treble
	// staff; naming it explicitly here makes the showcase's three-clef intent
	// visible at the call site rather than left implicit.
	score.staves[0]!.clef = 'treble';
	score.appendStaff('bass');
	score.appendStaff('treble8');

	const phrase: readonly (readonly [string, NoteValue])[] = [
		['C4', 'quarter'],
		['D4', 'quarter'],
		['E4', 'quarter'],
		['F4', 'quarter'],
		['G4', 'quarter'],
		['A4', 'quarter'],
		['B4', 'quarter'],
		['C5', 'quarter']
	];
	for (let staffIndex = 0; staffIndex < score.staves.length; staffIndex++) {
		for (const half of [phrase.slice(0, 4), phrase.slice(4)]) {
			const measure = score.appendMeasure(staffIndex);
			for (const [pitch, value] of half) {
				score.appendNote(measure, { pitch: parsePitch(pitch), value });
			}
		}
	}
	return score;
}

/**
 * M2 Slice 4's grand-staff showcase: a two-staff piano-style score (treble
 * over bass) with a *different* key signature per staff (D major over Eb
 * major, a deliberately implausible pairing no real piece would use, chosen
 * precisely because it makes each staff's own independent header impossible
 * to confuse with the other's at a glance), four measures, ending in a
 * `'final'` double-thick barline. The treble staff plays a busy run of
 * eighth notes while the bass staff plays sparser quarter notes and whole
 * notes, so a human looking at the rendered PNG can also see the column-
 * width sharing this slice adds: the bass staff's own narrower measures pad
 * out to match the treble staff's wider ones, keeping every barline in the
 * combined system a single straight vertical line across both staves.
 *
 * Built the same low-level way `createClefShowcaseScore` (M2 Slice 3) is,
 * for the same reason: `buildScore` only ever populates one implicit staff.
 * Deliberately *not* folded into `createFullDemoScore`/`npm run dev`'s single
 * combined score, again for the same reason `createClefShowcaseScore` is
 * not: `appendMeasures` only ever merges a source score into a single-staff
 * destination, and a second, differently-shaped multi-staff fixture has no
 * more payoff there than the first one did. Verified the same way too:
 * rasterizing `layoutScore` on this function's own score directly through
 * node-canvas and inspecting the PNG by eye.
 */
export function createGrandStaffShowcaseScore(): Score {
	const score = new Score({ keyFifths: 2, time: { beats: 4, beatType: 4 } });
	score.staves[0]!.clef = 'treble';
	score.appendStaff('bass');

	const treblePhrases: readonly (readonly (readonly [string, NoteValue])[])[] = [
		[
			['D5', 'eighth'],
			['E5', 'eighth'],
			['F#5', 'eighth'],
			['G5', 'eighth'],
			['A5', 'eighth'],
			['B5', 'eighth'],
			['C#6', 'eighth'],
			['D6', 'eighth']
		],
		[
			['D6', 'eighth'],
			['C#6', 'eighth'],
			['B5', 'eighth'],
			['A5', 'eighth'],
			['G5', 'eighth'],
			['F#5', 'eighth'],
			['E5', 'eighth'],
			['D5', 'eighth']
		],
		[['A5', 'quarter'], ['G5', 'quarter'], ['F#5', 'quarter'], ['E5', 'quarter']],
		[['D5', 'whole']]
	];
	const bassPhrases: readonly (readonly (readonly [string, NoteValue])[])[] = [
		[['Eb3', 'whole']],
		[['Bb2', 'half'], ['Eb3', 'half']],
		[['Ab2', 'quarter'], ['Eb3', 'quarter'], ['G3', 'quarter'], ['Eb3', 'quarter']],
		[['Eb2', 'whole']]
	];

	for (let i = 0; i < treblePhrases.length; i++) {
		// No explicit `keyFifths` override needed here: the score's own initial
		// value (2, D major) already applies to every staff by default, and
		// only staff 1 (bass) needs to diverge from it below.
		const trebleMeasure = score.appendMeasure(0);
		for (const [pitch, value] of treblePhrases[i]!) {
			score.appendNote(trebleMeasure, { pitch: parsePitch(pitch), value });
		}
	}
	for (let i = 0; i < bassPhrases.length; i++) {
		const bassMeasure = score.appendMeasure(1);
		if (i === 0) bassMeasure.keyFifths = -3;
		for (const [pitch, value] of bassPhrases[i]!) {
			score.appendNote(bassMeasure, { pitch: parsePitch(pitch), value });
		}
	}
	return score;
}

/**
 * M2 Slice 5's part-grouping showcase: a real four-staff SATB choral score
 * (Soprano/Alto in treble, Tenor in treble8 so the same written pitches read
 * naturally for a tenor voice, Bass in bass clef), each staff its own named,
 * single-staff `Part` (so each gets its own label, drawn only at system 1 per
 * this slice's own scope), plus one further, deliberately *unnamed*
 * grouping `Part` spanning all four staff indices, which is what actually
 * draws the bracket (a choir/ensemble group of 3+ staves; see
 * `computePartGroupDecorations`'s own comment on the brace-vs-bracket
 * convention this slice builds). A closed four-part G major hymn phrase,
 * chosen because real SATB voicing naturally exercises every clef's own
 * ledger-line/staff-position range at once (the soprano and tenor reach
 * above their own staves, the bass sits low in its own), which is a useful
 * side effect for eyeballing the render even though this slice's own scope
 * is the bracket and labels, not the clefs (M2 Slice 3's own job).
 *
 * Built the same low-level way `createClefShowcaseScore`/
 * `createGrandStaffShowcaseScore` (M2 Slices 3-4) are, for the same reason:
 * `buildScore` only ever populates one implicit staff. Deliberately *not*
 * folded into `createFullDemoScore`/`npm run dev`'s single combined score,
 * again for the same reason those two showcases are not: `appendMeasures`
 * only ever merges a source score into a single-staff destination. Verified
 * the same way too: rasterizing `layoutScore` on this function's own score
 * directly through node-canvas and inspecting the PNG by eye.
 */
export function createSatbBracketShowcaseScore(): Score {
	const score = new Score({ keyFifths: 1, time: { beats: 4, beatType: 4 }, clef: 'treble' });
	score.appendStaff('treble');
	score.appendStaff('treble8');
	score.appendStaff('bass');

	score.addPart([0], 'Soprano');
	score.addPart([1], 'Alto');
	score.addPart([2], 'Tenor');
	score.addPart([3], 'Bass');
	// The bracket-only grouping: unnamed on purpose, since a per-staff label
	// already names each voice; see this function's own doc comment.
	score.addPart([0, 1, 2, 3]);

	const voicing: readonly (readonly (readonly [string, NoteValue])[])[] = [
		[
			['D5', 'quarter'],
			['G5', 'quarter'],
			['F#5', 'quarter'],
			['G5', 'quarter']
		],
		[
			['B4', 'quarter'],
			['D5', 'quarter'],
			['D5', 'quarter'],
			['D5', 'quarter']
		],
		[
			['G4', 'quarter'],
			['B4', 'quarter'],
			['A4', 'quarter'],
			['B4', 'quarter']
		],
		[
			['G3', 'quarter'],
			['G3', 'quarter'],
			['D3', 'quarter'],
			['G3', 'quarter']
		]
	];
	for (let staffIndex = 0; staffIndex < voicing.length; staffIndex++) {
		const measure = score.appendMeasure(staffIndex);
		for (const [pitch, value] of voicing[staffIndex]!) {
			score.appendNote(measure, { pitch: parsePitch(pitch), value });
		}
	}
	return score;
}

/**
 * M2 Slice 6's cross-staff beaming showcase: a two-staff piano-style score
 * (treble over bass) whose middle measure links two eighth notes in the
 * treble staff to two eighth notes in the bass staff via one
 * `Score.addCrossStaffBeam` call, so the four notes render as one
 * continuous beam crossing the gap between the staves (a piano passage
 * crossing hands). An ordinary filler measure of quarter notes sits on
 * each side of it, so the beamed measure has a normal neighbour on both
 * sides, useful for confirming (in `layout.test.ts`) that the wider region
 * a cross-staff beam needs stays scoped to exactly its own measure column
 * and never leaks into either neighbour's.
 *
 * The beamed measure is deliberately *not* the score's first measure: a
 * system-opening measure draws each staff's own clef/key header before its
 * first note, and this slice's own scope cut (see `Score.addCrossStaffBeam`'s
 * own comment, and `layout.ts`'s cross-staff integration) never coordinates
 * x-position across the staff boundary, only reusing whatever x each
 * staff's own ordinary layout already produces. Putting the beam at measure
 * 1 means neither staff draws a header at that column, so both staves' note
 * cursors start from the exact same x right after the shared
 * `measureLeadIn`; giving both staves *identical* rhythmic content for the
 * beamed pair itself (two plain eighth notes each, no accidentals, no ties)
 * means their per-note x advances also match exactly there, with no extra
 * x-coordination code needed. This is a real, documented scope cut, not a
 * claim that arbitrary cross-staff content always lines up: a measure with
 * different rhythms on each side, or a system-first beamed measure, would
 * not automatically align this way.
 *
 * "Renders as one continuous beam" is verified two ways: a layout-level unit
 * test asserts each side's own beam segment lands at (nearly) the same y and
 * has a real (nonzero) x-extent, and a standalone PNG of this score,
 * rasterized through node-canvas the same way every other showcase is,
 * confirmed by eye that the beam looks unbroken across the staff gap with
 * correct stem directions (treble stems down into the gap, bass stems up
 * into it).
 *
 * A small horizontal jog is visible right where the two segments meet: a
 * down-stem attaches to its notehead's left side and an up-stem to its
 * right (`stemXEdges`'s own ordinary convention, unrelated to and pre-dating
 * this slice), so the forced opposite directions on the two sides of a
 * cross-staff beam put each side's beam segment a hair to a different side
 * of its own noteheads. Still one connected shape (the two segments meet
 * with no gap, see this function's own render check above), not the same as
 * a straight, unbroken bridge; smoothing it away would need per-note
 * x-coordination this slice's own documented scope cut above already
 * excludes.
 *
 * Built the same low-level way `createGrandStaffShowcaseScore`/
 * `createSatbBracketShowcaseScore` (M2 Slices 4-5) are, for the same reason:
 * `buildScore` only ever populates one implicit staff. Deliberately *not*
 * folded into `createFullDemoScore`/`npm run dev`'s single combined score,
 * again for the same reason those two showcases are not: `appendMeasures`
 * only ever merges a source score into a single-staff destination.
 */
export function createCrossStaffBeamShowcaseScore(): Score {
	const score = new Score({ keyFifths: 0, time: { beats: 4, beatType: 4 }, clef: 'treble' });
	score.appendStaff('bass');

	// Measure 0: ordinary filler on both staves, so the beamed measure below
	// is not the system-opening one (see this function's own doc comment).
	const trebleMeasure0 = score.appendMeasure(0);
	for (const pitch of ['C5', 'D5', 'E5', 'F5']) {
		score.appendNote(trebleMeasure0, { pitch: parsePitch(pitch), value: 'quarter' });
	}
	const bassMeasure0 = score.appendMeasure(1);
	for (const pitch of ['C3', 'D3', 'E3', 'F3']) {
		score.appendNote(bassMeasure0, { pitch: parsePitch(pitch), value: 'quarter' });
	}

	// Measure 1: the cross-staff beam itself, at the very start of the
	// measure (right after the shared lead-in) so both staves' cursors are
	// still aligned when it begins. Identical rhythmic content (two eighth
	// notes) on each side for the beamed pair itself, so both staves' natural
	// x advances at this column match exactly with no extra coordination;
	// three plain quarter notes fill out the rest of the 4/4 bar afterward
	// (0.125 + 0.125 + 0.25 + 0.25 + 0.25 = 1 whole note), since this
	// showcase's own measures still need to validate against the time
	// signature like every other showcase's do, not just look right.
	const trebleMeasure1 = score.appendMeasure(0);
	const trebleIds: NoteId[] = [];
	for (const pitch of ['G4', 'A4']) {
		trebleIds.push(score.appendNote(trebleMeasure1, { pitch: parsePitch(pitch), value: 'eighth' }).id);
	}
	for (const pitch of ['B4', 'C5', 'D5']) {
		score.appendNote(trebleMeasure1, { pitch: parsePitch(pitch), value: 'quarter' });
	}
	const bassMeasure1 = score.appendMeasure(1);
	const bassIds: NoteId[] = [];
	for (const pitch of ['C3', 'D3']) {
		bassIds.push(score.appendNote(bassMeasure1, { pitch: parsePitch(pitch), value: 'eighth' }).id);
	}
	for (const pitch of ['E3', 'F3', 'G3']) {
		score.appendNote(bassMeasure1, { pitch: parsePitch(pitch), value: 'quarter' });
	}
	score.addCrossStaffBeam([...trebleIds, ...bassIds]);

	// Measure 2: more ordinary filler, giving the beamed measure a normal
	// neighbour on both sides.
	const trebleMeasure2 = score.appendMeasure(0);
	for (const pitch of ['G5', 'F5', 'E5', 'D5']) {
		score.appendNote(trebleMeasure2, { pitch: parsePitch(pitch), value: 'quarter' });
	}
	const bassMeasure2 = score.appendMeasure(1);
	for (const pitch of ['G3', 'F3', 'E3', 'D3']) {
		score.appendNote(bassMeasure2, { pitch: parsePitch(pitch), value: 'quarter' });
	}

	return score;
}

/**
 * M6 Slice 2's chord showcase: nine measures in C major 4/4 walking through
 * every chord engraving rule the slice adds, so a human can check each one
 * by eye in `npm run dev`.
 *
 * 1. Triads, three up-stem and one high enough (E5-G5-C6) to flip down: one
 *    stem per chord, spanning every head, direction from the outermost head.
 * 2. Seconds: F4-G4 (up stem, the upper head crosses to the right of the
 *    stem), C5-D5 (down stem, the lower head crosses to the left), and two
 *    clusters (E4-F4-G4, B4-C5-D5-E5) whose heads alternate sides.
 * 3. Accidental stacks: Eb-Gb-Bb and F#-A#-C#, three accidentals each, the
 *    top and bottom nearest the heads and the middle one a column further
 *    left.
 * 4. A divisi passage in parallel thirds, the core choral case (two parts
 *    sharing one staff and one stem).
 * 5. Beamed eighth-note chords: each chord is one beam member, the beam and
 *    stems attached to the chord's normal-side heads.
 * 6-7. A tie between chords (each head tied to its own target, the upper
 *    heads' ties curving up and the lower down), then a dotted chord with a
 *    second (one dot per head, a line head's dot moved to the space above).
 * 8. Two voices, each a chord, sharing the staff (voice 1 up, voice 2 down).
 * 9. Ledger lines: A3-B3-D4 (the ledger under the displaced B3 widens to
 *    cover both sides of the stem) and G5-A5-C6 above the staff.
 */
export function createChordShowcaseScore(): Score {
	return buildScore(
		[
			{
				// Stated explicitly (not just the score's initial key) so that,
				// folded into `createFullDemoScore` after a showcase in another
				// key, these measures still read in C major.
				keyFifths: 0,
				notes: [
					[['C4', 'E4', 'G4'], 'quarter'],
					[['F4', 'A4', 'C5'], 'quarter'],
					[['G4', 'B4', 'D5'], 'quarter'],
					[['E5', 'G5', 'C6'], 'quarter']
				]
			},
			[
				[['F4', 'G4'], 'quarter'],
				[['C5', 'D5'], 'quarter'],
				[['E4', 'F4', 'G4'], 'quarter'],
				[['B4', 'C5', 'D5', 'E5'], 'quarter']
			],
			[
				[['Eb4', 'Gb4', 'Bb4'], 'half'],
				[['F#4', 'A#4', 'C#5'], 'half']
			],
			[
				[['A4', 'C5'], 'quarter'],
				[['G4', 'B4'], 'quarter'],
				[['F4', 'A4'], 'quarter'],
				[['E4', 'G4'], 'quarter']
			],
			[
				[['C4', 'E4'], 'eighth'],
				[['D4', 'F4'], 'eighth'],
				[['E4', 'G4'], 'eighth'],
				[['F4', 'A4'], 'eighth'],
				[['G4', 'B4'], 'eighth'],
				[['A4', 'C5'], 'eighth'],
				[['B4', 'D5'], 'eighth'],
				[['C5', 'E5'], 'eighth']
			],
			[
				[['C4', 'E4', 'G4'], 'half'],
				[['D4', 'F4', 'A4'], 'half', { tiedToNext: true }]
			],
			[
				[['D4', 'F4', 'A4'], 'half'],
				[['F4', 'G4', 'B4'], 'quarter', { dots: 1 }],
				[['E4', 'G4', 'C5'], 'eighth']
			],
			[
				[['E5', 'G5'], 'half', { voice: 1 }],
				[['D5', 'F5'], 'half', { voice: 1 }],
				[['C4', 'E4'], 'half', { voice: 2 }],
				[['B3', 'D4'], 'half', { voice: 2 }]
			],
			[
				[['A3', 'B3', 'D4'], 'half'],
				[['G5', 'A5', 'C6'], 'half']
			]
		],
		{ keyFifths: 0, time: { beats: 4, beatType: 4 } }
	);
}

/**
 * M6 Slice 5's showcase: articulations and fermatas, placed by the standard
 * rules (see `layoutEventMarks` in `layout.ts`). In order:
 *
 * 1. Staccato opposite the stem: above a stem-down B4 and C5, below a
 *    stem-up E4 and G4 (G4 sits on a line, so its dot skips the space the
 *    notehead half-fills and the next line, landing in the space below the
 *    staff).
 * 2. Tenuto, accent, staccatissimo, then a marcato on a stem-up note, which
 *    still goes above (beyond the stem tip).
 * 3. Stacks: staccato then accent outward; tenuto then accent; the combined
 *    tenuto-staccato (detached-legato); marcato above with staccato below.
 * 4. Beamed staccato eighths (the marks follow each note's side of the beam's
 *    one shared direction) and accented chords, one mark per chord.
 * 5. Ledger lines: an accent and a staccato above a stem-down A5/C6 (the
 *    marks clear the ledger lines by being beyond the head), staccatos below
 *    a stem-up C4/A3.
 * 6. Fermatas: over a note, over a chord, over a rest, and an inverted one
 *    below the staff.
 * 7. Two voices: voice 1's marks above (beyond its up stems), voice 2's below.
 */
export function createArticulationShowcaseScore(): Score {
	return buildScore(
		[
			{
				keyFifths: 0,
				notes: [
					['B4', 'quarter', { articulations: ['staccato'] }],
					['C5', 'quarter', { articulations: ['staccato'] }],
					['E4', 'quarter', { articulations: ['staccato'] }],
					['G4', 'quarter', { articulations: ['staccato'] }]
				]
			},
			[
				['D5', 'quarter', { articulations: ['tenuto'] }],
				['F4', 'quarter', { articulations: ['accent'] }],
				['A4', 'quarter', { articulations: ['staccatissimo'] }],
				['E4', 'quarter', { articulations: ['strong-accent'] }]
			],
			[
				['C5', 'quarter', { articulations: ['staccato', 'accent'] }],
				['F4', 'quarter', { articulations: ['tenuto', 'accent'] }],
				['A4', 'quarter', { articulations: ['detached-legato'] }],
				['G4', 'quarter', { articulations: ['strong-accent', 'staccato'] }]
			],
			[
				['E4', 'eighth', { articulations: ['staccato'] }],
				['F4', 'eighth', { articulations: ['staccato'] }],
				['G4', 'eighth', { articulations: ['staccato'] }],
				['A4', 'eighth', { articulations: ['staccato'] }],
				[['C4', 'E4', 'G4'], 'quarter', { articulations: ['accent'] }],
				[['C5', 'E5', 'G5'], 'quarter', { articulations: ['staccato', 'accent'] }]
			],
			[
				['A5', 'quarter', { articulations: ['accent'] }],
				['C6', 'quarter', { articulations: ['staccato'] }],
				['C4', 'quarter', { articulations: ['staccato'] }],
				['A3', 'quarter', { articulations: ['tenuto'] }]
			],
			[
				['G4', 'quarter', { fermata: 'upright' }],
				[['E4', 'G4', 'C5'], 'quarter', { fermata: 'upright' }],
				[null, 'quarter', { fermata: 'upright' }],
				['D4', 'quarter', { fermata: 'inverted' }]
			],
			[
				['E5', 'quarter', { voice: 1, articulations: ['staccato'] }],
				['D5', 'quarter', { voice: 1, articulations: ['accent'] }],
				['C5', 'half', { voice: 1, articulations: ['tenuto'], fermata: 'upright' }],
				['G4', 'quarter', { voice: 2, articulations: ['staccato'] }],
				['F4', 'quarter', { voice: 2, articulations: ['accent'] }],
				['E4', 'half', { voice: 2, articulations: ['tenuto'], fermata: 'inverted' }]
			]
		],
		{ keyFifths: 0, time: { beats: 4, beatType: 4 } }
	);
}

/**
 * M6 Slice 6's dynamics and hairpins showcase, eight measures in C major 4/4:
 *
 * 1. `p` under a low note and a crescendo from it to an `f`: the hairpin
 *    starts after the `p` and stops before the `f`.
 * 2. The `f`, then a diminuendo across the barline into measure 3 (in the
 *    demo's systems this barline is also a system break: the diminuendo's
 *    first segment ends half closed and the continuation opens the next
 *    system at that same width).
 * 3. `pp` at the diminuendo's end, under a low A3 with a ledger line: the
 *    whole system's dynamics line drops to clear it.
 * 4. Accent and combination dynamics: `sfz`, `fp`, `rfz`, `sffz`.
 * 5. Above the staff (`placement="above"`, how choral scores mark a vocal
 *    staff): `mp` and a crescendo above.
 * 6-8. A long crescendo from `pp` to `ff` crossing two barlines, drawn as
 *    one straight wedge out of three per-measure pieces.
 */
export function createDynamicsShowcaseScore(): Score {
	return buildScore(
		[
			{
				keyFifths: 0,
				notes: [
					['E4', 'quarter'],
					['C4', 'quarter'],
					['D4', 'quarter'],
					['E4', 'quarter']
				],
				dynamics: [{ kind: 'p' }]
			},
			{
				notes: [
					['G4', 'half'],
					['A4', 'quarter'],
					['B4', 'quarter']
				],
				dynamics: [{ kind: 'f' }]
			},
			{
				notes: [
					['A3', 'half'],
					['C4', 'half']
				],
				dynamics: [{ kind: 'pp', onset: 0.5 }]
			},
			{
				notes: [
					['C5', 'quarter'],
					['D5', 'quarter'],
					['E5', 'quarter'],
					['F5', 'quarter']
				],
				dynamics: [
					{ kind: 'sfz' },
					{ kind: 'fp', onset: 0.25 },
					{ kind: 'rfz', onset: 0.5 },
					{ kind: 'sffz', onset: 0.75 }
				]
			},
			{
				notes: [
					['G4', 'quarter'],
					['A4', 'quarter'],
					['B4', 'half']
				],
				dynamics: [{ kind: 'mp', placement: 'above' }]
			},
			{
				notes: [
					['C5', 'half'],
					['B4', 'half']
				],
				dynamics: [{ kind: 'pp' }]
			},
			[
				['A4', 'quarter'],
				['G4', 'quarter'],
				['F4', 'quarter'],
				['E4', 'quarter']
			],
			{ notes: [['D4', 'whole']], dynamics: [{ kind: 'ff' }] }
		],
		{ keyFifths: 0, time: { beats: 4, beatType: 4 } },
		[],
		[
			{ kind: 'crescendo', start: [0, 0.25], stop: [1, 0] },
			{ kind: 'diminuendo', start: [1, 0.5], stop: [2, 0.5] },
			{ kind: 'crescendo', start: [4, 0.25], stop: [4, 0.75], placement: 'above' },
			{ kind: 'crescendo', start: [5, 0], stop: [7, 0] }
		]
	);
}

/**
 * M6 Slice 8's grace-note showcase, six measures of 4/4 in C:
 *
 * 1. An acciaccatura (slashed eighth) before a quarter, an appoggiatura
 *    (plain eighth) before a quarter, and one before a half.
 * 2. A beamed pair of grace 16ths (a shape real choral scores use) and a slashed beamed
 *    pair of grace eighths before high notes.
 * 3. Cue-size accidentals and ledger lines: a sharp grace before its
 *    principal (which states its own sharp again), a flat grace below the
 *    staff, and a high A grace on a ledger line.
 * 4. A grace slurred to its principal (the slur drawn below, under the two
 *    heads), and a grace before a chord.
 * 5. Two voices, each with a grace before its downbeat: the upper stems up,
 *    the lower down.
 * 6. A whole note, then a grace left at the end of the measure (OMR's
 *    spelling of a grace before the next downbeat), drawn before the barline.
 */
export function createGraceShowcaseScore(): Score {
	return buildScore(
		[
			{
				keyFifths: 0,
				notes: [
					['D5', 'eighth', { grace: ACCIACCATURA }],
					['C5', 'quarter'],
					['F4', 'eighth', { grace: APPOGGIATURA }],
					['E4', 'quarter'],
					['B4', 'eighth', { grace: APPOGGIATURA }],
					['A4', 'half']
				]
			},
			[
				['B4', '16th', { grace: APPOGGIATURA }],
				['D5', '16th', { grace: APPOGGIATURA }],
				['C5', 'half'],
				['A5', 'eighth', { grace: ACCIACCATURA }],
				['B5', 'eighth', { grace: ACCIACCATURA }],
				['G5', 'half']
			],
			[
				['F#4', 'eighth', { grace: ACCIACCATURA }],
				['F#4', 'quarter'],
				['Bb3', 'eighth', { grace: APPOGGIATURA }],
				['A3', 'quarter'],
				['A5', 'eighth', { grace: ACCIACCATURA }],
				['G5', 'half']
			],
			[
				['A4', 'eighth', { grace: APPOGGIATURA }],
				['G4', 'half'],
				['D5', 'eighth', { grace: ACCIACCATURA }],
				[['C5', 'E5'], 'half']
			],
			[
				['F5', 'eighth', { grace: ACCIACCATURA, voice: 1 }],
				['E5', 'whole', { voice: 1 }],
				['D4', 'eighth', { grace: APPOGGIATURA, voice: 2 }],
				['C4', 'whole', { voice: 2 }]
			],
			[
				['C5', 'whole'],
				['B4', 'eighth', { grace: ACCIACCATURA }]
			]
		],
		{ keyFifths: 0, time: { beats: 4, beatType: 4 } },
		[{ start: [3, 0], end: [3, 1] }]
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
	// Dynamics and hairpins (M6 Slice 6) are positional, so they only need
	// their measure indices moved by where the source lands.
	const measureOffset = score.measures.length;
	for (const measure of source.measures) {
		const copy = score.appendMeasure();
		copy.dynamics = measure.dynamics;
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
				voice: note.voice,
				measureRestWholes: note.measureRestWholes,
				chordWithPrevious: note.chordWithPrevious,
				articulations: note.articulations,
				fermata: note.fermata,
				grace: note.grace
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
	for (const wedge of source.wedges) {
		score.wedges.push({
			...wedge,
			start: { ...wedge.start, measureIndex: wedge.start.measureIndex + measureOffset },
			stop: { ...wedge.stop, measureIndex: wedge.stop.measureIndex + measureOffset }
		});
	}
}

/**
 * What `npm run dev` actually shows: the Phase 0 fixture followed by Slice 1's
 * duration showcase, Slice 4's accidental showcase, Slice 5's tie showcase,
 * Slice 6's slur showcase, Slice 7's key/time-change showcase, Slice 8's
 * barline showcase, M2 Slice 1's two-voice showcase and M2 Slice 2's voice-
 * collision showcase, so a human can see all eight render without disturbing
 * `createDemoScore`'s frozen shape (see the comment on it above). M6 Slice 2's
 * chord showcase follows them, then M6 Slice 5's articulation showcase, M6
 * Slice 6's dynamics showcase and M6 Slice 8's grace-note showcase, each
 * last when added so every earlier measure keeps the index it always had.
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
	appendMeasures(score, createVoiceClashShowcaseScore());
	appendMeasures(score, createChordShowcaseScore());
	appendMeasures(score, createArticulationShowcaseScore());
	appendMeasures(score, createDynamicsShowcaseScore());
	appendMeasures(score, createGraceShowcaseScore());
	return score;
}
