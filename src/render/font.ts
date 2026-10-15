// Loading the SMuFL font in a browser.
//
// Canvas draws text with whatever font is installed *at the moment fillText
// runs*. There is no callback for "the font arrived, repaint": a score drawn
// before Bravura loads renders as tofu boxes and stays that way. So a host app
// has to await the font before the first draw, and this is the one-liner for
// doing that.
//
// The package ships Bravura itself: `Bravura.woff2` (and its license,
// `Bravura-OFL.txt`) sit next to `dist/index.js`, and `bravuraFontUrl` points
// at the font with the standard `new URL('./file', import.meta.url)` pattern.
// Vite builds and webpack 5 recognise that pattern and emit the file with no
// host config, and plain browser ESM from a CDN resolves it relative to the
// module URL at runtime. Two gaps (as of Vite 8.3, esbuild 0.28): Vite 6 and 7
// dev servers pre-bundle the package into `node_modules/.vite/deps/`, which
// breaks the relative URL (add `optimizeDeps: { exclude: ['notation-engine'] }`;
// Vite 8 is fine), and esbuild leaves the URL untouched even with a `.woff2`
// file loader, so an esbuild host copies `dist/Bravura.woff2` next to its
// bundle or passes its own URL. In source the URL points into
// `assets/bravura/`, and the library build (`vite.config.ts`) rewrites it to
// the shipped copy.
//
// It is a convenience, not a requirement. A host that already declares
// `@font-face` in CSS can skip it entirely and await `document.fonts.ready`
// instead, and a host that serves its own copy passes that URL.
//
// Headless (Node + node-canvas): `loadSmuflFont` needs a document, so register
// the bundled file with the rasterizer directly:
//
//   import { registerFont } from 'canvas';
//   import { fileURLToPath } from 'node:url';
//   import { bravuraFontUrl } from 'notation-engine';
//   registerFont(fileURLToPath(bravuraFontUrl), { family: 'Bravura' });

import { BRAVURA_FAMILY } from './glyph-metrics.js';

/** Location of the bundled `Bravura.woff2`: an http(s) URL in a browser, a file URL in Node. */
export const bravuraFontUrl: URL = new URL('../../assets/bravura/Bravura.woff2', import.meta.url);

/**
 * Register a SMuFL font with the document and resolve once it is usable.
 *
 * With no `url` it loads the Bravura copy shipped with the package
 * (`bravuraFontUrl`). Pass a URL to serve the font from elsewhere, or to load a
 * different SMuFL font under `family`. Resolves to the family name to pass to
 * `CanvasRenderer`'s `fontFamily` option.
 */
export async function loadSmuflFont(
	url: string | URL = bravuraFontUrl,
	family = BRAVURA_FAMILY
): Promise<string> {
	if (typeof FontFace === 'undefined' || typeof document === 'undefined') {
		throw new Error(
			'loadSmuflFont needs a browser document. In Node, register the font with the ' +
				'rasterizer directly (node-canvas exposes registerFont; see bravuraFontUrl).'
		);
	}
	const face = new FontFace(family, `url(${JSON.stringify(String(url))})`);
	await face.load();
	document.fonts.add(face);
	return family;
}
