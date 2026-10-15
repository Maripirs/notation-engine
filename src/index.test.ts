import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOTATION_ENGINE_VERSION } from './index.js';

describe('scaffold', () => {
	it('exports the package.json version', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
		expect(NOTATION_ENGINE_VERSION).toBe(pkg.version);
	});
});
