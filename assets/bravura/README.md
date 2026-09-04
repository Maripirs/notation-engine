# Vendored Bravura (SMuFL reference font)

Bravura is the reference implementation of [SMuFL](https://w3c.github.io/smufl/),
the Standard Music Font Layout. It supplies the *glyph shapes* this engine draws
(noteheads, clefs, rests, accidentals, flags). It is a font, not an engraving
library, so vendoring it does not violate the "no third-party engraving/rendering
library" principle in the repo README: every decision about *where* a glyph goes
is still ours.

## What is here, and where it came from

| File | Upstream |
| --- | --- |
| `Bravura.woff2` | [steinbergmedia/bravura](https://github.com/steinbergmedia/bravura) `redist/woff/Bravura.woff2` |
| `bravura_metadata.json` | same repo, `redist/Bravura.json` (renamed to the conventional SMuFL name) |
| `glyphnames.json` | [w3c/smufl](https://github.com/w3c/smufl) `metadata/glyphnames.json` |
| `OFL.txt` | same repo, `redist/OFL.txt` |

Font version: **Bravura 1.482** (per `fontVersion` in `bravura_metadata.json`),
fetched 2026-09-04.

Only `Bravura.woff2` is shipped to the browser. The two JSON files are here as
the auditable source for the *derived* metrics in `src/render/glyph-metrics.ts`,
which is what the engine actually imports. They are deliberately not imported at
runtime: together they are ~1.5 MB, versus the few hundred bytes of metrics the
Phase 0 glyph set actually needs. Regenerate the derived file with:

```bash
npm run glyphs
```

That script (`scripts/extract-glyph-metrics.mjs`) is a targeted extractor for a
named glyph list, not a general SMuFL metadata parser. A real parser is Phase 1+
work, once the glyph set stops fitting on one screen.

## License

Bravura is licensed under the SIL Open Font License, Version 1.1, reproduced in
full in `OFL.txt`. The OFL permits bundling and redistribution (including inside
commercial software) as long as the license text travels with the font, the
Reserved Font Name "Bravura" is not used for modified versions, and the font is
not sold on its own. This repo redistributes `Bravura.woff2` unmodified, so all
three conditions hold. `glyphnames.json` is part of the SMuFL specification,
published by the W3C Music Notation Community Group under the
[W3C document license](https://www.w3.org/copyright/document-license/).
