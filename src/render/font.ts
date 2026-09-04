// Loading the SMuFL font in a browser.
//
// Canvas draws text with whatever font is installed *at the moment fillText
// runs*. There is no callback for "the font arrived, repaint": a score drawn
// before Bravura loads renders as tofu boxes and stays that way. So a host app
// has to await the font before the first draw, and this is the one-liner for
// doing that.
//
// It is a convenience, not a requirement. A host that already declares
// `@font-face` in CSS can skip it entirely and await `document.fonts.ready`
// instead. Either way the engine itself never fetches anything: the caller
// supplies the URL, because only the host knows how its bundler emits assets.

import { BRAVURA_FAMILY } from './glyph-metrics.js';

/**
 * Register a SMuFL font with the document and resolve once it is usable.
 *
 * `url` should point at the vendored `assets/bravura/Bravura.woff2` however the
 * host's bundler exposes it. Resolves to the family name to pass to
 * `CanvasRenderer`'s `fontFamily` option.
 */
export async function loadSmuflFont(url: string, family = BRAVURA_FAMILY): Promise<string> {
	if (typeof FontFace === 'undefined' || typeof document === 'undefined') {
		throw new Error(
			'loadSmuflFont needs a browser document. In Node, register the font with the ' +
				'rasterizer directly (node-canvas exposes registerFont).'
		);
	}
	const face = new FontFace(family, `url(${JSON.stringify(url)})`);
	await face.load();
	document.fonts.add(face);
	return family;
}
