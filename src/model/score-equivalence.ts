// Musical-content equality between two `Score`s.
//
// Built for the MusicXML round-trip test (`import(export(score))` should be the
// same music as `score`), and written as a standalone module because it is the
// kind of check other work wants too: an undo/redo slice comparing a
// before/after snapshot, a future importer for another format, a fixture
// regression guard.
//
// "Musical content" deliberately excludes everything that is presentation or
// derived-on-demand:
//
//   - Note ids (freshly minted by whichever `Score` built the note).
//   - Raw `Measure.keyFifths` / `Measure.time` / `Measure.clef` /
//     `Measure.endBarline` fields: the *resolved* value from `keyFifthsAt` /
//     `timeAt` / `clefAt` / `endBarlineAt` is
//     compared instead, so "last measure, endBarline unset -> resolves to
//     final" and "last measure, endBarline explicitly final" count as equal.
//   - Beaming and stem directions (recomputed by layout, never stored).
//   - `crossStaffBeams`. `exportMusicXml` has no MusicXML element to carry a
//     cross-staff beam's note linkage (there is no clean representation), so a
//     score with one, e.g. `createCrossStaffBeamShowcaseScore`, round-trips
//     losing exactly that link and nothing else. This is a known, accepted gap
//     for M5; a later slice that needs cross-staff beams preserved would have
//     to add a private extension element on export and read it back here.
//   - Part names that match `/^Part \d+$/` and unnamed single-staff parts:
//     `exportMusicXml` invents a synthetic "Part N" name for every staff no
//     named model `Part` covers, so those names are noise, not signal.
//
// Every mismatch throws an `Error` naming the first thing that differed, so a
// failing round-trip test points straight at the divergence.

// Imports the model's own sibling modules directly, not `./index.js`: this
// file is re-exported *from* `index.js`, so pulling `index.js` back in here
// would be a circular import for no benefit (everything needed lives in
// `pitch.js` / `score.js`).
import { formatPitch, type Pitch } from './pitch.js';
import type { Note, Score } from './score.js';

/**
 * Throw unless `actual` and `expected` represent the same music. See this
 * file's header for exactly what "the same music" includes and excludes.
 */
export function assertScoresEquivalent(actual: Score, expected: Score): void {
	if (actual.keyFifths !== expected.keyFifths) {
		fail('score.keyFifths', actual.keyFifths, expected.keyFifths);
	}
	if (actual.time.beats !== expected.time.beats || actual.time.beatType !== expected.time.beatType) {
		fail('score.time', formatTime(actual.time), formatTime(expected.time));
	}
	if (actual.tempoBpm !== expected.tempoBpm) {
		fail('score.tempoBpm', actual.tempoBpm, expected.tempoBpm);
	}

	if (actual.staves.length !== expected.staves.length) {
		fail('staves.length', actual.staves.length, expected.staves.length);
	}

	for (let s = 0; s < expected.staves.length; s++) {
		const actualStaff = actual.staves[s]!;
		const expectedStaff = expected.staves[s]!;
		// The staff's starting clef as `clefAt(0)` resolves it, not the raw
		// `Staff.clef`: since M5 Slice 5 a `measures[0].clef` override is the
		// same music as that clef set on the staff itself (and is what an
		// export/import round trip turns it into). With no measures `clefAt`
		// falls back to `Staff.clef`, so an empty staff still compares it.
		if (actual.clefAt(0, s) !== expected.clefAt(0, s)) {
			fail(`staves[${s}].clef`, actual.clefAt(0, s), expected.clefAt(0, s));
		}
		if (actualStaff.measures.length !== expectedStaff.measures.length) {
			fail(`staves[${s}].measures.length`, actualStaff.measures.length, expectedStaff.measures.length);
		}

		for (let m = 0; m < expectedStaff.measures.length; m++) {
			const where = `staves[${s}].measures[${m}]`;

			assertEqual(`${where} keyFifthsAt`, actual.keyFifthsAt(m, s), expected.keyFifthsAt(m, s));
			assertEqual(`${where} clefAt`, actual.clefAt(m, s), expected.clefAt(m, s));
			assertEqual(`${where} timeAt`, formatTime(actual.timeAt(m, s)), formatTime(expected.timeAt(m, s)));
			assertEqual(`${where} endBarlineAt`, actual.endBarlineAt(m, s), expected.endBarlineAt(m, s));
			assertEqual(
				`${where} startBarline`,
				actualStaff.measures[m]!.startBarline ?? 'none',
				expectedStaff.measures[m]!.startBarline ?? 'none'
			);

			assertMeasureNotesEquivalent(where, actual, expected, actualStaff.measures[m]!.notes, expectedStaff.measures[m]!.notes);
		}
	}

	assertSlursEquivalent(actual, expected);
	assertPartsEquivalent(actual, expected);
}

