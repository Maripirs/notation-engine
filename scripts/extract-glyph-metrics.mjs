// Regenerates src/render/glyph-metrics.ts from the vendored Bravura metadata.
//
// This is deliberately a *targeted extractor for a named glyph list*, not a
// general SMuFL metadata parser. The two upstream JSON files total ~1.5 MB;
// the Phase 0 glyph set needs a few hundred bytes of that. Shipping the whole
// thing to the browser (or parsing it at startup) to draw eleven glyph shapes
// would be pure overhead. When the glyph set outgrows one screen, this script
// gets replaced by a real metadata layer, which is Phase 1+ work.
//
// Run with `npm run glyphs`. The output is committed, so nobody needs to run
// this to build or test the engine.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const assets = join(repoRoot, 'assets', 'bravura');

const metadata = JSON.parse(readFileSync(join(assets, 'bravura_metadata.json'), 'utf8'));
const glyphNames = JSON.parse(readFileSync(join(assets, 'glyphnames.json'), 'utf8'));

// The glyphs Phase 0 actually draws. Every one of these is exercised by the
// demo score, so an entry going stale shows up immediately rather than rotting.
const GLYPHS = [
	// Noteheads and flags for unbeamed eighth-and-shorter notes. Beamed groups
	// (Phase 1's Slice 2) replace these flags with beam rects instead, so no
	// new glyphs were needed for beaming itself.
	'noteheadWhole',
	'noteheadHalf',
	'noteheadBlack',
	'flag8thUp',
	'flag8thDown',
	'flag16thUp',
	'flag16thDown',
	'flag32ndUp',
	'flag32ndDown',
	'flag64thUp',
	'flag64thDown',
	// Clefs. M2 Slice 3 adds bass and the vocal-tenor "octave treble" clefs
	// alongside Phase 0's plain treble; `gClef8vb` is SMuFL's name for a G
	// clef with the small "8" below it (treble8, see `ClefType`'s own
	// comment in model/score.ts).
	'gClef',
	'fClef',
	'gClef8vb',
	// The C clef (M6 Slice 4), one glyph for both `alto` and `tenor`: SMuFL
	// draws it centred on its own origin, and layout simply places that origin
	// on the third line (alto) or the fourth (tenor).
	'cClef',
	// Rests, one per supported duration.
	'restWhole',
	'restHalf',
	'restQuarter',
	'rest8th',
	'rest16th',
	'rest32nd',
	'rest64th',
	// Accidentals: the three that a +/-1 semitone transpose can produce.
	'accidentalSharp',
	'accidentalFlat',
	'accidentalNatural',
	// Augmentation dot, for dotted durations.
	'augmentationDot',
	// The single dot half of a repeat barline (Slice 8); drawn twice, flanking
	// the middle line, for a repeatStart/repeatEnd boundary. A dedicated
	// glyph rather than reusing `augmentationDot`: the two happen to share
	// identical Bravura metrics today, but they are semantically different
	// marks (SMuFL publishes `repeatDot` separately for exactly this use),
	// and reusing `augmentationDot` here would be relying on a coincidence.
	'repeatDot',
	// Time signature digits. 0-9 rather than just the demo's 4, because the
	// model lets a caller pick any beats/beat-type and a missing digit would
	// be a silent hole in the render.
	'timeSig0',
	'timeSig1',
	'timeSig2',
	'timeSig3',
	'timeSig4',
	'timeSig5',
	'timeSig6',
	'timeSig7',
	'timeSig8',
	'timeSig9',
	// Part-grouping glyphs (M2 Slice 5). `brace` is drawn as a single glyph,
	// stretched via a one-off font size to whatever span a keyboard-style
	// two-staff part needs (see `layout.ts`'s `layoutBrace`); `bracketTop`/
	// `bracketBottom` are the fixed-size hook pieces a choir/ensemble
	// bracket is *assembled* from around a plain vertical rect, rather than
	// scaling the single `bracket` glyph Bravura also publishes, which would
	// distort its square corners for anything but its one native span.
	'brace',
	'bracketTop',
	'bracketBottom',
	// Articulations and fermatas (M6 Slice 5). SMuFL draws each in an
	// "above" and a "below" form (an accent's wedge or a fermata's arch
	// flips), so layout picks the one for the side it places the mark on.
	// `articTenutoStaccato*` is MusicXML's `detached-legato`.
	'articStaccatoAbove',
	'articStaccatoBelow',
	'articStaccatissimoAbove',
	'articStaccatissimoBelow',
	'articTenutoAbove',
	'articTenutoBelow',
	'articTenutoStaccatoAbove',
	'articTenutoStaccatoBelow',
	'articAccentAbove',
	'articAccentBelow',
	'articMarcatoAbove',
	'articMarcatoBelow',
	'fermataAbove',
	'fermataBelow'
];

