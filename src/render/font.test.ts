// The bundled font: `bravuraFontUrl` must point at a real woff2, and
// `loadSmuflFont` must use it by default while still honouring an explicit URL.
// The browser globals are stubbed just enough to record what FontFace was given.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bravuraFontUrl, loadSmuflFont } from '../index.js';

describe('bundled Bravura', () => {
	it('resolves to a woff2 that exists next to the source', () => {
		expect(bravuraFontUrl.pathname).toMatch(/\/Bravura\.woff2$/);
		expect(existsSync(fileURLToPath(bravuraFontUrl))).toBe(true);
	});
});

describe('loadSmuflFont', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubBrowser(): { sources: string[]; added: unknown[] } {
		const sources: string[] = [];
		const added: unknown[] = [];
		vi.stubGlobal(
			'FontFace',
			class {
				constructor(
					readonly family: string,
					source: string
				) {
					sources.push(source);
				}
				load(): Promise<this> {
					return Promise.resolve(this);
				}
			}
		);
		vi.stubGlobal('document', { fonts: { add: (face: unknown) => added.push(face) } });
		return { sources, added };
	}

	it.each([
		['the bundled font with no argument', undefined, bravuraFontUrl.href],
		['an explicit URL when given one', '/fonts/Custom.woff2', '/fonts/Custom.woff2']
	])('loads %s', async (_label, url, expected) => {
		const { sources, added } = stubBrowser();
		const family = await loadSmuflFont(url);
		expect(family).toBe('Bravura');
		expect(sources).toEqual([`url(${JSON.stringify(expected)})`]);
		expect(added).toHaveLength(1);
	});

	it('throws outside a browser', async () => {
		await expect(loadSmuflFont()).rejects.toThrow(/browser document/);
	});
});
