// The real-corpus regression net (M6 Slice 1).
//
// Every SFCC choral score in `src/test/fixtures/sfcc/` (7 real Audiveris-era
// MusicXML files, copied from Divisi's `Backend/fixtures/SFCC/`, the scores
// the SFCC board's feedback is about) is imported and laid out, and what the
// import kept and lost is snapshotted per file. The snapshot is the point:
// each later M6 slice that models or passes through an element (chords,
// dynamics, articulations, ...) shows up as a reviewed diff in that
// element's dropped count, and an accidental regression shows up the same
// way rather than silently.
//
// Hand-written unit tests elsewhere pin each rule down; this file is only
// about the real files, so it asserts invariants that must hold for any
// input plus the snapshot, never per-file magic numbers inline.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutScore } from '../layout/index.js';
import { createImportDiagnostics, importMusicXml } from './musicxml-import.js';
import { descendants, parseXml } from './xml.js';

const FIXTURE_DIR = join(import.meta.dirname, '../test/fixtures/sfcc');
const fixtures = readdirSync(FIXTURE_DIR)
	.filter((name) => name.endsWith('.musicxml'))
	.sort();

describe('SFCC corpus: import + layout', () => {
	it('finds all 7 fixtures', () => {
		expect(fixtures).toHaveLength(7);
	});

	for (const name of fixtures) {
		it(name, () => {
			const xml = readFileSync(join(FIXTURE_DIR, name), 'utf8');
			const source = parseXml(xml);
			const diagnostics = createImportDiagnostics();
			const score = importMusicXml(xml, { diagnostics });
			const layout = layoutScore(score);

			const sourceNotes = descendants(source, 'note').length;
			const sourceForwards = descendants(source, 'forward').length;
			const modelNotes = score.staves.reduce(
				(sum, staff) => sum + staff.measures.reduce((s, m) => s + m.notes.length, 0),
				0
			);
			const dropped = Object.fromEntries(
				[...diagnostics.dropped].sort(([a], [b]) => a.localeCompare(b))
			);

			// Every source <note> is either in the model or tallied as a whole-
			// note drop (`chord`/`grace`); each <forward> gap became one rest.
			// Holds for any file, so it is asserted, not just snapshotted.
			expect(modelNotes).toBe(
				sourceNotes - (dropped.chord ?? 0) - (dropped.grace ?? 0) + sourceForwards
			);
			expect(score.parts.filter((p) => p.name !== undefined)).toHaveLength(
				descendants(source, 'part').length
			);
			expect(layout.measures.length).toBeGreaterThan(0);

			expect({
				sourceNotes,
				modelNotes,
				sourceForwards,
				sourceParts: descendants(source, 'part').length,
				parts: score.parts.map((p) => `${p.name ?? '(group)'}: [${p.staffIndices.join(', ')}]`),
				staves: score.staves.length,
				measureRests: score.staves.reduce(
					(sum, staff) =>
						sum + staff.measures.reduce((s, m) => s + m.notes.filter((n) => n.isMeasureRest).length, 0),
					0
				),
				dropped,
				fallbacks: diagnostics.fallbacks.map(
					(f) => `${f.kind} ${f.partId} m${f.measureNumber}: ${f.detail}`
				)
			}).toMatchSnapshot();
		});
	}
});
