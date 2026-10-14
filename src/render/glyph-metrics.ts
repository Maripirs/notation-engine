// GENERATED FILE. Do not edit by hand: run `npm run glyphs` to regenerate it
// from the vendored Bravura metadata in assets/bravura/.
//
// Source: Bravura 1.482 (bravura_metadata.json) plus SMuFL
// glyphnames.json. See assets/bravura/README.md for provenance and license.
//
// All measurements are in *staff spaces*, SMuFL's unit, with y pointing up
// (the font's convention, the opposite of canvas). One staff space is a
// quarter of the em square, so a glyph drawn at font-size `4 * staffSpacePx`
// has these metrics scaled by exactly `staffSpacePx`.

/** A point in staff spaces, y up, relative to the glyph origin. */
export type GlyphPoint = readonly [x: number, y: number];

export interface GlyphMetrics {
	/** The SMuFL canonical glyph name, e.g. `noteheadBlack`. */
	readonly name: string;
	/** Unicode code point in the SMuFL private-use range. */
	readonly codepoint: number;
	/** SMuFL's human-readable description, kept so the table reads as documentation. */
	readonly description: string;
	/** Horizontal advance width, staff spaces. */
	readonly advance: number;
	/** Bounding-box south-west corner, staff spaces relative to the origin. */
	readonly bBoxSW: GlyphPoint;
	/** Bounding-box north-east corner, staff spaces relative to the origin. */
	readonly bBoxNE: GlyphPoint;
	/** Stem attachment points, where the font publishes them. */
	readonly anchors: Readonly<Record<string, GlyphPoint | undefined>>;
}

