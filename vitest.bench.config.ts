/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// A separate config so `npm run bench` picks up `*.bench.ts` and `npm test`
// never does. Timings depend on the machine and on whatever else it is running,
// so a benchmark that can fail CI is a benchmark someone eventually deletes.
// The property that has to hold everywhere is asserted in the ordinary suite
// instead: see src/render/renderer.test.ts.
export default defineConfig({
	test: {
		root: '.',
		environment: 'node',
		include: ['src/**/*.bench.ts']
	}
});
