# Project Plan: notation-engine

**Current milestone:** M6

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
- [x] **Slice 1: Duration model.** `NoteValue` grows to 16th/32nd/64th,
      single/double dots, and tuplet ratios (start with triplet); layout
      draws the right notehead/flag/dot combination and a measure's
      durations validate against its time signature's capacity.
      Acceptance: unit tests cover all duration values × 0/1/2 dots ×
      triplet across `durationWholes`, notehead/flag selection, and
      measure-capacity validation (valid and invalid cases); demo
      measure shows one of each duration rendering correctly.
- [x] **Slice 2: Automatic beaming.** Group consecutive eighth-and-
      shorter notes within a beat (per time signature) into beams
      instead of individual flags; replaces `layoutStemAndFlag`'s
      per-note flag path for beamed groups. Acceptance: unit tests
      assert correct beam grouping for common meters (4/4, 6/8) incl.
      a rest breaking a group; demo shows a beamed run rendering as one
      beam, not stacked flags.
- [x] **Slice 3: Stem direction rules.** Replace the fixed
      middle-line-split rule (`layoutStemAndFlag`'s `up = d <
      TREBLE_MIDDLE_LINE`) with the real single-voice rule: direction
      by distance from the middle line, and for a beamed group, one
      direction decided by the group's average position. Acceptance:
      unit tests over a range of pitches and one beamed-group case;
      demo shows correct stem directions including a beam that doesn't
      flip mid-group.
- [x] **Slice 4: Accidental placement + collision avoidance.**
      Courtesy accidentals (same pitch altered earlier in the measure
      needs no repeat per MusicXML convention, already partly handled
      by key-aware suppression; extend to same-measure repeats) and
      extra horizontal clearance when an accidental would overlap the
      previous note's stem/ledger lines at tight spacing. Acceptance:
      unit tests for repeated-accidental suppression within a measure
      and a tight-spacing collision case; demo shows no accidental
      overlapping adjacent ink.
- [x] **Slice 5: Ties.** Same-pitch note tied across a barline or
      within a measure; model gains a tie flag/link between two notes,
      layout draws the curve, and duration-capacity validation treats
      a tied pair as one sounding duration. Acceptance: unit tests for
      tie-across-barline and same-measure tie; demo shows a tie curve
      connecting two noteheads.
- [x] **Slice 6: Slurs.** Phrase mark spanning an arbitrary run of
      notes (not just a pair); model gains a slur span, layout draws
      one curve over/under the run. Acceptance: unit test for a
      multi-note slur's endpoints and curve direction (above vs below
      based on stem direction); demo shows a slur over a short run.
- [x] **Slice 7: Mid-score key/time signature changes.** `Score.time`/
      `keyFifths` become per-measure (or change-list) rather than one
      score-wide value; layout draws a courtesy signature at the
      change and at the system break before it if one falls there.
      Acceptance: unit test for a score with a key change and a time
      change, each landing at the right measure with correct courtesy
      glyphs; demo score includes one of each.
- [x] **Slice 8: Barline types.** Model gains a `BarlineType` field
      (normal/double/final/repeat-start/repeat-end) per measure
      boundary; layout draws each variant (final already exists via
      `ctx.isLast`, generalize it). Acceptance: unit test rendering
      each type's draw ops; demo score uses at least a double and a
      repeat pair.
- [x] **Slice 9: Note spacing algorithm.** Replace the fixed-plus-
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
- [x] **Slice 1: Two voices in one staff.** `layoutMeasure`'s single
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
- [x] **Slice 2: Voice-to-voice collision avoidance.** Extends M1
      slice 4's single-voice accidental/ink collision logic across
      voices: noteheads from two voices landing on the same or adjacent
      beat within a second of each other get offset (one nudged right,
      the standard convention) instead of overlapping, and an
      accidental in one voice checks the other voice's ink at that same
      x, not just its own. Acceptance: unit tests for a same-onset
      second-interval clash resolving to offset noteheads and an
      accidental clearing the other voice's stem/notehead; demo shows a
      close-interval two-voice passage with no overlapping noteheads.
- [x] **Slice 3: Staff/Part model + clef generalization.** `Score`
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
- [x] **Slice 4: Multi-staff system layout.** `layoutScore`'s
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
- [x] **Slice 5: Part grouping + braces/brackets.** `Part` (from
      slice 3) gains a brace (curly, for a keyboard-style grouped pair)
      or bracket (square, for a choir/ensemble group) drawn spanning
      its staves' full height at the start of each system, plus a part
      name label at the first system only (subsequent systems get no
      label, matching convention). Acceptance: unit test for correct
      brace/bracket glyph choice and vertical span per part, and name
      label appearing only on system 1; demo shows a 4-staff SATB score
      with a bracket and part labels.
- [x] **Slice 6: Cross-staff beaming.** A beam whose notes span two
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

### M3 — Phase 3: Sound / playback [?]

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
- [x] **Slice 1: Tempo model.** A score-wide tempo (beats per minute,
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
- [x] **Slice 2: Playback timeline.** A pass that walks the score's
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
- [x] **Slice 3: Web Audio lookahead scheduler.** A generic, drift-free
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
- [x] **Slice 4: Minimal oscillator synthesis.** A synthesis layer
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
- [x] **Slice 5: Transport controls.** A `PlaybackEngine` (or similar)
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
- [x] **Slice 6: Playback position hook.** A minimal, UI-free way for a
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

### M4 — Phase 4: Interaction layer [?]

Est. 1-2 months. Own hit-testing, selection/playback cursors, follow-scroll,
zoom, replacing what E2/E4/E7 currently read off OSMD
(`GetNearestNote`/`osmd.cursors`/`MeasureList`). Playback cursors depend on
M3's audio engine existing (built, all 6 slices, `[?]` pending the human's
own by-ear verification per M3's own closing report above; that
verification gates M3's sign-off, not this milestone's own scoping or slice
work, since everything below depends only on `PlaybackEngine`'s interface
(`onOnset`/`positionSeconds`), not on a human having confirmed it sounds
right).

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

Scoped 2026-09-06 (Claude, "on your own" per the human's explicit
instruction) against M0-M3's real, built code rather than a plan. A survey
of what already exists found this milestone narrower than its own
one-line summary suggests: hit-testing (`src/layout/hit-test.ts`) is
already real and already multi-staff-aware (`HitResult.staffIndex`, M2
Slice 3), so this milestone does not build hit-testing from nothing, it
closes the gaps left around it.

- **Selection is already multi-staff-broken, not just multi-staff-absent.**
  `CanvasRenderer.setSelection` (`src/render/renderer.ts`) resolves a
  `NoteId` to a bare measure `index`, not a `(staffIndex, index)` pair, a
  scope cut its own doc comment already flags ("left for whoever first
  builds one"). This is not merely incomplete, it actively misfires today:
  a caller combining it with `redrawMeasures(changed)`'s default
  `staffIndex = 0` will, for a note selected on any staff *other* than 0,
  repaint staff 0's same-numbered measure (arbitrary, unrelated pixels)
  and leave the actually-changed staff/measure stale, since two staves'
  measures can share the same numeric `index`. No test currently catches
  this because nothing before this milestone ever selected a note on a
  non-zero staff. Slice 1 below fixes it.
- **No playback cursor primitive exists at all.** `selectedNoteId` is a
  single id with one tint color; a playback cursor needs to highlight
  however many notes are sounding at once (a full SATB chord can be four,
  across four staves, on one onset), in a color distinct from an editor's
  own live selection so the two don't collide once M4 sits inside E2's
  editor (which keeps its own selection running while a piece plays back
  for preview). Slice 2 below adds this as its own tracked set, not a
  reuse of `selectedNoteId`.
- **Zoom is largely already free.** `LayoutOptions.staffSpacePx` is
  already documented as "the single knob that scales the whole render"
  (`src/layout/layout.ts`), and the demo already re-runs `layoutScore` +
  `renderer.setLayout` live on window resize (`demo/main.ts`'s debounced
  `resize` handler, changing `systemWidthPx`, not `staffSpacePx`, but the
  same mechanism). `CanvasRenderer.setLayout` does not touch
  `#selectedNoteId`, so selection already survives a relayout at a new
  scale for free. What is missing is not the scaling primitive itself but
  proof that it composes correctly with Slice 1/2's new state (a
  selection or playback cursor keyed by `NoteId`, not by a stored pixel
  rect, should relocate correctly after a zoom-triggered relayout without
  extra plumbing) and a real zoom control exercising it, which is what
  Slice 3 tests and demos rather than builds from scratch.
