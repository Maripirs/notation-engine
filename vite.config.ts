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
		environment: 'jsdom',
		include: ['src/**/*.test.ts']
	}
});
