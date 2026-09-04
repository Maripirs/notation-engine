import { describe, expect, it } from 'vitest';
import { NOTATION_ENGINE_VERSION } from './index.js';

describe('scaffold', () => {
	it('exports a version', () => {
		expect(NOTATION_ENGINE_VERSION).toBe('0.0.1');
	});
});
