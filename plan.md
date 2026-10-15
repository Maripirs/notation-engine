# Project Plan: notation-engine

**Current milestone:** M6

Roadmap and full decision record: `OMR_EDITOR_PLAN.md` milestone E13 in the
`divisi-omr-editor` worktree. This file tracks notation-engine's own
build-out; that one is Divisi's plan and stays the source of truth for why
this project exists.

## Testing policy

Adopted 2026-10-14 after the suite outgrew its value (about 12k test lines
for 18k source lines). Applies to every slice, including older
"Acceptance: unit tests for..." wording below.

- Test behavior through public entry points (import, layout output,
  render calls, playback events), not internal helpers or exact
  intermediate values.
- A slice adds a handful of tests (roughly 3 to 8): the main behavior,
  the one or two edge cases that actually broke or are likely to, and a
  round trip where IO is involved. Not every combination.
- Prefer `it.each` tables over copy-pasted cases. Reuse shared fixtures
  and builders instead of re-declaring scores inline.
- Don't pin pixel coordinates or layout constants unless the slice is
  about that exact geometry; assert relations (above/below, ordered,
  non-overlapping) instead.
- Don't re-test what an earlier test already covers just because a new
  feature passes through it.
- Per slice: `npm run check` and `npm test`. `npm run build` and the
  demo check run once at milestone end, or per slice only when the slice
  is visual and the risk is visible only in the demo.

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
  of M3 slice work starting (see git history). Slice 2 still does
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
  independently rather than summing across voices. This means Slice 2's
  playback timeline was never
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
      `staffIndex` (fixed 2026-09-06) but still
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
      2026-09-06 fix, but this slice's own test
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
      day rather than left for a slice to work around.

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
milestone): the human's workflow for an OMR-derived score is view
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
      2026-09-06.

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

### M6 — Phase 6: Real-world edge cases [~]

Open-ended; this pass scopes the first 9 slices. Scoped 2026-10-14
(Claude, with the human picking the fidelity strategy) while M2-M5 are
still `[?]`; the human chose to start M6 rather than block on those
reviews. Slices 12-15 (repeats and voltas) were scoped 2026-10-15 as the
second pass, the human picking repeats + voltas over also modelling
navigation marks (segno, coda, D.C./D.S./Fine). The corpus barely
exercises this: only Frost Myth has a repeat (one measure, m65) and no
SFCC score has an ending, so these slices lean on a hand-built fixture.

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
- [x] **Slice 4: C clefs** (extended to mid-measure clef changes). `ClefType` gains `alto` (C3) and `tenor` (C4)
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
- [x] **Slice 10: Shared multi-staff system breaks.** Found 2026-10-15
      reviewing Les Djinns in the demo: each staff is cast off into
      systems on its own and columns are widened to the widest staff
      afterwards, so at `systemWidthPx: 958` 70 of 124 measures end past
      the system's right edge (layout.width 1765) and `layout.systems`
      reports one system per staff per line (354). Cast off once per
      score from shared column widths so every staff breaks at the same
      measures and no system exceeds `systemWidthPx` (a single measure
      wider than the system is the only allowed overflow). The demo's
      `#score` keeps its aspect ratio if its CSS box is ever narrower
      than `layout.width`. Acceptance: every corpus file at two widths
      has no measure ending past `systemWidthPx` (except a lone
      over-wide measure) and every staff shares the same break points;
      scoped `relayoutMeasure` still matches full layout.
- [x] **Slice 11: Viewport-sized rendering.** One canvas the size of
      the whole score (Les Djinns: 1982x43530 CSS px, capped to a
      1492x32767 backing store at ~0.75x density) is blurry on retina
      and takes 33-65ms to reach the screen after a selection click,
      though the handler itself runs under 1ms. Render only what is
      visible (a viewport-sized canvas that repaints on scroll, or one
      canvas per system) at full device-pixel ratio, keeping scoped
      redraw, hit-testing, the playback cursor and follow-scroll
      working. Acceptance: backing store never exceeds the viewport
      (or one system) times DPR; Les Djinns renders at full DPR; a
      selection click on Les Djinns paints within one or two frames in
      the headless probe; existing renderer tests green.