- **No scroll-into-view query exists.** Follow-scroll and the PDF-sync
  paragraph above both need "given a note (or the current playback
  position), what canvas region should a host scroll to", and today a
  caller would have to reach into `LaidOutScore.measures`/`.systems` by
  hand to compute it, exactly the kind of internal-structure reach-in the
  layout/render split (`src/layout/types.ts`'s own header comment) exists
  to avoid. Slice 4 below adds one small, pure, exported helper for this,
  reused by both selection-follow and playback-cursor-follow, and by a
  future PDF-sync host per the scope paragraph above (that host-side
  sync itself stays out of this repo, per that paragraph's own
  boundary).

Rechecked 2026-09-06 (Claude, self-review at the human's explicit request,
before any slice work starts): the survey above held, but Slices 1-2's own
demo checks as first drafted glossed over a real constraint, caught by
reading `createGrandStaffShowcaseScore`'s and `createSatbBracketShowcaseScore`'s
own doc comments (`src/demo-score.ts`) rather than assuming. Both say outright
that they are "deliberately *not* folded into `createFullDemoScore`" because
`appendMeasures` "only ever merges a source score into a single-staff
destination", and that M2's own way of visually checking a multi-staff
fixture was never the interactive `npm run dev` demo at all, it was
rasterizing `layoutScore` through node-canvas and eyeballing a PNG (the same
technique `npm run bench` uses). The first draft's Slice 1 demo check hedged
("once one is added to `createFullDemoScore`, or via a dedicated demo toggle
if folding it in there conflicts") rather than confronting this, and Slice 2's
demo check claimed the cursor would visibly move "staff to staff" against a
demo (`createFullDemoScore`) that is, per this same constraint, single-staff.
Fixed by committing to one concrete choice rather than leaving it open: M4
adds a small second canvas to the dev demo specifically for its own slices,
rendering `createGrandStaffShowcaseScore` (two staves, the simplest genuinely
multi-staff fixture) directly, not merged into the combined score. This is
new demo scope beyond what any M2 slice needed, and deliberately so: M2's own
checks were about render *correctness* (does it look right), which a static
PNG answers fine, where M4's are about *interaction* (can you click it, does
a live cursor move across it), which nothing short of a live browser can
answer. Slice 1's and Slice 2's task text below reflect this directly rather
than leaving it for slice time to improvise.

Not in scope, confirmed against the milestone breakdown above: measure-range
selection and undo/redo are M5's job ("Reparity with E2-E12"), not this
one; drawing/aligning a PDF pane is Divisi's own job per the scope
paragraph above, this milestone only exposes the position/region data a
PDF-sync host would consume; seam markers (E4) are also M5 territory (an
overlay reparity item), this milestone does not add seam-specific
concepts, only the general region-lookup primitive (Slice 4) a seam
overlay could later be built on.

**Acceptance criteria (whole milestone):** all 4 slices' criteria below
pass; `npm run check`/`test`/`build` stay green throughout.

**Tasks — Claude:**
- [x] **Slice 1: Multi-staff selection.** Widen `CanvasRenderer.setSelection`
      to return `{ staffIndex, index }` pairs instead of bare measure
      indices, and widen every call site (the demo's own selection
      handler) to pass the returned `staffIndex` through to
      `redrawMeasures` instead of relying on its `staffIndex = 0` default.
      Closes the real misfire described above, not just the "not yet
      built" gap its own doc comment names. Acceptance: a unit test
      selecting a note on a non-zero staff of a multi-staff fixture (e.g.
      `createGrandStaffShowcaseScore` or `createSatbBracketShowcaseScore`)
      asserts the returned pair's `staffIndex` matches the note's real
      staff, and that redrawing with it touches only that staff's own
      measure region, extending `renderer.test.ts`'s existing
      region-scoped-redraw proof to a non-zero staff for the first time;
      a second test confirms the pre-fix failure mode is real by
      asserting the *old* bare-index-plus-default-staff-0 path would have
      redrawn the wrong measure, so the fix is provably not a no-op; demo
      check: this slice adds a small second canvas to `demo/index.html`/
      `main.ts`, rendering `createGrandStaffShowcaseScore` directly (per the
      2026-09-06 recheck above, not merged into `createFullDemoScore`, which
      `appendMeasures` cannot target past staff 0), with the same
      click-to-select and flash-redrawn-region wiring the main canvas
      already has; click a note on its lower (bass) staff and confirm only
      that staff's measure repaints.
- [x] **Slice 2: Playback cursor.** `CanvasRenderer` gains a
      `setPlaybackCursor(noteIds: readonly NoteId[]): { staffIndex, index }[]`
      method (mirroring `setSelection`'s own diff-and-return-affected-
      measures shape, but over a *set* of ids rather than one, since a
      chord/multi-voice onset can highlight several notes across several
      staves at once) and a new `CanvasRendererOptions.playbackCursor`
      color, distinct from `selection`'s, so a live editor selection and
      an in-progress playback preview never collide visually. A host
      wires this to `PlaybackEngine.onOnset` (M3 Slice 6): each onset
      event's note id(s) become the new cursor set, the previous set's
      notes revert to their ordinary (or selected) tint. Acceptance: unit
      tests for the affected-measures diff over a single-note cursor move
      and over a simultaneous multi-note onset spanning two staves
      (asserting draw ops for every previously- and newly-highlighted
      note's measure, and no others, get redrawn), plus a test that a
      note both selected and cursor-highlighted at once renders
      consistently (cursor takes precedence, documented as a deliberate
      choice, not left ambiguous); demo check, in two parts per the
      2026-09-06 recheck above (the existing playback demo has no
      staff-to-staff case to show, it plays `createFullDemoScore`, which is
      single-staff): first, wire the M3 demo controls already in
      `demo/main.ts` (Play/Pause/Stop) to also call `setPlaybackCursor` from
      a `PlaybackEngine.onOnset` callback and watch the cursor visibly move
      note to note in real time against the audio, including jointly
      highlighting more than one note when the existing two-voice/
      voice-clash showcase measures land simultaneous onsets; second, on
      Slice 1's new second canvas, a temporary debug control that calls
      `setPlaybackCursor` directly with a hand-picked multi-staff note-id
      list (no second `PlaybackEngine`/`AudioContext` pair, that is out of
      this slice's scope) and confirms the highlight lands correctly across
      staves.
- [x] **Slice 3: Zoom.** No new scaling primitive (per the survey above,
      `staffSpacePx` already is one); this slice proves and demos that
      Slices 1-2's new `NoteId`-keyed state survives a live rescale.
      Acceptance: a unit test that relays a score out at one `staffSpacePx`,
      selects a note and sets a playback cursor, relays it out again at a
      different `staffSpacePx` via `layoutScore` + `renderer.setLayout`,
      and asserts both the selection tint and the cursor tint reapply
      correctly to the same note's new draw ops at the new scale with no
      extra calls needed; demo check: a zoom in/out control (e.g. two
      buttons or a range input) in the dev demo rescales the score
      smoothly, with whatever note is currently selected and/or
      playback-cursor-highlighted staying correctly highlighted through
      the change.
- [x] **Slice 4: Scroll-into-view region lookup.** One small, pure,
      exported helper, `regionForNote(layout: LaidOutScore, noteId: NoteId): Rect | null`
      (naming open to whatever reads clearest against `hit-test.ts`'s own
      naming), returning the region a host should scroll into view for a
      given note, built by reusing the same measure-lookup `setSelection`
      already does internally rather than a second traversal
      implementation. This is the primitive both follow-scroll and the
      PDF-sync scope paragraph above need ("note bounding box" position
      data), not a scrolling implementation itself: per this engine's
      framework-agnostic principle (same precedent as pointer-coordinate
      translation in the demo's own `pointerdown` handler), the engine
      hands back a `Rect`, a host decides what "scroll into view" means
      for its own container. Acceptance: unit tests against known fixture
      coordinates (a note in the first measure, a note in a later system
      after cast-off, a note on a non-zero staff) asserting the returned
      `Rect` matches that note's owning measure's region; demo check: a
      scrollable wrapper around the demo's canvas auto-scrolls to follow
      the playback cursor (Slice 2) as multi-system playback proceeds,
      using this helper for the target `Rect` and the demo's own code for
      the actual `scrollIntoView`/`scrollTo` call.

**Tasks — Human:**
- [ ] Review this scoping before slice work starts, the same M1/M2/M3
      convention. Also still outstanding from M3, tracked there, not
      duplicated here: the by-ear verification of M3 Slices 4-6's real
      audio playback, now performable via the dev demo controls added
      2026-09-06 (see M3's own Log entry above).

### M5 — Phase 5: Reparity with E2-E12 [?]

Est. 1-2 months. Re-port the editor features Divisi currently runs on OSMD
(`OMR_EDITOR_PLAN.md` E4 seam markers, E7 bar-range clef change, E8 undo/
redo) onto this engine's own model, plus MusicXML import (Audiveris output)
and export, the format bridge nothing in M0-M4 needed. Scoped 2026-09-07
(Claude, solo per the standing "keep making progress" instruction), `[ ]`
not `[~]` since M4 is still `[?]` pending review. Scoped against M0-M4's
real, built code into 6 sequential slices below, each with acceptance
criteria in M1-M4's style (unit-test assertions plus a demo check).

A survey of the current code found no MusicXML anywhere (the only `xml`
matches in `src/` are prose in doc comments), one reachable edit op
(`Score.transposeNote`; the `append*`/`add*`/`setTie` methods are
score-construction, not editing), no undo/redo of any kind, and selection
that is strictly single-note (`CanvasRenderer.setSelection(noteId | null)`;
`setPlaybackCursor` takes a set but is the playback cursor, a different
concept). So this milestone builds four things with no partial form in the
engine today, ordered so the riskiest (import) sits early while the format
is fresh and each later slice only depends on earlier ones:

- **MusicXML export before import.** Export is the smaller, fully-specified
  half (the model is the source of truth; every field it has maps to a
  known MusicXML element) and gives import a round-trip oracle
  (`import(export(fixture))` structurally equals `fixture`) rather than
  import being checked only against hand-written XML. New code lives in a
  new `src/io/` module depending only on `model` (not layout/render/
  playback), the same one-way layering `playback` already follows;
  `src/index.ts`'s "four layers" header comment updates to five, the way M3
  Slice 1 updated it when `playback` landed.
- **Undo/redo is structural, not a MusicXML snapshot.** E8 (the OSMD
  editor's undo) snapshots the `workingXml` string because that editor is
  MusicXML-native; this engine is model-native, so undo/redo snapshots the
  `Score` itself (a deep, id-preserving clone) and does not route through
  `src/io/` at all. This keeps undo independent of export/import
  correctness and speed, and a transpose's undo restores the exact prior
  model with no parse step. It does depend on a reliable `Score.clone`,
  which slice 3 builds and tests as its own deliverable.
- **Measure-range selection is a new renderer/hit-test concern, independent
  of everything else.** `hit-test.ts` today is point -> note only; range
  selection needs point -> `(staffIndex, measureIndex)` (click a measure
  body) plus a range-state primitive on `CanvasRenderer` with its own
  tint, distinct from both note-selection and the playback cursor so the
  three never collide once this sits inside E2's editor. Slice 4 builds the
  primitive; slice 5 is E7's actual payload (change a bar range's clef),
  which is also the first per-measure clef change the model has ever had
  and follows the exact `keyFifthsAt`/`timeAt`/`endBarlineAt`
  per-measure-override-plus-walk-back precedent M1 Slices 7-8 set.
- **Seam markers are a pure overlay, never model state.** Per E4, a seam
  marker is anchored to a measure boundary (E3's report gains a
  `boundary_measure` per segment) and is "overlay DOM only, never written
  into the MusicXML" so a saved draft stays clean. Here that is a
  `CanvasRenderer.setSeamMarkers(boundaries)` layer painted outside every
  measure's own ops/region, the same `LaidOutScore.partDecorations`
  pattern M2 Slice 5 used for braces/brackets, so `redrawMeasure` never
  disturbs a marker and a marker never inflates a measure's region. The
  engine draws marks a host passes in; it owns no seam concept, does no
  OMR mapping, and persists nothing.

Not in scope, confirmed against the roadmap: lyrics, repeats/endings/codas
playback semantics, grace notes, articulations, and the choral-scan edge
cases (British rests, divisi splits) are M6, so MusicXML import is
deliberately import-*tolerant* (it skips `<lyric>`, `<articulations>`,
`<grace>`, and unknown elements without failing) rather than
import-*complete*. The host-side PDF pane and page-level scroll-sync stay
Divisi's own `divisi-omr-editor` job per M4's intro; this milestone still
only exposes position data (`regionForNote` from M4 Slice 4, plus slice
6's boundary-region lookup). Note-level pixel mapping onto the scan stays
blocked on OMR data the pipeline discards, tracked in that plan, not here.

**Acceptance criteria (whole milestone):** all 6 slices' criteria below
pass; `npm run check`/`test`/`build` stay green throughout.

**Tasks — Claude:**
- [x] **Slice 1: MusicXML export.** A pure `exportMusicXml(score: Score):
      string` in a new `src/io/` module, emitting `score-partwise` MusicXML
      covering everything the model can represent: parts and their staves,
      per-staff clefs (treble/bass/treble8) and per-measure clef changes
      once slice 5 adds them, initial and mid-score key/time signatures (M1
      Slice 7), `tempoBpm` as a metronome direction, notes and rests with
      `<type>`/dots/`<time-modification>` for tuplets, explicit `<beam>`
      elements from the computed beam groups, `<stem>` direction,
      `<tie>`/`<tied>` and `<slur>` spans, `<staff>` numbers for
      multi-staff parts, and all five barline types (M1 Slice 8) as
      `<barline>` with `<bar-style>`/`<repeat>`. `<divisions>` is one value
      per part, the LCM of every note's denominator in that part.
      Acceptance: unit tests asserting the emitted tree for
      `createFullDemoScore` and `createSatbBracketShowcaseScore` has the
      expected `part`/`measure`/`note` counts and structure, that
      key/time/tempo/clef/barline round-trip as the right elements, and
      that a tie across a barline and a triplet each emit the correct
      paired markup; the emitted string parses as well-formed XML (via the
      test env's `DOMParser` or a tiny bundled parser, no schema validator
      required). Demo check: a "Download MusicXML" button in `npm run dev`
      writes a file that opens in MuseScore/Verovio and reads as the same
      score on screen (manual, this repo's established
      no-browser-automation approach for anything needing a real external
      renderer).
- [x] **Slice 2: MusicXML import.** `importMusicXml(xml: string): Score`
      in `src/io/`, parsing the `score-partwise` subset slice 1 emits plus
      tolerant handling of what Audiveris adds that this model does not
      represent (`<lyric>`, `<direction>` dynamics, `<articulations>`,
      `<grace>`: skipped, not fatal; an unknown element is logged once and
      ignored). Builds the `Part`/`Staff` structure from `<part>` +
      `<staff>`, resolves `<tie>`/`<slur>` endpoints in a second pass once
      every note id exists (the same forward-reference problem `buildScore`
      already solves for `extra.tiedToNext`), and maps `<divisions>` +
      `<duration>` back to `durationWholes`. Acceptance: unit tests
      importing hand-written fixtures (a one-part single-staff score, an
      SATB multi-staff part, a mid-score key change, a tie across a
      barline, a triplet) and asserting the resulting `Score`'s
      measures/voices/pitches/durations; a round-trip test asserting
      `importMusicXml(exportMusicXml(s))` is structurally equal to `s` for
      every showcase score in `demo-score.ts`; a tolerance test importing a
      fixture full of `<lyric>`/`<grace>`/`<articulations>` and asserting
      it succeeds with those dropped. Demo check: a real Audiveris MusicXML
      file checked into `src/test/fixtures/` loads and renders in `npm run
      dev` via an "Open MusicXML" control.
- [x] **Slice 3: Undo/redo.** A `Score.clone()` (deep, id-preserving)
      plus an `EditHistory` holding a bounded stack of clones (cap
      configurable, default ~100): `record(score)` pushes and clears the
      redo stack, `undo()`/`redo()` return the neighbouring snapshot, and a
      `dirty` flag is `current !== lastSaved`. `transposeNote` (and every
      future edit op) is expected to `record` the pre-edit state; the demo
      wires this so a run of transposes is fully reversible. Acceptance:
      unit tests for `Score.clone` producing an independent tree that
      re-lays-out identically and shares no mutable node with its source, a
      no-op edit recording nothing, undo->redo round-trip, record clearing
      redo, the cap dropping the oldest entry, and `dirty` tracking across
      a `markSaved()`; a test that undoing a transpose restores the exact
      prior `Pitch` and that `relayoutMeasure` on the restored measure
      produces the pre-edit draw ops. Demo check: Undo/Redo buttons and
      Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z in `npm run dev` reverse and replay a
      sequence of transposes, with the dirty indicator clearing on save
      and reappearing on the next edit.
- [x] **Slice 4: Measure-range selection.** Measure-level hit-testing
      (`hitTestMeasure(layout, x, y): { staffIndex, measureIndex } | null`,
      alongside `hit-test.ts`'s existing note lookup) and a
      `CanvasRenderer.setMeasureRange(range: { staffIndex, from, to } |
      null): { staffIndex, index }[]` primitive mirroring `setSelection`'s
      diff-and-return-affected-measures shape but over a contiguous run,
      with its own `CanvasRendererOptions.measureRange` tint distinct from
      `selection` and `playbackCursor`. Range is single-staff and
      contiguous (matching E7's "bar range"); an out-of-order `from`/`to`
      normalizes. Acceptance: unit tests for `hitTestMeasure` resolving a
      click to the right `(staffIndex, measureIndex)` including on a
      non-zero staff and in a later system after cast-off, the
      affected-measures diff over a range grown/shrunk/moved/cleared, and
      region-scoped redraw touching only the range's own measures
      (extending `renderer.test.ts`'s region proof to a measure range).
      Demo check: shift-click or drag across measures on the second canvas
      (`createGrandStaffShowcaseScore`, from M4 Slice 1) highlights the
      contiguous range, and only the measures whose membership changed
      repaint.
- [x] **Slice 5: Range clef change (E7 payload).** `Measure` gains an
      optional `clef` field, `undefined` meaning "same as the previous
      measure" (or the staff's own `Staff.clef` for measure 0), with
      `Score.clefAt(staffIndex, measureIndex)` walking back to the nearest
      earlier explicit value, the exact shape `keyFifthsAt`/`timeAt`/
      `endBarlineAt` already use. A `Score.setClefRange(staffIndex, from,
      to, clef)` edit op sets the range's first measure and restores the
      prior clef at `to + 1` if the range does not run to the staff end; it
      records one `EditHistory` entry (slice 3). Layout draws a courtesy
      clef at the change measure and repeats it at a system break falling
      on or before it (the same handling M1 Slice 7 added for mid-score key
      changes), and all clef-dependent line/ledger/key-position math
      (`CLEF_LINES`/`KEY_SIGNATURE_OCTAVES`, per-staff since M2 Slice 3)
      reads `clefAt` instead of the staff's single clef. Acceptance: unit
      tests for `clefAt` walk-back (including a range that reverts
      partway), `setClefRange` recording exactly one undo entry and its
      undo restoring every affected measure's clef, layout drawing the
      courtesy clef at the change and at a preceding system break, and
      notehead/ledger positions following the new clef mid-staff. Demo
      check: select a bar range (slice 4), click a clef button, see the
      clef change with a courtesy glyph and the notes reposition, then Undo
      restores it in one step.
- [x] **Slice 6: Seam markers.** A pure `regionForMeasureBoundary(layout:
      LaidOutScore, staffIndex: number, boundaryIndex: number): Rect |
      null` in `src/layout/` (reusing the measure lookup `regionForNote`
      already does, per M4 Slice 4's "reuse, don't re-traverse" note)
      returning the vertical strip a host should mark, and a
      `CanvasRenderer.setSeamMarkers(boundaries: readonly { staffIndex,
      boundaryIndex }[]): void` overlay painted from a marker list held
      outside every measure's ops/region exactly like M2 Slice 5's
      `partDecorations`, so `redrawMeasure` never erases a marker and a
      marker never inflates a measure's region. Markers are never model
      state: the engine draws what it is handed and owns no seam concept,
      no OMR mapping, no persistence. Acceptance: unit tests for
      `regionForMeasureBoundary` against known fixture coordinates (a
      boundary in the first system, one in a later system after cast-off,
      one on a non-zero staff, and `null` for an out-of-range index), and a
      test that transposing a note in a measure adjacent to a seam and
      calling `redrawMeasure` leaves the seam overlay's draw ops intact.
      Demo check: a hand-picked boundary list passed to `npm run dev` draws
      vertical seam marks at the right measure boundaries, and they survive
      a scoped redraw when a neighbouring note is transposed.

**Tasks — Human:**
- [ ] Review this scoping before slice work starts, the same M1/M2/M3/M4
      convention. It was drafted solo against M0-M4's built code while M4
      is itself still `[?]`; if M4's own review changes anything structural
      (the renderer's selection/redraw API in particular), slices 4-6 may
      need a light re-check.

### M6 — Phase 6: Real-world edge cases [?]

Open-ended; this pass scopes the first 9 slices. Scoped 2026-10-14
(Claude, with the human picking the fidelity strategy) while M2-M5 are
still `[?]`; the human chose to start M6 rather than block on those
reviews.

**Driven by measurement, not the roadmap list.** Every SFCC choral score
in `divisi-omr-editor/Backend/fixtures/SFCC/` (7 real Audiveris-era
MusicXML files, the scores the SFCC board's feedback is about) was run
through `importMusicXml` + `layoutScore`. All 7 import and lay out without
throwing, but:

- **Chords are the biggest loss by far.** The model has no chord concept,
  so the importer drops every `<chord/>` note: 1,842 of 8,416 notes (22%)
  in Brahms "Der Abend", 1,018 of 3,751 in Elgar "Challenge of Thor", 876
  of 4,551 in Faure "Les Djinns" (the board's named benchmark). Choral
  divisi is notated as 2-note chords in one voice (Divisi's own
  `splitChordalDivisi` relies on it), so this is the core choral case, not
  a piano-only one.
- **Everything else unmodelled is silently dropped,** and a save
  re-exports from the model, so engine-edit-then-save would strip an OMR
  draft of its dynamics (306 in Brahms), hairpins (479), articulations
  (872) and fermatas. Divisi's OSMD editor avoids this by mutating the XML
  DOM in place (E2's "leave every element we don't touch exactly as-is");
  this engine is model-native, so it needs its own answer.
- Tenor C clef (`<sign>C</sign><line>4</line>`, the board's "tenor line
  alternating bass <-> tenor clef") falls back to treble; whole-measure
  rests (`<rest measure="yes"/>`, 392 in Brahms) hit the "no `<type>`,
  using quarter" fallback.
- The only note-level edit op is `transposeNote`. E2's OSMD editor also
  had delete-to-rest and planned duration edits; fixing "British rests all
  over page 1" needs rest-focused ops.
- Brahms (5 `<part>`s) imports as 7 `Part`s, an import bug. Its full
  layout takes ~1.1s (the others 11-67ms).
- Lyrics, grace notes and repeats are rare in this corpus (zero `<lyric>`
  in all 7 files and in every Audiveris output in Divisi's local storage;
  11 `<grace>` total; repeats only in Frost Myth), so they sit last.

**Fidelity decision (human, 2026-10-14): model the common things, pass
the rest through.** Chords, C clefs, articulations/fermatas, dynamics and
hairpins become real model features with layout. Everything still
unmodelled is kept as an opaque, position-anchored passthrough payload
and re-emitted verbatim on export, so an import -> edit -> export round
trip never loses OMR data. Each modelling slice then "promotes" its
elements out of passthrough.

**Chord model (decided here, re-check in Slice 2):** follow MusicXML: each
notehead stays its own `Note` (own id, so hit-testing, selection,
transpose, ties and the playback cursor keep working per head unchanged),
with a chord membership marker joining it to the previous note's onset.
The cost is that every duration walk (`measureDurationWholes`,
`validateMeasure`, the playback timeline, beaming, horizontal spacing)
must count a chord once; Slice 2 enumerates and tests those sites. The
alternative (one `Note` with `pitches[]`) was rejected because it breaks
per-head identity everywhere M4/M5 already rely on it.

**Real fixtures live in the repo.** Slice 1 copies the 7 SFCC
`.musicxml` files (~6MB, PDFs excluded) into `src/test/fixtures/sfcc/`
(private learning-tool use, per the board's copyright note in Divisi's
memory), and a corpus test becomes every later slice's regression net.

**Acceptance criteria (whole milestone):** each slice's criteria below
pass; `npm run check`/`test`/`build` stay green; the corpus test's
dropped-element count reaches zero for every modelled-or-passthrough
element by Slice 3 and stays there.

**Tasks — Claude:**
- [x] **Slice 1: Real-corpus harness + import fixes.** Copy the 7 SFCC
      fixtures in; add a corpus test that imports and lays out each and
      records, per file, source `<note>` count vs model note count, part
      and staff counts, and a per-element-name tally of what was dropped
      (the importer reports drops through a structured collector instead
      of only `console.warn`). Fix the Brahms part-count bug (5 `<part>`
      must yield 5 `Part`s), import `<rest measure="yes"/>` as a
      whole-measure rest that fills its measure for any time signature
      (layout centres it, the standard engraving), and make the "no
      `<type>`" fallback derive from `<duration>` where it maps exactly.
      Acceptance: corpus test green and its drop tally snapshotted; unit
      tests for the part-count case, measure rests in 3/4, 2/2 and 6/8, and
      the duration-derived fallback; no "using quarter" warnings left on
      the corpus except genuinely unmappable durations, each listed.
- [x] **Slice 2: Chords.** Model per the chord decision above; layout
      stacks noteheads on one stem (seconds displaced to the opposite side
      of the stem, the standard rule), stem length spanning the chord,
      stem direction from the chord's extremes (reusing
      `stemDirectionForNotes`), stacked accidentals in non-colliding
      columns, ledger lines for the outermost heads, augmentation dots per
      head, ties per member; beaming treats a chord as one beam member.
      Import reads `<chord/>`, export emits it; playback sounds every
      member at the onset (the M3 timeline already handles simultaneous
      onsets across voices); `transposeNote` on one member moves only that
      head. Acceptance: unit tests for each listed layout rule (incl. a
      second in up- and down-stem chords and a 3-accidental stack), every
      duration-walking site counting a chord once, round-trip
      `import(export(s))` with chords, and the corpus test's dropped
      `<chord>` count at 0 with note counts matching source except
      remaining grace notes. Demo: a chord showcase score plus Les Djinns
      loadable in `npm run dev`.
- [x] **Slice 3: Lossless passthrough.** Unmodelled elements are kept
      on import as opaque XML subtrees anchored where they appeared: on a
      `Note` (e.g. `<notations>` children, `<lyric>`, `<notehead>`), on a
      `Measure` at an onset (`<direction>`, `<print>`, `<harmony>`), or on
      measure attributes (`<staff-details>`, `<transpose>`), and export
      re-emits each at its anchor. Passthrough survives `Score.clone`
      (undo) and edits: transposing a note keeps its payload; deleting a
      note (Slice 7) drops its own payload only. Acceptance: for every
      corpus file, `export(import(file))` has the same multiset of element
      names as the source (modulo a documented normalization list, e.g.
      `<divisions>` rescaling and whitespace), and the same after a
      transpose + undo; unit tests for each anchor kind.
- [x] **Slice 4: C clefs** (extended to mid-measure clef changes, see log). `ClefType` gains `alto` (C3) and `tenor` (C4)
      with their position tables and Bravura glyphs; import/export map
      them; `setClefRange` (M5 Slice 5) accepts them so the board's
      bass <-> tenor alternation is fixable with the existing tool.
      Acceptance: unit tests for middle C's position under each clef,
      key-signature placement under alto/tenor (the tenor-clef sharp
      pattern differs from treble/bass), a mid-staff bass -> tenor ->
      bass range, and the Les Djinns C3 warning gone from the corpus
      test. Demo: switch a range to tenor clef and back.
- [x] **Slice 5: Articulations + fermatas.** Model staccato, staccatissimo,
      accent, strong accent (marcato), tenuto and fermata on `Note`
      (promoted out of passthrough); layout places each on the notehead
      side opposite the stem (fermata always above the staff), stacking
      outward and clearing ledger lines/slurs; playback shortens
      staccato/staccatissimo and lengthens fermatas by a fixed factor.
      Acceptance: placement unit tests for up/down stems and chords, the
      corpus `<articulations>` children promoted (passthrough count for
      them 0), round trip preserved.
- [x] **Slice 6: Dynamics + hairpins.** Model dynamic marks (pp..ff, sf,
      fp and the like) and crescendo/diminuendo wedges as staff-anchored
      directions at an onset (a wedge spans start onset to stop onset,
      possibly across measures and system breaks); layout places them
      below the staff (above for a vocal staff with lyrics, deferred to
      Slice 9) without colliding with low notes; a wedge crossing a system
      break draws as two open segments like a slur does (M2's slur
      splitting); playback scales note velocity. Region-scoped redraw
      rule: a wedge's ops belong to the measures it crosses, so a scoped
      redraw of one of them repaints its segment (tested). Acceptance:
      layout/collision unit tests, cross-system wedge test, corpus
      `<dynamics>`/`<wedge>` promoted, round trip preserved.
- [x] **Slice 7: Correction ops (E2 parity).** Model edit ops, each
      recording one `EditHistory` entry and returning the touched
      measures for scoped redraw: `noteToRest` (E2's delete, keeps
      duration so nothing shifts), `restToNote(pitch)`, `setDuration`
      (value/dots; refuses or reports when the measure would overflow,
      never silently shifts the next measure), `addChordMember` /
      `removeChordMember`, and `setTie` exposed as an undoable op so a
      tie lost at a page join can be re-added. Acceptance: unit tests per
      op incl. undo restoring the exact prior model, measure-capacity
      enforcement on `setDuration`, removing a chord's anchor promoting
      the next member (the rough edge E2's spike hit). Demo: keyboard
      shortcuts for each in `npm run dev`, fixing a mis-read rest in Les
      Djinns' first page.
- [x] **Slice 8: Grace notes.** Model a grace note (with/without slash)
      attached before its principal note, taking no measure time; layout
      draws it cue-sized with its own small stem/flag/slash, spacing
      before the principal; playback steals a fixed short time from the
      principal. Acceptance: unit tests for zero duration contribution,
      layout size/position, round trip; corpus `<grace>` notes now in the
      model.
- [x] **Slice 9: Lyrics.** Model per-note lyric syllables (verse number,
      syllabic begin/middle/end/single, extender) promoted from
      passthrough; layout places verse lines below the staff, centres
      syllables under noteheads, draws hyphens between split syllables
      and extender lines, and widens measures so syllables don't collide.
      Acceptance: unit tests for hyphen/extender drawing incl. across a
      system break, collision-driven widening, round trip, plus a
      hand-written SATB-with-lyrics fixture (the corpus has none).

**Tasks — Human:**
- [ ] Review this scoping (slice order, the chord model decision, the
      passthrough approach) before or during Slice 1, the same convention
      as M1-M5.
- [ ] Get a real Audiveris output that contains lyrics, if Audiveris can
      produce one from an SFCC PDF, so Slice 9 has a real fixture.

**Not yet scoped (later M6 passes):** repeats/endings/codas with playback
semantics (only Frost Myth has repeats); cross-page ties beyond Slice 7's
manual re-tie (the page join itself is Divisi's E3/E10); divisi splits
where the staff count changes between pages (Divisi's segmentation
problem; the engine side is covered by chords); British rests beyond
Slice 1 + Slice 7 (the misread itself is upstream OMR).

## Backlog

- Full layout of Brahms "Der Abend" (337 measures, 6 staves) takes ~1.1s,
  vs 11-67ms for the other SFCC scores; profile once chords land (M6
  Slice 2), since first paint on open is the user-visible cost.
-  (compressed MusicXML) import: Divisi's Mozart Lacrymosa fixture
  is `.mxl`; the importer only takes an XML string today.

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
  suite to 284 (up from 279); check/build are green.
- 2026-09-06: M3 Slice 4 (minimal oscillator synthesis) done, via subagent
  while the human was away; Claude reviewed the diff and ran check/test/build
  directly before committing. `src/playback/pitch-to-frequency.ts` adds
  `midiToFrequency`/`pitchToFrequency` (`440 * 2^((midi-69)/12)`, built on
  `toMidi`), living in `playback` rather than `model` for the same layering
  reason `model` knows nothing about canvas drawing either.
  `src/playback/synthesis.ts`'s `playOnsetEvent(event, options)` creates one
  triangle-wave `OscillatorNode` plus a `GainNode` attack/release envelope
  (defaults 10ms/50ms, gain 0.2 to leave headroom under 4 simultaneous SATB
  voices), connected oscillator -> gain -> `audioContext.destination`,
  started/stopped at the event's own start/end; a note shorter than
  attack+release scales both ramps down proportionally rather than
  overlapping incoherently. Follows the same "take the real DOM type, hand
  tests a stub cast via `as unknown as AudioContext`" precedent
  `CanvasRenderer`/`CanvasRenderingContext2D` already set, so no jsdom or
  real Web Audio API needed in tests. Signature is a direct fit for
  `LookaheadScheduler`'s `onSchedule` callback, documented for Slice 5 to
  wire up. 12 new tests (6 pitch-to-frequency: A4=440Hz exactly, middle C
  and C#4 against independently worked-out reference values; 6 synthesis:
  node creation/connection, triangle waveform and frequency, start/stop
  timing, the normal envelope shape, and the short-note scaled-down
  fallback) bring the suite to 296 (up from 284); check/build are green. The
  plan's own manual browser audibility check (`createTwoVoiceShowcaseScore`
  actually audible) is still pending human verification, same as every
  other manual demo check in this repo's established no-browser-automation
  approach.
- 2026-09-06: M3 Slice 5 (transport controls) done, via subagent while the
  human was away, handed a fully worked-out design up front given this
  slice's architectural weight (the most involved of M3's six); Claude
  reviewed the diff line by line, hand-traced all four tests' arithmetic,
  and ran check/test/build directly before committing.
  `src/playback/playback-engine.ts`'s `PlaybackEngine` wraps Slices 2-4
  behind play/pause/stop/seek, taking precomputed `events` directly (no
  model-layer dependency, same discipline every other `src/playback` file
  follows). Position tracking is a `basePosition`/`baseAudioTime` pair:
  while playing, true position is `basePosition + (currentTime -
  baseAudioTime)`; while paused/stopped, `baseAudioTime` is `null` and
  position is simply the frozen `basePosition`, which is what lets `pause()`
  "record elapsed position against a clock that never pauses" without
  actually stopping the clock. `play()` builds a fresh `LookaheadScheduler`
  over only the events still ahead of the resume point, remapped from
  piece-time to real audio-clock time. `pause()` freezes position and halts
  future scheduling but deliberately leaves already-sounding notes ringing
  (only `stop()` silences them); `stop()` and `seek()` share a
  `haltAndSilence()` cleanup that calls `oscillator.stop(currentTime)` on
  every tracked node (re-calling `stop()` early is valid per the Web Audio
  spec), leaving no dangling nodes. A note already "in progress" at a seek
  target is deliberately excluded, not resumed: this engine has no way to
  resume mid-envelope, so restarting its attack at the seek point would
  falsify its real onset, documented as an honest scope cut rather than a
  gap. `playOnsetEvent` (Slice 4) gained a small additive change: it now
  returns the `{ oscillator, gain }` nodes it creates instead of `void`, so
  `stop()` has something to hold onto; `synthesis.test.ts` needed no edits
  and still passes. A `tick()` escape hatch (mirroring
  `LookaheadScheduler.tick()`'s own reason for existing) lets tests drive
  scheduling deterministically against a mock `AudioContext` with a
  controllable `currentTime`, never a real timer. 4 new tests (pause/resume
  preserving position across a large simulated gap, a mid-timeline seek
  scheduling only the correct remaining event, a straddling note correctly
  excluded rather than restarted, and `stop()` giving every already-created
  oscillator a second, silencing `stop()` call) bring the suite to 300 (up
  from 296); check/build are green. The plan's own manual by-ear demo check
  of real play/pause/stop/seek is still pending human verification.
- 2026-09-06: M3 Slice 6 (playback position hook) done, via subagent while
  the human was away; Claude reviewed the diff, hand-traced the new tests'
  arithmetic, and ran check/test/build directly before committing.
  `PlaybackEngine` gains `onOnset?: (event: OnsetEvent) => void`
  (`PlaybackEngineOptions`), fired once per event at the exact moment the
  internal `LookaheadScheduler`'s own `onSchedule` fires, per the plan's own
  instruction to build this "directly off Slice 3's scheduler loop rather
  than a separate polling mechanism". The one real subtlety: `play()`
  remaps every event's `startSeconds` from piece-time to real audio-clock
  time before scheduling it (so `playOnsetEvent` fires at the right wall
  time), but a caller's `onOnset` wants the original piece-time value (the
  same number `positionSeconds` or a note's own score position would use),
  so each internally-scheduled event now also carries a
  `pieceTimeStartSeconds` field threaded through untouched, and `onOnset` is
  called with a fresh event built from that field rather than the remapped
  one, verified by a test that deliberately starts `play()` well after the
  audio clock has advanced so the two numbers are clearly different and
  provably not conflated. `positionSeconds` itself (the query half of this
  slice, already built in Slice 5) needed no code change, just the
  acceptance criteria's own explicit "after a seek" case added to test
  coverage (both seeking while stopped and while actively playing). 3 new
  tests bring the suite to 303 (up from 300); check/build are green. The
  plan's own manual on-screen-counter-vs-stopwatch demo check is still
  pending human verification, same status as every other manual check
  across this milestone.

  **M3 is now feature-complete across all 6 slices** and set to `[?]`, not
  `[x]`: awaiting explicit human review and sign-off, the same convention
  M1/M2 used, since the human was away for this milestone's entire
  build-out (all 6 slices delegated to a fresh subagent each, reviewed and
  committed directly by Claude in between per the standing "clean context
  per slice" approach) and M3's own scoping review task (below) is still
  unchecked. What is genuinely solid: a score-wide tempo model with a pure,
  well-tested duration-to-seconds conversion (Slice 1); a playback timeline
  walking each staff/voice independently and correctly collapsing tied
  chains, including 3+ note chains, into single onsets (Slice 2); a
  drift-free Web Audio lookahead scheduler, generic over an injected clock
  and callback, fully unit-testable with no real timer or audio API (Slice
  3); minimal but real oscillator/envelope synthesis with a correctly
  guarded short-note fallback (Slice 4); a play/pause/stop/seek transport
  whose position-tracking and node-cleanup mechanisms were worked out and
  reviewed in real detail, including the deliberate pause-vs-stop asymmetry
  and the seek-excludes-in-progress-notes scope cut (Slice 5); and a
  position query plus onset callback built directly off the scheduler's own
  loop, correctly distinguishing piece-time from audio-clock time (Slice
  6). Every slice's automated verification (`check`/`test`/`build`) stayed
  green throughout, and the four real M2 gaps the milestone's own recheck
  surfaced before slice work started were fixed standalone ahead of time
  (see the 2026-09-06 Log entry above), so no M3 slice had to work around
  stale M2 limitations.

  What is simplified or punted, collected here since this is the
  milestone's closing report: a single score-wide tempo only, no mid-score
  tempo changes, the `keyFifthsAt`-style walk-back accessor this would need
  is explicitly deferred to a later phase (Slice 1). `LookaheadScheduler.tick()`
  does a plain O(n) scan of every event on every call rather than tracking a
  sorted cursor, a documented, deliberate simplification fine at this
  milestone's scale (Slice 3). One timbre (`'triangle'`) for every voice and
  staff; per-part timbre (e.g. distinguishing SATB voices) is real but
  separate, punted work (Slice 4). `pause()` deliberately leaves an
  already-sounding note ringing to whatever stop time it was already given,
  rather than silencing it (only `stop()`/`seek()` do that); a `seek()` into
  the middle of a note already in progress excludes that note entirely
  rather than attempting to resume it mid-envelope, since this engine's
  synthesis model has no way to resume a note partway through its own
  attack/release shape (Slice 5). `PlaybackEngine`'s own `activeOscillators`
  tracking set is only ever pruned by `stop()`/`seek()`, not as each
  oscillator naturally finishes on its own (no `onended` cleanup wired up),
  so a very long playback session with no manual stop/seek would grow that
  set unboundedly in memory; harmless at any realistic score length this
  engine targets, but worth a note here since no test exercises it (Slice
  5, not caught until this closing-report pass). And, spanning every slice:
  no repeat-playback semantics (a `repeatStart`/`repeatEnd` pair, M1 Slice
  8, plays through with no jump or ending-bracket logic, since nothing in
  this milestone's scope touches barline semantics at all), no visual
  playback cursor (explicitly M4's job per this file's own M4 entry, this
  milestone only exposes the position/onset data an M4 cursor would
  consume), and every manual, by-ear/by-eye demo check across Slices 4-6
  (real audible playback, real transport controls, a real on-screen
  position counter) is still outstanding, per this repo's established
  no-browser-automation-dependency principle: these need a human in an
  actual browser, not something a subagent or Claude can verify from the
  command line. None of this blocks M4; all of it is either flagged in its
  owning slice's own code comments or listed here for whoever scopes M4's
  actual cursor work to see in one place.
- 2026-09-06: Play/pause/stop transport plus a live position/onset readout
  wired into the dev demo (`demo/main.ts`, `demo/index.html`), via subagent,
  at the human's request. This closes the actual blocker behind the Slice 6
  closing report's "every manual...demo check across Slices 4-6...is still
  outstanding" line above: there was no way to trigger real audio playback
  from `npm run dev` at all, `PlaybackEngine` had only ever been driven from
  unit tests against a mock `AudioContext`. Plays `createFullDemoScore` (the
  same score already on screen, whose two-voice and voice-clash showcase
  measures already give it independent simultaneous voices) at its own
  tempo. One `AudioContext`/`PlaybackEngine` pair, built lazily on the first
  Play click (the browser's autoplay policy needs the context created or
  resumed from inside a user-gesture handler) and reused across every later
  click, since `PlaybackEngine` owns its own paused-position state across
  calls and reconstructing it each click would silently discard wherever a
  prior pause left off; `onOnset` drives a "last note" line, and a
  `requestAnimationFrame` loop polls `positionSeconds` for a running
  `m:ss.d / m:ss.d` readout. `npm run check`/`test` (303/303, unchanged)/
  `build` stay green.

  One new, minor finding surfaced while building this: `PlaybackEngine.isPlaying`
  never flips back to `false` on its own when playback runs past the last
  scheduled event, only on an explicit `pause()`/`stop()` (confirmed by
  reading the class, not by a failing test), so the demo's position readout
  keeps counting up past the score's own total length until a human clicks
  Stop. Harmless, and consistent with the class's own documented scope (no
  repeat/end-of-timeline semantics were ever in scope, see the Slice 6
  closing report above), but worth naming here since it is a real,
  previously-unflagged gap and is now directly visible in the demo rather
  than only inferable from the source.

  This makes M3's one remaining outstanding item, the human's own by-ear/
  by-eye verification of Slices 4-6, actually performable for the first
  time; it does not itself constitute that verification. M3 stays `[?]`
  pending the human actually clicking through `npm run dev` and confirming
  playback sounds right.
- 2026-09-06: M4 (interaction layer) scoped, by Claude "on your own" per
  the human's explicit instruction to proceed without asking, into 4
  sequential slices, `[?]` pending human review, the same M1/M2/M3
  convention. Scoped against M0-M3's real, built code (unlike M3's own
  first scoping pass, which was necessarily speculative against M2's
  then-still-`[?]` shape), which found the milestone narrower than its
  one-line "own hit-testing, selection/playback cursors, follow-scroll,
  zoom" summary suggests: hit-testing already exists and is already
  multi-staff-aware (M2 Slice 3), and `staffSpacePx` already is the
  single scaling knob a zoom feature would need. What actually surfaced:
  `CanvasRenderer.setSelection` returning a bare measure index instead of
  a `(staffIndex, index)` pair is not just a documented scope cut, it is
  a live misfire, selecting a note on a non-zero staff and redrawing with
  the default `staffIndex = 0` repaints an unrelated same-numbered
  measure on staff 0 and leaves the real change stale, since two staves'
  measures can share a numeric index; Slice 1 fixes this. No playback
  cursor primitive exists (a chord onset can highlight several notes
  across several staves at once, which `selectedNoteId`'s single-id shape
  cannot represent), so Slice 2 adds a separate tracked set with its own
  colour, distinct from selection, so a live editor selection and an
  in-progress playback preview don't collide once this sits inside E2's
  editor. Slice 3 (zoom) turned out to mostly be a proof-and-demo slice
  over what Slices 1-2 build, not a new primitive, since `setLayout`
  already leaves `#selectedNoteId` untouched across a relayout. Slice 4
  adds one small `regionForNote` helper, reused by follow-scroll and by
  the PDF-sync scope paragraph's own "note bounding box" data need
  (already in this milestone's intro, added 2026-09-05), rather than
  building scrolling itself, per the framework-agnostic principle.
  Measure-range selection, undo/redo, and seam markers are confirmed M5
  territory, not this milestone's. M3's own by-ear verification (still
  pending, see the entry above) does not block this milestone's own
  scoping or slice work, since everything here depends only on
  `PlaybackEngine`'s interface, not on a human having confirmed it sounds
  right; noted explicitly in M4's own intro above to avoid the two
  `[?]`-pending items being conflated.
- 2026-09-06: M4's own scoping self-reviewed the same day, at the human's
  explicit request ("Review the M4 scoping in plan.md"), before any slice
  work starts. The milestone breakdown and slice boundaries held; what did
  not was Slices 1-2's demo checks, caught by actually reading
  `createGrandStaffShowcaseScore`'s and `createSatbBracketShowcaseScore`'s
  own doc comments (`src/demo-score.ts`) instead of assuming: both say
  outright that they are deliberately not folded into `createFullDemoScore`
  because `appendMeasures` only ever targets staff 0, and that M2's own way
  of checking a multi-staff fixture was never the interactive demo, it was
  rasterizing through node-canvas and eyeballing a PNG. Slice 1's demo check
  as first drafted hedged on this ("once one is added to
  `createFullDemoScore`, or via a dedicated demo toggle if folding it in
  there conflicts") instead of confronting it, and Slice 2's claimed the
  cursor would move "staff to staff" against a demo that is, by that same
  constraint, single-staff. Fixed by committing to one concrete design: a
  small second canvas in the dev demo, added by Slice 1, rendering
  `createGrandStaffShowcaseScore` directly; Slice 2's demo check now splits
  into the existing single-staff playback demo (real audio, note-to-note,
  including simultaneous multi-voice onsets) plus a debug-button call
  against the new second canvas for the staff-to-staff case, rather than
  standing up a second full `PlaybackEngine`/`AudioContext` pair just for a
  demo check. Both slices' task text above reflect the fix directly.
- 2026-09-06: M4 Slice 1 (multi-staff selection) done, via subagent, reviewed
  and committed by Claude. `CanvasRenderer.setSelection` now returns
  `{ staffIndex, index }` pairs instead of bare measure indices, closing the
  real misfire its own doc comment used to flag: a caller feeding the old
  return straight into `redrawMeasures` (default `staffIndex = 0`) would
  repaint staff 0's same-numbered measure instead of the staff a non-zero-
  staff selection actually changed. Both demo call sites (`demo/main.ts`'s
  main canvas and the new second canvas below) now redraw each affected pair
  on its own staff instead of batching through one `redrawMeasures` call.
  `createGrandStaffShowcaseScore` is now exported from `src/index.ts`'s
  barrel (it wasn't) so the demo can use it. Per this milestone's own
  2026-09-06 recheck, `demo/index.html`/`main.ts` gained a small second
  canvas rendering `createGrandStaffShowcaseScore` (two staves, treble over
  bass) with its own click-to-select wiring, since `createFullDemoScore`
  cannot include a second staff (`appendMeasures` only targets staff 0);
  clicking a bass-staff note there now visibly redraws only that staff's
  measure. `renderer.test.ts` gained a test asserting the returned pair
  matches the note's real staff and that redrawing with it stays inside
  that staff's region, plus a second test that reproduces the pre-fix bug
  by construction (drops `staffIndex`, defaults to 0) and shows it paints
  the wrong staff, proving the fix is not a no-op. 305 tests pass (up from
  303); `check`/`test`/`build` all green. Flagged, not fixed here:
  `redrawMeasures(indices, staffIndex)` still only accepts one `staffIndex`
  for a whole batch, which is why both call sites now loop and call
  `redrawMeasure` per pair; widening `redrawMeasures` itself to accept pairs
  is a real but separate follow-up, out of this slice's stated scope.
- 2026-09-07: M4 Slice 2 (playback cursor) done, via subagent, reviewed and
  committed by Claude. `CanvasRenderer` gains `setPlaybackCursor(noteIds):
  { staffIndex, index }[]`, mirroring `setSelection`'s diff-and-return shape
  but over a set of ids (a chord or simultaneous multi-voice onset can
  highlight several notes across several staves at once), plus a new
  `CanvasRendererOptions.playbackCursor` colour (`#0369a1`, a blue distinct
  from `selection`'s orange/rust). `#drawOps` now checks cursor membership
  before selection, a deliberate precedence documented inline: a played-
  through selected note must show the moving cursor, not sit disguised as
  merely selected. Demo wiring split in two per this milestone's own
  2026-09-06 recheck: the main canvas's existing `onOnset` callback now also
  drives the cursor, batching same-instant onsets into one `setPlaybackCursor`
  call via `queueMicrotask` (since `OnsetEvent` is always one note per event,
  even for a chord, and `LookaheadScheduler` fires every simultaneous onset
  synchronously in one tick, so a microtask flush after that burst correctly
  groups them); Stop also clears the cursor, Pause deliberately leaves it
  (matching `PlaybackEngine.pause`'s already-sounding-notes-keep-ringing
  semantics). The second canvas (Slice 1) gained a debug button calling
  `setPlaybackCursor` directly with a hand-picked three-note chord spanning
  both staves, no second `AudioContext`, confirming the highlight lands on
  the right staff. `renderer.test.ts` gained three tests: a single-note
  cursor move, a multi-staff simultaneous-onset union (asserting only the
  affected measures repaint), and a colour-precedence test proving a note
  both selected and cursor-highlighted paints with the cursor's colour, not
  the selection's, via a small local styled-recording-context stub. 308
  tests pass (up from 305); `check`/`test`/`build` all green.
- 2026-09-07: M4 Slice 3 (zoom) done, via subagent, reviewed and committed by
  Claude. No new scaling primitive needed, per the milestone's own survey:
  `staffSpacePx` already scales the whole render, so zoom is just
  `layoutScore` at a new value plus `renderer.setLayout`. This slice proved
  and demoed that Slices 1-2's `NoteId`-keyed selection/playback-cursor
  state survives a rescale for free, since `setLayout` never touches either
  field. `renderer.test.ts` gained a test laying a score out at
  `staffSpacePx: 7`, selecting a note and setting a different note as the
  playback cursor, laying the same score out again at `staffSpacePx: 15`
  with only `setLayout` (no new `setSelection`/`setPlaybackCursor` call),
  and asserting both tints reapply to each note's new-scale coordinates,
  plus a sanity check that the coordinates actually changed so the
  assertions aren't vacuous. The dev demo's main canvas gained Zoom in/out
  buttons (`setZoom`, clamped `staffSpacePx` 5-20) doing the same
  relayout-setLayout-resize-redraw sequence the resize handler and
  `transposeSelected`'s full-relayout fallback already use; `drawAll` is
  correct here despite being a whole-canvas repaint, since every pixel's
  position changed, unlike an ordinary edit. 309 tests pass (up from 308);
  `check`/`test`/`build` all green.
- 2026-09-07: M4 Slice 4 (scroll-into-view region lookup) done, via subagent,
  reviewed and committed by Claude. New `regionForNote(layout, noteId): Rect
  | null` in its own file, `src/layout/region-for-note.ts` (kept separate
  from `hit-test.ts` rather than folded in: that file's own scope is
  specifically "canvas point -> note id", the opposite direction, and its
  DOM-element-avoidance framing doesn't apply to this lookup), mirroring
  `CanvasRenderer.setSelection`'s own measure search as a standalone pure
  function rather than a private method, exported from `src/layout/index.ts`.
  A lookup primitive only, not a scrolling implementation, per the
  framework-agnostic principle: it hands back a `Rect`, a host decides what
  "scroll into view" means for its own container. 4 new tests (first
  measure, a later system after forced cast-off, a non-zero staff, and the
  `null` case for an unknown id), each comparing against the layout's own
  `region` directly rather than a hand-computed rectangle. Demo check: the
  main canvas is now wrapped in a height-capped `#score-scroll` (`max-height:
  22rem`), small enough that `createFullDemoScore` (already casting off into
  well over a dozen systems at typical widths, confirmed directly rather than
  assumed) overflows and scrolls; the existing onset-cursor flush now also
  calls `regionForNote` and a manual `scrollTo` to keep the playback cursor's
  measure in view as playback proceeds into later systems. 313 tests pass (up
  from 309); `check`/`test`/`build` all green.

  This closes all 4 of M4's slices. What's solid: multi-staff selection no
  longer misfires onto the wrong staff (Slice 1); a playback cursor primitive
  distinct from selection, with documented precedence and correct behaviour
  across simultaneous multi-staff onsets (Slice 2); confirmation, not just
  assumption, that `NoteId`-keyed state survives a live rescale for free
  (Slice 3); and a scroll-into-view lookup reused by two real host needs
  (follow-scroll, and the PDF-sync data need named in this milestone's own
  intro) rather than a single-purpose one-off (Slice 4). What's simplified or
  punted, spanning the milestone: `redrawMeasures(indices, staffIndex)` still
  takes one `staffIndex` for a whole batch (flagged at Slice 1, both demo call
  sites work around it by looping); the zoom control's `staffSpacePx` bounds
  (5-20) are not derived from anything principled, just sanity limits; the
  demo's playback-cursor auto-scroll follows only the first note id of a
  simultaneous onset (harmless, since a chord's notes share the same or an
  adjacent measure region); and, per this milestone's own intro, the actual
  PDF-pane rendering and page-level sync stay Divisi's own job, this engine
  only exposes the position data. No gaps were found spanning into a slice
  that wasn't this milestone's own (measure-range selection, undo/redo, seam
  markers, confirmed M5 territory throughout). M4 stays `[?]`, not `[x]`:
  awaiting the human's own review of the scoping and a pass through
  `npm run dev`, the same M1/M2/M3 convention, and separately from M3's own
  still-outstanding by-ear verification tracked under M3, not duplicated
  here.
- 2026-09-07: M5 (reparity with E2-E12 plus MusicXML I/O) scoped, by Claude
  solo per the standing "keep making progress" instruction, `[ ]` not `[~]`
  since M4 is still `[?]`. Scoped against M0-M4's built code: confirmed no
  MusicXML anywhere, one reachable edit op (`transposeNote`), no undo/redo,
  single-note-only selection. Split into 6 slices: MusicXML export, then
  import (round-trip-tested against export, deliberately import-tolerant not
  import-complete so lyrics/grace/articulations stay M6), then structural
  (not XML-snapshot) undo/redo via a new `Score.clone`, then a
  measure-range selection primitive plus measure-level hit-testing, then
  E7's range clef-change payload (the model's first per-measure clef,
  following the `keyFifthsAt`/`timeAt`/`endBarlineAt` precedent), then E4
  seam markers as a pure overlay reusing M2 Slice 5's `partDecorations`
  pattern, never model state. Three judgment calls: export before import
  (gives import a round-trip oracle); undo/redo structural rather than
  E8-style XML snapshots since this engine is model-native; E7's clef op
  in-scope as its own droppable slice. Flagged for human review, same
  convention as M1-M4.
- 2026-09-07: M5 Slice 1 (MusicXML export) done, via subagent, reviewed and
  re-verified in the main session before recording. New `src/io/` module
  (fifth layer): `exportMusicXml` emits `score-partwise` 4.0 covering parts
  and staves, per-staff clefs, initial and mid-score key/time signatures,
  `tempoBpm` as a metronome direction, notes/rests with
  `<type>`/`<dot>`/`<time-modification>`, computed `<beam>`/`<stem>`,
  `<tie>`+`<tied>`, `<slur>`, `<staff>`+`<backup>` for multi-staff and
  multi-voice, and all five barline shapes; `<divisions>` is a per-part LCM
  computed from exact rationals so every `<duration>` is an integer. Part
  normalization: a named model `Part` becomes one `<part>` (multi-staff
  named parts carry `<staves>`), staves in no named part get a synthetic
  `<part>`, and an unnamed 2+-staff grouping becomes a `<part-group>` (brace
  for two, bracket for more), so `createSatbBracketShowcaseScore` exports as
  four bracketed parts. `computeBeamGroups`/`stemDirectionForNotes`/a new
  `middleLineForClef` are now exported from `layout`; `src/io` imports those
  three pure functions, a deliberate, documented exception to the
  "io depends only on model" note (they carry no geometry, and duplicating
  the beam-break rule would be worse). 327 tests pass (up from 313);
  `check`/`build` green; bench flat at 0.278-0.336ms scoped edit, unchanged.
  Three simplifications left for review: only the primary `<beam number="1">`
  is emitted (no secondary beams over 16ths inside an eighth group); a
  tuplet "run" is any maximal stretch of consecutive tupleted notes, so a
  six-note all-triplet measure emits one `<tuplet>` bracket rather than two
  groups of three (per-note `<time-modification>` is still correct); and a
  two-voice measure's `<stem>`/`<beam>` directions follow pitch, not
  layout's voice-1-up/voice-2-down override. Demo check outstanding: the
  "Download MusicXML" button in `npm run dev` was not built.
- 2026-09-07: M5 Slice 2 (MusicXML import) done, via subagent, reviewed and
  re-verified in the main session. New `src/io/xml.ts`: a small shipped
  dependency-free XML parser (`parseXml` -> immutable `XmlElement` tree),
  because the Node test env and a framework-agnostic runtime both lack
  `DOMParser`; skips prolog/comments/PIs/DOCTYPE (internal subset included),
  handles both quote styles, named + numeric entities, CDATA, and throws on
  malformed input. `importMusicXml(xml): Score` reads the `score-partwise`
  subset export emits plus Audiveris-tolerant extras: part-list names and
  brace/bracket `part-group` spans, `<staves>`-driven staff allocation,
  clef mapping, score-global + per-part + mid-score key/time, tempo from
  `<metronome>`/`<sound tempo>`, notes bucketed by `<staff>`/`<voice>` in
  document order (`<backup>` ignored, `<forward>` synthesized as a rest),
  all five barline shapes, two-pass tie and slur linking. Unknown elements
  `console.warn` once each; only malformed XML or a non-`<score-partwise>`
  root throws. New `src/model/score-equivalence.ts` (`assertScoresEquivalent`, in
  `model` rather than `io` so Slice 3's `EditHistory` can use it)
  compares musical content only (resolved key/time/barline accessors,
  per-voice note buckets, tie linkage, slurs by position, named parts and
  part-groups as sets; excludes note ids, beaming, and `crossStaffBeams`,
  the last a documented round-trip gap since export has no element for it).
  366 tests pass (up from 327: +17 xml, +22 import); `check`/`build` green.
  `TupletRatio` is now re-exported from `src/model/index.ts` (an M5 Slice 1
  omission). All 14 showcase/demo scores round-trip
  (`import(export(s))` musically equal to `s`), the sole exception being
  `createCrossStaffBeamShowcaseScore`'s cross-staff beam link.
- 2026-10-14: M5 Slice 3 (undo/redo) done. `Score.clone()` (deep,
  id-preserving, carries `#nextNoteId`, rebuilds the three private indexes
  rather than copying them) and `EditHistory` in `src/model/` (bounded
  snapshot stack, default cap 100; `record(edit)` keeps a pre-edit clone only
  when the edit returns non-null; `dirty` compares against the `markSaved()`
  baseline by musical content via `assertScoresEquivalent`, so undoing back to
  the saved state clears it). The session that built these was interrupted
  with 2 failing tests, fixed on resume: `transposeNote(id, 0)` now returns
  `null` (nothing changed, so nothing to record or redraw), and the
  "undo re-lays-out identically" test now compares against a `relayoutMeasure`
  of the pre-edit state rather than `layoutScore`'s output, because the two
  differ in the last float ulp of staff-line y (pre-existing drift, not an
  undo bug; left unfixed). Demo wiring via subagent, reviewed in the main
  session: Undo/Redo buttons, Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z and Ctrl+Y, a
  Saved/Unsaved indicator, and a "Save (download MusicXML)" button that
  exports and calls `markSaved()` (also closing Slice 1's outstanding demo
  check). Undo/redo does a full re-layout rather than diffing snapshots;
  playback rebuilds its engine from the current score on the next Play after
  an edit (an edit during active playback lands on the next pause/stop).
  378 tests pass; `check`/`build` green. Manual browser check of the demo
  passed (user, 2026-10-14). Synth timbre (bare triangle oscillator, M3
  Slice 4) noted as unpleasant during that check; user chose not to track
  it.
- 2026-10-14: Fixed two playback bugs found during Slice 3's manual demo
  check (both pre-existing, neither caused by Slice 3). (1) Engine bug in
  `computePlaybackTimeline` (M3): each `(staff, voice)` kept its own cursor
  that only advanced over that voice's own notes, so a voice absent from
  earlier measures started at time 0 wherever it first appeared.
  `createFullDemoScore`'s voice 2 (measures 23-26 only) played on top of
  measure 1, and the playback cursor bounced between the top and bottom of
  the score. Now every voice re-anchors to shared per-measure start times (a
  measure lasts as long as its longest voice on any staff, or its time
  signature's capacity if empty); regression test added. (2) Demo bug in
  `followPlaybackCursor` (M4 Slice 4): `canvas.offsetTop` was measured from
  the body because `#score-scroll` was not positioned, and a smooth scroll
  restarted on every onset; the wrapper is now `position: relative` and it
  scrolls only when the measure is off screen. Verified in headless Chrome:
  the score box now scrolls once per system, top to bottom. 379 tests pass.
- 2026-10-14: M5 Slice 4 (measure-range selection) done, via subagent,
  reviewed and re-verified in the main session. `hitTestMeasure(layout, x,
  y)` in `hit-test.ts` resolves a point to `{ staffIndex, measureIndex }` by
  region containment (blank staff space inside a bar counts, unlike
  `hitTest`). `CanvasRenderer.setMeasureRange(range | null)` stores a
  normalized single-staff `MeasureRange` and, unlike `setSelection`/
  `setPlaybackCursor`, returns only the symmetric difference of old and new
  members, so growing a long range by one bar repaints one measure. The
  `measureRange` option is a translucent region fill painted under the
  measure's ops (in `drawAll` and region redraws), not an ink recolour, so it
  composes with note selection and the playback cursor without a precedence
  rule. Demo: on the grand-staff canvas, click sets the anchor, shift-click or
  drag extends the range on the same staff; verified headlessly in Chrome
  (only changed measures repaint), and manual browser check passed (user,
  2026-10-14). 396 tests pass; `check`/`build` green.
  Noted, not fixed: a small pre-existing gap in the barline joining the two
  grand-staff staves, and em dashes in three `musicxml-import.test.ts` test
  names.
- 2026-10-14: M5 Slice 5 (range clef change) done, via subagent, reviewed
  and re-verified in the main session. `Measure.clef` is an optional
  per-measure override; `Score.clefAt(measureIndex, staffIndex = 0)` walks
  back to `Staff.clef` (argument order matches `keyFifthsAt`/`timeAt`, not
  the spec's `(staffIndex, measureIndex)`). `Score.setClefRange` normalizes
  the range, clears explicit clefs inside it, restores the prior clef at
  `to + 1`, and returns `null` for a no-op so `EditHistory.record` skips it.
  Layout resolves the clef per measure in `layoutScore`, the width probe and
  `relayoutMeasure`; a mid-system change draws a 0.75-scale clef inside the
  change measure's own ops, and system headers show the resolved clef. As
  with M1 Slice 7's key changes, no anticipatory clef at the previous
  system's end. MusicXML export/import carry mid-score `<clef>` changes (a
  clef between a measure's notes applies to the whole measure on import).
  Demo: the grand-staff canvas has its own `EditHistory`, clef buttons and
  Undo/Redo; Cmd/Ctrl+Z targets the last-clicked canvas. Verified headlessly
  in Chrome, and manual browser check passed (user, 2026-10-14). 415 tests
  pass; `check`/`build` green.
  Noted, not fixed: the grand-staff showcase is two one-staff parts, so the
  multi-staff `<clef number="2">` export path is covered only by a
  hand-built test score.
- 2026-10-14: M5 Slice 6 (seam markers) done, via subagent, reviewed and
  re-verified in the main session. `regionForMeasureBoundary(layout,
  staffIndex, boundaryIndex)` in `src/layout/region-for-measure-boundary.ts`:
  boundary `i` is the left edge of measure `i` (so at a system break, the
  start of the new system), `i === measureCount` the final barline; strip is
  0.6 staff spaces wide (`SEAM_STRIP_WIDTH_STAFF_SPACES`), centred on the
  edge except the final one, which sits inside it so the thick final barline
  is fully covered; height is the owning measure's region. Out-of-range,
  non-integer or missing-staff input returns `null`.
  `CanvasRenderer.setSeamMarkers` stores the list outside every measure's
  ops/region and re-resolves strips on `setLayout`; `drawAll` paints them
  last. Unlike `partDecorations`, strips overlap measure regions, so scoped
  redraws repaint each strip's intersection with the redrawn region (clipped,
  so translucent fill never stacks). `setSeamMarkers` itself does not paint
  (a removed strip can lie partly outside every region), so the host calls
  `drawAll` after it. New pixel-level node-canvas test proves strip pixels
  match a fresh full draw after a transpose plus scoped redraw. Demo: "Show
  seam markers" toggle on the main canvas; verified headlessly in Chrome.
  429 tests pass; `check`/`build` green. All 6 M5 slices done; M5 is `[?]`
  pending the scoping review and manual demo check.
  Noted, not fixed: scoped redraw already leaves faint anti-aliasing
  differences at fractional region edges (pre-existing, no seams needed);
  strip height varies with each measure's region; the demo picks its
  system-break boundary at toggle time, so after a resize it may no longer
  sit on a break until re-toggled.
- 2026-10-14: M6 (real-world edge cases) first pass scoped, with M2-M5
  still `[?]` (human chose to move on). Ran all 7 SFCC fixtures through
  import + layout: none throw, but chords (22% of notes in Brahms) are
  dropped whole, and every unmodelled element (dynamics, hairpins,
  articulations) would be lost on save. Human chose "model the common
  things, pass the rest through". Scoped 9 slices: corpus harness + import
  fixes, chords, lossless passthrough, C clefs, articulations/fermatas,
  dynamics/hairpins, E2 correction ops, grace notes, lyrics. Repeats,
  cross-page ties and staff-count divisi splits stay unscoped for a later
  pass. Brahms layout perf and `.mxl` import went to Backlog.
- 2026-10-14: M6 Slice 1 (real-corpus harness + import fixes) done, via
  subagent. The 7 SFCC `.musicxml` files (no PDFs) now live in
  `src/test/fixtures/sfcc/`; `src/io/sfcc-corpus.test.ts` imports and lays
  out each one, asserts the invariant "model notes = source notes - chord -
  grace + forward gaps" and that every `<part>` became a named `Part`, and
  snapshots (`src/io/__snapshots__/`) per file: source vs model note counts,
  parts, staves, measure rests, the drop tally and every fallback. Whole
  corpus runs in ~1.5s (Brahms ~0.8s).
  Diagnostics API: `importMusicXml(xml, { diagnostics })` with
  `createImportDiagnostics()` returning `{ dropped: Map<name, count>,
  fallbacks: ImportFallback[] }` (kind `note-value`/`clef`, part id, source
  measure number, detail), all exported from `src/io/index.ts`. Passing it
  records instead of `console.warn`ing; without it behaviour is unchanged.
  Tally unit is "topmost lost element": direction content by its
  `<direction-type>` child (`dynamics`, `wedge`, `octave-shift`, ...),
  notations by child (`articulations`, `fermata`, ...), a dropped chord or
  grace note once as `chord`/`grace`. Regenerated elements (`stem`, `beam`,
  `accidental`, notations `tuplet`, `backup`) are not tallied, nor is the
  one metronome/sound the score tempo came from.
  Part-count root cause: the `Score` constructor seeds a default part
  `{ staffIndices: [0] }` and the importer never cleared it (unlike
  `Score.clone`), so Brahms gave seed + 5 parts + 1 bracket group = 7. Every
  bracketed corpus file had the same extra part, not just Brahms. Now the
  seed is dropped and each `<score-part>` with a `<part>` gets a `Part`
  (also when unnamed; before, an unnamed `<part>` got none). Brahms yields
  5 instrument Parts plus the bracket group as a 6th, unnamed `Part`: the
  model records a bracket as a `Part` (layout draws it from there), so "5
  `<part>` -> 5 `Part`s" holds for instrument parts, not `score.parts.length`.
  Measure rests: `NoteSpec`/`Note.measureRestWholes` (number or null,
  `isMeasureRest` getter); `durationWholes` returns it, so validation,
  playback and spacing need no special case. The importer sets it from
  `timeAt` (capacity), ignoring `<type>` (Brahms writes `<type>whole</type>`
  on 3/4 measure rests) and `<duration>`; value is `'whole'`. Layout lays it
  out in its column, then `centreMeasureRests` translates its glyph and hit
  box to the centre between header end and barline. Export writes `<rest
  measure="yes"/>`, exact `<duration>`, no `<type>`; equivalence compares the
  field. It is a snapshot: a future time-signature edit op must refresh it.
  No-`<type>` fallback now derives dots too (0, 1, 2 when no `<dot>` given)
  and also covers an unsupported `<type>`, named in the event.
  Corpus after the fixes (source `<note>` -> model notes; parts =
  instrument + group): Brahms 8416 -> 6574 (1831 chord, 11 grace dropped;
  392 measure rests; 5+1 parts, 6 staves); Coleridge-Taylor 676 -> 552 (124
  chord; 4+1, 4); Faure 4551 -> 3675 (868 chord, 8 grace; 5+1, 6);
  Gardiner 3516 -> 2719 (797 chord; 5+1, 6); Frost Myth 1584 -> 1358 (226
  chord; 5+1, 5); Elgar 3751 -> 2733 (1018 chord; 5+1, 6); Fay's Song 798
  -> 728 (70 chord; 4+1, 4). No type-less notes remain anywhere. Remaining
  "using quarter" fallbacks, all genuinely unmappable: 8 `<type>breve</type>`
  notes in Coleridge-Taylor (4/2 time; P1 m14/m29/m30, P2 m30, P3 m30, P4
  m14/m29/m30), since the model has no breve value. Other fallback: Faure P4
  m66 C3 clef (Slice 4).
  Tests: 429 -> 446 (7 corpus + 1 fixture-count, plus unit tests for the
  part count (2), measure rests in 3/4, 2/2, 6/8 incl. round trip (3) and
  centring (1), duration-derived and unmappable fallbacks (2), drop tally
  (1)); `check`/`build` green.
  Noted, not fixed: 36 notes in the corpus have a `<type>` that disagrees
  with their `<duration>` (Brahms 7, Coleridge-Taylor 6, Faure 12, Frost
  Myth 11; e.g. Faure eighths with duration 1/96 whole), and the importer
  trusts `<type>`; 2 Frost Myth measure rests (m60) carry a 5/8 duration in
  a 3/4 bar (capacity wins); Audiveris names parts "Part 1".."Part 5" with
  `print-object="no"`, which layout will draw as labels since
  `print-object` is not read; the plan's "306 dynamics" for Brahms is 153
  `<dynamics>` elements (306 was likely open+close tags).
- 2026-10-14: M6 Slice 2 (chords) done, via subagent. Chord model as
  decided, no blocker found: each head stays its own `Note`, and
  `NoteSpec`/`Note.chordWithPrevious` joins it to the most recent earlier
  note *of the same voice* in its measure (the anchor; the MusicXML shape,
  made voice-scoped so interleaved two-voice literals and imports work).
  `Score.appendNote` throws for a member with no pitched same-voice anchor
  or on a rest. One grouping helper, `noteEvents(notes)` (model, exported):
  events in anchor order, anchor first; every duration walk now steps
  events and advances by the anchor's `durationWholes`. A member's own
  `value`/`dots` are ignored for timing and drawing (the anchor's head
  glyph, stem, flag, dots and beam membership are the chord's).
  `buildScore` takes a pitch array (`[['C4','E4','G4'], 'quarter']`);
  `tiedToNext` on a chord ties each head to the same-pitch head of the
  voice's next event.
  Duration-walking sites changed: `measureDurationWholes`,
  `validateMeasure`, layout `noteOnsets`/`measureColumns` (via new
  `eventsByVoice`), the `layoutMeasure` column walk (one event per voice per
  column), `computeBeamGroups` (a chord is one member, all heads vote on
  direction; `BeamGroup.notes` lists anchors), playback
  `measureStartsWholes` and `computePlaybackTimeline` (every head sounds at
  the onset; open tie events are keyed by tie target so each head of a tied
  chord extends its own event), export (`writeMeasureNotes` walks events;
  `<chord/>` on members, every head states the anchor's `<duration>`,
  `<beam>` and tuplet edges on the anchor only, `<stem>` from all heads;
  `<backup>` is unchanged since it already rewinds a full measure), import
  (`<chord/>` joins the previous `<note>` of the measure, taking its
  measure/staff/voice; a `<chord/>` with no pitched note to join is still
  dropped and tallied `chord`), `Score.clone`, `score-equivalence.ts`
  (compares `chordWithPrevious`), demo `appendMeasures`. Unchanged and
  correct per head: hit-test, `regionForNote`, renderer selection/cursor,
  slurs (`notesInOrder` includes heads, roof covers them), `transposeNote`.
  Layout (`layoutNote` now takes an event; a single note is the one-head
  case and every pre-existing layout/renderer test passed unchanged, i.e.
  single notes are op-for-op identical): one stem on the normal column from
  the far head (`ChordStem { left, attachY, nearY }`, also what
  `layoutBeamGroup` draws from), direction by `stemDirectionForNotes` over
  all heads; seconds displaced by `chordHeadDisplacement` (up stem
  bottom-up, upper head right; down stem top-down, lower head left;
  clusters alternate); `measureColumns` reserves one head width for a chord
  with a second; accidentals judged against the state before the chord
  (F#4+F#5 both show), placed by `stackAccidentals` (top, bottom,
  alternating inward, nearest column clearing by 6 steps), extra columns
  push the voice right like the existing collision shift; ledger lines
  once per position spanning every head at or beyond it
  (`layoutChordLedgerLines`, widened under a displaced head); dots in one
  column right of the rightmost head, line heads up a space, a clash
  pushed to the space below (`layoutChordDots`); ties split by side
  (upper half up, lower half down, odd middle away from the stem) via
  `NotePlacement.tieBelow`; cross-voice second clash checks every head
  pair. Stem/flag ops carry the anchor's id (selecting the anchor tints the
  stem).
  Corpus after (source `<note>` -> model notes, `chord` drops 0 in all 7):
  Brahms 8416 -> 8405 (11 grace), Coleridge-Taylor 676 -> 676, Faure 4551
  -> 4543 (8 grace), Gardiner 3516 -> 3516, Frost Myth 1584 -> 1584, Elgar
  3751 -> 3751, Fay's Song 798 -> 798. Expected side effects in the
  snapshot: notation children of formerly dropped chord notes are now
  tallied on their own (Brahms `cue` 3 -> 4, `technical` 38 -> 43; Faure
  `technical` 17 -> 18), and Coleridge-Taylor gains one breve fallback (P3
  m30, a chord member's `<type>breve</type>`). Corpus test runs in ~1.6s,
  Brahms ~0.8s, about as before.
  Demo: `createChordShowcaseScore` (9 measures: triads, seconds up/down,
  clusters, two 3-accidental stacks, divisi thirds, beamed eighth chords,
  tied chords, dotted chord, two chordal voices, ledger chords) appended
  to `createFullDemoScore` and exported from `src/index.ts`. There was no
  "Open MusicXML" control in the demo despite M5's plan text, so one was
  added (file input, fresh `EditHistory`, clears selection/seams/playback);
  transpose in the demo now passes the note's staff to
  `relayoutMeasure`/`redrawMeasure` so edits work on opened multi-staff
  files; `sizeCanvas` caps the backing-store density so a ~43k-px-tall
  score (Les Djinns) still allocates a canvas (it silently drew blank at
  dpr 2). Verified headlessly in system Chrome: showcase renders as
  intended, Les Djinns opens (6 staves, 124 measures, 4543 notes; import
  ~126ms, layout ~134ms) with its chords drawn.
  Tests: 446 -> 479 (19 in new `src/layout/chord-layout.test.ts`, 7 model,
  3 timeline, 4 import/round-trip; existing drop-tally test adjusted);
  `check`/`build` green. Bench (same machine, before -> after, scoped
  edit): 0.344/0.284/0.283/0.322 ms -> 0.359/0.292/0.280/0.331 ms for
  4/16/64/124 measures, i.e. noise; full redraw 27.5 -> 29.6 ms at 124
  (also within run-to-run noise). This machine's baseline today was
  already ~0.28-0.34 ms, not the logged 0.11-0.18.
  Noticed, not fixed: unisons in a chord (F and F# on one position) overlap;
  the cross-voice clash shift uses one x for all heads of a chord, so two
  voices' clustered chords (Les Djinns' piano bass, last bars) can still
  crowd; the extra-accidental-column shift is per voice, so in two-voice
  measures later shared columns can drift apart (pre-existing behaviour of
  the accidental collision shift); a member whose `value` differs from its
  anchor's is drawn with the anchor's head; cross-staff beams with chord
  anchors draw the anchor's stem only (untested); the demo's full score
  inherits D major from an earlier showcase, so the chord showcase states
  `keyFifths: 0` explicitly; `layout.systems.length` reports 372 for Les
  Djinns' 62 multi-staff systems (counts per staff, probably), worth a look.
- 2026-10-14: M6 Slice 3 (lossless passthrough) done, via subagent.
  Payload representation: `src/model/passthrough.ts` declares
  `OpaqueElement`, structurally identical to io's `XmlElement`, so the
  parser's frozen nodes are stored as-is with no conversion while `model`
  still imports nothing from `io` (a serialized string was rejected: every
  promotion and every equality check would reparse). Payloads are immutable,
  so `Score.clone` (undo) shares them by reference.
  Anchor kinds: `Note.passthrough` (unowned `<note>` children: `<lyric>`,
  `<notehead>`, `<cue>`, a `<notations>` cut down to unowned children, a
  `<rest>`'s display-step/octave, and any `<tie>`/`<tied>`/`<slur>` end that
  found no partner); `Measure.passthrough` (`MeasurePassthrough`: element +
  exact onset in wholes + voice stream + `lead` (a `<print>` before anything
  else) + the `<divisions>` it was read at), holding `<direction>`,
  `<print>`, `<harmony>`, `<sound>`, grace `<note>`s, an `<attributes>` with
  nothing modelled in it, unknown names; `Measure.attributesPassthrough` and
  `.barlinePassthrough` (unowned children of an owned `<attributes>`, and
  barlines minus what `startBarline`/`endBarline` took, merged back in
  schema order); `Score.headerPassthrough` (`<work>`, `<identification>`,
  ...) and `Part.passthrough` (`<score-part>`/`<part-group>` extras). The
  importer decides by `*_OWNED` sets, so promotion is "add the name, read
  it". Stream rule: an element right after a note is in that note's stream
  at its model clock (so OMR `<duration>`/`<type>` disagreements do not shift
  it); after a `<backup>`/`<forward>` it is in the next note's stream at the
  source cursor if a note follows before the cursor moves again, else the
  previous note's; a grace note is in its own staff/voice at that stream's
  clock, i.e. right before its principal. Export writes an anchor before the
  event at its onset, at the stream end, or (onset inside a longer event)
  after the stream via `<backup>`, never `<forward>` (import reads that as a
  rest). Export's backup between streams is now the actual cursor, not a
  fixed full measure. Part `<divisions>` folds in each anchor's source
  divisions (so `<offset>` stays verbatim; otherwise it is rescaled).
  `<tuplet>` brackets are passed through (the model has the ratio, not
  bracket extents, so adjacent triplets used to merge into one bracket);
  export regenerates brackets only for a run with none from the source. The
  tempo direction export writes is passed through like any direction, and
  export skips its own when passthrough already states the model's tempo; a
  direction of exactly export's own tempo shape in part 1 measure 1 is
  model-owned instead, so a built score gains no payload on round trip.
  Import fixes found by the new re-import equivalence check: measure 1's
  attributes are now read across every `<attributes>` block (Audiveris puts
  `<key>` in a second block, so the global key read as 0 and the real key
  became a measure-0 change); mid-score clefs are exported whenever a
  measure states one (redundant restatements survive).
  Normalization list (the corpus test's `NORMALIZED`, counts may differ):
  `accidental` (not written), `attributes` (blocks in one measure merged),
  `backup`, `beam` (primary level only), `notations` (several on one note
  merge when the model writes one), `staff` (written iff multi-staff part),
  `staves` (same), `stem`, `tuplet` (bare source runs get brackets), `type`
  (not on measure rests), `voice` (written on every note). Asserted exactly,
  not waived: nonzero `<alter>` count, `<duration>` minus backups, one
  synthesized tempo direction when the source has none, and one
  `clef`/`sign`/`line` per `dropped.clef`.
  Corpus result: `dropped` is `{}` for 4 files and only `clef` (a
  mid-measure clef change overridden in the same measure; the model has one
  clef per measure) for Brahms 4, Faure 5, Gardiner 2; everything else moved
  to a new `passthrough` tally (e.g. Brahms `articulations` 872, `wedge` 479,
  `tuplet` 461, `grace` 11, `tied` 27 and `slur` 9 unpaired ends). For all 7,
  `export(import(f))` matches the source modulo the list above,
  `import(export(import(f)))` is equivalent to `import(f)` with payloads
  compared (`assertScoresEquivalent` now compares every payload kind, as
  multisets, `<offset>` by the time it means), the second export is
  byte-identical, and a transpose keeps the note's payload and after undo
  the export is byte-identical again.
  Timings (Brahms, same machine): import 230-234 -> 240-244 ms, export 87-89
  -> 110-132 ms (it now writes the ~4k payload elements it used to drop).
  Tests: 479 -> 503 (17 in new `src/io/passthrough.test.ts`, 7 corpus
  round-trip tests, diagnostics test reworked); `check`/`build` green.
  Noticed, not fixed: XML attributes on modelled elements are not preserved
  (`<note default-x>`, `<time symbol="common">`, `<measure width>`, measure
  numbers are renumbered, `score-partwise version`); `<key><mode>` and other
  sub-children of modelled elements are tallied as dropped; `<unpitched>`
  becomes a rest (dropped); a `<part-group>` over one staff is dropped;
  unmatched slur ends keep their source `number`, so on re-import one could
  pair with a regenerated slur of the same number (none in the corpus);
  Slice 7's `setTie`/delete ops must clear a note's passthrough tie/tied of
  the same type, and duration edits must drop passthrough `<tuplet>`s of the
  run they change; the breve fallback in Coleridge-Taylor still loses a
  breve's length (now a passthrough-free fallback, listed under fallbacks);
  layout ignores all passthrough (nothing is drawn yet, by design).
- 2026-10-14: M6 Slice 4 (C clefs + mid-measure clef changes) done, via
  subagent. `ClefType` gains `alto` (C3) and `tenor` (C4): `CLEF_LINES`
  (alto F3/C4/G4, tenor D3/A3/E4), `KEY_SIGNATURE_OCTAVES`, and the Bravura
  `cClef` glyph (added to `scripts/extract-glyph-metrics.mjs` and regenerated,
  additions only), drawn centred on middle C's line. Key-signature positions
  were checked against MuseScore's `clefTable` (`src/engraving/dom/clef.cpp`,
  per-clef half-space offsets for sharps/flats), consistent with Gould,
  *Behind Bars*: alto keeps the usual zigzag; tenor sharps start low (F3 C4
  G3 D4 A3 E4 B3). The same check found a pre-existing bug, fixed: bass-clef
  flats were B3 E3 A3 ... (Bb above the staff, Ab on the top line); now B2
  E3 A2 D3 G2 C3 F2. The old flats test had encoded the wrong Bb3 and was
  corrected. Import maps `<sign>C</sign>` lines 3/4 both ways; C1/C2/C5
  still fall back to treble with a fallback event. Demo: Alto/Tenor clef
  buttons on the grand-staff canvas.
  Added to the slice (human request): mid-measure clef changes.
  `Measure.clefChanges: readonly ClefChange[]` (`{ onset (wholes, > 0),
  clef }`, sorted, immutable entries, frozen `NO_CLEF_CHANGES` default), kept
  apart from `Measure.clef` so every downbeat reader keeps its shape.
  `Score.clefAt` now carries an earlier measure's last change forward;
  `clefAtOnset(m, onset, s)` and `clefAtEnd(m, s)` are new. `setClefRange`
  clears changes inside the range (so a range holding one is never a no-op)
  and restores via `clefAt`, which already reflects a change the range ended
  in. Clone, `buildScore` (`clefChanges` on `MeasureBuildSpec`) and
  `assertScoresEquivalent` (compared as written) cover it. Layout: every
  note is laid out against a per-clef `MeasureContext`, so heads, ledgers,
  accidentals, dots and stems follow the new clef; the change draws a
  `CHANGE_CLEF_SCALE` clef before the first column at or after its onset
  (fixed, unjustified width, `MID_MEASURE_CLEF_GAP` each side), or after the
  last column before the barline for a change at the measure end (OMR's
  usual spelling of a next-downbeat change, and the commonest corpus case);
  the clef's ink becomes every voice's previous ink so a following
  accidental clears it. `computeBeamGroups` accepts a per-note middle line
  (layout and export use it only when a measure has changes). The barline
  courtesy clef compares against `clefAtEnd(m - 1)`. Import reads clefs in
  document order at the onset `MeasureAnchors.position()` gives (the same
  rule positional passthrough uses); onset 0 is `Measure.clef`, later is a
  change; two clefs at one onset keep the later and tally `clef` dropped.
  Export rides the passthrough anchor writer: each change is a synthetic
  `<attributes><clef>` anchor in the staff's first stream (before the event
  at its onset, at the stream end, or via `<backup>` inside a longer event),
  with change onsets folded into `<divisions>`. This also fixes the old
  behaviour where a clef at a measure's end recoloured that whole measure.
  Corpus: `dropped` is `{}` for all 7 files (Brahms 4, Faure 5, Gardiner 2
  clefs gone), and Les Djinns' C3 fallback is gone (P4 m66 imports as an
  alto change at beat 2.75); round-trip tests unchanged and green. Snapshot
  updated deliberately (only those lines).
  Verified headlessly (system Chrome): bass measures 2-3 of the grand staff
  switched to tenor (C clef on line 4, tenor Eb-major flats, small bass clef
  restoring at m4) and Undo restored them; Les Djinns P4 m66, P5 m53-56 (LH
  alternating G/F clefs mid-measure and at measure ends) and Brahms P5
  m47-48 rendered offline at 3x via node-canvas, since the demo canvas's
  capped density is too blurry for a 43k-px score.
  Tests: 503 -> 522 (model 5, layout 9, import 4, export 1); `check`/`build`
  green. Bench scoped edit 0.353/0.295/0.287/0.344 ms at 4/16/64/124
  measures, within this machine's usual range.
  Noticed, not fixed: `slurRoofY` and a slur's direction still use the
  measure's downbeat clef for every spanned note (and other measures'
  notes), so a slur across a clef change can arch oddly (visible at Les
  Djinns P5 m55-56); no edit op inserts or removes a mid-measure change
  (only import and `buildScore` create one; `setClefRange` clears them); a
  redundant change to the clef already in force is kept in the model but
  not drawn; multiple changes at one column draw only the last.
- 2026-10-14: M6 Slice 5 (articulations + fermatas) done, via subagent.
  Model: `Articulation` (`staccato`, `staccatissimo`, `tenuto`,
  `detached-legato`, `accent`, `strong-accent`) and `Fermata` (`upright` |
  `inverted`, normal shape only) on `Note` (`articulations`, always in
  `ARTICULATIONS` order without duplicates via `normalizeArticulations`;
  `fermata`, `null` for none), in `NoteSpec`, `Score.clone`, `buildScore`
  extras (`articulations`, `fermata`, set on a chord's anchor only) and
  `assertScoresEquivalent` (compared per head). Chords: a mark stays on the
  head it was written on, so a round trip keeps it there; everything that
  interprets marks reads the event's union (`eventArticulations`,
  `eventFermata`, exported from model). The corpus only has marks on chord
  anchors.
  Import: `readMarks` promotes the six kinds out of `<articulations>` and
  the first normal-shape `<fermata>` (empty text or `normal`), owning them
  by element identity, so a duplicate mark or a second/angled/square
  fermata stays passthrough; other kinds (`breath-mark`, `caesura`,
  `spiccato`, `stress`, ...) stay too, in an `<articulations>` cut down to
  them. The marks' XML attributes (`placement`, `default-y`, a marcato's
  `type`) are not kept, the same loss as other modelled elements. Export
  writes `<articulations>` (model kinds, then any passthrough kinds merged
  into the same element) and `<fermata type>` inside `<notations>`.
  Corpus: `articulations` and `fermata` gone from every `passthrough`
  tally (Brahms 872/11, Coleridge-Taylor 51, Faure 305, Gardiner 152, Frost
  Myth 5/3, Elgar 622/6, Fay's Song 59); the snapshot gains a per-file
  `marks` tally, and the test asserts every source mark of a modelled kind
  landed in the model (e.g. Brahms staccato 844, staccatissimo 6, tenuto
  22, fermata 10 upright + 1 inverted; Elgar accent 168, tenuto 132; Faure
  one detached-legato). Lossless round trip, re-import equivalence and the
  transpose+undo check all unchanged and green.
  Layout (`layoutEventMarks`, run last in `layoutMeasure` so stems, beams,
  measure-rest centring, ties and slurs exist): side opposite the stem,
  above for a rest or whole note; multi-voice uses the voice's side (odd
  above, even below), i.e. the stem end, stacking beyond the stem tip/beam
  (`layoutBeamGroup` now reports tips) and centring on the stem; marcato
  always above. Stack order is `ARTICULATIONS` (staccato/tenuto nearest).
  Staccato and tenuto snap into the nearest space clear of the head
  (`IN_STAFF_CLEARANCE` 0.25), stepping out once if that is a staff or
  ledger line; taller marks (accent, marcato, staccatissimo wedge, the
  combined tenuto-staccato glyph) stack at `ARTICULATION_CLEARANCE` 0.35 and
  move outside the staff if they would cross it. Fermata above the staff
  and everything at its x (heads, stem tip, marks, any tie/slur curve's
  control-point hull), inverted mirrored below, centred on the note or the
  (centred) rest. A chord gets each mark once, on its normal column. Mark
  ops carry the carrying head's id (selection tints them) and sit in the
  measure's own ops, so `measureRegion` covers them. Bravura `artic*`
  above/below glyphs, `articTenutoStaccato*` and `fermataAbove/Below` added
  to the glyph script and regenerated (additions only).
  Playback (`timeline.ts`, documented constants): staccato sounds 0.5 of the
  written span, staccatissimo 0.25, detached-legato 0.75, tenuto unchanged
  (unmarked notes are already full length); accent/marcato set
  `OnsetEvent.velocity` 1.3/1.5, which `playOnsetEvent` multiplies into its
  peak gain (the synth's only velocity notion). Fermata: the score's fermata
  spans (merged across voices/staves) become a time warp stretching each
  span 2x (`FERMATA_FACTOR`), so every voice sounding there is held and
  everything after starts later.
  Demo: `createArticulationShowcaseScore` (7 measures: each side, each kind,
  stacks, beamed staccatos, chords, ledger notes, fermatas on note/chord/
  rest plus an inverted one, two voices) appended to `createFullDemoScore`
  and exported. Verified headlessly: the demo in system Chrome, and Brahms
  m241-250 rendered offline at staff space 18 via node-canvas (piano
  staccato chords, a fermata on a whole-measure rest, chord fermatas).
  Tests: 522 -> 551 (14 in new `src/layout/articulation-layout.test.ts`,
  import/export 5, model 3, playback 6, renderer region 1); `check`/`build`
  green. Bench scoped edit 0.346/0.294/0.277/0.337 ms at 4/16/64/124
  measures, full redraw 30.2 ms at 124, i.e. unchanged.
  Noticed, not fixed: source `placement` is ignored, so an OMR mark read
  above a stem-up note moves below it; the whole-note rule is "above"
  (per the slice spec) rather than following a virtual stem; marks are not
  placed inside a slur and slurs do not avoid marks (only the fermata clears
  curves); a tall mark on the stem side between a high ledger note and the
  staff (multi-voice) is not checked against ledger lines; a staccato on a
  tied-into segment shortens only that segment, leaving a gap mid-tie;
  fermata over a barline (`<barline><fermata>`) stays passthrough; no edit
  op adds or removes a mark yet.
- 2026-10-14: M6 Slice 6 (dynamics + hairpins) done, via subagent.
  Model (`src/model/directions.ts`): `DynamicKind` (MusicXML's `<dynamics>`
  child names: p/f ladders pppppp..ffffff, mp, mf, sf, sfz, sffz, sfp, sfpp,
  sfzp, fp, fz, rf, rfz, pf, n; every one has a Bravura combined glyph),
  `DynamicMark { kind, onset, placement, voice, source }` on
  `Measure.dynamics` (sorted, immutable, the display staff's measure), and
  `Wedge { kind, staffIndex, placement, start, stop }` on `Score.wedges`, a
  score-level span list like `slurs`, each end a `{ measureIndex, onset,
  voice, source }` position (not note ids: MusicXML anchors a hairpin to a
  time, and stops often fall at a measure's end). `placement` is `null` when
  unstated (drawn below). `voice` is only the stream export writes in.
  Lossless round trip via `DirectionSource { element, slot, divisions,
  markAttrs }`: the source `<direction>` minus the promoted
  `<direction-type>`s (and minus `placement` when a dynamic or hairpin start
  owns it), the slot each came from, and the mark element's unread
  attributes (a wedge's `spread`). Marks read from one `<direction>` share
  one `element` object (identity is the grouping, kept by `clone`), so a
  dynamic + hairpin direction, or Audiveris' zero-length start+stop
  direction, is written back as one. `Score.addDynamic`/`addWedge`,
  `buildScore` (`MeasureBuildSpec.dynamics`, a 4th `wedges: WedgeSpec[]`
  argument), `clone` and `assertScoresEquivalent` (multisets of kind, onsets,
  placement, source key; `voice` deliberately not compared) cover it.
  Import: a `<direction>` with a promotable `<direction-type>` (exactly one
  child: `<dynamics>` with one empty modelled kind, or `<wedge>` of type
  crescendo/diminuendo/stop) is anchored by `MeasureAnchors` as before, and
  at the end of the part `promoteDirections` reads onset/stream/divisions
  off its passthrough entry, removes it, and builds marks. A dynamic goes on
  the staff its `<staff>` names (piano directions are often written in the
  other staff's stream). Hairpins pair by `number` per part in time order
  (measure, onset, document order); an unpaired end keeps its whole
  direction (and any dynamic in it, propagated to its partner's direction)
  as passthrough. A direction holding only the mark (plus its `<staff>` in a
  multi-staff part) gets `source: null`, so built scores round-trip to the
  same model. Left as passthrough: `<other-dynamics>`, two marks in one
  `<dynamics>`, wedge `continue`, and `<note><notations><dynamics>` (none in
  the corpus). Export: `directionAnchorsForPart` turns marks into synthetic
  positional anchors (the clef-change mechanism), rebuilding source
  directions slot by slot or writing a fresh `<direction>`; wedge `number`s
  are allocated afresh per part, lowest free among hairpins whose closed
  spans touch, so re-import pairs them regardless of same-onset order;
  anchor divisions fold into `<divisions>`.
  Corpus: `dynamics` gone from every passthrough tally (all 473 source
  `<dynamics>` promoted: Brahms 153, Coleridge-Taylor 31, Faure 119,
  Gardiner 55, Frost Myth 73, Elgar 38, Fay's Song 4); `wedge` passthrough 0
  except Brahms 7 and Frost Myth 4, all genuine source mismatches left as
  passthrough rather than guessed (a start numbered 3 whose stop says 4, two
  Brahms Part 1 diminuendos whose stops Audiveris wrote into Part 2, one
  start with no stop). Wedges modelled: Brahms 236, Coleridge-Taylor 90,
  Faure 70, Gardiner 81, Frost Myth 59, Elgar 54, Fay's Song 79. The
  snapshot gains per-file `dynamics` (by kind) and `wedges` counts, and the
  test asserts source `<dynamics>` = model dynamics and source `<wedge>` = 2
  x wedges + passthrough wedges. Lossless round trip, re-import equivalence,
  byte-identical second export and transpose+undo all green. Snapshot
  updated deliberately (only those lines).
  Layout: a separate pass per staff per system (`layoutDirectionRow`), run
  in `layoutScore` after a row's measures exist and redone for one measure
  in `relayoutMeasure` from cached neighbours. `LaidOutMeasure.inkExtent`
  (new, optional) records each measure's ink extent minus barlines (a
  shared multi-staff barline reaches into the staff gap) and minus
  directions. Each side of a system row gets one baseline
  (`directionBaselines`): clearance 0.6 plus Bravura's tallest ascent
  (1.776) below the lowest ink of every measure carrying a mark on that
  side, mirrored above with the deepest descent; so a system's dynamics and
  hairpins line up and clear low notes, stems, ledgers, marks and curves of
  the measures they sit in (a per-measure skyline, not per x). A dynamic is
  centred on the notehead/rest at its onset (interpolated by time between
  onsets, towards the barline after the last), clamped inside its measure's
  band. A hairpin is two straight lines (degenerate `curve` ops, Bravura
  `hairpinThickness`) from its start x (notehead left, or past a dynamic at
  that onset) to its stop x (before the notehead there, before a dynamic at
  that onset or the next downbeat, or the barline), opening 1.1 spaces,
  centred half an x-height above the baseline. It is cut at every barline,
  each measure owning its piece (so `measureRegion` covers it). Across a
  system break: one segment per system, the opening shared evenly between
  segments, a continuation starting just left of the new system's first
  note; a stop on the downbeat of a measure that opens a new system ends at
  the previous barline (no stub). Hairpins shorter than 1 space (OMR's
  zero-length ones) are not drawn. `relayoutMeasure` returns `null` if the
  edit moved the row's baseline (tolerance 0.001px), since every other
  marked measure would be stale. Bravura `dynamic*` combined glyphs and
  `hairpinThickness` added to the glyph script and regenerated (additions
  only).
  Playback (`timeline.ts`, documented `DYNAMIC_LEVELS`): ladder pppppp 0.1
  ... pp 0.35, p 0.5, mp 0.62, mf 0.75, f 0.88, ff 1.0, fff 1.1 ... ffffff
  1.4, held per staff until the next dynamic; music before a staff's first
  dynamic keeps level 1 (scores without dynamics sound unchanged). Accent
  kinds (sf, sfz, fz, rf, rfz 1.0; sffz 1.1) affect only attacks at their
  onset; fp/sfp/sfpp/sfzp attack then hold p/p/pp/p (`DYNAMIC_ACCENTS`); pf
  one step up; n `NIENTE_LEVEL` 0.05. A hairpin ramps linearly in written
  time from the level at its start to the next plain dynamic at/after its
  stop (before the next hairpin starts), else one ladder step, held after
  the stop. Multiplied with the Slice 5 accent velocity.
  Demo: `createDynamicsShowcaseScore` (8 measures: p < f, a diminuendo that
  crosses a system break in the demo, pp under a ledger A3 lowering the
  line, sfz/fp/rfz/sffz, mp and a crescendo above, a 3-measure pp < ff)
  appended to `createFullDemoScore` (`appendMeasures` now copies dynamics
  and offsets wedges) and exported. Verified headlessly in system Chrome
  (demo, no page errors besides the pre-existing 404) and offline at
  staff space 11-14 via node-canvas: Brahms m19-26 and Fay's Song m9-16.
  Tests: 551 -> 582 (layout 12 in new `src/layout/direction-layout.test.ts`,
  io 8 in new `src/io/directions.test.ts`, model 4 in new
  `src/model/directions.test.ts`, playback 6, renderer region 1; the
  diagnostics test now expects the paired `<p/>` promoted and the unpaired
  wedge still passthrough); `check`/`build` green. Bench scoped edit
  0.339/0.288/0.283/0.336 ms at 4/16/64/124 measures, full redraw 30.8 ms at
  124, i.e. unchanged (the pass is skipped for rows with no marks).
  Noticed, not fixed: `<offset>` is kept but not used for layout; a
  hairpin's `spread` is kept for export but layout uses a fixed opening;
  staff spacing is still fixed (`SPACING.staffGap`), so in close choral
  systems a staff's below-hairpins and the next staff's above-hairpins can
  meet or touch the neighbour's notes (visible in Fay's Song), and a
  direction reaching past the half gap makes the two staves' regions
  overlap by a few pixels (the same pre-existing class as deep ledger
  notes); dynamics and hairpins do not avoid each other horizontally beyond
  the start/stop rule (a hairpin spanning a mid-hairpin dynamic runs through
  it), nor lyrics (Slice 9, which should move vocal dynamics above); a
  neighbour's hairpin piece can go stale after a scoped edit that shifts
  note x without changing width (the slur precedent); per-staff playback
  levels ignore a grand staff's shared dynamics; no edit op adds or removes
  a dynamic or hairpin yet.
- 2026-10-14: M6 Slice 7 (correction ops) done, via subagent. Six ops on
  `Score`, each returning the touched measures as `MeasureRef[]` (`{
  staffIndex, measureIndex }`, deduplicated, sorted; a tie partner's or slur
  end's measure across a barline included) or `null` for both refusal and
  no-op, so `EditHistory.record` skips either; the caller records them like
  a transpose. A kept note keeps its id; `#measureOfNote`,
  `#tieSourceOfTarget` and `#crossStaffBeamOfNote` are maintained on every
  removal. Nothing ever moves outside the edited voice of the edited
  measure, so onset anchors (dynamics, hairpins, measure passthrough) stay
  valid. Semantics decided: `noteToRest(id)` keeps value/dots/tuplet,
  clears ties at both ends (partner's `tiedToId` too), drops articulations
  and the note's own payload, keeps a fermata (a rest fermata is real
  notation); a slur ending on it moves to the nearest pitched event inside
  the slur (same voice preferred), or is dropped if nothing is left inside;
  a cross-staff beam loses it and is dropped below two notes per side. On a
  chord head with siblings it removes the head instead (`removeChordMember`
  rules). `removeChordMember(id)` refuses a lone note; removing the anchor
  rebuilds the next head as anchor in the old anchor's slot (same id, its
  own ties/payload, the chord's value/dots/tuplet, plus any passthrough
  `<tuplet>` bracket the old anchor had); the removed head's articulations
  and fermata, slurs and cross-staff beam membership move to the remaining
  anchor. `restToNote(id, pitch)` keeps the duration and marks, drops the
  rest's payload (its `<rest>` display-step is meaningless on a note); a
  whole-measure rest becomes one note of the measure's length via the new
  model `noteValueForWholes` (4/4, 2/2 whole; 3/4, 6/8 dotted half; 7/8
  double-dotted half) and is refused when none exists (5/4, 5/8).
  `setDuration(id, value, dots)` changes the whole event (members follow
  the anchor): shorter pads with rests right after it (`restValuesFor`:
  undotted, each aligned to its own length, so half to eighth on beat 1
  gives eighth rest + quarter rest); longer consumes the rests that directly
  follow in the voice (leftover re-spelled as rests), then an under-full
  voice's slack, and refuses a pitched note in the way or a total past
  capacity; tuplets refused (the note's, or a tupleted rest it would
  consume), so Slice 3's passthrough `<tuplet>` brackets stay valid (any
  stray one on a changed head is stripped); a measure rest becomes an
  ordinary rest plus padding; ties stay; a head longer than an eighth
  leaves its cross-staff beam. `addChordMember(id, pitch)` appends a member
  after the event's last head with the anchor's value/dots/tuplet/voice,
  refusing a rest or a pitch already in the chord. The undoable tie op is
  `editTie(source, target | null)` (plus `tieTargetFor(source)`), not a
  stricter `setTie`, because import and `buildScore` still wire resolved
  ties through the low-level `setTie` and import does not guarantee
  adjacency; `editTie` requires the same-pitch head of the voice's next
  event (in the measure or the next one) and refuses a target another note
  already ties into; linking strips the source's passthrough `<tie>`/
  `<tied>` start and the target's stop (new `withoutTieMarkup`/
  `withoutNoteMarkup` in `passthrough.ts`), and untying strips a dangling
  OMR start too, so export writes each end once. `deriveValueFromDuration`
  in the importer now calls the model's `noteValueForWholes` (`NOTE_VALUES`
  moved to the model). Re-layout of the touched measures recomputes
  accidentals, beaming, second displacement and direction baselines; a
  layout test checks each op's touched measures against a fresh
  `layoutScore`, scoped or via the full-layout fallback (pitch/tie ops stay
  scoped, most duration and chord edits change width and fall back).
  Demo: shortcuts on the main canvas's selection, listed in a new
  `#shortcuts` block in `index.html`: Delete/Backspace note to rest (chord
  head removal), R rest/note toggle (middle line of the clef, spelled in the
  key), 1-7 whole..64th (undotted), `.` toggle dot, Shift+Up/Down add a
  diatonic third above/below, T tie to next / untie; each through
  `applyCorrection` (record, scoped redraw of every touched measure or full
  layout, selection moves to a surviving head when the selected one is
  removed); undo/redo drop a selection whose note no longer exists and say
  "Undid the last edit". Verified headlessly in system Chrome: opened Les
  Djinns, selected Part 2 m3's quarter rest, R made it a Bb4 (no
  accidental), 2 was refused (a note follows), R made it a rest again, undo
  restored the note, undoing all returned to "Saved"; no page errors.
  Tests: 582 -> 626 (28 model in new `src/model/correction-ops.test.ts`, 7
  io in new `src/io/correction-ops.test.ts` incl. passthrough tie markup,
  tuplet bracket hand-over, export -> re-import after every op on a built
  score with exact undo of every export, and a Les Djinns page-1 fix flow;
  9 layout in new `src/layout/correction-layout.test.ts`); `check`/`build`
  green. Bench scoped edit 0.356/0.287/0.280/0.334 ms at 4/16/64/124
  measures, full redraw 30.7 ms at 124, i.e. unchanged.
  Noticed, not fixed: rests consumed by a lengthening lose their fermatas
  and payloads silently; padding uses undotted rests even in compound time
  (correct, not always the shortest spelling); the demo's digit keys reset
  dots (`.` re-adds one); there is no op for inserting tied notes when a
  measure-rest length has no single value, nor for moving a chord head
  between voices; `transposeNote` still returns a bare measure index rather
  than `MeasureRef[]`; Les Djinns page 1 has no British-rest misreads to fix
  (its rests are real), so the demo flow fixes a real rest as a stand-in.
- 2026-10-14: M6 Slice 8 (grace notes) done, via subagent. Model:
  `Note.grace: GraceNote | null` (`{ slash, stealTimePrevious,
  stealTimeFollowing, makeTime }`, percentages as numbers, `make-time` held
  in wholes so it survives `<divisions>` rescaling; `ACCIACCATURA` /
  `APPOGGIATURA` constants for literals, `buildScore` extra `grace`). A grace
  is an ordinary `Note` stored inline in `measure.notes` right before its
  principal (the next event anchor of its voice in the measure), chosen over
  a list on the principal for the chord model's reason: per-head id, so
  hit-testing, selection, transpose, slurs, ties, clone/undo and passthrough
  work unchanged. The cost is paid in one place: a grace is *not an event*.
  `durationWholes` is 0, `noteEvents` skips graces, `measureDurationWholes`/
  `validateMeasure` skip them (a grace-only voice is no voice to fill),
  `appendNote` never lets a chord member stand on one, `buildScore`'s tie
  resolution skips them, and `noteDurationQuarters` (io) is 0; so every time
  walk (onsets, columns, beaming, playback measure starts, export cursor,
  correction-op event logic) is untouched. New `graceRuns(notes)` is the one
  place that groups graces into per-voice runs with their principal, or
  `null` for a run ending its voice (Brahms m86's grace is written at the
  end of m85, OMR's spelling of a grace before the next downbeat). Not
  modelled (constructor throws; import keeps them passthrough whole, the old
  path): grace rests, grace chords (`<grace/><chord/>`, also the anchor of
  one), tupleted graces; none in the corpus. Clone/`specOf`/equivalence
  (slash and every attribute) cover it. Correction ops: `noteToRest` on a
  grace removes it outright (ties, slurs re-anchored or dropped, payload,
  cross-staff beam), the only op that changes a grace's existence;
  `setDuration`, `addChordMember`, `removeChordMember`, `editTie`,
  `tieTargetFor` refuse a grace; `transposeNote` works; editing a principal
  ignores its graces (a consumed rest's graces stay and attach to the next
  event).
  Import: a `<grace>` note that is modelled goes through `buildNote` (no
  `<duration>`; no usable `<type>` falls back to eighth), joins slur pairing
  and tie linking like any note, and anchors positional passthrough on its
  stream exactly where the passthrough grace used to be. Export writes each
  run right before its principal (after positional anchors at that onset) or
  at the stream end for a trailing run: `<grace>` first (`slash="yes"` only
  when set, steal/make times as read), no `<duration>`, stem up (down for an
  even voice in a multi-voice measure), `<beam>` begin/continue/end for a
  run of two or more beamable graces; `make-time` folds into `<divisions>`.
  Corpus: `grace` passthrough 0 everywhere (Brahms 11, Faure 8 now model
  notes: beamed 16th pairs, eighth pairs, single slashed/unslashed eighths,
  one trailing, graces before invisible rests, two grace-to-principal slurs
  per file); the test now asserts model notes = source `<note>` + `<forward>`
  for all 7 files and model graces = source `<grace>`; the snapshot gains
  `graces` and `modelNotes` +11/+8, and `slur` passthrough drops 9 -> 7 in
  both (grace slur ends now pair). Updated deliberately (only those lines).
  Lossless round trip, re-import equivalence, byte-identical second export
  and transpose+undo unchanged and green.
  Layout (`planGraceRun`/`layoutGraceRun`): `GRACE_SCALE` 0.65 (SMuFL's
  engravingDefaults and Bravura publish no cue scale; Gould gives roughly
  60-70%, MuseScore's `graceNoteMag` is 0.7), every glyph via the op's
  `fontSizePx`, rects/curves sized in `g = 0.65 ss`, vertical positions on
  the real staff. Room for the widest run at a column is inserted before it
  as a fixed, unjustified width (`graceInsertPx`, the clef-change pattern),
  each voice's run right-aligned against its principal with
  `GRACE_PRINCIPAL_GAP` 0.55 ss, graces 0.3 ss apart; a trailing run draws
  after the last column, before the barline. Stem always up in a single
  voice (`graceStemUp`; voice parity in multi-voice), length `STEM_LENGTH`
  in grace spaces; cue flag; acciaccatura slash as a straight curve op
  through stem and flag (through the first stem of a slashed beamed run);
  consecutive beamable graces beamed with cue-thickness beams and secondary
  levels; cue accidentals judged against the measure's state but not
  updating it (a grace accidental applies to the grace alone, so the
  principal restates its own); cue-width ledger lines; hit boxes and
  `NotePlacement` (new `scale`) per grace, ties/slurs read head extents
  through it. A slur starting on a grace is drawn as the short grace slur
  under (away from the stem of) the two heads. The run's ink becomes the
  voice's previous ink, so the principal's accidental clears it. All ops in
  the measure's own ops, so `measureRegion` covers them (tested).
  Playback (`timeline.ts`, documented constants): graces play on the beat,
  stealing from the principal's start; a lone unslashed grace takes 1/2 of
  the principal (2/3 if dotted), anything else (acciaccatura, runs of 2+)
  takes a 32nd each, capped so a run takes at most 1/2 of the principal;
  `steal-time-following` overrides; total capped at 3/4; a trailing run
  plays before the next measure's first event of its voice; graces play at
  the dynamic level, never open ties; `steal-time-previous`/`make-time` are
  round-trip only.
  Demo: `createGraceShowcaseScore` (6 measures: acciaccatura/appoggiaturas,
  beamed 16th pair and slashed beamed eighths, cue accidentals and ledger
  lines, grace slur and grace before a chord, two voices, trailing grace)
  appended to `createFullDemoScore` (`appendMeasures` copies `grace`) and
  exported. Verified headlessly in system Chrome (demo bottom, only the
  pre-existing 404) and offline via node-canvas at staff space 14: Brahms
  m14-15, m63-64, m100, m129, m234, m279 and Les Djinns m22-24, m71-73,
  m84-86, m102-104 (beamed grace 16ths, slashed down-stem graces in the
  piano LH, a slashed grace slurred under to its principal, the trailing
  Bb3 before m86's barline).
  Tests: 626 -> 662 (model 14 in new `src/model/grace-notes.test.ts`, io 6
  in new `src/io/grace-notes.test.ts`, layout 9 in new
  `src/layout/grace-layout.test.ts`, playback 7 in new
  `src/playback/grace-playback.test.ts`; the passthrough grace test now
  covers a grace chord, the diagnostics tests expect `grace` modelled);
  `check`/`build` green. Bench scoped edit 0.351/0.289/0.288/0.328 ms at
  4/16/64/124 measures, full redraw 31.0 ms at 124, i.e. unchanged.
  Noticed, not fixed: in multi-staff systems the grace insert (like a clef
  change insert) shifts only its own staff's later columns, so the staves'
  rhythmic columns drift apart by up to a run's width; the source
  `<stem>` of a grace is not kept (Les Djinns' LH voice-2 graces say up, the
  multi-voice rule draws them down); dots on a grace and articulations on a
  grace are modelled but not drawn; a grace's ledger lines can visually
  merge with its principal's; `<type size="cue">` and `print-object="no"`
  rests the graces precede are not honoured (the latter pre-existing); no
  edit op inserts a grace (by scope).
- 2026-10-14: M6 Slice 9 (lyrics) done, via subagent. Model (new
  `src/model/lyrics.ts`): `Note.lyrics: readonly Lyric[]`, at most one per
  verse, `Lyric { verse, syllabic, text, elisions, extend, source }`: `verse`
  is MusicXML's `number` verbatim (`'1'` when unstated; `compareVerses` puts
  numeric verses first, by value), `syllabic` `single|begin|middle|end`
  (`single` when unstated), `text` `''` for an extend-only lyric, `elisions`
  the further `{ syllabic, text }` syllables of a MusicXML `<elision>` (drawn
  joined by an undertie), `extend` `start|stop|continue|untyped` or null.
  Lossless round trip by keeping the whole source `<lyric>` as `source`
  (formatting such as `placement`, `default-y`, `name`, `justify`, font
  attributes and `xml:lang` on `<text>`, `<end-line/>` sits on the very
  elements the model reads, so a cut-down residual would have to remember it
  all anyway); export writes `source` verbatim whenever reading it again
  gives the lyric's fields (always, until an op edits lyrics), else a
  regenerated `<lyric>` keeping the source's attributes and trailers. A
  `<lyric>` in exactly the plain shape export writes gets `source: null`, so
  built scores round-trip equivalent (the Slice 6 direction rule). Lyrics stay
  on the head they were read from (a chord member's too); layout reads the
  event's union (`eventLyrics`, first head wins per verse). `buildScore`
  `extra.lyrics` (anchor only), `clone`/`specOf` (shared frozen list),
  `assertScoresEquivalent` (per head, in order, source key included) cover
  it. Correction ops: `noteToRest` drops the note's lyrics (a rest is not
  sung, and which neighbour should take them is not an op's call; undo
  restores them); on a chord head, and `removeChordMember`, the removed
  head's lyrics merge into the remaining anchor (`mergeLyrics`: a verse the
  anchor already has keeps the anchor's syllable). Playback ignores lyrics
  (documented in `lyrics.ts`): the engine does not sing.
  Import/export (new `src/io/lyric-xml.ts`, `readLyric`/`lyricElement`,
  shared so "unchanged" means the same both ways): a `<lyric>` is promoted
  when its content is `(<syllabic>?, <text>, (<elision>, <syllabic>?,
  <text>)*, <extend>?)` or a lone `<extend>`, followed only by
  `<end-line>`/`<end-paragraph>`/`<footnote>`/`<level>`; `<humming>`,
  `<laughing>`, out-of-order content and a second lyric for a verse the note
  already has stay in `Note.passthrough`. Export writes model lyrics at the
  `<lyric>` slot (after `<notations>`), unpromoted passthrough lyrics right
  after them: the one reordering a round trip can make, only between a
  promoted and an unpromoted verse on one note (tested). Corpus untouched (no
  `<lyric>` in it); snapshot unchanged.
  Fixture: `src/test/fixtures/satb-lyrics.musicxml`, hand-written (generated
  once by a scratch script): SATB as 4 parts, 8 measures of 4/4, two verses
  on the soprano, begin/middle/end syllables, "ev-'ry" across measures 4/5
  (a system break at 1200px, staff space 10), "light," and "sing" melismas
  with extenders (one ended by an explicit extend-only `stop`), elisions
  ("in_a"), a low bass E2, an F#4 in the alto, a default-placed p and
  crescendo on the soprano and an explicit `placement="below"` mf on the alto.
  117 lyrics, all promoted, and they round-trip as the same elements in order.
  Layout (`layout.ts` lyric section): verse lines below the staff, verse 1
  nearest, 2.6 spaces apart, verse 1's baseline shared per system row:
  `firstBaseline` 4.6 spaces under the bottom line, or lower so the text
  clears the lowest ink of every measure in the row carrying a syllable
  (0.9 + 1.45 ascent). Text 2 spaces, drawn through the existing `text` op /
  label-font path with a new optional `align: 'center'` that the renderer
  honours (`ctx.textAlign`), so a syllable is centred under its notehead by
  real metrics; a syllable that starts an extender is left-aligned with the
  head (simple Gould rule). Widths are estimated per character class
  (`estimateLyricWidthSpaces`, sans-serif em widths), keeping layout
  renderer-free as `estimateTextWidthPx` does. Hyphens: rects (0.65 x 0.13
  spaces, 0.6 above the baseline) centred in the gap to the word's next
  syllable, one per ~6 spaces of a long gap, none below a 1-space gap; at a
  system break one after the syllable to the system's end and one more
  before the continuing syllable on the next system. Extenders: from 0.25
  after the syllable to the right edge of the melisma's last note (the
  voice's following pitched events singing nothing in that verse, stopping
  before the next syllable, a rest, or after an explicit extend `stop`),
  across measures and systems (continuing from the next system's first
  note); shorter than 0.8 spaces not drawn. Both cut at barlines, each
  measure owning its piece (a hyphen the measure holding its centre), so
  `measureRegion` covers them; `measureRegion` now gives a `text` op 0.3 em
  of descent. Horizontal spacing: `lyricColumnExtras` (model-only, run by
  `layoutMeasure`/`systemSpacingScale` so probes, justification, the real
  pass and a scoped relayout agree) estimates every staff's syllables at this
  measure index (head offset including an accidental wherever an alter
  differs from the key) and widens a shared onset grid until adjacent
  syllables of a verse keep 0.8 spaces between words and 1.6 inside a word,
  spreading each shortfall over the time between them; `measureColumns` adds
  each grid stretch to the columns covering it, so homophonic staves stay
  aligned (tested). Extra lead-in (unjustified) keeps the first syllable off
  the left barline; the barline moves right past the last syllable measured
  on the laid-out heads. Vertical: barlines are no longer joined below a
  staff carrying lyrics in that row (vocal-score practice, and the gap there
  is no longer fixed), and the next staff's top becomes max(fixed gap, row's
  lowest ink incl. lyrics and any dynamic under them + 4.5 spaces).
  Dynamics: on a row with lyrics, a dynamic or hairpin with no placement goes
  above (Slice 6's deferred rule), an explicit `below` one goes under the
  lyrics (`DirectionRow.lyricBottom`). `LaidOutScore.systems[]` gains
  optional `lyricVerses`/`lyricBaseline`; `relayoutMeasure` returns `null`
  when the row's verse set or baseline changed, or when any other measure of
  the row would draw a different hyphen/extender piece (a moved head, e.g.
  an added accidental), so no lyric ink goes stale.
  Demo: an "Open SATB lyrics sample" button imports the fixture through the
  Open MusicXML path. Verified headlessly in system Chrome (Playwright,
  `channel: 'chrome'`): the sample opens (4 systems of 4 staves at the demo width),
  verses, hyphens, extenders, elisions, p and hairpin above, mf below the
  alto lyrics; selecting C5 "ia," and transposing works (full relayout,
  since the sharp moves the head); no page errors besides the pre-existing
  404. Also checked offline via node-canvas at 900px (extender across the
  break) and unbroken.
  Tests: 662 -> 696 (model 10 in new `src/model/lyrics.test.ts`, io 7 in new
  `src/io/lyrics.test.ts`, layout 16 in new `src/layout/lyric-layout.test.ts`,
  renderer region 1; three existing io tests now expect `<lyric>` promoted
  rather than passthrough); `check`/`build` green. Bench scoped edit
  0.350/0.292/0.292/0.339 ms at 4/16/64/124 measures, full redraw 31.1 ms at
  124, i.e. unchanged.
  Noticed, not fixed: the staff gap is sized from what the row drew, but the
  gap *above* a lyric staff is still the fixed one, so its above-placed
  dynamics plus high ledger notes can still crowd the previous staff's
  lowest notes; the system-level gap only grows, never reserves per system
  for the next staff's above-dynamics; text widths are estimates for a
  sans-serif face (lyrics are drawn in the label font, sans-serif, not the
  usual serif), so gaps can be a little loose or tight; lyrics on a
  whole-measure rest or a grace note are not drawn; `placement="above"`
  lyrics are drawn below; two voices of one staff singing the same verse at
  the same onset draw overlapping text; a cross-staff beam on a lyric staff
  still uses the fixed-gap barline split; multi-staff `relayoutMeasure`
  still skips column sharing (pre-existing), so an edit on a staff that was
  not the widest at its column may fall back to a full layout; no op edits lyrics (by scope).
- 2026-10-14: M6 first pass (Slices 1-9) complete, each slice built by a
  fresh subagent and re-verified in the main session (check/test/build
  green before every commit). 696 tests (up from 429 at M5's close). On
  all 7 SFCC scores every source note is in the model, nothing is in the
  `dropped` tally, and import -> export is lossless modulo the documented
  normalization list. M6 is `[?]` pending the human scoping review and a
  manual demo pass; repeats/endings/codas, cross-page ties beyond
  `editTie`, staff-count divisi splits and general vertical spacing remain
  for a later M6 pass.
