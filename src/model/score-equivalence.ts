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
//     `Measure.clefChanges` (M6 Slice 4, a clef change inside a measure) is
//     compared as written, since only it says where in the measure it falls.
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
// Passthrough payloads (M6 Slice 3) *are* compared, since a round trip that
// lost a dynamic or a lyric is exactly what they exist to prevent: each
// payload by `opaqueElementKey` (attribute order and re-indentation ignored,
// `<offset>`/`<duration>` values compared as the time they mean, so a
// `<divisions>` change does not count). A measure's positional payloads are
// compared as a multiset of (lead, voice, onset, element) rather than a list:
// export may legitimately reorder two payloads at different onsets or in
// different streams (it writes stream by stream), and nothing reads their
// relative order.
//
// Dynamics and hairpins (M6 Slice 6) are compared as multisets per measure
// (dynamics) and per score (hairpins): kind, onset(s), placement and the kept
// `DirectionSource` (its element by `opaqueElementKey` at its divisions, its
// slot and the mark's unread attributes). A mark's `voice` is not compared:
// it only says which stream export writes the `<direction>` in, and export
// writes a mark in its own staff's stream even when the source wrote it in
// another staff's (a `<direction>` naming `<staff>2</staff>` after a staff-1
// note), so a round trip may legitimately change it.
//
// Every mismatch throws an `Error` naming the first thing that differed, so a
// failing round-trip test points straight at the divergence.

// Imports the model's own sibling modules directly, not `./index.js`: this
// file is re-exported *from* `index.js`, so pulling `index.js` back in here
// would be a circular import for no benefit (everything needed lives in
// `pitch.js` / `score.js`).
import { opaqueElementKey, type MeasurePassthrough, type OpaqueElement } from './passthrough.js';
import { formatPitch, type Pitch } from './pitch.js';
import type { DirectionSource, DynamicMark, Wedge, WedgeEnd } from './directions.js';
import type { Lyric } from './lyrics.js';
import type { ClefChange, Measure, Note, Part, Score } from './score.js';

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

	assertEqual('score.headerPassthrough', payloadListKey(actual.headerPassthrough), payloadListKey(expected.headerPassthrough));

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
			// Mid-measure clef changes (M6 Slice 4) are compared as written,
			// onsets rounded the way layout buckets them: a change is music
			// (it moves every later notehead) and a round trip must keep it at
			// its onset, not fold it into the downbeat.
			assertEqual(
				`${where} clefChanges`,
				clefChangesKey(actualStaff.measures[m]!.clefChanges),
				clefChangesKey(expectedStaff.measures[m]!.clefChanges)
			);
			assertEqual(`${where} timeAt`, formatTime(actual.timeAt(m, s)), formatTime(expected.timeAt(m, s)));
			assertEqual(`${where} endBarlineAt`, actual.endBarlineAt(m, s), expected.endBarlineAt(m, s));
			assertEqual(
				`${where} startBarline`,
				actualStaff.measures[m]!.startBarline ?? 'none',
				expectedStaff.measures[m]!.startBarline ?? 'none'
			);

			assertMeasurePassthroughEquivalent(where, actualStaff.measures[m]!, expectedStaff.measures[m]!);
			assertEqual(
				`${where} dynamics`,
				dynamicsKey(actualStaff.measures[m]!.dynamics),
				dynamicsKey(expectedStaff.measures[m]!.dynamics)
			);
			assertMeasureNotesEquivalent(where, actual, expected, actualStaff.measures[m]!.notes, expectedStaff.measures[m]!.notes);
		}
	}

	assertSlursEquivalent(actual, expected);
	assertEqual('wedges', wedgesKey(actual.wedges), wedgesKey(expected.wedges));
	assertPartsEquivalent(actual, expected);
}

// --- Dynamics and hairpins (M6 Slice 6) --------------------------------

function onsetKey(onset: number): string {
	return String(Math.round(onset * 1e9) / 1e9);
}

function directionSourceKey(source: DirectionSource | null): string {
	if (source === null) return '-';
	const attrs = Object.keys(source.markAttrs)
		.sort()
		.map((key) => `${key}=${JSON.stringify(source.markAttrs[key])}`)
		.join(',');
	return `#${source.slot}[${attrs}]${opaqueElementKey(source.element, source.divisions)}`;
}

function dynamicsKey(marks: readonly DynamicMark[]): string {
	return marks
		.map((mark) => `${mark.kind}@${onsetKey(mark.onset)} ${mark.placement ?? '-'} ${directionSourceKey(mark.source)}`)
		.sort()
		.join('\n');
}

function wedgeEndKey(end: WedgeEnd): string {
	return `m${end.measureIndex}@${onsetKey(end.onset)} ${directionSourceKey(end.source)}`;
}