// Engraving defaults are line thicknesses and extensions the font *recommends*
// for things drawn as plain rectangles rather than glyphs (staff lines, stems,
// ledger lines, barlines, beams). Using the font's own numbers is what keeps
// our hand-drawn strokes visually consistent with its glyph shapes.
const ENGRAVING_DEFAULTS = [
	'staffLineThickness',
	'stemThickness',
	'legerLineThickness',
	'legerLineExtension',
	'thinBarlineThickness',
	'thickBarlineThickness',
	'barlineSeparation',
	'beamThickness',
	'beamSpacing',
	'tieMidpointThickness',
	'slurMidpointThickness',
	// The vertical spine `layoutBracket` (M2 Slice 5) draws as a plain rect
	// between its `bracketTop`/`bracketBottom` end pieces, the same
	// hand-drawn-rect-at-the-font's-own-thickness convention every other
	// line in this list already follows.
	'bracketThickness'
];

// The stem attachment anchors we use. SMuFL publishes many more per notehead
// (split stems, cut-outs for accidental kerning); those matter for engraving
// quality work that is not Phase 0.
const ANCHORS = ['stemUpSE', 'stemDownNW', 'stemUpNW', 'stemDownSW'];

const round = (n) => Number(n.toFixed(4));

function glyphEntry(name) {
	const names = glyphNames[name];
	const bbox = metadata.glyphBBoxes[name];
	const advance = metadata.glyphAdvanceWidths[name];
	if (!names || !bbox || advance === undefined) {
		throw new Error(`glyph "${name}" is missing from the vendored Bravura metadata`);
	}
	const codepoint = Number.parseInt(names.codepoint.replace('U+', ''), 16);
	const anchors = metadata.glyphsWithAnchors[name] ?? {};
	const kept = {};
	for (const anchor of ANCHORS) {
		if (anchors[anchor]) kept[anchor] = anchors[anchor].map(round);
	}
	return {
		name,
		codepoint,
		description: names.description,
		advance: round(advance),
		bBoxSW: bbox.bBoxSW.map(round),
		bBoxNE: bbox.bBoxNE.map(round),
		anchors: kept
	};
}

const entries = GLYPHS.map(glyphEntry);

