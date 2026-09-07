# notation-engine

A from-scratch music notation engraving and rendering engine: an editable
score model plus a canvas renderer, built to replace
[OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/) (and, under it,
[VexFlow](https://www.vexflow.com/)) in [Divisi](https://divisi.maripi.net)'s
notation editor and practice player.

## Getting started

```bash
git clone <this repo>
cd notation-engine
npm install
npm run dev   # demo page at the printed localhost URL
```

See [Development](#development) below for the rest of the scripts (tests,
bench, build).

## Why

Divisi's editor is a correction tool for OMR (optical music recognition)
output: click a note, fix its pitch/duration, delete it, insert a bar. OSMD
has no partial-render API, so every edit pays a full MusicXML reparse +
whole-score re-layout, profiled at ~1.1-1.3s on a 124-measure real choral
piece, dominated by OSMD's own internals. Noteflight-style instant,
region-scoped redraw needs owning the model and the renderer end to end.

Full background and the decision record live in Divisi's own plan
(`OMR_EDITOR_PLAN.md`, milestone E13, in the `divisi-omr-editor` worktree).
That document is the project history; this repo is the engine itself,
kept independent on purpose (see below).

## Design principles

- **No engraving/rendering library dependency, at any phase.** Not VexFlow,
  not OSMD, not a fork of either. A bundled [SMuFL](https://w3c.github.io/smufl/)
  font ([Bravura](https://github.com/steinbergmedia/bravura), SIL OFL) supplies
  glyph shapes; layout and drawing are ours.
- **Framework-agnostic core.** The model, layout, and renderer have zero
  dependency on Svelte, React, or any other UI framework, only the DOM
  `CanvasRenderingContext2D` API. Any host app wires up its own click/keyboard
  handling and calls into this engine's public API. This is what makes the
  engine "an independent project that can be easily integrated into any
  other platform," not just a Divisi-internal module.
- **Canvas, not SVG/DOM-per-note.** One canvas element (or region), our own
  hit-testing (bounding boxes we maintain, not `element.onclick`), so a redraw
  never means diffing or rebuilding a DOM/SVG tree.
- **MusicXML in, MusicXML out**, eventually. It is the interop/storage format
  the rest of Divisi (and most notation software) depends on. Not in Phase 0.

## Status

**Phase 0 (spike): built.** The core loop is real. An editable model, canvas
layout for a single staff and single voice, our own hit-testing, and one edit
op (transpose by a semitone) that re-lays-out and repaints only the measure it
touched. `npm run dev` puts it on screen: click a notehead, press an arrow key,
watch one measure's region repaint.

The scoping claim is asserted in the ordinary test suite
(`src/render/renderer.test.ts`), not left to a stopwatch: a transpose in measure
2 of a four-measure score must issue every one of its drawing calls inside
measure 2's region and none inside measures 1, 3 or 4, and the number of calls
for a one-measure repaint must not change when the score grows to 40 measures.

`npm run bench` puts wall-clock numbers on what that is worth, rasterizing for
real through node-canvas. On an M-series laptop, a region-scoped edit stays flat
at roughly 0.11-0.18 ms whatever the score length, while repainting the whole
system grows from 0.7 ms at 4 measures to 11.9 ms at 124. The shape is the
point, not the constant: our cost is one measure's, OSMD's is the score's.

Nothing beyond Phase 0 is built. See `OMR_EDITOR_PLAN.md` E13 in
`divisi-omr-editor` for the full phased roadmap (1: single-voice engraving,
2: multi-voice/multi-staff, 3: pagination, 4: interaction layer, 5: reparity
with the OSMD editor plus MusicXML import/export, 6: real-world edge cases).
None of that is committed scope until Phase 0's go/no-go.

## Structure

```
src/
  model/         editable score model (notes, measures, pitch), no rendering code
  layout/        lays the model out into positioned draw ops, plus hit-testing
  render/        executes draw ops against a Canvas2D context, SMuFL metrics
  demo-score.ts  the four-measure fixture the demo, tests and bench all share
  index.ts       public API
assets/bravura/  the vendored SMuFL font, its metadata and its OFL license
scripts/         extracts the glyph metrics the engine needs from that metadata
demo/            a plain Vite page exercising the engine directly, for `npm run dev`
```

## Development

```bash
npm install
npm run dev     # demo page at the printed localhost URL
npm test        # vitest, no DOM and no canvas needed
npm run bench   # redraw timings, rasterized through node-canvas
npm run check   # tsc --noEmit
npm run build   # library build to dist/
npm run glyphs  # regenerate src/render/glyph-metrics.ts from assets/bravura/
```
