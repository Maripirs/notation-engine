// The real-corpus regression net (M6 Slice 1).
//
// Every SFCC choral score in `src/test/fixtures/sfcc/` (7 real Audiveris-era
// MusicXML files, copied from Divisi's `Backend/fixtures/SFCC/`, the scores
// the SFCC board's feedback is about) is imported and laid out, and what the
// import kept, passed through and lost is snapshotted per file. The snapshot
// is the point: each later M6 slice that models an element (dynamics,
// articulations, ...) shows up as a reviewed diff moving that element out of
// the passthrough tally, and an accidental regression shows up the same way
// rather than silently.
//
// Since M6 Slice 6 the snapshot also tallies the dynamics (by kind) and
// hairpins promoted into the model.
//
// Since M6 Slice 3 it is also the lossless-save acceptance test: `export(
// import(file))` must carry the same multiset of element names as the file,
// modulo the normalizations listed in `NORMALIZED` (and the few counted
// adjustments asserted next to it), and re-importing that export must give
// back an equivalent score, payloads included. The same holds after a note
// is transposed and the edit undone through `EditHistory`.
//
// Hand-written unit tests elsewhere pin each rule down; this file is only
// about the real files, so it asserts invariants that must hold for any
// input plus the snapshot, never per-file magic numbers inline.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutScore } from '../layout/index.js';
import { ARTICULATIONS, assertScoresEquivalent, EditHistory, type Score } from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { createImportDiagnostics, importMusicXml } from './musicxml-import.js';
import { descendants, parseXml, type XmlElement } from './xml.js';

const FIXTURE_DIR = join(import.meta.dirname, '../test/fixtures/sfcc');
const fixtures = readdirSync(FIXTURE_DIR)
	.filter((name) => name.endsWith('.musicxml'))
	.sort();

/**
 * Element names whose count an import -> export round trip may change, each
 * because the engine writes it from the model by its own rule rather than
 * copying the source. Nothing here is information the model loses; it is
 * the source's spelling of information the model holds (or derives).
 */
const NORMALIZED: Readonly<Record<string, string>> = {
	accidental: 'not written: layout derives accidentals from pitch, key and measure state',
	attributes: 'several <attributes> in one measure are merged into one',
	backup: 'regenerated per voice stream (plus one per passthrough onset inside a longer note)',
	beam: 'regenerated from the beaming rule, primary level only',
	notations: 'several <notations> on one note merge into one when the model writes any',
	staff: 'written on every note of a multi-staff part, never on a single-staff one',
	staves: 'written only for a multi-staff part',
	stem: 'regenerated on every pitched non-whole note',
	tuplet: 'source brackets are kept; a run the source left bare gets regenerated ones',
	type: 'written on every note except a whole-measure rest',
	voice: 'written on every note'
};

/** The elements of the one tempo direction export writes when the source
 *  states no tempo (`Score.tempoBpm` defaults to 120 and is always written). */
const SYNTHESIZED_TEMPO = ['direction', 'direction-type', 'metronome', 'beat-unit', 'per-minute', 'sound'];

function tally(root: XmlElement): Map<string, number> {
	const counts = new Map<string, number>();
	const walk = (el: XmlElement): void => {
		counts.set(el.name, (counts.get(el.name) ?? 0) + 1);
		for (const c of el.children) walk(c);
	};
	walk(root);
	return counts;
}

/**
 * `exported` against `source`, as the per-name count differences left after
 * every documented normalization, so a lossless round trip yields `{}`.
 * Besides `NORMALIZED`, four adjustments are exact, not waived: `<alter>0`
 * is omitted (only nonzero alters must match); `<duration>` must match once
 * `<backup>` durations are set aside; a source with no tempo gets exactly one
 * synthesized tempo direction; and each `<clef>` overridden by another at the
 * same onset (`droppedClefs`, the importer's own `dropped.clef`) costs
 * exactly one `<clef>`/`<sign>`/`<line>`. Since M6 Slice 4 models clef changes
 * inside a measure, no corpus file has one, so this is 0 throughout.
 */