- [ ] **Slice 12: Volta model + IO.** Bring `<ending>` out of
      passthrough into per-measure model fields, mirroring
      `startBarline`/`endBarline`: a start carries its numbers (`1`,
      `1, 2`) and optional label text; an end is `stop` (hooked) or
      `discontinue` (open). Read a backward `<repeat>`'s `times`. A
      malformed ending (start with no stop) stays passthrough.
      Acceptance: a hand-built fixture with 1st/2nd endings round-trips;
      SFCC corpus snapshots unchanged.
- [ ] **Slice 13: Volta layout + render.** Brackets above each system's
      top staff: hooked start, number label, hooked or open end, and a
      continuation across a system break (no left hook on the continued
      piece). Clear above-staff marks and dynamics the way the existing
      above-staff stacking does; scoped redraw stays correct.
      Acceptance: relational layout tests; demo check.
- [ ] **Slice 14: Playback unfolding.** Build a measure play order: a
      backward repeat jumps to the nearest forward repeat (or the score
      start), honouring `times`; each pass takes the ending whose numbers
      match. The timeline plays measures in that order, so a note id can
      appear in several events. A tie chain ends at a jump; fermatas,
      dynamics and graces apply per pass. Acceptance: timeline tests on
      the hand-built fixture; Frost Myth m65 plays twice.
- [ ] **Slice 15: Cursor and seek across repeats.** The playback cursor
      and follow-scroll jump back with the music; pause/resume keeps the
      current pass; seeking from a note starts at its first pass.
      Acceptance: headless demo probe on the fixture.

**Tasks — Human:**
- [ ] Review this scoping (slice order, the chord model decision, the
      passthrough approach) before or during Slice 1, the same convention
      as M1-M5.
- [ ] Get a real Audiveris output that contains lyrics, if Audiveris can
      produce one from an SFCC PDF, so Slice 9 has a real fixture.

**Not yet scoped (later M6 passes):** cross-page ties beyond Slice 7's
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
- `assertScoresEquivalent` ignores cross-staff beams: a clone with a beam
  removed still compares equal (found during the 2026-10-14 test trim).
- [Layout] Beams are flat, not angled to the notes' contour; accidental
  carry-over is tracked per diatonic step, not per (step, octave).
- [Layout] Key, time and clef changes landing at a system break are not
  announced at the end of the previous system.
- [Layout] Casting-off is greedy and justification a single linear
  estimate (can land a hair short); a narrower staff's column is padded,
  not re-justified; label width is a character-count heuristic.
- [Layout] Natural spacing is loose for dense multi-staff music: Les
  Djinns at 958px (ss 11) casts off 114 systems for 124 measures, about
  79k CSS px tall.
- [Demo] `systemWidthForViewport` overestimates the score box at narrow
  windows (a 709px layout in a 652px box at a 700px window), so the
  canvas scales down; the staff-select canvas still pins its height.
- [Ties/slurs] Each tie/slur half picks its direction from its own note,
  so halves can bulge oppositely around a beamed note; `slurRoofY` and
  slur direction use the downbeat clef, so a slur across a clef change
  arches oddly (Les Djinns P5 m55-56); slurs and articulations ignore
  each other (marks are not placed inside a slur).
- [Cross-staff beams] No x-coordination; only two adjacent staves with 2+
  notes per side (no beamlet stub); chord anchors draw only the anchor's
  stem (untested); on a lyric staff they still use the fixed-gap split.
- [Chords] Unisons (F and F# on one position) overlap; the cross-voice
  clash shift uses one x for every head, so two voices' clustered chords
  crowd; the per-voice extra-accidental shift lets shared columns drift
  apart; a member whose value differs from its anchor draws the anchor's.
- [Multi-staff] Clef-change and grace inserts shift only their own
  staff's later columns, so staves' rhythmic columns drift apart; small
  gap in the barline joining the two grand-staff staves.
- [Vertical spacing] Staff gap is fixed except below a lyric staff:
  neighbouring staves' hairpins/dynamics can meet (Fay's Song) and their
  regions overlap by a few px; the gap above a lyric staff stays fixed,
  and a system's gap only grows, never reserving room for the next
  staff's above-dynamics.