function wedgesKey(wedges: readonly Wedge[]): string {
	return wedges
		.map((w) => `${w.kind} s${w.staffIndex} ${w.placement ?? '-'} ${wedgeEndKey(w.start)} -> ${wedgeEndKey(w.stop)}`)
		.sort()
		.join('\n');
}

function clefChangesKey(changes: readonly ClefChange[]): string {
	return changes.map((change) => `${Math.round(change.onset * 1e9) / 1e9}:${change.clef}`).join(',');
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

function graceKey(note: Note): string {
	const g = note.grace;
	if (g === null) return 'none';
	const time = (x: number | null): string => (x === null ? '-' : String(Math.round(x * 1e9) / 1e9));
	return `${g.slash ? 'slash' : 'plain'} ${time(g.stealTimePrevious)} ${time(g.stealTimeFollowing)} ${time(g.makeTime)}`;
}

function lyricsKey(lyrics: readonly Lyric[]): string {
	return lyrics
		.map(
			(l) =>
				`${l.verse}:${l.syllabic}:${JSON.stringify(l.text)}` +
				l.elisions.map((e) => `_${e.syllabic}:${JSON.stringify(e.text)}`).join('') +
				`:${l.extend ?? '-'}:${l.source ? opaqueElementKey(l.source) : '-'}`
		)
		.join(' | ');
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
	// Marks (M6 Slice 5) are compared per head, as written: a round trip must
	// keep a mark on the chord member it came from, not just on the chord.
	assertEqual(`${where} articulations`, actualNote.articulations.join(','), expectedNote.articulations.join(','));
	assertEqual(`${where} fermata`, actualNote.fermata, expectedNote.fermata);
	// Grace notes (M6 Slice 8): being one, and every attribute of one.
	assertEqual(`${where} grace`, graceKey(actualNote), graceKey(expectedNote));
	// Lyrics (M6 Slice 9), per head as written, in order, source included (so
	// a round trip that rewrote a `<lyric>`'s formatting is caught too).
	assertEqual(`${where} lyrics`, lyricsKey(actualNote.lyrics), lyricsKey(expectedNote.lyrics));
	assertEqual(`${where} passthrough`, notePayloadKey(actualNote.passthrough), notePayloadKey(expectedNote.passthrough));

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

// --- Passthrough payloads -------------------------------------------------

function assertMeasurePassthroughEquivalent(where: string, actual: Measure, expected: Measure): void {
	assertEqual(`${where} passthrough`, anchoredKeys(actual.passthrough), anchoredKeys(expected.passthrough));
	assertEqual(
		`${where} attributesPassthrough`,
		payloadListKey(actual.attributesPassthrough),
		payloadListKey(expected.attributesPassthrough)
	);
	assertEqual(
		`${where} barlinePassthrough`,
		payloadListKey(actual.barlinePassthrough),
		payloadListKey(expected.barlinePassthrough)
	);
}

function anchoredKeys(anchors: readonly MeasurePassthrough[]): string {
	return anchors
		.map(
			(a) =>
				`${a.lead ? 'lead' : `v${a.voice}@${a.onset.num}/${a.onset.den}`} ${opaqueElementKey(a.element, a.divisions)}`
		)
		.sort()
		.join('\n');
}

/**
 * A note's payload key, minus `<notations><tuplet>`: tuplet brackets are
 * presentation of `Note.tuplet` (compared above), like beams. Export writes a
 * source's brackets back verbatim but brackets a run the source left bare
 * itself, and a re-import keeps those as passthrough, so they may appear
 * without the music having changed.
 */
function notePayloadKey(elements: readonly OpaqueElement[]): string {
	const withoutBrackets: OpaqueElement[] = [];
	for (const el of elements) {
		if (el.name !== 'notations') {
			withoutBrackets.push(el);
			continue;
		}
		const rest = el.children.filter((c) => c.name !== 'tuplet');
		if (rest.length > 0) withoutBrackets.push({ ...el, children: rest });
	}
	return payloadListKey(withoutBrackets);
}

/** A payload list as a multiset: export writes payloads back in MusicXML's
 *  schema order (a `<notehead>` before a `<lyric>`, a `<score-instrument>`
 *  before a `<midi-instrument>`), which need not be the order a source file
 *  used, and nothing reads their relative order. */
function payloadListKey(elements: readonly OpaqueElement[] | undefined): string {
	return (elements ?? [])
		.map((el) => opaqueElementKey(el))
		.sort()
		.join('\n');
}

function partPassthroughKey(part: Part): string {
	return part.passthrough && part.passthrough.length > 0 ? ` +${payloadListKey(part.passthrough)}` : '';
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
		keys.add(`${sortedIndices(part.staffIndices)}::${part.name}${partPassthroughKey(part)}`);
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
		keys.add(`${sortedIndices(part.staffIndices)}::${symbol}${partPassthroughKey(part)}`);
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