function unexplainedDifferences(source: XmlElement, exported: XmlElement, droppedClefs: number): Record<string, number> {
	const before = tally(source);
	const after = tally(exported);
	const adjust = (map: Map<string, number>, name: string, by: number): void => {
		map.set(name, (map.get(name) ?? 0) + by);
	};

	const zeroAlters = (root: XmlElement): number =>
		descendants(root, 'alter').filter((a) => Number(a.text.trim()) === 0).length;
	adjust(before, 'alter', -zeroAlters(source));
	adjust(after, 'alter', -zeroAlters(exported));
	adjust(before, 'duration', -(before.get('backup') ?? 0));
	adjust(after, 'duration', -(after.get('backup') ?? 0));
	if (descendants(source, 'metronome').length === 0) {
		for (const name of SYNTHESIZED_TEMPO) adjust(after, name, -1);
	}
	for (const name of ['clef', 'sign', 'line']) adjust(before, name, -droppedClefs);

	const differences: Record<string, number> = {};
	for (const name of new Set([...before.keys(), ...after.keys()])) {
		if (name in NORMALIZED) continue;
		const delta = (after.get(name) ?? 0) - (before.get(name) ?? 0);
		if (delta !== 0) differences[name] = delta;
	}
	return differences;
}

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
			const sorted = (map: Map<string, number>): Record<string, number> =>
				Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
			const dropped = sorted(diagnostics.dropped);
			const passthrough = sorted(diagnostics.passthrough);

			// Every source <note> is either in the model, passed through whole
			// (a grace note the model cannot hold, `grace`: a grace chord or
			// rest), or dropped whole (`chord`, a `<chord/>` note with nothing
			// to join, 0 across the corpus since M6 Slice 2); each <forward> gap
			// became one rest.
			// Holds for any file, so it is asserted, not just snapshotted.
			expect(modelNotes).toBe(
				sourceNotes - (dropped.chord ?? 0) - (passthrough.grace ?? 0) + sourceForwards
			);
			// Since M6 Slice 8 every corpus grace note is a model grace note, so
			// the model holds exactly the source's notes (plus <forward> rests).
			const modelGraces = score.staves.reduce(
				(sum, staff) => sum + staff.measures.reduce((s, m) => s + m.notes.filter((n) => n.isGrace).length, 0),
				0
			);
			expect(passthrough.grace).toBeUndefined();
			expect(modelNotes).toBe(sourceNotes + sourceForwards);
			expect(modelGraces).toBe(descendants(source, 'grace').length);
			expect(score.parts.filter((p) => p.name !== undefined)).toHaveLength(
				descendants(source, 'part').length
			);
			expect(layout.measures.length).toBeGreaterThan(0);

			// Marks promoted into the model (M6 Slice 5), per kind. Every source
			// mark of a modelled kind must have landed in the model (the corpus
			// has no duplicates on one note and no non-normal fermata shapes,
			// the two cases `readMarks` leaves in passthrough), and none is
			// still tallied as passthrough.
			const marks: Record<string, number> = {};
			for (const staff of score.staves) {
				for (const measure of staff.measures) {
					for (const note of measure.notes) {
						for (const kind of note.articulations) marks[kind] = (marks[kind] ?? 0) + 1;
						if (note.fermata) marks[`fermata ${note.fermata}`] = (marks[`fermata ${note.fermata}`] ?? 0) + 1;
					}
				}
			}
			for (const kind of ARTICULATIONS) {
				expect(marks[kind] ?? 0).toBe(descendants(source, kind).length);
			}
			expect((marks['fermata upright'] ?? 0) + (marks['fermata inverted'] ?? 0)).toBe(
				descendants(source, 'fermata').length
			);
			expect(passthrough.articulations).toBeUndefined();
			expect(passthrough.fermata).toBeUndefined();

			// Dynamics and hairpins promoted into the model (M6 Slice 6). Every
			// source `<dynamics>` is in the corpus's one promotable shape, so all
			// of them land in the model. Every `<wedge>` is a hairpin end:
			// either half of a modelled `Wedge`, or one the source never paired
			// (a start whose stop has another `number`, or sits in another
			// part: OMR slips), which stays passthrough rather than guessing.
			const dynamicKinds: Record<string, number> = {};
			for (const staff of score.staves) {
				for (const measure of staff.measures) {
					for (const mark of measure.dynamics) dynamicKinds[mark.kind] = (dynamicKinds[mark.kind] ?? 0) + 1;
				}
			}
			expect(Object.values(dynamicKinds).reduce((a, b) => a + b, 0)).toBe(descendants(source, 'dynamics').length);
			expect(passthrough.dynamics).toBeUndefined();
			expect(score.wedges.length * 2 + (passthrough.wedge ?? 0)).toBe(descendants(source, 'wedge').length);

			expect({
				sourceNotes,
				modelNotes,
				sourceForwards,
				sourceParts: descendants(source, 'part').length,
				parts: score.parts.map((p) => `${p.name ?? '(group)'}: [${p.staffIndices.join(', ')}]`),
				staves: score.staves.length,
				graces: modelGraces,
				measureRests: score.staves.reduce(
					(sum, staff) =>
						sum + staff.measures.reduce((s, m) => s + m.notes.filter((n) => n.isMeasureRest).length, 0),
					0
				),
				dropped,
				passthrough,
				marks: sorted(new Map(Object.entries(marks))),
				dynamics: sorted(new Map(Object.entries(dynamicKinds))),
				wedges: score.wedges.length,
				fallbacks: diagnostics.fallbacks.map(
					(f) => `${f.kind} ${f.partId} m${f.measureNumber}: ${f.detail}`
				)
			}).toMatchSnapshot();
		});
	}
});