- [Articulations] Source `placement` is ignored; whole notes always take
  marks above; a tall stem-side mark in multi-voice is not checked
  against ledger lines; a staccato on a tied-into note leaves a gap
  mid-tie; a barline `<fermata>` stays passthrough.
- [Dynamics] `<offset>` and a wedge's `spread` are kept but unused by
  layout; dynamics and hairpins do not avoid each other horizontally; a
  neighbour's hairpin piece can go stale after a scoped edit that moves
  note x without changing width; playback ignores grand-staff sharing.
- [Grace] Source `<stem>` is not kept (Les Djinns' LH graces draw down);
  dots and articulations on graces are not drawn; grace ledger lines can
  merge with the principal's; `<type size="cue">` is not honoured.
- [Lyrics] Widths are estimated for the sans-serif label font (gaps can
  be loose or tight); lyrics on measure rests or graces are not drawn;
  `placement="above"` draws below; two voices of one staff singing a
  verse at the same onset overlap.
- [Import] `<type>` is trusted over `<duration>` (36 corpus notes
  disagree); `print-object="no"` is not read (Audiveris "Part 1" labels
  and invisible rests draw); no breve value (falls back to quarter); C1,
  C2, C5 clefs fall back to treble; `<unpitched>` becomes a rest; a
  `<part-group>` over one staff is dropped.
- [Round trip] XML attributes on modelled elements are lost (`default-x`,
  `<time symbol>`, measure width/numbers, mark `placement`); sub-children
  like `<key><mode>` are dropped; unmatched slur ends keep their source
  `number` and could pair with a regenerated slur on re-import.
- [Export] Only `<beam number="1">` is written; adjacent tuplet groups
  without source brackets merge into one bracket; two-voice stems/beams
  follow pitch, not voice; cross-staff beams have no element (lost).
- [Clefs] No edit op inserts or removes a mid-measure clef change; a
  redundant change is kept but not drawn; several changes at one column
  draw only the last; multi-staff `<clef number="2">` export is covered
  only by a hand-built test score.
- [Editing] Rests consumed by a lengthening lose fermatas and payloads
  silently; padding uses undotted rests even in compound time; no op for
  tied notes filling a 5/4 measure rest or moving a chord head between
  voices; `transposeNote` returns a bare index, not `MeasureRef[]`; no
  ops add/remove marks, dynamics, hairpins, graces or lyrics.
- [Playback] Single score-wide tempo; `LookaheadScheduler.tick()` scans
  every event; `activeOscillators` is pruned only by stop/seek (no
  `onended`); `isPlaying` never turns false at the end, so the demo
  counter keeps running.
- [Render] `redrawMeasures` takes one `staffIndex` per batch; scoped
  redraw leaves faint anti-aliasing differences at fractional region
  edges; `relayoutMeasure` and `layoutScore` differ in the last float ulp
  of staff-line y; seam strip height varies per measure.
- [Demo] Digit keys reset dots; zoom bounds (5-20) are arbitrary;
  follow-scroll tracks only an onset's first note; the seam toggle's
  system-break boundary goes stale after a resize.
- [Viewport] `drawAll` with a viewport still draws every `partDecorations`
  op (no region to cull by); the demo's zoom keeps scrollTop in px, not
  the score position; Flash maps `lastScopedMeasures` through
  `layout.measures[index]` (wrong on multi-staff); one click in ~18 takes
  ~200ms to paint in headless Chrome before and after Slice 11 (handler
  <1ms, likely `auditionNote`).
- [Repeats] Not modelled: segno, coda, D.C./D.S./Fine (navigation marks
  and `<sound>` jumps), nested repeats, and edit ops that add or remove
  repeats or endings.
