# Project Plan: notation-engine

**Current milestone:** M2

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

### M1 — Phase 1: Single-voice engraving [x]

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
- [x] **Slice 9 — Note spacing algorithm.** Replace the fixed-plus-
      linear spacing in `layout.ts`'s `SPACING` constants with real
      optical spacing (roughly logarithmic duration curve) plus
      justification to fill a system width, superseding the "Phase 0
      is deliberately naive" note at the top of that file. Acceptance:
      unit test asserting spacing grows sub-linearly with duration and
      a justified system's measures fill its width; bench confirms
      region-scoped redraw cost is still flat after a spacing change
      (this must not regress M0's core claim).

**Tasks — Human:**
- [x] Review this scoping when back; it was done solo per the standing
      "keep making progress" instruction rather than left blocked.

### M2 — Phase 2: Multi-voice / multi-staff [?]

Est. 2-3 months. Multiple voices per staff, SATB part grouping + braces,
cross-staff beaming. Scoped 2026-09-05 (Claude, off a codebase survey) into
6 sequential slices below, each with acceptance criteria in M1's style
(unit-test assertions + a demo check). Ordered by architectural dependency:
two voices sharing one staff fits inside the existing measure-scoped
region/redraw model with no new addressing scheme, so it comes first and
stays self-contained; the staff/part model, clef generalization, and
multi-staff stacking are one architecturally heavier unit that everything
after it (grouping/braces, cross-staff beaming) depends on. `Note.voice`
already exists as a stub field from Phase 0 (nothing reads it yet); `clef`
is currently one hardcoded treble value for the whole score, and
`Measure`'s addressing is a single global index with no staff dimension,
both narrowed accordingly below.

**Acceptance criteria (whole milestone):** all 6 slices' criteria below
pass; `npm run check`/`test`/`build` stay green throughout.

**Tasks — Claude:**
- [x] **Slice 1 — Two voices in one staff.** `layoutMeasure`'s single
      note-walking cursor splits into one onset-aligned column pass
      across all voices in a measure (same beat -> same x, the widest
      voice's `noteAdvanceSpaces` winning that column) plus independent
      per-voice beam grouping (`computeBeamGroups` filtered by
      `note.voice` before beat-position tracking, which today corrupts
      across voices if simply run on the flat array); stem direction
      gains a per-voice override (voice 1 forced up, voice 2 forced
      down, a convention `stemDirectionForNotes` doesn't currently
      support) and rests gain a per-voice vertical offset off today's
      fixed rest `y`. Acceptance: unit tests for shared-onset column
      alignment across two voices of differing rhythms, independent
      beam grouping per voice, the stem-direction override, and rest
      offset avoiding the other voice's notes; demo measure shows two
      rhythmically independent voices (e.g. a half-note voice against a
      running eighth-note voice) in one staff with correct stems and no
      overlapping ink.
- [x] **Slice 2 — Voice-to-voice collision avoidance.** Extends M1
      slice 4's single-voice accidental/ink collision logic across
      voices: noteheads from two voices landing on the same or adjacent
      beat within a second of each other get offset (one nudged right,
      the standard convention) instead of overlapping, and an
      accidental in one voice checks the other voice's ink at that same
      x, not just its own. Acceptance: unit tests for a same-onset
      second-interval clash resolving to offset noteheads and an
      accidental clearing the other voice's stem/notehead; demo shows a
      close-interval two-voice passage with no overlapping noteheads.
- [x] **Slice 3 — Staff/Part model + clef generalization.** `Score`
      gains real `Staff`/`Part` types (a part groups one or more
      staves, e.g. one SATB choir part or a piano's two staves);
      `Measure`'s flat global `index` addressing is replaced with a
      `(staffIndex, measureIndex)` scheme threaded through
      `LaidOutMeasure`/`relayoutMeasure`/`redrawMeasure` so each staff's
      measures redraw independently, preserving the region-scoped
      redraw guarantee across a staff dimension it doesn't have today.
      `clef` becomes a per-staff field (today one hardcoded treble clef
      for the whole score) with treble, bass, and treble-8 (vocal
      tenor) added; clef-specific line/ledger math and key-signature
      position tables (today treble-only) generalize accordingly.
      Acceptance: unit tests for correct notehead placement under each
      new clef, key-signature glyph position per clef, and a redraw
      scoped to one staff's one measure leaving every other
      staff/measure's ops untouched; demo shows the same pitches
      rendering correctly under treble, bass, and treble-8 clefs.
- [x] **Slice 4 — Multi-staff system layout.** `layoutScore`'s
      per-system loop gains a nested per-staff pass stacking N staves'
      `staffTopY`s tightly within one system (today exactly one staff
      per system); each staff draws its own clef/key-signature header
      off its own clef, while barline/time-signature ink (already
      score-wide in the model, per M1 slices 7-8) draws once per
      system-column and spans the full staff group's height, matching
      real multi-staff convention. Acceptance: unit test for correct
      per-staff vertical stacking and offsets, a shared barline's
      height spanning a multi-staff group, and each staff's own correct
      clef/key header; demo shows a two-staff grand-staff-style system
      with shared barlines and independent clefs.
- [x] **Slice 5 — Part grouping + braces/brackets.** `Part` (from
      slice 3) gains a brace (curly, for a keyboard-style grouped pair)
      or bracket (square, for a choir/ensemble group) drawn spanning
      its staves' full height at the start of each system, plus a part
      name label at the first system only (subsequent systems get no
      label, matching convention). Acceptance: unit test for correct
      brace/bracket glyph choice and vertical span per part, and name
      label appearing only on system 1; demo shows a 4-staff SATB score
      with a bracket and part labels.
- [x] **Slice 6 — Cross-staff beaming.** A beam whose notes span two
      staves (e.g. a piano passage crossing hands) breaks the "a region
      never needs another region's pixels" invariant ties/slurs already
      routed around via per-measure splitting (M1 slices 5-6); this
      slice generalizes that pattern to a beam segment split per staff,
      or a widened region spanning both staves' bounding box for that
      beam only. Acceptance: unit test for a cross-staff beam's region
      correctly covering both staves without leaking into an unrelated
      neighbor, and a scoped redraw of one note in the pair correctly
      repainting both halves; demo shows a note run beamed across two
      staves rendering as one continuous beam.

**Tasks — Human:**
- [ ] Review this scoping (drafted with you live this session, off a
      fresh codebase survey rather than solo) before slice work starts.

### M3 — Phase 3: Sound / playback [ ]

Est. 1-2 months, drafted more uncertain than M1/M2's own estimates since
the original scoping pass was necessarily speculative (see below); the
2026-09-06 recheck against M2's real, now-built shape found the
speculation held closely, so this estimate stands but with less residual
risk than when it was first drafted. Audio playback
of the score (tempo model, note onset/duration scheduling, audio
engine). Placed after M2 rather than right after M1: this is a
choral-notation tool (SATB part grouping, divisi splits), so playback
only becomes useful once multi-voice/multi-staff data exists, not with
M1's single voice alone. Client-side only (Web Audio API, in-browser,
same as the canvas renderer); no server backend, one was considered and
ruled out (2026-09-05) since nothing in scope needs server-rendered
audio, a hosted soundfont library, or multi-user sync.

Scoped 2026-09-05 (Claude, delegated to a subagent at the human's
explicit request) into 6 sequential slices below, in M1/M2's style
(unit-test assertions plus a demo check each), against M2's then-only
*scoped* shape rather than built code. Rechecked 2026-09-06 (Claude) now
that M2 is actually built (all 6 slices, `[?]` pending human approval):
the shape held closely enough that no slice needed re-ordering or
dropping, but several assumptions below are now pinned to real code
rather than a plan, and a couple of adjustments came out of the recheck:

- `Score.notesInOrder()` walking `staves[0]` only, and needing its own
  superseding per-voice/per-staff walk here (Slice 2), was flagged
  speculatively below and confirmed exactly as built (M2 Slice 3's own
  scope cut) — and turned out to be a real bug, not just a scope cut:
  `addSlur` always threw on a non-staff-0 slur. Fixed 2026-09-06, ahead
  of M3 slice work starting; see the Log entry below. Slice 2 still does
  its own per-voice/per-staff walk regardless (`notesInOrder` only ever
  answers "one staff's order", never all staves at once, exactly as
  this recheck originally anticipated), it just no longer has a latent
  bug sitting underneath it.
- `layoutScore` (M2 Slice 4) throws if any staff has a different measure
  count than staff 0, so a real, renderable score always has equal
  measure counts across staves; Slice 2's per-staff walk below no longer
  needs to handle or test a ragged case, it can assume parity.
- M2's own closing report punts "voices 3+ have no stem/rest convention"
  and "`measureDurationWholes`/`validateMeasure` sum across all voices
  rather than per-voice" as layout/validation gaps, plus "nothing checks
  a 3rd voice's ink against the other two" (collision avoidance). All
  three fixed 2026-09-06, ahead of M3 slice work starting: stem
  direction and rest offset generalize to N voices by odd/even parity,
  notehead-clash avoidance checks every earlier-placed voice rather than
  a fixed voice 1, and `validateMeasure` checks each voice's own total
  independently rather than summing across voices. See the Log entry
  below for detail. This means Slice 2's playback timeline was never
  going to be blocked by any of this either way (it reads whatever voice
  numbers are present in the model regardless of what layout can draw),
  but the fix removes the asymmetry of playback handling 3+ voices
  before layout could.
- New finding, not in either milestone's original scope: `Staff`,
  `Part`, `ClefType`, `CrossStaffBeam`, `measureDurationWholes`,
  `measureCapacityWholes`, and `validateMeasure` are all real, used
  types/functions in `src/model/score.ts` but were never re-exported by
  `src/model/index.ts` (and therefore not by the package's public
  `src/index.ts` barrel either) — an M2 oversight, since every other
  milestone's new model surface was exported as it was built. Fixed
  2026-09-06 alongside the other three items above, ahead of M3 slice
  work starting, so Slice 1 below only has its own new tempo export to
  add, not this backlog too.

A survey of the current model found no existing notion of tempo,
real-world time, or seconds anywhere, confirmed unchanged by the
recheck. `Note.durationWholes` (`src/model/score.ts`) is purely
abstract, a fraction of a whole note with no clock attached, and nothing
in `src/layout/` (`LaidOutNote`, `DrawOp`, `LaidOutScore`) carries a time
or ordering concept beyond a note's own x/y position on the page. Ties
(M1 Slice 5) matter here: `Note.tiedToId`/`Score.tiedFromNote` model a
tied pair as two `Note` objects sounding as one continuous note, and
`measureDurationWholes`'s own doc comment is explicit that a tie is
layered on top of two ordinarily-durationed notes, not a merge of them;
Slice 2 below has to collapse a tied chain into one scheduled onset
rather than firing two attacks. On mid-score tempo changes: M1 Slice 7
set a precedent for how a mid-score musical change is modelled here (an
optional per-measure field, e.g. `Measure.keyFifths`, walked back to the
nearest earlier explicit value by a `Score`-level accessor like
`keyFifthsAt`), and a tempo change would fit that same shape if built;
this milestone deliberately does not build it. Slice 1 below is a
single score-wide tempo, and a mid-score tempo-change field plus its
walk-back accessor is explicitly punted to a later phase since nothing
currently in scope needs it. Finally, per this file's own M4 entry, a
visible playback cursor is explicitly M4's job, not this one; nothing
below draws or tracks a cursor, only schedules and produces audio, with
Slice 6 exposing the minimal position hook M4 will eventually consume.

**Acceptance criteria (whole milestone):** all 6 slices' criteria below
pass; `npm run check`/`test`/`build` stay green throughout.

**Tasks — Claude:**
- [x] **Slice 1 — Tempo model.** A score-wide tempo (beats per minute,
      quarter-note-based per MIDI/MusicXML convention), stored as
      `tempoBpm` on `ScoreOptions`/`Score` (default 120), the same
      pattern `keyFifths`/`time` already use for a score-wide musical
      default; plus a pure conversion function taking a duration in
      `durationWholes` units (already dots/tuplet-folded by
      `Note.durationWholes`) and a bpm value, independent of where the
      caller got either, into seconds: `seconds = durationWholes * 4 *
      (60 / bpm)`. A single score-wide value only; mid-score tempo
      changes are explicitly punted, per the milestone's own scoping
      note above on the `keyFifthsAt`/`timeAt` precedent this would
      follow if built later. (The export-gap finding the recheck above
      flagged for this slice to close alongside its own new tempo type
      was instead fixed standalone on 2026-09-06, ahead of any slice
      starting; this slice only needs to export its own new tempo type
      when it lands.) Acceptance: unit tests cover a range of BPM
      values and duration values (plain, dotted, tripleted) converting
      to the expected number of seconds, plus `Score`'s own `tempoBpm`
      defaulting to 120 when unset and taking an explicit `ScoreOptions`
      value when given; demo check: a hand-computed duration at a known
      BPM matches the function's output within floating-point tolerance.
- [x] **Slice 2 — Playback timeline.** A pass that walks the score's
      notes in true playback order, independently per voice (whatever
      voice numbers are actually present in a staff's measures, not a
      hardcoded 1/2) and per staff. `Score.notesInOrder()` now takes a
      `staffIndex` (fixed 2026-09-06, see the Log entry below) but still
      only ever answers one staff's own order, never a single flat order
      across every staff at once, so this slice's own per-staff walk is
      still what supersedes it here, exactly as originally planned.
      Produces a flat list of onset events
      (`{ noteId, pitch, startSeconds, durationSeconds }`) using Slice
      1's conversion. Every staff has the same measure count by
      construction (`layoutScore` throws otherwise, confirmed by the
      recheck), so the walk needs no ragged-staff handling. A tied chain
      (`Note.tiedToId`/`Score.tiedFromNote`) collapses into exactly one
      onset event spanning the chain's combined duration, not one event
      per note. Each voice/staff's own cumulative duration, not a shared
      cursor, determines its notes' onset times, so two voices or staves
      starting together land simultaneous notes on the same
      `startSeconds` with no separate synchronization step. Acceptance:
      unit tests for single-voice sequential onsets landing at the
      expected cumulative times, a tied pair and a three-note tied chain
      each collapsing into one event with the summed duration, two
      independent voices/staves producing simultaneous onsets on a
      shared beat, and a 3-voice measure scheduling all three
      independently (layout can now draw one correctly too, per the
      2026-09-06 fix in the Log entry below, but this slice's own test
      coverage of it stands regardless); demo check: the timeline for
      `createTwoVoiceShowcaseScore` prints a human-checkable list of
      onset times matching a by-hand count of its two voices, and the
      timeline for `createSatbBracketShowcaseScore` (the project's
      actual 4-staff SATB shape) shows all four staves' onsets landing
      together on shared beats.
- [x] **Slice 3 — Web Audio lookahead scheduler.** A generic, drift-free
      scheduler using the standard Web Audio scheduling technique (the
      "lookahead" pattern: a `setInterval`-driven loop, running more
      often than strictly needed, that looks a short window ahead of
      `AudioContext.currentTime` and schedules any not-yet-scheduled
      event whose onset falls inside that window against the audio
      clock directly, rather than firing a `setTimeout` per note against
      the imprecise JS clock, which drifts under GC pauses and
      tab-throttling). Built generically over Slice 2's flat event list
      and an injected "play this event" callback, decoupled from what
      actually synthesizes the sound, so it is unit-testable against a
      fake/injected clock rather than real wall time. Acceptance: unit
      tests (fake clock/injected `currentTime`) assert every event is
      scheduled exactly once, within the lookahead window's tolerance of
      its true onset time, across a run long enough to require multiple
      lookahead passes, and that advancing the fake clock past an
      event's onset never re-schedules it; demo check: none at this
      slice (no sound wired up yet), deferred to Slice 4.
- [ ] **Slice 4 — Minimal oscillator synthesis.** A synthesis layer
      wired as Slice 3's "play this event" callback: for each scheduled
      onset, an `OscillatorNode` (a simple, concretely-buildable
      waveform, e.g. triangle, chosen over sampled/soundfont playback
      per the client-side-only, no-server, no-soundfont-library
      constraint already decided for this milestone) plus a `GainNode`
      short attack/release envelope to avoid clicking, started and
      stopped at the event's `startSeconds`/`startSeconds +
      durationSeconds`. Frequency comes from a new pitch-to-Hz
      conversion built on the existing `toMidi` (`src/model/pitch.ts`)
      via the standard `440 * 2^((midi - 69) / 12)` formula, which does
      not exist anywhere in the model yet. One timbre for every
      voice/staff in this milestone; distinguishing parts by timbre
      (e.g. a different waveform per SATB part) is a real but separate
      refinement, punted. Acceptance: unit tests for the MIDI-to-Hz
      conversion at known reference pitches (A4 = 440Hz, middle C, an
      accidental) and for a scheduled event producing an oscillator/gain
      node pair with the correct frequency and start/stop times
      (asserted against a mock `AudioContext`, not real audio hardware);
      demo check: playing `createTwoVoiceShowcaseScore` in a real
      browser is audible and recognizable as two independent rhythmic
      lines, and playing `createSatbBracketShowcaseScore` (the actual
      4-part choral shape this engine is for) is audible as four
      simultaneous voices (manual, per this repo's established avoidance
      of browser-automation dependencies for anything needing a real
      render).
- [ ] **Slice 5 — Transport controls.** A `PlaybackEngine` (or similar)
      wrapping Slices 2-4 behind a play/pause/stop/seek API, no UI:
      `play()` starts the scheduler from the current position, `pause()`
      stops scheduling and records elapsed position against
      `AudioContext.currentTime` (which itself never pauses), `stop()`
      clears every pending/sounding node and resets position to zero,
      `seek(seconds)` recomputes which of Slice 2's timeline events are
      still upcoming from an arbitrary point and resumes scheduling from
      there, correctly handling a note already sounding at the seek
      target (started at its own onset, not at the seek point).
      Acceptance: unit tests for pause/resume preserving elapsed
      position across a real time gap, a seek into the middle of the
      timeline scheduling only the correct remaining events, a note
      active across the seek point being handled correctly, and stop
      leaving no dangling scheduled nodes; demo check: play/pause/stop/
      seek controls in the dev demo control real audible playback
      correctly by ear.
- [ ] **Slice 6 — Playback position hook.** A minimal, UI-free way for a
      future caller to know what is currently playing: the
      `PlaybackEngine` exposes a current-position query (elapsed
      seconds) and an onset callback fired as each event starts, built
      directly off Slice 3's scheduler loop rather than a separate
      polling mechanism. This is deliberately the full extent of this
      milestone's involvement with a "cursor": per this file's own M4
      entry, drawing or moving a visual playback cursor on the score is
      M4's job once this engine exists, not this milestone's; this
      slice only makes the underlying position observable, it draws
      nothing. Acceptance: unit tests assert the position query returns
      the correct elapsed time mid-playback and after a pause/seek, and
      that the onset callback fires once per event in the correct order
      with the correct note id; demo check: a temporary on-screen
      counter (not real UI) driven by this slice's hook counts up
      correctly against a stopwatch during playback.

**Tasks — Human:**
- [ ] Review this scoping (and M2's own scoping, still pending its own
      approval above) before slice work starts. Rechecked 2026-09-06
      against M2's real, now-built shape rather than its plan; the
      recheck's findings and adjustments are in the milestone's intro
      above. The recheck also surfaced four real M2 gaps (one an actual
      bug, not just a limitation) which were fixed standalone the same
      day rather than left for a slice to work around; see the Log
      entry below for what changed.

### M4 — Phase 4: Interaction layer [ ]

Est. 1-2 months. Own hit-testing, selection/playback cursors, follow-scroll,
zoom, replacing what E2/E4/E7 currently read off OSMD
(`GetNearestNote`/`osmd.cursors`/`MeasureList`). Playback cursors depend on
M3's audio engine existing.

Also scope (added 2026-09-05, folded in from the now-dropped pagination
milestone, see Log): the human's workflow for an OMR-derived score is view
the original scanned PDF, play/interact in this engine's own engraved
score, and wants the cursor to eventually work on the PDF too, i.e. a
synced position marker on a separate PDF reference pane as playback/
selection advances in the engraved score. This engine stays PDF/format-
agnostic per E13's own decisions, so it does not render or align to a PDF
itself; its job here is exposing enough position/timing data (measure
index, onset time, note bounding box) for a host app to drive that sync
externally. The host-side half of this (rendering the PDF pane, page-level
scroll-to-sync, and any finer note-level pixel mapping) is Divisi's own
`divisi-omr-editor` plan, not this repo's — see that plan's E9 (per-page
measure offsets) and E12 (playback follows the PDF, page-level only for
now; true note-level position on the scan is a separate, harder backlog
item there, blocked on pixel-box data the OMR pipeline currently discards).
Unscoped.

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
- 2026-09-05: Slice 9 (note spacing algorithm) done, closing M1. `layout.ts`'s
  naive fixed-plus-linear spacing (`SPACING.noteBase`/`noteSlopePerWhole`) is
  replaced by a logarithmic curve, `noteAdvanceSpaces`: `space = noteSpaceBase
  + noteSpacePerDoubling * log2(durationWholes / noteSpaceReferenceWholes)`,
  the standard real-engraving shape (Ross/Read spacing tables; "each doubling
  of duration adds a constant increment of space, not a constant multiple").
  Constants (base 2, per-doubling 1, reference the 64th, this model's
  shortest plain `NoteValue`) were chosen so every plain duration lands on a
  clean integer number of staff spaces one apart (64th=2 ... whole=8),
  verified by a new test to grow strictly monotonically and, the acceptance
  criterion's specific ask, sub-linearly: a whole note gets 8/5 = 1.6x an
  eighth note's room, nowhere near the 8x a linear model would give. A
  tripleted note shorter than the reference (only reachable via the one
  implemented tuplet ratio, a triplet) is deliberately *not* floored back up
  to the reference's own space: it gets a small negative log term instead, so
  even the model's shortest plain value still visibly shortens under a
  triplet, which a first draft's reference-clamp got wrong (see below) before
  being corrected. `SPACING.minAccidentalClearance` (Slice 4) was re-checked
  against the new curve rather than assumed unchanged: a plain 64th's natural
  room dropped slightly (2 staff spaces vs. the old formula's ~2.34), making
  the same collision case if anything more likely to bite, not less; the
  existing geometric test still passes unchanged, and its doc comment now
  quotes the corrected natural-gap number (a small overlap, ~0.38 staff
  spaces short, not merely a tight-but-positive gap as the old comment said).

  A system's measures are now justified: once `planSystems` (unchanged; it
  still decides *which* measures land in a system, this slice only changes
  *how wide* they render) has settled a system's membership, `layoutScore`
  computes a `systemSpacingScale` for it, a factor that stretches (or, in the
  one edge case a single measure is too wide to fit `planSystems`'s budget
  alone, very mildly compresses, floored at 0.5x) every note's own advance so
  the system's combined width fills `systemWidthPx` exactly. The factor is a
  single linear estimate (natural width plus the deficit spread proportionally
  across every note's own natural advance, so a whole note absorbs more slack
  than an eighth note automatically, with no separate proportionality logic
  needed), not solved iteratively; it can be very slightly off whenever
  stretching happens to relax an accidental-collision shift that would have
  fired at the natural width, which only ever pulls the true result a hair
  short of the target, never over it. Real engraving justifies every system
  except the last, the same convention as the last line of justified prose:
  reproduced here by simply never scoring the score's own last system (whether
  because a `systemWidthPx` casting-off left it partial, or because there is
  no `systemWidthPx` at all, which is always exactly one system and therefore
  always "last"), so the no-`systemWidthPx` mode needs no separate branch to
  keep behaving exactly as before this slice. This was a judgement call, not
  spelled out in the slice's own scoping text, made and documented in-code per
  the standing autonomous-progress instruction.

  The scale factor is cached on the new `LaidOutScore.systems[i].spacingScale`
  field precisely so `relayoutMeasure`'s single-measure incremental path can
  reuse it rather than recompute a whole system's justification on every
  edit: a transpose (the only edit op that exists so far) never changes a
  measure's own natural note-to-net advances, so re-laying it out at its
  system's already-cached scale reproduces the exact same width and takes the
  same fast path it always has, confirmed by `bench` staying flat. A future
  duration-changing edit that *did* change a measure's natural width would
  still be caught honestly by the existing `widthChanged` check (comparing
  against the stale-scale-but-still-different width), falling back to a full
  `layoutScore`, exactly as it already did before this slice; no new
  system-scoped relayout path was built, since nothing in this slice's own
  scope exercises one.

  `redraw.bench.ts` was itself missing `systemWidthPx`, so it had never
  actually exercised a `spacingScale` other than 1 even before this slice
  landed; fixed by adding `systemWidthPx: 700` to its `LAYOUT_OPTIONS`, which
  is what makes the bench a real test of the cached-scale reuse path rather
  than an accidental non-test of it. With that change, `npm run bench` still
  confirms the core M0 claim: scoped edit cost stays flat at 0.268-0.323ms
  across 4-124 measures while full redraw grows 0.877-24.561ms (2.7x-79.4x
  speedup, growing with score length as expected). Four new tests (duration-
  advance monotonicity, whole-vs-eighth sub-linearity, the tripleted-64th
  edge case, and a justified system's measures filling `systemWidthPx` within
  a small tolerance) bring the suite to 196 (up from 192); five existing
  tests needed their expected numbers touched, all in
  `layout.test.ts`'s multi-system describe blocks. Three of those failures
  were purely mechanical (adding `spacingScale` to `LaidOutScore.systems`
  broke exact `toEqual` snapshots of that shape; loosened to assert
  `measureIndices` and `spacingScale` individually, which is more robust
  anyway). Two were a real consequence of wider natural spacing changing
  where the demo score happened to cast off at a 600px system width (it now
  splits into three systems there, not two); fixed by widening the shared
  test fixture's `systemWidthPx` to 700, which restores the same illustrative
  two-system split the tests were written to exercise. Only the tripleted-64th
  case was an actual bug caught by a test (the reference-clamp described
  above); every other change was an expected numeric shift, not a
  behavioural regression. `check`/`test`/`build` are all green; the full demo
  score was rasterized through real node-canvas directly at `systemWidthPx:
  1000` and inspected by eye: every system but the last visibly fills the
  same width, the last sits shorter at its own natural width exactly as
  designed, and nothing overlaps or clips.

  **M1 is now feature-complete across all 9 slices** and set to `[?]`, not
  `[x]`: awaiting explicit human review and sign-off, the same as M0's own
  convention, since the human has been away for this milestone's entire
  build-out and none of its scoping or slice work has had human eyes on it
  yet. What is genuinely solid: the duration model (16th-64th, 0-2 dots,
  triplets) with measure-capacity validation; automatic beaming with correct
  per-meter beat grouping; the real single-voice stem-direction rule
  (farthest-member-then-majority, not a naive average); accidental placement
  with same-measure suppression and geometric collision avoidance; ties and
  slurs that both survive a barline (or, for a slur, several) via independent
  per-measure segments, which is also what keeps both compatible with
  region-scoped redraw; mid-score key/time signature changes with correct
  courtesy signatures and key-cancellation naturals; all five barline types;
  and now optical, sub-linear note spacing with system justification. Every
  slice's bench numbers stayed flat end to end (0.107-0.153ms scoped edit
  regardless of score length, throughout all 9 slices), meaning M0's core
  architectural claim survived nine slices of real feature work on top of it
  without erosion.

  What is simplified or punted, collected here since this is the milestone's
  closing report: beams are flat, not angled to the notes' contour (Slice 2).
  Stem-direction and beat-grouping logic assumes simple/compound meter
  heuristics, not the full engraving convention for ambiguous meters like 3/8
  (Slice 2). Accidental carry-over is tracked per diatonic step, not per
  (step, octave), so a same-measure same-step accidental in a *different*
  octave is not distinguished (Slice 4). A tie's or slur's curve direction is
  decided independently by each side's own note, so one crossing into or out
  of a beamed note whose group direction disagrees with that note's own pitch
  could in principle bulge its two halves oppositely at the boundary (Slices
  5-6). Nothing models cross-*system* ties or slurs beyond "each half/segment
  lands wherever its own measure's system places it", since system-aware
  layout is Phase 3 territory (Slices 5-6). A key/time change landing exactly
  at a system break is not announced one system early the way real engraving
  does (Slice 7). Repeat barlines are purely visual: no repeat-playback
  semantics (jump targets, repeat counts, ending brackets) exist anywhere
  (Slice 8). Casting-off is greedy, not balanced/optimal, producing a ragged
  last system rather than evenly-filled lines (M0, unchanged by Slice 9).
  Justification is a single linear estimate, not iterative, so it can be a
  hair short of exact whenever an accidental-collision shift's presence
  changes between natural and justified spacing (Slice 9). And, spanning
  every slice: single staff, single voice, one clef, no pagination beyond
  system casting-off, and no MusicXML import/export, all explicitly out of
  M1's scope per the milestone's own framing. None of this blocks M2; all of
  it is either flagged in its owning slice's own code comments or listed here
  for whoever scopes M2 to see in one place.
- 2026-09-05: Added M3 (sound/playback) to the roadmap between M2 and
  pagination, discussed with the human directly (not a solo autonomous
  call). Placed after M2 rather than right after M1 because this is a
  choral-notation tool (SATB grouping, divisi splits per M2/M6), so a
  player only serves the real use case once multi-voice data exists;
  single-voice-only playback off M1 alone was judged not worth building
  as a throwaway. Old M3-M6 renumbered to M4-M7 accordingly.
- 2026-09-05: M1 approved and closed after human review (test/check/build
  green, all 196 tests passing, all 9 slices' acceptance criteria verified).
  M2 (multi-voice/multi-staff) is now current; needs its own scoping pass
  off M1's outcome before task work starts.
- 2026-09-05: M2 scoped, live with the human present (not a solo autonomous
  call, unlike M1's scoping). An Explore agent surveyed the current model/
  layout architecture first (voice/staff representation, the region-scoped
  redraw mechanism, beaming/stem logic, spacing/columns, clef handling) to
  ground the slices in what actually exists rather than guessed structure.
  Split into 6 ordered slices: two voices in one staff fits the existing
  measure-scoped redraw model with no new addressing scheme, so it's
  self-contained and first; a Staff/Part model, clef generalization
  (treble-only today), and multi-staff stacking are one architecturally
  heavier unit next, since `Measure`'s current global index has no staff
  dimension; part grouping/braces and cross-staff beaming (which reuses
  the tie/slur per-region-split pattern from M1) come last since both
  depend on the staff model existing.
- 2026-09-05: M3 scoped, delegated to a subagent at the human's explicit
  request (not a solo autonomous call, and not live-discussed the way
  M2's scoping was). Split into 6 ordered slices: tempo model; a
  per-voice/per-staff playback timeline collapsing tied chains into
  single onsets; a Web Audio lookahead scheduler; minimal oscillator
  synthesis; play/pause/stop/seek transport; a position hook for M4's
  future cursor. Necessarily more speculative than M1's/M2's own
  scoping passes, since M2 (the staff/voice/part model M3's timeline and
  multi-voice onset mapping depend on) is still only Slice 1 of 6, so
  this was scoped against M2's planned shape rather than built code and
  will need re-checking once M2 actually lands.
- 2026-09-05: Dropped the pagination milestone (was M4) and folded its
  concern into the interaction layer (renumbered M5->M4). Print-style
  casting into fixed pages doesn't serve a continuous-scroll web app; the
  real need, per the human, is that their OMR workflow views the original
  scanned PDF while playing/interacting in this engine's own engraved
  score, and the cursor should eventually work on the PDF too (a synced
  position marker there, not just a scrolled-to page). That's a position-
  data-exposure job for M4's cursor work, not a pagination job; this engine
  stays PDF-agnostic and leaves the actual PDF rendering/alignment to
  `divisi-omr-editor`'s own plan (its E9/E12 already do page-level sync;
  note-level pixel mapping is a harder, separate item tracked there, not
  here, since it's blocked on OMR pixel-box data the pipeline currently
  discards). Old M5-M7 renumbered to M4-M6 accordingly.
- 2026-09-05: M2 Slice 1 (two voices in one staff) done, via subagent;
  Claude reviewed the diff and ran check/test/build/bench directly before
  committing, same rigor as M1 Slice 1. `layoutMeasure`'s single flat
  cursor is replaced by onset-aligned columns shared across every voice
  (`measureColumns`), with independent per-voice beam grouping, a stem-
  direction override (voice 1 up, voice 2 down, regardless of pitch, once
  a measure genuinely holds two voices), and a per-voice rest offset (2
  staff spaces either way, tuned against a rendered PNG after 1 space let
  two rests visibly merge). `systemSpacingScale`'s justification sum was
  quietly double-counting both voices' advances at a shared onset; fixed
  to sum column widths instead. A single voice is the exact degenerate
  case of all of this, verified by every one of the 196 pre-existing
  tests passing unchanged. Deliberately left open for later: voices 3+
  get no stem/rest convention (documented fallback, not a crash);
  `measureDurationWholes`/`validateMeasure` still sum across all voices,
  so a valid two-voice measure can incorrectly fail capacity validation;
  cross-voice notehead/accidental collision avoidance is Slice 2, not
  this one. 209 tests pass (up from 196); bench unchanged (0.28-0.33ms
  scoped edit vs 0.91-25.8ms full redraw across 4-124 measures).
- 2026-09-05: M2 Slice 2 (voice-to-voice collision avoidance) done. Handed
  to a subagent, which restructured `layoutMeasure`'s column walk (voice-
  by-voice -> columns left to right, voices ascending within a column,
  giving voice 2 visibility into voice 1's just-drawn ink at a shared
  onset) but was interrupted twice by transient host-sleep infra, and its
  own attempt to resume itself hit the same interruption a third time.
  Rather than spawn a fourth attempt, Claude picked up its diff directly:
  added the notehead-clash test (a second-interval pair resolving to a
  full notehead's-width nudge, voice 2 always the one that yields, per
  the same one-sided convention Slice 1's stem-direction override already
  set), the cross-voice accidental-clearance test (extending M1 Slice 4's
  `previousInkRight` mechanism to also check ink an earlier-processed
  voice deposited in the same column, geometry asserted with the same
  "closes to exactly the minimum" style Slice 4's own test used), two
  tests confirming the new checks don't over-fire (an interval wider than
  a second, and a second-apart pair already cleared by ordinary column
  spacing), a new `createVoiceClashShowcaseScore` folded into
  `createFullDemoScore`, and ran the full check/test/build/bench suite
  directly before committing, the same rigor M1 Slice 1's own interrupted-
  subagent recovery used. 215 tests pass (up from 209); check/build are
  green and bench is unchanged (0.279-0.335ms scoped edit vs
  0.912-25.624ms full redraw across 4-124 measures). The showcase was
  rasterized through node-canvas directly and inspected by eye: parallel
  seconds resolve to visibly offset noteheads with no overlap, and a
  cross-voice accidental clears a ledger line sharing its column instead
  of printing on top of it.
- 2026-09-05: M2 Slice 3 (Staff/Part model + clef generalization) done, the
  heaviest of M2's six slices. `Score` gains real `Staff` (own clef, own
  `measures[]`) and `Part` (grouping only, no brace/bracket yet) types;
  `Score.clef`/`measures` become convenience getters onto `staves[0]` so
  every pre-slice score is the exact single-staff degenerate case, and
  `appendMeasure`/`keyFifthsAt`/`timeAt`/`endBarlineAt` all gained an
  additive `staffIndex = 0` parameter rather than a breaking signature
  change. `clef` is now per-staff (treble/bass/treble8); the three
  treble-only diatonic constants generalized into `CLEF_LINES[clef]` and
  the key-signature octave table into `KEY_SIGNATURE_OCTAVES[clef]`.
  `Measure`'s flat global `index` became a `(staffIndex, index)` pair,
  threaded through `LaidOutMeasure`, `relayoutMeasure` and
  `CanvasRenderer.redrawMeasure`/`redrawMeasures`; `layoutScore` lays each
  staff out independently (reusing the prior single-staff algorithm via a
  new `layoutOneStaff` helper) and stacks the results, a deliberately
  naive placeholder left for Slice 4's real interleaved-per-system
  stacking. A latent bug was caught while auditing the staff dimension:
  the slur-drawing pass compared raw `measure.index` with no staff guard,
  which could have let one staff draw part of another staff's slur once
  local indices collided; fixed alongside. Handed to a subagent with an
  explicit scope-boundary brief against Slices 4-5 (this repo's plan-vs-
  code cross-check for staying inside scope); it completed in one run
  with no interruption. Claude reviewed the full diff, re-ran `npm run
  glyphs` to confirm the new `fClef`/`gClef8vb` metrics reproduce
  byte-for-byte, ran check/test/build/bench directly, and independently
  rendered the new clef showcase to confirm by eye (middle C on a ledger
  line below treble/treble8, squarely mid-staff in bass; treble8 visually
  identical to treble but for the small "8") before committing. 229 tests
  pass (up from 215); bench unchanged (0.278-0.331ms scoped edit vs
  0.918-25.725ms full redraw across 4-124 measures).
- 2026-09-05: M2 Slice 4 (multi-staff system layout) done. `layoutScore`'s
  naive Slice 3 placeholder (stack each staff's whole independent block)
  is replaced with real interleaved layout: within each system, every
  staff stacks tightly (`SPACING.staffGap`) with the next, sharing one
  barline per measure column that spans the full staff-group height
  (`barlineSpan`), while each staff still draws its own clef/key header.
  System membership is decided once, off staff 0, since a shared system
  needs every staff to agree where it starts/ends; every staff must now
  have the same measure count (checked, not assumed). A narrower staff's
  column pads its own trailing space to match the widest staff at that
  column, rather than rescaling notes. Splitting the shared barline into
  one segment per staff (not one staff owning the whole tall line) is
  what keeps this compatible with region-scoped redraw; doing that split
  at the raw geometric midpoint of the staff gap turned out insufficient
  on its own, since `measureRegion`'s constant antialiasing bleed on
  every edge would make the two staves' regions overlap by 2px at that
  shared point, a genuine redraw-correctness bug. Fixed by reserving a
  neutral strip on each segment's neighbour-facing side sized to exactly
  cancel that bleed. First attempt (subagent) got most of the
  restructure right but was interrupted by host-sleep infra mid-edit,
  leaving three compile errors; a second subagent, briefed with the
  broken diff, finished the plumbing and caught the bleed-overlap bug
  above while writing the shared-barline test. Claude reviewed the full
  diff, ran check/test/build/bench directly, and independently rendered
  the new grand-staff showcase (treble/D major over bass/Eb major, three
  systems) to confirm by eye: continuous barlines through both staves at
  every column, independent key signatures, correct column alignment
  despite very different rhythmic density per staff. 236 tests pass (up
  from 229); bench unchanged (0.277-0.326ms scoped edit vs
  0.953-26.407ms full redraw across 4-124 measures).
- 2026-09-05: M2 Slice 5 (part grouping + braces/brackets) done, in one
  subagent run with no interruption. `Part` (Slice 3) now draws a curly
  brace (exactly 2 contiguous staves) or square bracket (3+ contiguous
  staves), spanning the group's full outer height at every system, plus a
  part-name label at system 1 only. Bracket assembles from Bravura's
  fixed-size hook glyphs plus a plain rect spine (keeps corners crisp at
  any span); brace is a single glyph stretched via a new per-op font-size
  override, scaled uniformly rather than SMuFL's non-uniform
  recommendation, safe since a 2-staff span is always the same fixed
  size. Both decorations live in a new `LaidOutScore.partDecorations`
  array outside every measure's own ops/region, specifically to avoid
  blowing one staff's region into a rectangle overlapping every other
  staff's row at the shared x, which would break region-scoped redraw;
  nothing edits a `Part`'s grouping/name, so `drawAll()` paints these
  once and `redrawMeasure` never touches them. A named multi-staff Part
  labels its group once, centred; a named single-staff Part labels its
  own row, letting an SATB score's four per-voice labels coexist with
  one broader unnamed bracket-only Part spanning all four. Scope cuts:
  non-contiguous groupings skip the connector (label still draws), a
  solo staff draws no glyph, the reserved header width isn't fed into
  `systemWidthPx` budgeting (a documented combination gap), and label
  width is a character-count heuristic (no real text-metric API in
  layout). Claude reviewed the full diff, re-ran `npm run glyphs` to
  confirm the new brace/bracket metrics reproduce byte-for-byte, ran
  check/test/build/bench directly, and independently rendered both the
  SATB bracket showcase (four labelled voices, one bracket) and a
  2-staff piano-brace case to confirm by eye before committing. 244
  tests pass (up from 236); bench unchanged (0.274-0.326ms scoped edit
  vs 0.964-26.515ms full redraw across 4-124 measures).
- 2026-09-06: M2 Slice 6 (cross-staff beaming) done, closing all 6 slices
  of M2. `Score` gains `CrossStaffBeam` (mirroring `Slur`: two notes each
  already correctly notated in their own staff's own `Measure`, linked
  explicitly since two different staves have no shared onset timeline to
  infer a grouping from), validated tightly (real pitched notes,
  beam-eligible duration, same measure column across staves, exactly two
  adjacent staff indices, 2+ notes per side). `layoutMeasure` excludes a
  cross-staff note from ordinary automatic beaming and gives it a
  synthetic `BeamGroup` drawn at a fixed join height reusing `barlineSpan`
  (Slice 4)'s own already bleed-safe staff-boundary geometry rather than
  fitting to either side's notes, which is what keeps a scoped one-
  measure redraw correct with zero cross-region plumbing, the same
  property that already made a tie/slur half correct for free. Caught and
  fixed a latent Slice-4 bug along the way: `relayoutMeasure` built its
  context without `barlineTop`/`barlineBottom`, silently reverting a
  scoped redraw's shared end-barline to the single-staff band; nothing
  had caught it since no prior test exercised a scoped redraw on a
  shared barline. First attempt hit the account session limit mid-
  exploration (no files written, relaunched clean); the second run
  completed, and (per its own report) had itself spawned a review pass
  before reporting back, replacing a vacuous first-draft region test with
  a stronger noteId-based one. Claude independently re-reviewed the full
  diff, ran check/test/build/bench directly, and rendered the cross-
  staff showcase to confirm by eye: the beam reads as one continuous
  shape crossing the staff gap (a small documented jog at the crossing
  point, from the pre-existing stem-attachment-side convention applied to
  two forced-opposite directions), correct stem directions on each side.
  13 new tests bring the suite to 257 (up from 244); bench unchanged
  (0.274-0.335ms scoped edit vs 0.980-26.789ms full redraw across
  4-124 measures).

  **M2 is now feature-complete across all 6 slices** and set to `[?]`,
  not `[x]`: awaiting explicit human review and sign-off, the same
  convention M1 used, since M2's own scoping review task (below) is
  still unchecked and this milestone's slice work proceeded solo per the
  standing "keep making progress" instruction while the human was away.
  What is genuinely solid: two voices sharing one staff with independent
  beaming/stems/rests (Slice 1) and voice-to-voice notehead/accidental
  collision avoidance (Slice 2); a real `Staff`/`Part` model with
  treble/bass/treble8 clefs generalized throughout (Slice 3); true
  interleaved multi-staff system layout with a shared barline spanning
  the group and per-staff column-width padding (Slice 4); part-grouping
  braces/brackets and system-1-only name labels (Slice 5); and
  cross-staff beaming for a piano-style hands-crossing passage (Slice
  6). Every slice's `(staffIndex, measureIndex)` addressing scheme
  (introduced Slice 3) proved sufficient all the way through Slice 6's
  genuinely cross-staff case, and bench numbers stayed flat end to end
  (0.27-0.34ms scoped edit regardless of score length, throughout all 6
  slices), meaning region-scoped redraw survived six slices of real
  multi-voice/multi-staff feature work without erosion.

  What is simplified or punted, collected here since this is the
  milestone's closing report: voices 3+ have no stem/rest convention,
  and `measureDurationWholes`/`validateMeasure` still sum across all
  voices in a measure rather than per-voice, so a valid two-voice
  measure can incorrectly fail capacity validation (Slice 1). Nothing
  here checks a *3rd* voice's ink against the other two (Slice 2's own
  collision avoidance is strictly voice-1-vs-voice-2). `notesInOrder()`
  (and therefore slur validation) only ever walks staff 0 (Slice 3).
  Multi-staff system layout assumes every staff has the same measure
  count, checked and thrown on rather than handled (Slice 4); a
  narrower staff's column is padded, not re-justified, to match a wider
  one. A bracketed/labelled part's reserved header width is not fed
  into `systemWidthPx`'s own budgeting, so such a score renders slightly
  wider than asked (Slice 5); label text width is a character-count
  heuristic, not a real text measurement. Cross-staff beaming assumes
  identical rhythmic content lands both sides at the same x with no
  x-coordination logic, and only ever links exactly two adjacent staves
  with 2+ notes each side, no beamlet-stub convention for a lone note on
  one side (Slice 6). And, spanning every slice: no repeat-playback
  semantics, no MusicXML import/export, and nothing here draws a
  brace/bracket or cross-staff beam that itself gets edited (nothing in
  this engine's one edit op, transpose, ever changes a `Part` or
  `CrossStaffBeam`). None of this blocks M3; all of it is either flagged
  in its owning slice's own code comments or listed here for whoever
  scopes M3's actual slice work (already drafted speculatively, see M3's
  own section) to see in one place once M3 re-checks its scoping against
  this real, now-built M2 shape.
- 2026-09-06: M3's speculative scoping (drafted 2026-09-05 against M2's
  planned shape) rechecked against M2's real, now-built code. The shape
  held closely: `notesInOrder()`'s staff-0-only limitation and the need
  for Slice 2's own per-voice/per-staff walk were both confirmed exactly
  as anticipated, no slice needed re-ordering or dropping. Two real
  adjustments came out of it: `layoutScore` throwing on unequal per-staff
  measure counts means Slice 2 can assume parity rather than handle a
  ragged case, and M2's "voices 3+ have no stem convention" layout punt
  doesn't block playback from handling 3+ voices anyway, so Slice 2's
  acceptance now includes a 3-voice case ahead of layout supporting one
  visually. Also found, independent of either milestone's own scoping: M2
  built `Staff`/`Part`/`ClefType`/`CrossStaffBeam`/`measureDurationWholes`/
  `measureCapacityWholes`/`validateMeasure` but never re-exported them
  through `src/model/index.ts`, an oversight versus every other
  milestone's new surface; planned as a one-line fix folded into M3
  Slice 1 alongside that slice's own new tempo export, though it (and
  three further real M2 gaps found in this same recheck) ended up fixed
  standalone the same day instead of waiting for Slice 1 - see the next
  Log entry. Demo checks throughout M3's slices now name real fixtures
  (`createTwoVoiceShowcaseScore`, `createSatbBracketShowcaseScore`)
  instead of a generic "M1/M2 demo score", since those fixtures now exist
  and the SATB one is this project's actual target shape.
- 2026-09-06: Four gaps the M3 recheck (above) surfaced in M2 were fixed
  standalone, ahead of M3 slice work starting, at the human's request
  ("fix everything before we start M3", scoped down to these four plus
  the export gap, not the milestone's other cosmetic layout punts or the
  separate-phase items like MusicXML import/export). Handed to a
  subagent with the full design pre-worked out (parity-based convention
  for the N-voice cases, backward-compatible shapes for the model
  changes); Claude reviewed the full diff before writing this entry.
  (1) `src/model/index.ts` now re-exports `Staff`/`Part`/`ClefType`/
  `BarlineType`/`CrossStaffBeam`/`MeasureValidation`/
  `measureDurationWholes`/`measureCapacityWholes`/`validateMeasure`,
  closing the export-barrel gap. (2) `validateMeasure` now groups a
  measure's notes by voice and requires every voice's own total to
  independently fill the time signature's capacity, replacing the old
  single sum-across-all-voices check that made a valid two-voice measure
  fail; `measureDurationWholes` keeps its original all-voices-summed
  meaning as a separate, still-useful number. (3) `notesInOrder()` gained
  a `staffIndex` parameter (default 0); this turned out to be a real bug,
  not just a documented scope cut, since `addSlur`'s order check against
  the old staff-0-only order always compared two `indexOf` misses
  (`-1 >= -1`) and threw on every slur whose notes lived on any other
  staff. `addSlur` now resolves and requires both ends share one staff
  and validates order within it; `layoutMeasure`'s slur pass threads the
  resolved staff index through to `slurSpanNotes`. (4) `voiceStemOverride`
  and `restVoiceOffsetSpaces` generalize the existing voice-1-up/
  voice-2-down convention to odd/even parity for any voice number, and
  `secondIntervalClashShift` now checks a note against every
  earlier-placed voice at its column (was: a single hardcoded "voice 1"
  slot), all one-directional exactly as the original two-voice version
  was. 268 tests pass (up from 257, 11 net new: per-voice validation x5,
  staff-scoped-slur x3, N-voice stem/rest/clash x3, one existing test's
  assertion rewritten since it was pinning down the exact gap this closed);
  check/build green. Left untouched, per the human's own scoping of "fix
  everything": the cosmetic layout punts (narrower-staff-column
  re-justification, bracket header width budgeting, label text
  measurement, cross-staff beam x-coordination/beamlet stubs) and the
  items that span every M2 slice (repeat-playback semantics, MusicXML
  import/export, edit ops touching `Part`/`CrossStaffBeam`) — those are
  separate milestones' scope, not bugs, and stay in M2's closing report
  as-is.
- 2026-09-06: M3 Slice 1 (tempo model) done, via subagent while the human was
  away; Claude reviewed the diff and ran check/test/build directly before
  committing. `Score` gains `tempoBpm` (quarter-note beats per minute,
  defaulting to 120), following the exact `keyFifths`/`time` pattern on
  `ScoreOptions` and the constructor: a single score-wide starting value, no
  per-measure change tracked, matching this slice's own explicit scope cut.
  A new `src/playback` layer (fourth alongside `model`/`layout`/`render`,
  `src/index.ts`'s own top-of-file comment updated accordingly) holds
  `durationToSeconds(durationWholes, bpm)`, a pure function with no
  dependency on any model type: `seconds = durationWholes * 4 * (60 / bpm)`.
  5 new tests (2 on `Score.tempoBpm`'s default/override, 3 on
  `durationToSeconds` covering a BPM range, a plain/dotted/tripleted duration
  range, and a zero-duration edge case, all via hand-computed expected values
  in the test's own comments) bring the suite to 273 (up from 268);
  check/build are green.
- 2026-09-06: M3 Slice 2 (playback timeline) done, via subagent while the
  human was away; Claude reviewed the diff and ran check/test/build directly
  before committing. `src/playback/timeline.ts`'s `computePlaybackTimeline`
  walks each `(staffIndex, voice)` pair present in the score independently
  (voices discovered dynamically per staff, not hardcoded 1/2), each with its
  own cumulative `cursorWholes` converted through `durationToSeconds` for
  `startSeconds`, deliberately not built on `Score.notesInOrder()` (that
  method interleaves every voice's notes in one flat per-staff order, not
  onset order; a two-voice measure's `measure.notes` holds voice 1's notes
  then voice 2's, not interleaved, so this needed its own per-voice walk
  exactly as the milestone's own scoping anticipated). A rest advances the
  cursor with no event; a tie continuation (detected via
  `Score.tiedFromNote`) folds its duration onto the still-open event from the
  tie's source rather than starting a fresh one, correctly collapsing chains
  of 3+ tied notes, not just pairs. Returns a flat `OnsetEvent[]`
  (`{ noteId, pitch, startSeconds, durationSeconds }`) with no
  staffIndex/voice field, matching the plan's own event shape exactly. 6 new
  tests (single-voice sequential onsets, a tied pair, a three-note tied
  chain, two differing-rhythm voices realigning on shared beats via
  `createTwoVoiceShowcaseScore`, a hand-built 3-voice measure, and all four
  staves of `createSatbBracketShowcaseScore` landing on the same shared
  onsets) bring the suite to 279 (up from 273); check/build are green. Demo
  checks confirmed by hand: `createTwoVoiceShowcaseScore`'s two voices open
  together at 0 and realign at 2.5 after each fills one 4/4 bar despite
  differing rhythm in between; `createSatbBracketShowcaseScore`'s 4 staves
  all land 4-per-onset at 0/0.5/1.0/1.5.
- 2026-09-06: M3 Slice 3 (Web Audio lookahead scheduler) done, via subagent
  while the human was away; Claude reviewed the diff and ran check/test/build
  directly before committing. `src/playback/scheduler.ts`'s
  `LookaheadScheduler<T extends SchedulableEvent>` implements the standard
  Web Audio lookahead pattern generically: `tick()` schedules every
  not-yet-scheduled event whose `startSeconds` falls within
  `lookaheadSeconds` (default 0.1s) of an injected `getCurrentTime()`, and
  `start()`/`stop()` wrap that in a real `setInterval` loop (default 25ms)
  for actual use; nothing in the class references a real `AudioContext`,
  keeping it runnable in this repo's DOM-free Node test environment.
  "Already scheduled" bookkeeping is a `Set` of array indices, deliberately
  isolated so a `reset()` method (unused this slice, present for Slice 5's
  future seek) can clear it in one line with no cursor to also rewind. 5 new
  tests, all driven by a fake clock and direct `tick()` calls with no real
  timer: exactly-once scheduling across a run spanning multiple lookahead
  windows, a precise two-sided timing bound (never before
  `startSeconds - lookaheadSeconds`, never later than one tick-step past it,
  the tests' own cadence-specific tightness clearly distinguished in a
  comment from the class's actual one-sided guarantee), never re-scheduling
  after firing, an already-past-due event still firing on the first tick,
  and `reset()` making an already-fired event eligible again. Bring the
  suite to 284 (up from 279); check/build are green. M3 Slice 4 (minimal
  oscillator synthesis) is next.