const lines = [];
lines.push(
	'// GENERATED FILE. Do not edit by hand: run `npm run glyphs` to regenerate it',
	'// from the vendored Bravura metadata in assets/bravura/.',
	'//',
	`// Source: Bravura ${metadata.fontVersion} (bravura_metadata.json) plus SMuFL`,
	'// glyphnames.json. See assets/bravura/README.md for provenance and license.',
	'//',
	'// All measurements are in *staff spaces*, SMuFL\'s unit, with y pointing up',
	"// (the font's convention, the opposite of canvas). One staff space is a",
	'// quarter of the em square, so a glyph drawn at font-size `4 * staffSpacePx`',
	'// has these metrics scaled by exactly `staffSpacePx`.',
	'',
	'/** A point in staff spaces, y up, relative to the glyph origin. */',
	'export type GlyphPoint = readonly [x: number, y: number];',
	'',
	'export interface GlyphMetrics {',
	'\t/** The SMuFL canonical glyph name, e.g. `noteheadBlack`. */',
	'\treadonly name: string;',
	'\t/** Unicode code point in the SMuFL private-use range. */',
	'\treadonly codepoint: number;',
	'\t/** SMuFL\'s human-readable description, kept so the table reads as documentation. */',
	'\treadonly description: string;',
	'\t/** Horizontal advance width, staff spaces. */',
	'\treadonly advance: number;',
	'\t/** Bounding-box south-west corner, staff spaces relative to the origin. */',
	'\treadonly bBoxSW: GlyphPoint;',
	'\t/** Bounding-box north-east corner, staff spaces relative to the origin. */',
	'\treadonly bBoxNE: GlyphPoint;',
	'\t/** Stem attachment points, where the font publishes them. */',
	'\treadonly anchors: Readonly<Record<string, GlyphPoint | undefined>>;',
	'}',
	'',
	'/** The glyphs Phase 0 draws, keyed by SMuFL canonical name. */',
	'export const GLYPH_METRICS = {'
);
for (const entry of entries) {
	const anchorPairs = Object.entries(entry.anchors)
		.map(([key, value]) => `${key}: [${value.join(', ')}]`)
		.join(', ');
	lines.push(
		`\t${entry.name}: {`,
		`\t\tname: '${entry.name}',`,
		`\t\tcodepoint: 0x${entry.codepoint.toString(16).toUpperCase()},`,
		`\t\tdescription: '${entry.description.replace(/'/g, "\\'")}',`,
		`\t\tadvance: ${entry.advance},`,
		`\t\tbBoxSW: [${entry.bBoxSW.join(', ')}],`,
		`\t\tbBoxNE: [${entry.bBoxNE.join(', ')}],`,
		`\t\tanchors: {${anchorPairs ? ` ${anchorPairs} ` : ''}}`,
		`\t},`
	);
}
lines.push(
	'} as const satisfies Record<string, GlyphMetrics>;',
	'',
	'/** Name of any glyph this engine knows how to draw. */',
	'export type GlyphName = keyof typeof GLYPH_METRICS;',
	'',
	'/**',
	' * Look a glyph up as a plain `GlyphMetrics`.',
	' *',
	' * `GLYPH_METRICS` is `as const`, so indexing it directly gives a union of',
	' * per-glyph literal types and an anchor that only some glyphs have is not',
	' * addressable on that union. This widens once, at the boundary, instead of',
	' * scattering casts through the layout code.',
	' */',
	'export function glyphMetrics(name: GlyphName): GlyphMetrics {',
	'\treturn GLYPH_METRICS[name];',
	'}',
	'',
	'/**',
	" * Line thicknesses and extensions recommended by the font, staff spaces. We",
	' * draw staff lines, stems, ledger lines and barlines ourselves as plain',
	" * rectangles, so using Bravura's own numbers is what keeps them looking like",
	' * they belong to the same typeface as the glyphs.',
	' */',
	'export const ENGRAVING_DEFAULTS = {'
);
for (const key of ENGRAVING_DEFAULTS) {
	const value = metadata.engravingDefaults[key];
	if (value === undefined) throw new Error(`engraving default "${key}" is missing`);
	lines.push(`\t${key}: ${round(value)},`);
}
lines.push(
	'} as const;',
	'',
	'/**',
	' * Staff spaces per em. SMuFL fixes this at 4: a font size of `4 * staffSpacePx`',
	' * makes every metric above scale by `staffSpacePx`. Named rather than inlined',
	' * because it appears in both layout and the renderer.',
	' */',
	'export const STAFF_SPACES_PER_EM = 4;',
	'',
	'/** The font family name the vendored Bravura file registers itself under. */',
	"export const BRAVURA_FAMILY = 'Bravura';",
	''
);

const out = join(repoRoot, 'src', 'render', 'glyph-metrics.ts');
writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out}: ${entries.length} glyphs from Bravura ${metadata.fontVersion}`);