// --- Notes, bucketed by voice ---------------------------------------------

function assertMeasureNotesEquivalent(
	where: string,
	actualScore: Score,
	expectedScore: Score,
	actualNotes: readonly Note[],
	expectedNotes: readonly Note[]
): void {
	const actualByVoice = groupByVoice(actualNotes);
	const expectedByVoice = groupByVoice(expectedNotes);

	const actualVoices = [...actualByVoice.keys()].sort((a, b) => a - b);
	const expectedVoices = [...expectedByVoice.keys()].sort((a, b) => a - b);
	if (actualVoices.join(',') !== expectedVoices.join(',')) {
		fail(`${where} voices present`, actualVoices.join(','), expectedVoices.join(','));
	}

	for (const voice of expectedVoices) {
		const actualVoiceNotes = actualByVoice.get(voice)!;
		const expectedVoiceNotes = expectedByVoice.get(voice)!;
		if (actualVoiceNotes.length !== expectedVoiceNotes.length) {
			fail(`${where} voice ${voice} note count`, actualVoiceNotes.length, expectedVoiceNotes.length);
		}
		for (let i = 0; i < expectedVoiceNotes.length; i++) {
			assertNoteEquivalent(
				`${where} voice ${voice} note ${i}`,
				actualScore,
				expectedScore,
				actualVoiceNotes[i]!,
				expectedVoiceNotes[i]!
			);
		}
	}
}

function assertNoteEquivalent(
	where: string,
	actualScore: Score,
	expectedScore: Score,
	actualNote: Note,
	expectedNote: Note
): void {
	assertEqual(`${where} isRest`, actualNote.isRest, expectedNote.isRest);
	assertEqual(`${where} pitch`, pitchKey(actualNote.pitch), pitchKey(expectedNote.pitch));
	assertEqual(`${where} value`, actualNote.value, expectedNote.value);
	assertEqual(`${where} dots`, actualNote.dots, expectedNote.dots);
	assertEqual(`${where} tuplet`, tupletKey(actualNote), tupletKey(expectedNote));
	// A whole-measure rest is its own thing, not "a whole rest that happens to
	// fill a 4/4 bar": the flag and the duration it fills both have to survive.
	assertEqual(`${where} measureRestWholes`, actualNote.measureRestWholes, expectedNote.measureRestWholes);
	// Chord membership (M6 Slice 2): the same heads in the same order but
	// regrouped into different chords would sound and draw differently.
	assertEqual(`${where} chordWithPrevious`, actualNote.chordWithPrevious, expectedNote.chordWithPrevious);

	// Tie linkage: both must either start no tie, or start one that lands on a
	// note of the same pitch.
	const actualTarget = actualNote.tiedToId === null ? null : actualScore.findNote(actualNote.tiedToId) ?? null;
	const expectedTarget = expectedNote.tiedToId === null ? null : expectedScore.findNote(expectedNote.tiedToId) ?? null;
	assertEqual(
		`${where} tie target pitch`,
		actualTarget ? pitchKey(actualTarget.pitch) : 'no-tie',
		expectedTarget ? pitchKey(expectedTarget.pitch) : 'no-tie'
	);
}

function groupByVoice(notes: readonly Note[]): Map<number, Note[]> {
	const byVoice = new Map<number, Note[]>();
	for (const note of notes) {
		const list = byVoice.get(note.voice);
		if (list) list.push(note);
		else byVoice.set(note.voice, [note]);
	}
	return byVoice;
}

