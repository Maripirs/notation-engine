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
- [x] **Slice 5 — Ties.** Same-pitch note tied across a barline or
      within a measure; model gains a tie flag/link between two notes,
      layout draws the curve, and duration-capacity validation treats
      a tied pair as one sounding duration. Acceptance: unit tests for
      tie-across-barline and same-measure tie; demo shows a tie curve
      connecting two noteheads.
- [x] **Slice 6 — Slurs.** Phrase mark spanning an arbitrary run of
      notes (not just a pair); model gains a slur span, layout draws
      one curve over/under the run. Acceptance: unit test for a
      multi-note slur's endpoints and curve direction (above vs below
      based on stem direction); demo shows a slur over a short run.
- [x] **Slice 7 — Mid-score key/time signature changes.** `Score.time`/
      `keyFifths` become per-measure (or change-list) rather than one
      score-wide value; layout draws a courtesy signature at the
      change and at the system break before it if one falls there.
      Acceptance: unit test for a score with a key change and a time
      change, each landing at the right measure with correct courtesy
      glyphs; demo score includes one of each.
- [x] **Slice 8 — Barline types.** Model gains a `BarlineType` field
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
- 2026-09-04: Slice 5 (ties) done. `Note` gains `tiedToId: NoteId | null` (the
  low-level, direction-picked form: source -> target, since layout needs to
  know *which* note a curve reaches, not just that a tie exists), and `Score`
  gains a reverse index (`tiedFromNote`) plus `setTie` (validates the target
  exists and shares the source's exact pitch, via a new `pitchesEqual` in
  `pitch.ts`). `MeasureSpec`'s compact literal gets `extra.tiedToNext: true`;
  `buildScore` resolves it to a real target id in a second pass once every
  note exists (mirroring how a tie's target commonly lives in a measure not
  yet built while its source is being written), searching forward in score
  order within the same voice. `measureDurationWholes` is unchanged and its
  doc comment now spells out why: a tie is a sounding/perceptual construct
  layered on top of two ordinarily-durationed notes (MusicXML's own model,
  this file's spiritual reference), so each tied note still counts its own
  duration toward its own measure's capacity; merging them would let an
  under-full measure validate as full.

  Layout gained a new `DrawOp` kind, `curve` (a general cubic Bezier with two
  control points, not a tie-specific shape), since a tie is the short,
  two-point case of the same primitive Slice 6's slurs will need for a
  longer, arbitrary-length run; `CanvasRenderer` paints it via
  `beginPath`/`bezierCurveTo`/`stroke` at a constant `thickness` pulled from
  Bravura's own `tieMidpointThickness` (added to `extract-glyph-metrics.mjs`'s
  extracted list, same as `beamThickness` before it). A same-measure tie
  draws one curve directly inside `layoutMeasure`, once both notes' positions
  are known (widening `NotePlacement`, previously beam-only, to record every
  pitched note's position and stem direction). A tie crossing a barline is
  drawn as two independent halves, one owned by each measure's own ops: this
  is the part of the design worth flagging, since it is what keeps a tie
  compatible with region-scoped redraw at all (a curve reaching into a
  neighbour's pixels would get erased by that neighbour's own next redraw, or
  leave stale ink behind on this measure's), and because each half only ever
  needs its own note's position, `relayoutMeasure`'s incremental path
  recomputes a measure's ties correctly for free, no extra plumbing, and a
  tie crossing a *system* break (Phase 3 territory, not modelled by anything
  here) gets a reasonable result the same way, with no special case: the
  outgoing half stops at its own system's barline and the resuming half
  starts at whichever system the target lands in. Curve direction follows
  the standard convention (away from the stem: below the notehead when the
  stem points up, above when it points down), with a documented, deliberately
  unfixed edge case: each half decides its own direction from only its own
  note's stem, so a tie into or out of a beamed note whose *group* direction
  disagrees with what that note's pitch alone would pick could, in principle,
  have its two halves bulge opposite ways at the barline; not handled, judged
  rare and low-cost enough to leave for later. `translateMeasure` needed an
  explicit fix alongside this: its generic `{ ...op, y: op.y + dy }` shift
  (for turning a layout done at staff top 0 into final canvas position) does
  not touch a curve's four y-coordinates at all, since a curve has no single
  `y` field: caught by tracing the translation path by hand rather than by a
  failing test, since the bug would otherwise have shipped as a
  correctly-shaped but wrongly-positioned curve.

  `createTieShowcaseScore` (a same-measure tie, then one crossing a barline)
  folds into `createFullDemoScore` the same way Slice 4's showcase did;
  `appendMeasures` needed its own second-pass fix to carry a copied note's
  tie across into its new id, the same chicken-and-egg problem `buildScore`
  solves for `extra.tiedToNext`. 151 tests pass (up from 138); `check`/`build`
  are green and `bench` is unchanged (0.113-0.147ms scoped edit vs
  0.662-10.537ms full redraw across 4-124 measures, matching Slice 4's
  0.107-0.145ms/0.659-10.505ms). The full demo score, including the tie
  showcase, was rasterized through real node-canvas directly (this repo's
  no-browser-automation approach) to confirm `bezierCurveTo`/`stroke` render
  without error, not just that layout produces the right coordinates.
- 2026-09-04: Slice 6 (slurs) done. `Score` gains a `Slur` type (just
  `startNoteId`/`endNoteId`, no per-note field at all: unlike a tie, a slur's
  two ends are typically many notes apart, so a per-note flag like
  `tiedToId` does not fit) plus `addSlur` (validates both notes exist, rejects
  a rest at either end, and requires the start to precede the end in a new
  `Score.notesInOrder()`, since layout walks forward between them to find
  what the slur spans) and a `readonly slurs: Slur[]`. `buildScore` gains a
  third, optional `slurs: SlurSpec[]` parameter addressing each end by
  `[measureIndex, noteIndex]` rather than by an `extra` flag on a note
  literal, deliberately not extending `MeasureSpec`'s compact per-note tuple:
  a slur is not a property of either endpoint alone the way `tiedToNext` is
  of its own note, so bolting it on there would have cluttered every plain
  note literal for a marking only a few notes in a score ever have.

  Layout splits a slur into one curve segment per measure it passes through,
  the same reasoning as a tie crossing a barline: a curve reaching into a
  neighbouring measure's pixels would break region-scoped redraw on either
  measure's next repaint. Direction reuses `stemDirectionForNotes` (the same
  farthest-member-then-majority rule a beamed group's shared stem direction
  already uses) over every diatonic index the slur spans, curving opposite
  it exactly like a tie does. Endpoint placement and the multi-segment arc
  both hang off one new idea, `slurRoofY`: the canvas y a slur's curve
  cruises at everywhere it is not anchored to one of its own two end notes,
  computed from the single most extreme diatonic position among *every* note
  the whole slur spans (gathered fresh from `Score.notesInOrder()` every
  time by a new `slurSpanNotes`, never from another measure's already-laid-
  out positions) via the existing `staffY` function, plus a fixed clearance.
  Every measure a slur touches recomputes the same `spanNotes` and therefore
  the same `roofY` regardless of which measure is being laid out, which is
  what lets a first segment (real note -> roof, ending at its own barline), a
  last segment (roof -> real note, starting at its own left edge), and any
  middle segment (a flat roof-to-roof "shelf" spanning the full measure width)
  all agree on where they meet, without needing another measure's layout as
  input: the same property that lets `relayoutMeasure` recompute a tie's half
  correctly with no extra plumbing now does the same for a slur segment. A
  single-measure slur is the same machinery with both real endpoints in one
  segment, the curve rising to `roofY` in between and arching over whatever
  falls between its two ends. The tie pass's own curve-drawing code was
  factored into a shared `pushCurve` (just the op literal) plus
  `pushTieCurve`/`pushSlurSegment` (each computing its own control-point
  formula) rather than duplicated, since both draw the same `DrawOp` shape.
  `slurMidpointThickness` was added to `extract-glyph-metrics.mjs`'s
  extracted list and `glyph-metrics.ts` regenerated via `npm run glyphs`,
  the same as `tieMidpointThickness` before it, rather than reusing the tie's
  constant for what is a different (if numerically identical, in Bravura)
  engraving default.

  `createSlurShowcaseScore` (a 4-note single-measure slur, then a second
  slur crossing the barline) folds into `createFullDemoScore` the same way
  the tie showcase did; `appendMeasures` gained a slur-copying pass alongside
  its existing tie one. 15 new tests (5 model: wiring, id/rest/order
  validation, `SlurSpec` resolution; 10 layout: endpoint clearance, both
  curve directions, barline-splitting with roof continuity, a flat
  pass-through segment in a measure holding neither end, region containment,
  `relayoutMeasure` survival, and the showcase's curve counts) bring the
  suite to 166 (up from 151); `check`/`build` are green and `bench` is
  unchanged (0.113-0.148ms scoped edit vs 0.674-10.606ms full redraw across
  4-124 measures, matching Slice 5's 0.113-0.147ms/0.662-10.537ms; the bench
  score has no slurs at all, so this was never expected to move). The full
  demo score, slur showcase included, was rasterized through real
  node-canvas directly to confirm it renders without error, and a
  standalone PNG of just the slur showcase was inspected by eye to confirm
  the arc actually looks like a slur (clears the notes it spans, curves the
  documented direction, and the barline-crossing slur's two segments meet
  without a visible gap).
- 2026-09-04: Slice 7 (mid-score key/time changes) done. `Measure` gains
  optional `keyFifths`/`time` fields, `undefined` meaning "same as the
  previous measure" (or the score's initial `Score.keyFifths`/`time` for
  measure 0); `Score.keyFifthsAt`/`timeAt` walk back to the nearest earlier
  measure's explicit value so no caller has to. `buildScore`'s `measures`
  array now accepts, alongside a plain `MeasureSpec` tuple-array, a
  `MeasureBuildSpec` object (`{ notes, keyFifths?, time? }`) for a measure
  that changes one or both; a hand-written `isMeasureBuildSpec` guard tells
  the two apart, not an inline `Array.isArray` check, because TypeScript's
  narrowing for `Array.isArray` cannot exclude a *readonly* array type from a
  union (worked out only after `npm run check` failed on it), and every
  other spec type in this file is deliberately readonly. `layout.ts`'s every
  read of `score.keyFifths`/`score.time` (the key-aware accidental
  suppression, `computeBeamGroups`'s beat math, the header itself) now reads
  `score.keyFifthsAt(measure.index)`/`timeAt(measure.index)` instead.

  `layoutMeasure` draws a courtesy signature at the measure a change lands
  on: the key and/or time signature, independently (only whichever actually
  changed), whether or not that measure opens a system. A key change also
  draws cancellation naturals for any of the old key's accidentals the new
  key drops (worked out as the correct convention, not skipped: D major to G
  major cancels only the C#, since the F# carries over; D major to C major
  cancels both; a sharp-to-flat change cancels every old accidental), tested
  and eyeballed via a rendered PNG. A change landing at a measure that also
  opens a system is handled by the same existing "repeat key at system
  start" logic, now reading the walked-back key instead of the score's
  initial one, so it shows the changed key correctly with no separate code
  path; a time signature, never repeated at a system start before this
  slice, gained that case explicitly since nothing else covered it. Deliberate
  scope cut, called out in `layoutMeasure`'s own comment: real engraving also
  announces a change one system early, at the end of the system just before
  it, when the change would otherwise land exactly at a system break; this
  does not do that (it would need a measure's layout to know about a
  *different* measure's eventual system membership, which nothing here
  currently threads through), so every change still lands with correct
  glyphs at its own measure, just without that extra advance notice.

  13 new tests (4 model: `keyFifthsAt`/`timeAt` walk-back, a `MeasureBuildSpec`
  with no change recording none, `validateMeasure` catching the exact bug a
  wrong per-measure time signature would let through; 9 layout: full new
  signature at a key change, both cancellation cases, a time change's own
  courtesy signature, both changing together, no restatement at an
  unrelated later measure, a change landing on a forced new system, beam
  grouping actually following the new time signature, and the new showcase's
  render) bring the suite to 179 (up from 166); `check`/`build` are green
  and `bench` is unchanged (0.107-0.150ms scoped edit vs 0.661-10.546ms full
  redraw across 4-124 measures, matching Slice 6's 0.113-0.148ms/
  0.674-10.606ms; the bench's own fixture has no key/time changes, so this
  was never expected to move). `createKeyTimeChangeShowcaseScore` (G major
  4/4 -> D major 4/4 -> D major 3/4) folds into `createFullDemoScore` the
  same way every other showcase does; `appendMeasures` now also copies a
  copied measure's `keyFifths`/`time` (already-absolute values, so they
  carry over unchanged regardless of where a showcase lands in the combined
  score). The full demo score was rasterized through real node-canvas
  directly and inspected by eye: the key change shows two sharps drawn
  inline mid-system with no clef, and the time change's measure (which also
  happens to open the demo's last system at this width) shows both the
  repeated key and the new 3/4 together. Also fixed in passing: this file
  ended in a stray, unmatched `</content>` line, evidently a leaked wrapper
  artifact from an earlier session's edit; removed since it was never valid
  Markdown and had nothing to open it.
- 2026-09-04: Slice 8 (barline types) done. `BarlineType` is
  `'normal' | 'double' | 'final' | 'repeatStart' | 'repeatEnd'`. `Measure`
  gets two fields, not one: `endBarline` (the boundary after this measure:
  `'normal'`/`'double'`/`'final'`/`'repeatEnd'`) and `startBarline`
  (`'repeatStart'` only). A repeat start is conventionally attached to the
  measure it *opens*, not the one before it (MusicXML's own `<barline
  location="left">` vs `"right">`), which is why it needed its own field
  rather than one more value squeezed into `endBarline`. `Score.endBarlineAt`
  resolves a boundary the same way `keyFifthsAt`/`timeAt` resolve a key or
  time (one method, one place), with two rules: the *next* measure's
  `startBarline: 'repeatStart'` always wins over this measure's own
  `endBarline` (a boundary has one physical barline; the two fields could
  otherwise disagree about who draws it), and an unset `endBarline` resolves
  to `'final'` only at the score's true last measure, preserving `ctx.isLast`'s
  old hardcoded behaviour with no annotation required, but yielding to an
  explicit choice (e.g. `endBarline: 'double'` on the last measure) when one
  is made. `buildScore`'s `MeasureBuildSpec` grows both fields, following
  Slice 7's per-measure-options-object pattern rather than a fourth mechanism.

  Layout keeps barline ink owned entirely by the measure whose region it
  falls inside, same as `ctx.isLast` always did: `'double'`/`'final'` draw a
  second thin line just left of the main barline, inside the blank space
  `measureTrailOut` already reserves (so neither changes measure width, just
  like today's final pair never did); `'repeatEnd'` draws two dots in that
  same reserved space instead. `'repeatStart'` is the one shape that
  genuinely grows a measure (a thick line, then two dots, at its own start,
  before the ordinary lead-in space), which is also why it lives on the
  measure it opens rather than needing the previous measure's layout to grow
  on its behalf. The two dots are Bravura's own `repeatDot` glyph (added to
  `extract-glyph-metrics.mjs`'s list, `npm run glyphs` regenerated), drawn
  twice, stacked at the same x in the staff spaces straddling the middle
  line; not hand-drawn rects, and not the coincidentally-identical
  `augmentationDot`, since SMuFL publishes `repeatDot` for exactly this mark.
  Repeat barlines here are a single thick line plus dots, not the
  thin-then-thick-then-dots combo some engravings additionally draw; a
  deliberate, documented simplification, not an oversight. No repeat-playback
  semantics exist anywhere in this slice: nothing resolves a repeatStart/
  repeatEnd pair into a jump, a repeat count, or an ending bracket. That is
  real work for whichever later phase adds a player; this slice is purely
  the visual barline shapes.

  13 new tests (5 model: default resolution, an explicit override beating the
  automatic final default, a `MeasureBuildSpec` with neither field recording
  no change, a next-measure repeatStart overriding this measure's own
  endBarline, a plain repeatEnd needing no lookahead; 8 layout: each of the
  five shapes' exact rects/dots/positions, an explicit override on the last
  measure beating the automatic default, a lone repeatEnd with no matching
  repeatStart laying out without error, and the new showcase's render) bring
  the suite to 192 (up from 179); `check`/`build` are green and `bench` is
  unchanged (0.113-0.147ms scoped edit vs 0.659-10.651ms full redraw across
  4-124 measures, matching Slice 7's 0.107-0.150ms/0.661-10.546ms; the bench's
  own fixture has no non-normal barlines and its last measure is still
  resolved to `'final'` by the same default, so this was never expected to
  move). `createBarlineShowcaseScore` (a double barline, then, after a
  deliberately plain buffer measure, a repeat-start/repeat-end pair) folds
  into `createFullDemoScore` the same way every other showcase does; the
  buffer measure is not padding, it exists because a double barline placed
  directly before a repeat-start measure would be silently overridden by
  `endBarlineAt`'s own precedence rule, so the showcase's own doc comment
  spells that out as the reason the layout looks the way it does, not an
  arbitrary choice. `appendMeasures` now also copies a copied measure's
  `endBarline`/`startBarline` (already-absolute values, carrying over
  unchanged, the same reasoning as `keyFifths`/`time` before them). The full
  demo score was rasterized through real node-canvas directly and inspected
  by eye: the double barline renders as two close thin lines, the repeat
  start as a thick line then two dots opening its measure, and the repeat
  end as two dots then a thick line closing the score's actual last measure
  (overriding what would otherwise have been an automatic final barline).
