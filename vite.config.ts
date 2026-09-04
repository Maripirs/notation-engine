/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
	// `npm run dev` serves the demo page (a plain Vite app rooted at demo/)
	// against the library source directly, no build step. `npm run build`
	// switches to library mode and bundles `src/index.ts`.
	root: 'demo',
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