/** The glyphs Phase 0 draws, keyed by SMuFL canonical name. */
export const GLYPH_METRICS = {
	noteheadWhole: {
		name: 'noteheadWhole',
		codepoint: 0xE0A2,
		description: 'Whole (semibreve) notehead',
		advance: 1.688,
		bBoxSW: [0, -0.5],
		bBoxNE: [1.688, 0.5],
		anchors: {}
	},
	noteheadHalf: {
		name: 'noteheadHalf',
		codepoint: 0xE0A3,
		description: 'Half (minim) notehead',
		advance: 1.18,
		bBoxSW: [0, -0.5],
		bBoxNE: [1.18, 0.5],
		anchors: { stemUpSE: [1.18, 0.168], stemDownNW: [0, -0.168] }
	},
	noteheadBlack: {
		name: 'noteheadBlack',
		codepoint: 0xE0A4,
		description: 'Black notehead',
		advance: 1.18,
		bBoxSW: [0, -0.5],
		bBoxNE: [1.18, 0.5],
		anchors: { stemUpSE: [1.18, 0.168], stemDownNW: [0, -0.168] }
	},
	flag8thUp: {
		name: 'flag8thUp',
		codepoint: 0xE240,
		description: 'Combining flag 1 (8th) above',
		advance: 1.056,
		bBoxSW: [0, -3.24],
		bBoxNE: [1.056, 0.036],
		anchors: { stemUpNW: [0, -0.04] }
	},
	flag8thDown: {
		name: 'flag8thDown',
		codepoint: 0xE241,
		description: 'Combining flag 1 (8th) below',
		advance: 1.224,
		bBoxSW: [0, -0.056],
		bBoxNE: [1.224, 3.232],
		anchors: { stemDownSW: [0, 0.132] }
	},
	flag16thUp: {
		name: 'flag16thUp',
		codepoint: 0xE242,
		description: 'Combining flag 2 (16th) above',
		advance: 1.116,
		bBoxSW: [0, -3.252],
		bBoxNE: [1.116, 0.008],
		anchors: { stemUpNW: [0, -0.088] }
	},
	flag16thDown: {
		name: 'flag16thDown',
		codepoint: 0xE243,
		description: 'Combining flag 2 (16th) below',
		advance: 1.168,
		bBoxSW: [0, -0.036],
		bBoxNE: [1.164, 3.248],
		anchors: { stemDownSW: [0, 0.128] }
	},
	flag32ndUp: {
		name: 'flag32ndUp',
		codepoint: 0xE244,
		description: 'Combining flag 3 (32nd) above',
		advance: 1.048,
		bBoxSW: [0, -3.248],
		bBoxNE: [1.044, 0.596],
		anchors: { stemUpNW: [0, 0.376] }
	},
	flag32ndDown: {
		name: 'flag32ndDown',
		codepoint: 0xE245,
		description: 'Combining flag 3 (32nd) below',
		advance: 1.096,
		bBoxSW: [0, -0.688],
		bBoxNE: [1.092, 3.248],
		anchors: { stemDownSW: [0, -0.448] }
	},
	flag64thUp: {
		name: 'flag64thUp',
		codepoint: 0xE246,
		description: 'Combining flag 4 (64th) above',
		advance: 1.048,
		bBoxSW: [0, -3.248],
		bBoxNE: [1.044, 1.388],
		anchors: { stemUpNW: [0, 1.172] }
	},
	flag64thDown: {
		name: 'flag64thDown',
		codepoint: 0xE247,
		description: 'Combining flag 4 (64th) below',
		advance: 1.1,
		bBoxSW: [0, -1.504],
		bBoxNE: [1.092, 3.248],
		anchors: { stemDownSW: [0, -1.244] }
	},
	gClef: {
		name: 'gClef',
		codepoint: 0xE050,
		description: 'G clef',
		advance: 2.684,
		bBoxSW: [0, -2.632],
		bBoxNE: [2.684, 4.392],
		anchors: {}
	},
	fClef: {
		name: 'fClef',
		codepoint: 0xE062,
		description: 'F clef',
		advance: 2.736,
		bBoxSW: [-0.02, -2.54],
		bBoxNE: [2.736, 1.048],
		anchors: {}
	},
	gClef8vb: {
		name: 'gClef8vb',
		codepoint: 0xE052,
		description: 'G clef ottava bassa',
		advance: 2.656,
		bBoxSW: [0, -3.512],
		bBoxNE: [2.684, 4.392],
		anchors: {}
	},
	cClef: {
		name: 'cClef',
		codepoint: 0xE05C,
		description: 'C clef',
		advance: 2.796,
		bBoxSW: [0, -2.024],
		bBoxNE: [2.796, 2.024],
		anchors: {}
	},
	restWhole: {
		name: 'restWhole',
		codepoint: 0xE4E3,
		description: 'Whole (semibreve) rest',
		advance: 1.132,
		bBoxSW: [0, -0.54],
		bBoxNE: [1.128, 0.036],
		anchors: {}
	},
	restHalf: {
		name: 'restHalf',
		codepoint: 0xE4E4,
		description: 'Half (minim) rest',
		advance: 1.132,
		bBoxSW: [0, -0.008],
		bBoxNE: [1.128, 0.568],
		anchors: {}
	},
	restQuarter: {
		name: 'restQuarter',
		codepoint: 0xE4E5,
		description: 'Quarter (crotchet) rest',
		advance: 1.08,
		bBoxSW: [0.004, -1.5],
		bBoxNE: [1.08, 1.492],
		anchors: {}
	},
	rest8th: {
		name: 'rest8th',
		codepoint: 0xE4E6,
		description: 'Eighth (quaver) rest',
		advance: 1,
		bBoxSW: [0, -1.004],
		bBoxNE: [0.988, 0.696],
		anchors: {}
	},
	rest16th: {
		name: 'rest16th',
		codepoint: 0xE4E7,
		description: '16th (semiquaver) rest',
		advance: 1.28,
		bBoxSW: [0, -2],
		bBoxNE: [1.28, 0.716],
		anchors: {}
	},
	rest32nd: {
		name: 'rest32nd',
		codepoint: 0xE4E8,
		description: '32nd (demisemiquaver) rest',
		advance: 1.452,
		bBoxSW: [0, -2],
		bBoxNE: [1.452, 1.704],
		anchors: {}
	},
	rest64th: {
		name: 'rest64th',
		codepoint: 0xE4E9,
		description: '64th (hemidemisemiquaver) rest',
		advance: 1.696,
		bBoxSW: [0, -3.012],
		bBoxNE: [1.692, 1.72],
		anchors: {}
	},
	accidentalSharp: {
		name: 'accidentalSharp',
		codepoint: 0xE262,
		description: 'Sharp',
		advance: 0.996,
		bBoxSW: [0, -1.392],
		bBoxNE: [0.996, 1.4],
		anchors: {}
	},
	accidentalFlat: {
		name: 'accidentalFlat',
		codepoint: 0xE260,
		description: 'Flat',
		advance: 0.904,
		bBoxSW: [0, -0.7],
		bBoxNE: [0.904, 1.756],
		anchors: {}
	},
	accidentalNatural: {
		name: 'accidentalNatural',
		codepoint: 0xE261,
		description: 'Natural',
		advance: 0.672,
		bBoxSW: [0, -1.34],
		bBoxNE: [0.672, 1.364],
		anchors: {}
	},
	augmentationDot: {
		name: 'augmentationDot',
		codepoint: 0xE1E7,
		description: 'Augmentation dot',
		advance: 0.4,
		bBoxSW: [0, -0.2],
		bBoxNE: [0.4, 0.2],
		anchors: {}
	},
	repeatDot: {
		name: 'repeatDot',
		codepoint: 0xE044,
		description: 'Single repeat dot',
		advance: 0.4,
		bBoxSW: [0, -0.2],
		bBoxNE: [0.4, 0.2],
		anchors: {}
	},
	timeSig0: {
		name: 'timeSig0',
		codepoint: 0xE080,
		description: 'Time signature 0',
		advance: 1.88,
		bBoxSW: [0.08, -1],
		bBoxNE: [1.8, 1.004],
		anchors: {}
	},
	timeSig1: {
		name: 'timeSig1',
		codepoint: 0xE081,
		description: 'Time signature 1',
		advance: 1.336,
		bBoxSW: [0.08, -1],
		bBoxNE: [1.256, 1.004],
		anchors: {}
	},
	timeSig2: {
		name: 'timeSig2',
		codepoint: 0xE082,
		description: 'Time signature 2',
		advance: 1.784,
		bBoxSW: [0.08, -1.028],
		bBoxNE: [1.704, 1.016],
		anchors: {}
	},
	timeSig3: {
		name: 'timeSig3',
		codepoint: 0xE083,
		description: 'Time signature 3',
		advance: 1.684,
		bBoxSW: [0.08, -1.004],
		bBoxNE: [1.604, 0.996],
		anchors: {}
	},
	timeSig4: {
		name: 'timeSig4',
		codepoint: 0xE084,
		description: 'Time signature 4',
		advance: 1.88,
		bBoxSW: [0.08, -1],
		bBoxNE: [1.8, 1.004],
		anchors: {}
	},
	timeSig5: {
		name: 'timeSig5',
		codepoint: 0xE085,
		description: 'Time signature 5',
		advance: 1.612,
		bBoxSW: [0.08, -1.004],
		bBoxNE: [1.532, 0.984],
		anchors: {}
	},
	timeSig6: {
		name: 'timeSig6',
		codepoint: 0xE086,
		description: 'Time signature 6',
		advance: 1.736,
		bBoxSW: [0.08, -0.996],
		bBoxNE: [1.656, 1.004],
		anchors: {}
	},
	timeSig7: {
		name: 'timeSig7',
		codepoint: 0xE087,
		description: 'Time signature 7',
		advance: 1.764,
		bBoxSW: [0.08, -1],
		bBoxNE: [1.684, 0.996],
		anchors: {}
	},
	timeSig8: {
		name: 'timeSig8',
		codepoint: 0xE088,
		description: 'Time signature 8',
		advance: 1.744,
		bBoxSW: [0.08, -1.036],
		bBoxNE: [1.664, 1.036],
		anchors: {}
	},
	timeSig9: {
		name: 'timeSig9',
		codepoint: 0xE089,
		description: 'Time signature 9',
		advance: 1.736,
		bBoxSW: [0.08, -0.996],
		bBoxNE: [1.656, 1.004],
		anchors: {}
	},
	brace: {
		name: 'brace',
		codepoint: 0xE000,
		description: 'Brace',
		advance: 0.28,
		bBoxSW: [0, -0.0025],
		bBoxNE: [0.2774, 4.0024],
		anchors: {}
	},
	bracketTop: {
		name: 'bracketTop',
		codepoint: 0xE003,
		description: 'Bracket top',
		advance: 1.876,
		bBoxSW: [0, 0],
		bBoxNE: [1.876, 1.18],
		anchors: {}
	},
	bracketBottom: {
		name: 'bracketBottom',
		codepoint: 0xE004,
		description: 'Bracket bottom',
		advance: 1.876,
		bBoxSW: [0, -1.18],
		bBoxNE: [1.876, 0],
		anchors: {}
	},
	articStaccatoAbove: {
		name: 'articStaccatoAbove',
		codepoint: 0xE4A2,
		description: 'Staccato above',
		advance: 0.336,
		bBoxSW: [0, 0],
		bBoxNE: [0.336, 0.336],
		anchors: {}
	},
	articStaccatoBelow: {
		name: 'articStaccatoBelow',
		codepoint: 0xE4A3,
		description: 'Staccato below',
		advance: 0.336,
		bBoxSW: [0, -0.336],
		bBoxNE: [0.336, 0],
		anchors: {}
	},
	articStaccatissimoAbove: {
		name: 'articStaccatissimoAbove',
		codepoint: 0xE4A6,
		description: 'Staccatissimo above',
		advance: 0.408,
		bBoxSW: [0.004, -0.008],
		bBoxNE: [0.4, 1.172],
		anchors: {}
	},
	articStaccatissimoBelow: {
		name: 'articStaccatissimoBelow',
		codepoint: 0xE4A7,
		description: 'Staccatissimo below',
		advance: 0.408,
		bBoxSW: [0.004, -1.18],
		bBoxNE: [0.4, 0],
		anchors: {}
	},
	articTenutoAbove: {
		name: 'articTenutoAbove',
		codepoint: 0xE4A4,
		description: 'Tenuto above',
		advance: 1.352,
		bBoxSW: [-0.004, 0],
		bBoxNE: [1.352, 0.192],
		anchors: {}
	},
	articTenutoBelow: {
		name: 'articTenutoBelow',
		codepoint: 0xE4A5,
		description: 'Tenuto below',
		advance: 1.352,
		bBoxSW: [-0.004, -0.192],
		bBoxNE: [1.352, 0],
		anchors: {}
	},
	articTenutoStaccatoAbove: {
		name: 'articTenutoStaccatoAbove',
		codepoint: 0xE4B2,
		description: 'Louré (tenuto-staccato) above',
		advance: 1.356,
		bBoxSW: [-0.004, 0],
		bBoxNE: [1.352, 0.96],
		anchors: {}
	},
	articTenutoStaccatoBelow: {
		name: 'articTenutoStaccatoBelow',
		codepoint: 0xE4B3,
		description: 'Louré (tenuto-staccato) below',
		advance: 1.352,
		bBoxSW: [-0.004, -0.968],
		bBoxNE: [1.352, 0],
		anchors: {}
	},
	articAccentAbove: {
		name: 'articAccentAbove',
		codepoint: 0xE4A0,
		description: 'Accent above',
		advance: 1.356,
		bBoxSW: [0, 0.004],
		bBoxNE: [1.356, 0.98],
		anchors: {}
	},
	articAccentBelow: {
		name: 'articAccentBelow',
		codepoint: 0xE4A1,
		description: 'Accent below',
		advance: 1.356,
		bBoxSW: [0, -0.976],
		bBoxNE: [1.356, 0],
		anchors: {}
	},
	articMarcatoAbove: {
		name: 'articMarcatoAbove',
		codepoint: 0xE4AC,
		description: 'Marcato above',
		advance: 0.944,
		bBoxSW: [-0.004, -0.004],
		bBoxNE: [0.94, 1.012],
		anchors: {}
	},
	articMarcatoBelow: {
		name: 'articMarcatoBelow',
		codepoint: 0xE4AD,
		description: 'Marcato below',
		advance: 0.944,
		bBoxSW: [-0.004, -1.016],
		bBoxNE: [0.94, 0],
		anchors: {}
	},
	fermataAbove: {
		name: 'fermataAbove',
		codepoint: 0xE4C0,
		description: 'Fermata above',
		advance: 2.42,
		bBoxSW: [0.012, -0.012],
		bBoxNE: [2.42, 1.316],
		anchors: {}
	},
	fermataBelow: {
		name: 'fermataBelow',
		codepoint: 0xE4C1,
		description: 'Fermata below',
		advance: 2.42,
		bBoxSW: [0.012, -1.328],
		bBoxNE: [2.42, 0],
		anchors: {}
	},
} as const satisfies Record<string, GlyphMetrics>;

