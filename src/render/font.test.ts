// The bundled font: `bravuraFontUrl` must point at a real woff2, and
// `loadSmuflFont` must use it by default while still honouring an explicit URL,
// and fall back to the inlined copy only when the default fails. The browser
// globals are stubbed just enough to record what FontFace was given.

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

	// `fails` picks which sources reject on load, like a 404 would.
	function stubBrowser(fails: (source: string) => boolean = () => false): {
		sources: string[];
		added: unknown[];
	} {
		const sources: string[] = [];
		const added: unknown[] = [];
		vi.stubGlobal(
			'FontFace',
			class {
				constructor(
					readonly family: string,
					readonly source: string
				) {
					sources.push(source);
				}
				load(): Promise<this> {
					return fails(this.source)
						? Promise.reject(new DOMException('A network error occurred.', 'NetworkError'))
						: Promise.resolve(this);
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

	it('falls back to the inlined font when the bundled URL fails', async () => {
		const { sources, added } = stubBrowser((source) => !source.includes('data:'));
		await expect(loadSmuflFont()).resolves.toBe('Bravura');
		expect(sources).toHaveLength(2);
		expect(sources[1]).toMatch(/^url\("data:font\/woff2;base64,/);
		expect(added).toHaveLength(1);
	});

	it('rejects without falling back when an explicit URL fails', async () => {
		const { sources, added } = stubBrowser(() => true);
		await expect(loadSmuflFont('/fonts/Missing.woff2')).rejects.toThrow(/network error/);
		expect(sources).toEqual([`url("/fonts/Missing.woff2")`]);
		expect(added).toHaveLength(0);
	});

	it('throws outside a browser', async () => {
		await expect(loadSmuflFont()).rejects.toThrow(/browser document/);
	});
});
