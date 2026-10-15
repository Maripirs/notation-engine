# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(while it is 0.x, a minor version may change the API).

## [0.1.0] - unreleased

First public release.

### Added

- `mountScore(container, source, options)`: render a MusicXML string or a
  `Score` into an element with scrolling, resize refit, zoom and playback
  with a moving, repeat-aware cursor, returning a `ScoreView` handle
  (`load`, `play`/`pause`/`stop`/`seek`, `setZoom`, `on('noteclick' |
  'onset' | 'end')`, `refresh`, `destroy`).
- Editable score model: multiple staves, parts and voices, chords, ties,
  slurs, tuplet timing, key/time/clef changes (including alto and tenor
  clefs and mid-measure clef changes), articulations, fermatas, dynamics,
  hairpins, grace notes, lyrics, repeats and voltas.
- Edit ops (transpose, note to rest and back, duration, chord members,
  ties, clef ranges) with structural undo/redo through `EditHistory`.
- Layout with greedy casting-off into systems, and a canvas renderer with
  region-scoped redraw (an edit repaints only the measures it touched),
  viewport rendering, hit-testing, selection, playback cursor,
  measure-range and seam-marker overlays.
- MusicXML import and export with lossless passthrough of unmodelled
  elements, and import diagnostics.
- Web Audio playback: timeline with repeats unfolded, dynamics,
  articulations, fermatas and grace notes; lookahead scheduling.
- The Bravura SMuFL font bundled and loaded automatically, with a data-URL
  fallback for bundlers that break the default font URL; `bravuraFontUrl`
  for headless rendering with node-canvas.
- `notation-engine/examples` entry with showcase scores built in code.

[0.1.0]: https://github.com/Maripirs/notation-engine/releases/tag/v0.1.0
