/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// Ship Bravura next to `dist/index.js` instead of inlining it. Vite's library
// mode always inlines `new URL(..., import.meta.url)` assets as base64 (323KB of
// font in the JS), so for the build only this plugin points font.ts's URL at the
// shipped copy, hides it from Vite's asset rewrite with `@vite-ignore`, strips
// that marker again from the output (a downstream Vite would honour it and skip
// the file), and emits the font and its license under stable names. In dev and
// tests the source URL into `assets/bravura/` is used as is.
const FONT_SOURCE_URL = "'../../assets/bravura/Bravura.woff2'";
const FONT_DIST_NAME = 'Bravura.woff2';
const VITE_IGNORE = '/* @vite-ignore */ ';

function shipBravura(): Plugin {
	return {
		name: 'ship-bravura',
		apply: 'build',
		enforce: 'pre',
		transform(code, id) {
			if (!id.endsWith('/src/render/font.ts')) return null;
			if (!code.includes(FONT_SOURCE_URL)) {
				this.error(`font.ts no longer references ${FONT_SOURCE_URL}; update shipBravura`);
			}
			return code.replace(FONT_SOURCE_URL, `${VITE_IGNORE}'./${FONT_DIST_NAME}'`);
		},
		renderChunk(code) {
			// Rollup reflows the call, so match the marker with any whitespace.
			return code.replace(/\/\*\s*@vite-ignore\s*\*\/\s*/g, '');
		},
		generateBundle() {
			const dir = new URL('./assets/bravura/', import.meta.url);
			this.emitFile({
				type: 'asset',
				fileName: FONT_DIST_NAME,
				source: readFileSync(new URL('Bravura.woff2', dir))
			});
			this.emitFile({
				type: 'asset',
				fileName: 'Bravura-OFL.txt',
				source: readFileSync(new URL('OFL.txt', dir))
			});
		}
	};
}

// The fallback `loadSmuflFont` imports when the shipped URL does not survive a
// host's tooling (see font.ts): the font as a data URL, in a module of its own
// so the build splits it into a chunk that only that path fetches. Served in
// dev and tests too, so the fallback runs from source with nothing generated
// on disk.
const INLINE_ID = 'virtual:bravura-inline';

function inlineBravura(): Plugin {
	const resolved = `\0${INLINE_ID}`;
	return {
		name: 'inline-bravura',
		resolveId(id) {
			return id === INLINE_ID ? resolved : null;
		},
		load(id) {
			if (id !== resolved) return null;
			const font = readFileSync(new URL('./assets/bravura/Bravura.woff2', import.meta.url));
			return `export default ${JSON.stringify(`data:font/woff2;base64,${font.toString('base64')}`)};`;
		},
		outputOptions(options) {
			// A readable, stable name next to Bravura.woff2 instead of `_virtual_...-[hash].js`.
			options.chunkFileNames = (chunk) =>
				chunk.facadeModuleId === resolved ? 'Bravura-inline.js' : '[name]-[hash].js';
			return options;
		}
	};
}

export default defineConfig({
	// `npm run dev` serves the demo page (a plain Vite app rooted at demo/)
	// against the library source directly, no build step. `npm run build`
	// switches to library mode and bundles `src/index.ts`.
	root: 'demo',
	plugins: [shipBravura(), inlineBravura()],
	build: {
		outDir: '../dist',
		emptyOutDir: true,
		lib: {
			entry: '../src/index.ts',
			formats: ['es'],
			fileName: 'index'
		}
	},
	test: {
		root: '.',
		// Node, not jsdom. Nothing in model/, layout/ or render/ touches the DOM:
		// the renderer talks to a `CanvasRenderingContext2D` and the tests hand it
		// a stub that records coordinates, which is a better proof than a jsdom
		// canvas would be anyway (jsdom has no 2D implementation to record). The
		// benchmark rasterizes for real through node-canvas, which is also native
		// Node. Keeping the test environment DOM-free is a standing check on the
		// framework-agnostic principle: if a DOM sneaks into the core, the suite
		// stops running.
		environment: 'node',
		include: ['src/**/*.test.ts']
	}
});