// --- Slurs, addressed by note position ----------------------------------

function assertSlursEquivalent(actual: Score, expected: Score): void {
	if (actual.slurs.length !== expected.slurs.length) {
		fail('slurs.length', actual.slurs.length, expected.slurs.length);
	}
	const actualKeys = new Set(actual.slurs.map((slur) => slurKey(actual, slur.startNoteId, slur.endNoteId)));
	for (const slur of expected.slurs) {
		const key = slurKey(expected, slur.startNoteId, slur.endNoteId);
		if (!actualKeys.has(key)) {
			throw new Error(`scores differ: expected a slur at ${key}, actual slurs are {${[...actualKeys].join('; ')}}`);
		}
	}
}

/** A slur as `staff:measure:index -> staff:measure:index`, using each end
 *  note's position within its own staff. */
function slurKey(score: Score, startId: string, endId: string): string {
	return `${noteLocation(score, startId)} -> ${noteLocation(score, endId)}`;
}

function noteLocation(score: Score, noteId: string): string {
	for (let s = 0; s < score.staves.length; s++) {
		const measures = score.staves[s]!.measures;
		for (let m = 0; m < measures.length; m++) {
			const index = measures[m]!.notes.findIndex((note) => note.id === noteId);
			if (index !== -1) return `${s}:${m}:${index}`;
		}
	}
	return '?:?:?';
}

// --- Parts: named parts and part-groups, as sets -----------------------

function assertPartsEquivalent(actual: Score, expected: Score): void {
	assertSetEqual('named parts', namedPartKeys(actual), namedPartKeys(expected));
	assertSetEqual('part-groups', partGroupKeys(actual), partGroupKeys(expected));
}

/** `[staffIndices]::name` for every part with a real name, dropping the
 *  synthetic `Part N` names export invents for unnamed staves. */
function namedPartKeys(score: Score): Set<string> {
	const keys = new Set<string>();
	for (const part of score.parts) {
		if (part.name === undefined || part.name === '') continue;
		if (/^Part \d+$/.test(part.name)) continue;
		keys.add(`${sortedIndices(part.staffIndices)}::${part.name}`);
	}
	return keys;
}

/** `[staffIndices]::symbol` for every unnamed multi-staff part, deriving the
 *  brace/bracket symbol the same way `exportMusicXml` does (2 staves -> brace,
 *  3+ -> bracket). */
function partGroupKeys(score: Score): Set<string> {
	const keys = new Set<string>();
	for (const part of score.parts) {
		if (part.staffIndices.length < 2) continue;
		if (part.name !== undefined && part.name !== '') continue;
		const symbol = part.staffIndices.length === 2 ? 'brace' : 'bracket';
		keys.add(`${sortedIndices(part.staffIndices)}::${symbol}`);
	}
	return keys;
}

function sortedIndices(indices: readonly number[]): string {
	return `[${[...indices].sort((a, b) => a - b).join(',')}]`;
}

// --- Tiny assertion helpers -------------------------------------------------

function assertEqual(label: string, actual: unknown, expected: unknown): void {
	if (actual !== expected) fail(label, actual, expected);
}

function assertSetEqual(label: string, actual: Set<string>, expected: Set<string>): void {
	const actualSorted = [...actual].sort();
	const expectedSorted = [...expected].sort();
	if (actualSorted.join(' | ') !== expectedSorted.join(' | ')) {
		fail(label, `{${actualSorted.join('; ')}}`, `{${expectedSorted.join('; ')}}`);
	}
}

function fail(label: string, actual: unknown, expected: unknown): never {
	throw new Error(`scores differ at ${label}: actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function pitchKey(pitch: Pitch | null): string {
	return pitch === null ? 'rest' : formatPitch(pitch);
}

function tupletKey(note: Note): string {
	return note.tuplet === null ? 'none' : `${note.tuplet.actualNotes}:${note.tuplet.normalNotes}`;
}

function formatTime(time: { beats: number; beatType: number }): string {
	return `${time.beats}/${time.beatType}`;
}