/** Name of any glyph this engine knows how to draw. */
export type GlyphName = keyof typeof GLYPH_METRICS;

/**
 * Look a glyph up as a plain `GlyphMetrics`.
 *
 * `GLYPH_METRICS` is `as const`, so indexing it directly gives a union of
 * per-glyph literal types and an anchor that only some glyphs have is not
 * addressable on that union. This widens once, at the boundary, instead of
 * scattering casts through the layout code.
 */
export function glyphMetrics(name: GlyphName): GlyphMetrics {
	return GLYPH_METRICS[name];
}

/**
 * Line thicknesses and extensions recommended by the font, staff spaces. We
 * draw staff lines, stems, ledger lines and barlines ourselves as plain
 * rectangles, so using Bravura's own numbers is what keeps them looking like
 * they belong to the same typeface as the glyphs.
 */
export const ENGRAVING_DEFAULTS = {
	staffLineThickness: 0.13,
	stemThickness: 0.12,
	legerLineThickness: 0.16,
	legerLineExtension: 0.4,
	thinBarlineThickness: 0.16,
	thickBarlineThickness: 0.5,
	barlineSeparation: 0.4,
	beamThickness: 0.5,
	beamSpacing: 0.25,
	tieMidpointThickness: 0.22,
	slurMidpointThickness: 0.22,
	bracketThickness: 0.5,
} as const;

/**
 * Staff spaces per em. SMuFL fixes this at 4: a font size of `4 * staffSpacePx`
 * makes every metric above scale by `staffSpacePx`. Named rather than inlined
 * because it appears in both layout and the renderer.
 */
export const STAFF_SPACES_PER_EM = 4;

/** The font family name the vendored Bravura file registers itself under. */
export const BRAVURA_FAMILY = 'Bravura';
