# Project Plan: notation-engine

**Current milestone:** M1

Roadmap and full decision record: `OMR_EDITOR_PLAN.md` milestone E13 in the
`divisi-omr-editor` worktree. This file tracks notation-engine's own
build-out; that one is Divisi's plan and stays the source of truth for why
this project exists.

## Milestones

### M0 — Phase 0: Spike [x]

Own editable model + canvas renderer using bundled SMuFL glyphs (Bravura);
single staff, single voice; one edit op (transpose) with instant,
region-scoped redraw of just the touched measure. Proves the core
"touch one measure" loop before anything else is built on it.

**Acceptance criteria:**
- [x] `npm test` passes, including `renderer.test.ts`'s region-scoped
      assertions (a transpose in measure 2 of a 4-measure score issues every
      draw call inside measure 2's region, none in 1/3/4; call count for a
      1-measure repaint is unchanged at 40 measures)
- [x] `npm run bench` shows region-scoped edit cost flat (~0.11-0.18ms)
      regardless of score length, vs whole-system repaint growing 0.7ms
      (4 measures) to 11.9ms (124 measures)
- [x] `npm run dev` demo: click a notehead, press an arrow key, only that
      measure's region repaints

**Tasks — Claude:**
- [x] Editable score model (notes, measures, pitch) with no rendering code
- [x] Canvas layout for single staff, single voice
- [x] Own hit-testing (maintained bounding boxes, not DOM `onclick`)
- [x] Transpose-by-semitone edit op, region-scoped repaint
- [x] Bench harness rasterizing through node-canvas
- [x] Multi-system casting-off (`systemWidthPx`, greedy measure-to-system
      packing) so the demo wraps instead of CSS-shrinking one long system

**Tasks — Human:**
- [x] Confirm go/no-go to proceed to Phase 1 (per `OMR_EDITOR_PLAN.md` E13,
      recommendation is go; confirmed)

### M1 — Phase 1: Single-voice engraving [~]

Est. 2-3 months. Scoped 2026-09-04 (Claude, autonomously, human
confirmation still pending) into 9 sequential slices below, each with its
own acceptance criteria in M0's style (unit-test assertions + a demo
check). Slices are ordered so each only depends on earlier ones (beaming
needs the duration model; accidental collision-avoidance needs nothing
new since key signatures already exist). Rescoped from the original
Human "scope Phase 1" task per the standing instruction to keep making
progress solo; flag for review when the human is back.

Two of the original task-list items turned out to already be
substantially built in Phase 0 and are narrowed accordingly below:
`layout.ts` already draws key signatures (`layoutKeySignature`,
key-aware accidental suppression) and time signatures
(`TIME_SIG_DIGITS`), and single/final barlines already work
(`ctx.isLast` in `layoutMeasure`). What is genuinely still open there is
double/repeat barline types (no `BarlineType` model field exists yet)
and mid-score key/time signature changes (score-wide `keyFifths`/`time`
are still single, unchanging values).

**Acceptance criteria (whole milestone):** all 9 slices' criteria below
pass; `npm run check`/`test`/`build` stay green throughout.

**Tasks — Claude:**
- [x] **Slice 1 — Duration model.** `NoteValue` grows to 16th/32nd/64th,
      single/double dots, and tuplet ratios (start with triplet); layout
      draws the right notehead/flag/dot combination and a measure's
      durations validate against its time signature's capacity.
      Acceptance: unit tests cover all duration values × 0/1/2 dots ×
      triplet across `durationWholes`, notehead/flag selection, and
      measure-capacity validation (valid and invalid cases); demo
      measure shows one of each duration rendering correctly.
- [x] **Slice 2 — Automatic beaming.** Group consecutive eighth-and-
      shorter notes within a beat (per time signature) into beams
      instead of individual flags; replaces `layoutStemAndFlag`'s
      per-note flag path for beamed groups. Acceptance: unit tests
      assert correct beam grouping for common meters (4/4, 6/8) incl.
      a rest breaking a group; demo shows a beamed run rendering as one
      beam, not stacked flags.
