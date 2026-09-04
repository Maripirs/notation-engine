# notation-engine

A from-scratch music notation engraving and rendering engine: an editable
score model plus a canvas renderer, built to replace
[OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/) (and, under it,
[VexFlow](https://www.vexflow.com/)) in [Divisi](https://divisi.maripi.net)'s
notation editor and practice player.

## Why

Divisi's editor is a correction tool for OMR (optical music recognition)
output: click a note, fix its pitch/duration, delete it, insert a bar. OSMD
has no partial-render API, so every edit pays a full MusicXML reparse +
whole-score re-layout — profiled at ~1.1-1.3s on a 124-measure real choral
piece, dominated by OSMD's own internals. Noteflight-style instant,
region-scoped redraw needs owning the model and the renderer end to end.

Full background and the decision record live in Divisi's own plan
(`OMR_EDITOR_PLAN.md`, milestone E13, in the `divisi-omr-editor` worktree)
— that document is the project history; this repo is the engine itself,
kept independent on purpose (see below).

## Design principles

- **No engraving/rendering library dependency, at any phase.** Not VexFlow,
  not OSMD, not a fork of either. A bundled [SMuFL](https://w3c.github.io/smufl/)
  font ([Bravura](https://github.com/steinbergmedia/bravura), SIL OFL) supplies
  glyph shapes; layout and drawing are ours.
- **Framework-agnostic core.** The model, layout, and renderer have zero
  dependency on Svelte, React, or any other UI framework — only the DOM
  `CanvasRenderingContext2D` API. Any host app wires up its own click/keyboard
  handling and calls into this engine's public API. This is what makes the
  engine "an independent project that can be easily integrated into any
  other platform," not just a Divisi-internal module.
- **Canvas, not SVG/DOM-per-note.** One canvas element (or region), our own
  hit-testing (bounding boxes we maintain, not `element.onclick`), so a redraw
  never means diffing or rebuilding a DOM/SVG tree.
- **MusicXML in, MusicXML out**, eventually — it's the interop/storage format
  the rest of Divisi (and most notation software) depends on. Not in Phase 0.

## Status

**Phase 0 (spike):** proving the core loop — an editable model, canvas
layout for a single staff/single voice, hit-testing, one edit op (transpose)
redrawing only the touched measure — is real and meaningfully faster than a
full OSMD `load()`+`render()` on an equivalent snippet. Nothing beyond that
is built yet. See `OMR_EDITOR_PLAN.md` E13 in `divisi-omr-editor` for the
full phased roadmap (1: single-voice engraving, 2: multi-voice/multi-staff,
3: pagination, 4: interaction layer, 5: reparity with the OSMD editor +
MusicXML import/export, 6: real-world edge cases) — none of that is
committed scope until Phase 0's go/no-go.

## Structure

```
src/
  model/    editable score model (notes, measures, staves) — no rendering code
  layout/   lays out the model into positioned glyphs
  render/   draws laid-out glyphs to a Canvas2D context, SMuFL font handling
  index.ts  public API
demo/       a plain Vite page exercising the engine directly, for `npm run dev`
```

## Development

```bash
npm install
npm run dev     # demo page at the printed localhost URL
npm test        # vitest
npm run check   # tsc --noEmit
npm run build   # library build to dist/
```