describe('SFCC corpus: lossless round trip (M6 Slice 3)', () => {
	for (const name of fixtures) {
		it(name, () => {
			const xml = readFileSync(join(FIXTURE_DIR, name), 'utf8');
			const source = parseXml(xml);
			const diagnostics = createImportDiagnostics();
			const score = importMusicXml(xml, { diagnostics });
			const droppedClefs = diagnostics.dropped.get('clef') ?? 0;

			const exported = exportMusicXml(score);
			expect(unexplainedDifferences(source, parseXml(exported), droppedClefs)).toEqual({});

			// The export reads back as the same music with the same payloads,
			// and exporting that again is byte-identical: the anchors are stable.
			const reimported = importMusicXml(exported);
			assertScoresEquivalent(reimported, score);
			expect(exportMusicXml(reimported)).toBe(exported);

			// Transpose one pitched note that carries passthrough (or any
			// pitched note), then undo: the save is unchanged. The transposed
			// state itself keeps that note's payload.
			const history = new EditHistory(score);
			const target = findNoteWithPayload(history.current);
			const before = history.current.findNote(target)!;
			const payloadBefore = before.passthrough;
			const alteredBefore = before.pitch!.alter !== 0;
			expect(history.record((s) => s.transposeNote(target, 2))).not.toBeNull();
			const after = history.current.findNote(target)!;
			expect(after.passthrough).toBe(payloadBefore);
			// The only name a transpose may change is whether that one note
			// writes a nonzero `<alter>`.
			const alterDelta = Number(after.pitch!.alter !== 0) - Number(alteredBefore);
			expect(unexplainedDifferences(source, parseXml(exportMusicXml(history.current)), droppedClefs)).toEqual(
				alterDelta === 0 ? {} : { alter: alterDelta }
			);
			history.undo();
			expect(exportMusicXml(history.current)).toBe(exported);
		});
	}
});

/** The first pitched note with a passthrough payload, else the first pitched note. */
function findNoteWithPayload(score: Score): string {
	let fallback: string | undefined;
	for (const staff of score.staves) {
		for (const measure of staff.measures) {
			for (const note of measure.notes) {
				if (note.pitch === null) continue;
				if (note.passthrough.length > 0) return note.id;
				fallback ??= note.id;
			}
		}
	}
	return fallback!;
}