- [x] **Slice 3 — Stem direction rules.** Replace the fixed
      middle-line-split rule (`layoutStemAndFlag`'s `up = d <
      TREBLE_MIDDLE_LINE`) with the real single-voice rule: direction
      by distance from the middle line, and for a beamed group, one
      direction decided by the group's average position. Acceptance:
      unit tests over a range of pitches and one beamed-group case;
      demo shows correct stem directions including a beam that doesn't
      flip mid-group.
- [x] **Slice 4 — Accidental placement + collision avoidance.**
      Courtesy accidentals (same pitch altered earlier in the measure
      needs no repeat per MusicXML convention, already partly handled
      by key-aware suppression; extend to same-measure repeats) and
      extra horizontal clearance when an accidental would overlap the
      previous note's stem/ledger lines at tight spacing. Acceptance:
      unit tests for repeated-accidental suppression within a measure
      and a tight-spacing collision case; demo shows no accidental
      overlapping adjacent ink.
- [ ] **Slice 5 — Ties.** Same-pitch note tied across a barline or
      within a measure; model gains a tie flag/link between two notes,
      layout draws the curve, and duration-capacity validation treats
      a tied pair as one sounding duration. Acceptance: unit tests for
      tie-across-barline and same-measure tie; demo shows a tie curve
      connecting two noteheads.
- [ ] **Slice 6 — Slurs.** Phrase mark spanning an arbitrary run of
      notes (not just a pair); model gains a slur span, layout draws
      one curve over/under the run. Acceptance: unit test for a
      multi-note slur's endpoints and curve direction (above vs below
      based on stem direction); demo shows a slur over a short run.
- [ ] **Slice 7 — Mid-score key/time signature changes.** `Score.time`/
      `keyFifths` become per-measure (or change-list) rather than one
      score-wide value; layout draws a courtesy signature at the
      change and at the system break before it if one falls there.
      Acceptance: unit test for a score with a key change and a time
      change, each landing at the right measure with correct courtesy
      glyphs; demo score includes one of each.
- [ ] **Slice 8 — Barline types.** Model gains a `BarlineType` field
      (normal/double/final/repeat-start/repeat-end) per measure
      boundary; layout draws each variant (final already exists via
      `ctx.isLast`, generalize it). Acceptance: unit test rendering
      each type's draw ops; demo score uses at least a double and a
      repeat pair.
- [ ] **Slice 9 — Note spacing algorithm.** Replace the fixed-plus-
      linear spacing in `layout.ts`'s `SPACING` constants with real
      optical spacing (roughly logarithmic duration curve) plus
      justification to fill a system width, superseding the "Phase 0
      is deliberately naive" note at the top of that file. Acceptance:
      unit test asserting spacing grows sub-linearly with duration and
      a justified system's measures fill its width; bench confirms
      region-scoped redraw cost is still flat after a spacing change
      (this must not regress M0's core claim).

**Tasks — Human:**
- [ ] Review this scoping when back; it was done solo per the standing
      "keep making progress" instruction rather than left blocked.

### M2 — Phase 2: Multi-voice / multi-staff [ ]

Est. 2-3 months. Multiple voices per staff, SATB part grouping + braces,
cross-staff beaming. Unscoped; needs its own pass off M1's outcome.

### M3 — Phase 3: Pagination [ ]

Est. 1-2 months. Casting measures into systems and systems into pages,
system/page breaks, part-name indent. Unscoped; M0 already built basic
measure-to-system casting-off as demo-driven layout work, not a start on
this milestone's full scope (page casting-off, breaks, indent remain open).

### M4 — Phase 4: Interaction layer [ ]

Est. 1-2 months. Own hit-testing, selection/playback cursors, follow-scroll,
zoom, replacing what E2/E4/E7 currently read off OSMD
(`GetNearestNote`/`osmd.cursors`/`MeasureList`). Unscoped.

### M5 — Phase 5: Reparity with E2-E12 [ ]

Est. 1-2 months. Re-port seam markers, measure-range selection, undo/redo;
MusicXML import (Audiveris output) and export. Unscoped.

### M6 — Phase 6: Real-world edge cases [ ]

Ongoing, open-ended. Lyrics, repeats/endings/codas, grace notes,
articulations, cross-page ties, and the choral-scan edge cases already
fought once against OSMD (British rests, tenor/bass clef splits, page-to-page
divisi splits). Unscoped.

## Backlog

- (none yet)

## Log

- 2026-09-04: plan.md created. Phase 0 spike is built and its acceptance
  criteria pass. Phases 1-6 are the roadmap from that plan's phase table,
  rough estimates only, none scoped with real acceptance criteria yet.
- 2026-09-04: M0 approved and closed. Go/no-go on Phase 1 confirmed;
  M1 is current. Its task list is still a first pass off E13's phase table
  and needs a proper scoping pass with real acceptance criteria before
  work starts.
- 2026-09-04: M1 scoped solo while the human was away (their instruction:
  keep making progress rather than block on the "scope Phase 1" human
  task). Split into 9 ordered slices with concrete acceptance criteria;
  discovered key signatures, time signatures, and single/final barlines
  are already substantially built in Phase 0, narrowing slices 7-8 to
  what's genuinely still open (mid-score changes, other barline types).
  Starting Slice 1 (duration model) via subagent; flagged for human
  review of the scoping itself when they're back.
- 2026-09-04: Slice 1 (duration model) done. `NoteValue` now spans whole
  through 64th with 0/1/2 augmentation dots and a tuplet-ratio field
  (triplet implemented, other ratios representable but unbuilt); added
  `measureDurationWholes`/`validateMeasure` to check a measure's total
  against its time signature's capacity. Layout draws the new note/rest
  heads, flags, and augmentation dots (nudged off the staff line they'd
  otherwise sit on). `createDemoScore`'s frozen fixture (other tests
  depend on its exact shape) is untouched; a new `createFullDemoScore`
  appends a duration/dot/triplet showcase for `npm run dev`. 114 tests
  pass (up from 32 at M0), `check`/`build` green, bench unchanged
  (0.11-0.18ms scoped edit vs 0.7-11.9ms full redraw across 4-124
  measures) confirming M0's core claim didn't regress. The subagent that
  built this was interrupted twice by transient infra (host sleep, then
  an account session-limit reset) and resumed each time; Claude
  reviewed the diff and ran the full check/test/build/bench suite
  directly before committing, rather than trusting the subagent's own
  report.
- 2026-09-04: Slice 2 (automatic beaming) done. `layoutMeasure` now runs a
  grouping pass (`computeBeamGroups`) before laying out stems: consecutive
  eighth-and-shorter notes sharing a beat (the quarter beat in simple
  meters, the dotted-quarter beat in compound ones) become one beam group;
  a rest, a quarter-or-longer note, or a beat boundary breaks the group,
  and a group of one falls back to its old individual flag. A beamed
  group's stems share one direction (the average of the group's diatonic
  positions against the middle line, mirroring the existing single-note
  split) and one flat beam height, with secondary/tertiary beam segments
  drawn only over the sub-run of notes whose own duration needs them
  (16th/32nd/64th), including a fixed-width stub for an isolated note at a
  deeper level with no same-level neighbour. Two deliberate
  simplifications, both flagged in code comments for a later pass: the
  beam is flat (real engraving angles it to follow the notes' contour),
  and the stem-direction rule is the same simple middle-line split Slice 3
  is scoped to replace, just applied to a group average instead of one
  note. `beamThickness`/`beamSpacing` were added to the generated
  `glyph-metrics.ts` (extracted from Bravura's own engraving defaults,
  like every other line thickness this engine draws by hand) rather than
  invented locally. `createDurationShowcaseScore` gained a third measure
  (a plain ascending/descending eighth-note scale) so `npm run dev` shows
  a clean single-level beam alongside the mixed 16th/32nd/64th group
  Slice 1's showcase already happened to contain, which now beams instead
  of drawing three stacked flags; the frozen `createDemoScore` fixture's
  existing eighth pair (measure 3) also now renders as a beam with no
  model changes, confirmed by direct inspection of its draw ops. 120
  tests pass (up from 114), covering 4/4 and 6/8 grouping, a rest
  splitting a group into a beamed pair plus a singleton, cross-beat
  non-grouping, mixed-subdivision secondary beaming, and shared stem
  direction; `check`/`build` are green and `bench` is unchanged
  (0.11-0.15ms scoped edit vs 0.65-10.4ms full redraw across 4-124
  measures).
- 2026-09-04: Slice 3 (stem direction rules) done. A single shared function,
  `stemDirectionForNotes`, now decides stem direction for both a lone note
  (`layoutStemAndFlag`) and a beamed group (`layoutBeamGroup`), replacing the
  inline middle-line split and Slice 2's group average with one rule each
  path calls with its own diatonic index(es). A single note's direction is
  by side of the middle line, same as before; a note exactly on the line
  picks down-stem, the tie-break convention this slice fixes (documented in
  the function's doc comment as a common house style, not a universal one).
  A beamed group's direction is decided by its farthest-from-the-middle-line
  member, not an average: a tie for farthest between a note above and one
  below falls back to a majority vote across the whole group, and a further
  tie (majority also even, or every note on the line) falls back to the same
  down-stem convention. 12 new tests cover a range of single-note pitches
  including the on-line case, a beamed group where farthest-note and average
  disagree (constructed and hand-checked: G4, G4, E5 averages to 33.67,
  below the middle line at 34, so the old rule gave up-stem; the farthest
  member, E5, sits above the line, so the new rule gives down-stem instead),
  a farthest-tie broken by majority, and a farthest-and-majority double-tie
  falling back to the down-stem convention. 132 tests pass (up from 120);
  check/build are green and bench is unchanged (0.114-0.146ms scoped edit
  vs 0.655-10.408ms full redraw across 4-124 measures). The demo was
  sanity-checked by laying out `createFullDemoScore` directly (not through a
  browser, per this repo's no-browser-automation-dependency principle) and
  confirming it renders without error and still draws stems.
- 2026-09-04: Slice 4 (accidental placement + collision avoidance) done.
  `layoutMeasure` now tracks, per diatonic step, the alter most recently
  stated by a note earlier in the same measure (starting from the key
  signature, reset by a fresh `Map` on every `layoutMeasure` call, i.e. at
  every barline); `layoutNote` draws an accidental only when a note's alter
  disagrees with that running value, not just the key signature, so a
  repeated F-sharp stops repeating its sharp while an F-natural in between
  still draws, and a third F-sharp after that draws again rather than
  staying suppressed. Deliberately tracked per step only, not per (step,
  octave): a stricter reading of the real convention scopes the carry-over
  to the same octave too, so an F#5 followed later by a plain F4 would,
  under that reading, still need its own natural; this does not yet draw
  that natural, flagged in `layoutNote`'s own comment as a known
  simplification with nothing in this slice's scope exercising it. Collision
  avoidance adds `SPACING.minAccidentalClearance` (0.9 staff spaces): a new
  `noteInkRight` helper computes each note's rightmost ink (notehead, ledger
  line, or stem, sharing a new `stemXEdges` helper extracted from what
  `layoutStemAndFlag` and `beamStemX` each computed separately before), and
  `layoutNote` pushes a note needing an accidental right by whatever
  shortfall closes that gap to the minimum, propagating the shift into its
  own returned cursor so the measure's width and every later note's position
  stay honest. Worked out against this file's own spacing constants that the
  only realistic case ever tight enough to trigger is the shortest durations
  (32nd/64th) landing right after a ledger-lined note, which is also what
  the new geometric test targets, asserting the resulting gap closes to
  exactly the minimum rather than merely checking "no overlap" (already true
  even without the fix at this specific gap size, so a weaker assertion
  would not have proven anything). A small refactor rides along: beam
  groups now decide their shared stem direction once, in `computeBeamGroups`
  itself (a new `BeamGroup.direction` field), instead of `layoutBeamGroup`
  recomputing it later, because a beamed note's ink-extent calculation needs
  to know its eventual direction before `layoutBeamGroup` ever runs. 6 new
  tests (repeat suppression, the reverting case, the cross-measure reset,
  the tight-spacing geometry, plus the new `createAccidentalShowcaseScore`'s
  capacity validation and a rendering smoke test) bring the suite to 138
  (up from 132); check/build are green and bench is unchanged (0.107-0.145ms
  scoped edit vs 0.659-10.505ms full redraw across 4-124 measures, matching
  Slice 3's 0.114-0.146ms/0.655-10.408ms). `npm run dev` now also shows this
  slice's showcase (`createAccidentalShowcaseScore`, folded into
  `createFullDemoScore` alongside Slice 1's via a small shared
  `appendMeasures` helper factored out of what was `createFullDemoScore`'s
  own copy loop): one measure demonstrating the suppress/revert/redraw
  sequence, one demonstrating the tight-spacing pair, both sanity-checked by
  laying out `createFullDemoScore` directly (this repo's established
  no-browser-automation-dependency approach) rather than through a browser.
</content>
