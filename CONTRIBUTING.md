# Contributing to notation-engine

Thanks for taking a look. This file covers how the code is organised, how
it is tested, and how to propose a change.

## Getting set up

```bash
git clone https://github.com/Maripirs/notation-engine.git
cd notation-engine
npm install
npm run dev   # the demo page, a hands-on view of most features
```

| Script          | What it does |
| --------------- | ------------ |
| `npm run dev`   | Vite dev server for `demo/`, which drives the engine directly. |
| `npm test`      | Vitest. No DOM or canvas needed; renderer tests use a recording context. |
| `npm run check` | `tsc --noEmit` over sources and tests. |
| `npm run build` | Library build to `dist/` (JS, `.d.ts`, the font and its license). |
| `npm run smoke` | Builds, checks the `npm pack` file list, installs the tarball into a temp project, imports every entry point in Node and type-checks a consumer. |
| `npm run bench` | Redraw timings, rasterized for real through node-canvas. |
| `npm run glyphs`| Regenerates `src/render/glyph-metrics.ts` from `assets/bravura/`. |

## Architecture

Six layers under `src/`, exported as one flat surface from `src/index.ts`:

- **`model/`**: the editable score (`Score`, staves, measures, notes,
  directions, lyrics, passthrough) and its edit ops and `EditHistory`.
  Knows nothing about drawing.
- **`layout/`**: turns a score into positioned drawing operations per
  measure, plus hit-testing and region lookups. Knows nothing about a
  canvas.
- **`render/`**: executes those operations against a
  `CanvasRenderingContext2D`, owns highlight state (selection, playback
  cursor, measure range, seam markers) and the SMuFL font metrics and
  loading.
- **`playback/`**: turns durations and tempo into a timeline of note
  events and plays it through Web Audio. Depends on no other layer's
  drawing code.
- **`io/`**: MusicXML import and export. Depends only on `model` (plus two
  pure beam-grouping helpers from `layout`, a reviewed exception noted in
  `io/musicxml-export.ts`).
- **`view/`**: `mountScore`, the one layer that touches the DOM, `window`,
  `ResizeObserver` or `AudioContext`. It wires the other five together
  using only their public functions. Its arithmetic lives in
  `view-math.ts` so Node tests can reach it.

No layer imports a UI framework. `src/examples.ts` is a second entry point
(`notation-engine/examples`) holding showcase scores built in code; the
demo in `demo/` is not published.

### The core invariant: region-scoped redraw

The reason this engine exists is that an edit repaints only what it
changed. An edit op returns the measures it touched; `relayoutMeasure`
re-lays-out one measure in place (returning `null` when its width changed,
so the caller falls back to a full layout); `CanvasRenderer.redrawMeasure`
clears and repaints only that measure's region. Anything drawn across
measures (beams, slurs, hairpins, voltas) has to belong to the measures it
crosses so a scoped redraw repaints it correctly.

`src/render/renderer.test.ts` asserts this as a property rather than a
timing: a one-measure edit must issue every drawing call inside that
measure's region, and the call count must not grow with the score's
length. A change that breaks scoping fails the suite. When you add
something that draws, add it to that proof if it can cross a measure
boundary.

## Testing policy

The suite once outgrew its value, so new tests follow these rules:

- Test behavior through public entry points (import, layout output,
  render calls, playback events), not internal helpers or exact
  intermediate values.
- A change adds a handful of tests (roughly 3 to 8): the main behavior,
  the one or two edge cases that actually broke or are likely to, and a
  round trip where MusicXML is involved. Not every combination.
- Prefer `it.each` tables over copy-pasted cases. Reuse shared fixtures
  and builders (`buildScore`, `src/io/test-helpers.ts`,
  `src/test/fixtures/`) instead of re-declaring scores inline.
- Don't pin pixel coordinates or layout constants unless the change is
  about that exact geometry; assert relations (above/below, ordered,
  non-overlapping) instead.
- Don't re-test what an earlier test already covers just because a new
  feature passes through it.
- Visual changes also deserve a look in `npm run dev`; some risks only
  show on screen.

### The real-score corpus test (opt-in)

`src/io/corpus.test.ts` imports and lays out every `.musicxml` file in a
directory of real scores, snapshots per-file counts (notes, parts, what was
modelled, passed through or dropped) and checks that export, re-import and
an edit plus undo are all lossless. The scores are not in the repo, so the
test is skipped unless you point it at a directory:

```bash
NOTATION_CORPUS_DIR=/path/to/musicxml/dir npm test
```

The committed snapshot matches the maintainer's own corpus, keyed by file
name, so with a different directory it will not match; run with `-u` to
create your own local snapshot and do not commit it. Contributors without
a corpus can ignore this test entirely.

## Roadmap

[`plan.md`](plan.md) is the roadmap and design record: milestones broken
into slices, the decisions behind them, and a backlog of known gaps. If you
want to pick something up, the backlog is a good place to look, and a
change that settles a backlog item should remove or update its line.

## Code style

- Tabs for indentation; TypeScript strict mode; ES modules with `.js`
  extensions in relative imports.
- Comments explain *why* (a constraint, a trade-off, a bug that shaped the
  code), not what the next line does.
- Keep layers one-way as described above; a new cross-layer import needs a
  reason in a comment.
- No new runtime dependencies.
- In prose (comments, docs, commit messages), avoid em dashes; use a
  period, comma, colon or parentheses instead. It is the house style.

## Proposing a change

- For anything large (a new layer feature, an API change, a new
  dependency), open an issue first so the approach can be agreed before
  you write it.
- For a pull request, keep it to one concern, add tests per the policy
  above, and make sure these pass:

  ```bash
  npm run check && npm test && npm run smoke
  ```

- Mention anything you noticed but did not fix; it may belong in the
  backlog.

By contributing you agree that your contribution is licensed under the
project's MIT license.
