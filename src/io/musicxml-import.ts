// Turning a MusicXML `score-partwise` document back into the model.
//
// This is the second half of Phase 5's format bridge. Where `musicxml-export.ts`
// is fully specified (every model field maps to one known element), import is
// not: a real-world file, and especially one produced by Audiveris' optical
// music recognition, carries far more than this model can hold, and carries the
// parts it *can* hold in shapes that vary. So the contract here is narrow and
// deliberately lax at the edges:
//
//   - It round-trips everything `exportMusicXml` emits: `import(export(score))`
//     is musically equal to `score` (see `score-equivalence.ts` for exactly
//     what "musically equal" excludes, notably cross-staff beam linkage, which
//     export has no MusicXML representation for).
//   - It reads the same subset out of a hand-written or third-party file.
//   - Anything outside that subset is dropped. Known-irrelevant elements
//     (`<lyric>`, `<print>`, dynamics, articulations, ...) are dropped silently;
//     a genuinely unrecognized element name is `console.warn`ed once and then
//     ignored. The only hard errors are XML that is not well-formed and a
//     document whose root is not `<score-partwise>`.
//
// `<backup>` and `<forward>` are ignored for ordering. The model has no
// simultaneity to reconstruct: each `(staff, voice)` is a flat list whose notes'
// onsets are implied by cumulative duration, so bucketing every `<note>` by its
// `<staff>`/`<voice>` in document order is all the structure that is needed. A
// `<forward>` that carries a duration but no note (a rest gap some encoders
// write instead of an explicit `<note><rest/>`) is turned into a rest so the
// voice's later notes still land at the right offset; a `<backup>` is pure
// simultaneity bookkeeping and has nothing to contribute here.

import {
	Measure,
	NOTE_VALUE_WHOLES,
	Score,
	type ClefType,
	type NoteId,
	type NoteValue,
	type Pitch,
	type Step,
	type TimeSignature,
	type TupletRatio
} from '../model/index.js';
import { child, childText, children, descendants, parseXml, type XmlElement } from './xml.js';

/**
 * Parse a MusicXML `score-partwise` document into a `Score`.
 *
 * Throws if `xml` is not well-formed, or if its root element is not
 * `<score-partwise>` (a `<score-timewise>` document has to be converted to
 * partwise first; nothing here does that conversion).
 */
export function importMusicXml(xml: string): Score {
	const root = parseXml(xml);
	if (root.name !== 'score-partwise') {
		const hint =
			root.name === 'score-timewise'
				? ' (score-timewise is not supported; convert it to score-partwise first)'
				: '';
		throw new Error(`importMusicXml: expected a <score-partwise> root element, got <${root.name}>${hint}`);
	}

	const warned = new Set<string>();
	const warnOnce = (key: string, message: string): void => {
		if (warned.has(key)) return;
		warned.add(key);
		console.warn(message);
	};

	const score = new Score();

	// --- Part list: names and bracket/brace groupings -----------------------
	const partNameById = new Map<string, string>();
	const scorePartOrder: string[] = [];
	interface GroupSpan {
		readonly symbol: 'brace' | 'bracket';
		readonly firstScorePartIndex: number;
		readonly lastScorePartIndex: number;
	}
	const groupSpans: GroupSpan[] = [];
	const openGroups = new Map<string, { symbol: 'brace' | 'bracket'; firstScorePartIndex: number }>();

	const partListEl = child(root, 'part-list');
	if (partListEl) {
		for (const el of partListEl.children) {
			if (el.name === 'score-part') {
				const id = el.attrs.id ?? '';
				scorePartOrder.push(id);
				const name = childText(el, 'part-name');
				if (name !== undefined && name !== '') partNameById.set(id, name);
			} else if (el.name === 'part-group') {
				const number = el.attrs.number ?? '1';
				if (el.attrs.type === 'start') {
					const symbol: 'brace' | 'bracket' =
						childText(el, 'group-symbol') === 'brace' ? 'brace' : 'bracket';
					openGroups.set(number, { symbol, firstScorePartIndex: scorePartOrder.length });
				} else if (el.attrs.type === 'stop') {
					const open = openGroups.get(number);
					if (open) {
						openGroups.delete(number);
						groupSpans.push({
							symbol: open.symbol,
							firstScorePartIndex: open.firstScorePartIndex,
							lastScorePartIndex: scorePartOrder.length - 1
						});
					}
				}
			}
		}
	}

	// --- Staves: one Staff per <staves> count, clefs from the first <attributes> --
	interface PartInfo {
		readonly id: string;
		readonly baseStaffIndex: number;
		readonly staffCount: number;
		readonly divisions: number;
		readonly el: XmlElement;
	}
	const partEls = children(root, 'part');
	const partInfos: PartInfo[] = [];
	let nextStaffIndex = 0;

	for (const partEl of partEls) {
		const id = partEl.attrs.id ?? '';
		const firstAttrs = firstMeasureAttributes(partEl);
		const staffCount = Math.max(1, intText(firstAttrs && childText(firstAttrs, 'staves'), 1));
		const divisions = Math.max(1, intText(firstAttrs && childText(firstAttrs, 'divisions'), 1));
		const baseStaffIndex = nextStaffIndex;

		for (let k = 0; k < staffCount; k++) {
			// staves[0] already exists (the Score constructor makes it); every
			// other staff, across every part, is appended here.
			if (baseStaffIndex + k >= score.staves.length) score.appendStaff();
		}
		nextStaffIndex += staffCount;

		if (firstAttrs) {
			for (const clefEl of children(firstAttrs, 'clef')) {
				const k = Math.max(1, intText(clefEl.attrs.number, 1)) - 1;
				const staff = score.staves[baseStaffIndex + k];
				if (staff) staff.clef = mapClef(clefEl, warnOnce);
			}
		}

		partInfos.push({ id, baseStaffIndex, staffCount, divisions, el: partEl });
	}
	const partInfoById = new Map(partInfos.map((info) => [info.id, info]));

	// --- Score-global key / time / tempo ----------------------------------
	const firstPartInfo = partInfos[0];
	if (firstPartInfo) {
		const attrs = firstMeasureAttributes(firstPartInfo.el);
		const keyEl = attrs && child(attrs, 'key');
		const fifths = keyEl && childText(keyEl, 'fifths');
		if (fifths !== undefined && fifths !== null) score.keyFifths = intText(fifths, 0);
		const timeEl = attrs && child(attrs, 'time');
		const time = timeEl ? parseTime(timeEl) : undefined;
		if (time) score.time = time;
	}
	const tempo = findTempo(root);
	if (tempo !== undefined) score.tempoBpm = tempo;

	// --- Recreate the part grouping --------------------------------------
	// Same order the export writes it: every named <score-part> first (each an
	// addPart with its own staff indices), then every <part-group> span (an
	// unnamed addPart over every staff it covers). This reproduces a
	// showcase's `score.parts` shape exactly; `score-equivalence.ts` ignores
	// the synthetic "Part N" names export invents for unnamed staves, so
	// re-adding them here is harmless and keeps this loop rule-free.
	const staffIndicesOfScorePart = (scorePartIndex: number): number[] => {
		const info = partInfoById.get(scorePartOrder[scorePartIndex] ?? '');
		return info ? range(info.baseStaffIndex, info.staffCount) : [];
	};
	for (let i = 0; i < scorePartOrder.length; i++) {
		const name = partNameById.get(scorePartOrder[i]!);
		if (name !== undefined) score.addPart(staffIndicesOfScorePart(i), name);
	}
	for (const span of groupSpans) {
		const staffIndices: number[] = [];
		for (let i = span.firstScorePartIndex; i <= span.lastScorePartIndex; i++) {
			staffIndices.push(...staffIndicesOfScorePart(i));
		}
		staffIndices.sort((a, b) => a - b);
		if (staffIndices.length > 0) score.addPart(staffIndices);
	}

	// --- Measures, notes, barlines, key/time changes ---------------------
	const builtNotes: BuiltNoteRecord[] = [];

	for (const info of partInfos) {
		const measureEls = children(info.el, 'measure');
		const measureCount = measureEls.length;
		// `<divisions>` is normally stated once, in measure 0, but a tolerant
		// reader honours a later restatement too.
		let divisions = info.divisions;

		for (let m = 0; m < measureCount; m++) {
			const measureEl = measureEls[m]!;
			const isLastMeasure = m === measureCount - 1;

			// One Measure object per staff this part owns, at this column.
			const measureObjs: Measure[] = [];
			for (let k = 0; k < info.staffCount; k++) {
				measureObjs.push(score.appendMeasure(info.baseStaffIndex + k));
			}

			for (const attrs of children(measureEl, 'attributes')) {
				const restated = childText(attrs, 'divisions');
				if (restated !== undefined) divisions = Math.max(1, intText(restated, divisions));
				applyAttributeChanges(attrs, measureObjs, m, score, warnOnce);
			}

			for (const barlineEl of children(measureEl, 'barline')) {
				applyBarline(barlineEl, measureObjs, isLastMeasure);
			}

			// Notes and forward-gaps, in document order. `<backup>` is ignored.
			for (const el of measureEl.children) {
				if (el.name === 'note') {
					buildNote(el, info, measureObjs, divisions, builtNotes, score, warnOnce);
				} else if (el.name === 'forward') {
					synthesizeForwardRest(el, info, measureObjs, divisions, score, warnOnce);
				} else if (!KNOWN_MEASURE_CHILDREN.has(el.name)) {
					warnOnce(el.name, `importMusicXml: ignoring unrecognized <${el.name}> inside <measure>`);
				}
			}
		}
	}

	linkTies(builtNotes, score);
	linkSlurs(builtNotes, score);

	return score;
}

// --- Attributes: mid-score and per-part key/time changes ---------------------

/**
 * Apply a measure's `<attributes>` key/time/clef to the model.
 *
 * At measure 0 an `<attributes>` only records a *change* when its value differs
 * from the score-global one (this is how a per-staff key like the grand-staff
 * showcase's Eb-major bass under a D-major score comes back). At any later
 * measure, a `<key>`/`<time>` present at all is a change, recorded verbatim on
 * every staff of the part.
 *
 * A `<clef>` (M5 Slice 5) is per staff, addressed by its `number` attribute
 * (1-based within the part, default 1), and lands on just that staff's
 * `Measure.clef`. Measure 0's clefs are skipped here: the staves pass above
 * already set them as each `Staff.clef`, the staff's initial clef. The model
 * has no mid-measure clef position, so a `<clef>` between a measure's notes
 * applies to that whole measure, a documented simplification.
 */
function applyAttributeChanges(
	attrs: XmlElement,
	measureObjs: readonly Measure[],
	measureIndex: number,
	score: Score,
	warnOnce: WarnOnce
): void {
	if (measureIndex !== 0) {
		for (const clefEl of children(attrs, 'clef')) {
			const k = Math.max(1, intText(clefEl.attrs.number, 1)) - 1;
			const measure = measureObjs[k];
			if (measure) measure.clef = mapClef(clefEl, warnOnce);
		}
	}
	const keyEl = child(attrs, 'key');
	if (keyEl) {
		const fifthsText = childText(keyEl, 'fifths');
		if (fifthsText !== undefined) {
			const fifths = intText(fifthsText, 0);
			if (measureIndex !== 0 || fifths !== score.keyFifths) {
				for (const measure of measureObjs) measure.keyFifths = fifths;
			}
		}
	}
	const timeEl = child(attrs, 'time');
	if (timeEl) {
		const time = parseTime(timeEl);
		if (time && (measureIndex !== 0 || !timeSignaturesEqual(time, score.time))) {
			for (const measure of measureObjs) measure.time = time;
		}
	}
}

// --- Barlines --------------------------------------------------------------

/**
 * Map a `<barline>` onto `Measure.startBarline` / `Measure.endBarline`.
 *
 * A right-side `light-heavy` with no repeat is a `'final'` barline, but only
 * when it is *not* the staff's last measure: the model leaves the last
 * measure's `endBarline` unset and `Score.endBarlineAt` defaults it to
 * `'final'`, so writing it explicitly there would make an otherwise-equal
 * round-trip compare unequal.
 */
function applyBarline(barlineEl: XmlElement, measureObjs: readonly Measure[], isLastMeasure: boolean): void {
	const location = barlineEl.attrs.location ?? 'right';
	const repeatDirection = child(barlineEl, 'repeat')?.attrs.direction;
	const barStyle = childText(barlineEl, 'bar-style');

	if (location === 'left') {
		if (repeatDirection === 'forward') {
			for (const measure of measureObjs) measure.startBarline = 'repeatStart';
		}
		return;
	}

	if (barStyle === 'light-light') {
		for (const measure of measureObjs) measure.endBarline = 'double';
	} else if (barStyle === 'light-heavy' && repeatDirection === 'backward') {
		for (const measure of measureObjs) measure.endBarline = 'repeatEnd';
	} else if (barStyle === 'light-heavy' && !isLastMeasure) {
		for (const measure of measureObjs) measure.endBarline = 'final';
	}
}

// --- Notes --------------------------------------------------------------

const KNOWN_MEASURE_CHILDREN: ReadonlySet<string> = new Set([
	'note',
	'attributes',
	'barline',
	'direction',
	'backup',
	'forward',
	'print',
	'sound',
	'harmony',
	'figured-bass',
	'grouping',
	'link',
	'bookmark',
	'listening'
]);

const KNOWN_NOTE_CHILDREN: ReadonlySet<string> = new Set([
	'pitch',
	'rest',
	'unpitched',
	'duration',
	'tie',
	'voice',
	'type',
	'dot',
	'time-modification',
	'stem',
	'staff',
	'beam',
	'notations',
	'grace',
	'chord',
	'accidental',
	'lyric',
	'notehead',
	'cue',
	'instrument',
	'play',
	'listen',
	'footnote',
	'level'
]);

const NOTE_VALUES: readonly NoteValue[] = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th'];

function buildNote(
	noteEl: XmlElement,
	info: { baseStaffIndex: number; staffCount: number },
	measureObjs: readonly Measure[],
	divisions: number,
	builtNotes: BuiltNoteRecord[],
	score: Score,
	warnOnce: WarnOnce
): void {
	// The model has neither grace notes nor chords, so a note carrying either
	// marker is dropped whole. `<grace>` is a known, silent drop; `<chord>` is
	// rarer here and worth a one-time note.
	if (child(noteEl, 'grace')) return;
	if (child(noteEl, 'chord')) {
		warnOnce('chord', 'importMusicXml: <chord> is not representable in this model; dropping the chord note');
		return;
	}

	const staffNumber = Math.max(1, intText(childText(noteEl, 'staff'), 1));
	const k = Math.min(staffNumber - 1, measureObjs.length - 1);
	const targetMeasure = measureObjs[k] ?? measureObjs[0];
	if (!targetMeasure) return;
	const globalStaffIndex = info.baseStaffIndex + k;
	const voice = Math.max(1, intText(childText(noteEl, 'voice'), 1));

	let pitch: Pitch | null = null;
	if (!child(noteEl, 'rest')) {
		const pitchEl = child(noteEl, 'pitch');
		if (pitchEl) {
			pitch = {
				step: (childText(pitchEl, 'step') ?? 'C') as Step,
				alter: Number.parseFloat(childText(pitchEl, 'alter') ?? '0') || 0,
				octave: intText(childText(pitchEl, 'octave'), 4)
			};
		}
	}

	const timeModEl = child(noteEl, 'time-modification');
	let tuplet: TupletRatio | undefined;
	if (timeModEl) {
		const actualNotes = intText(childText(timeModEl, 'actual-notes'), 1);
		const normalNotes = intText(childText(timeModEl, 'normal-notes'), 1);
		if (actualNotes !== normalNotes) tuplet = { actualNotes, normalNotes };
	}

	const dots = Math.min(2, children(noteEl, 'dot').length) as 0 | 1 | 2;

	const typeText = childText(noteEl, 'type');
	const value =
		typeText !== undefined && isNoteValue(typeText)
			? typeText
			: deriveValueFromDuration(childText(noteEl, 'duration'), divisions, tuplet, dots, warnOnce);

	const note = score.appendNote(targetMeasure, { pitch, value, voice, dots, tuplet });

	// Tie state: `<tie>` is authoritative; fall back to `<notations><tied>`
	// only when there is no `<tie>` at all.
	let tieStart = false;
	let tieStop = false;
	const tieEls = children(noteEl, 'tie');
	const notationsEl = child(noteEl, 'notations');
	if (tieEls.length > 0) {
		tieStart = tieEls.some((t) => t.attrs.type === 'start');
		tieStop = tieEls.some((t) => t.attrs.type === 'stop');
	} else if (notationsEl) {
		for (const tied of children(notationsEl, 'tied')) {
			if (tied.attrs.type === 'start') tieStart = true;
			if (tied.attrs.type === 'stop') tieStop = true;
		}
	}

	const slurStarts: number[] = [];
	const slurStops: number[] = [];
	if (notationsEl) {
		for (const slur of children(notationsEl, 'slur')) {
			const number = intText(slur.attrs.number, 1);
			if (slur.attrs.type === 'start') slurStarts.push(number);
			else if (slur.attrs.type === 'stop') slurStops.push(number);
		}
	}

	builtNotes.push({
		id: note.id,
		staffIndex: globalStaffIndex,
		voice,
		pitch,
		tieStart,
		tieStop,
		slurStarts,
		slurStops
	});

	for (const c of noteEl.children) {
		if (!KNOWN_NOTE_CHILDREN.has(c.name)) {
			warnOnce(c.name, `importMusicXml: ignoring unrecognized <${c.name}> inside <note>`);
		}
	}
}

/**
 * A `<forward>` with a duration but no note: a rest gap in the current voice.
 * Synthesized as a real rest so the voice's later notes keep their offset.
 * Anything whose duration does not map to a note value (with dots) falls back
 * to a quarter rest via `deriveValueFromDuration`, which warns once.
 */
function synthesizeForwardRest(
	forwardEl: XmlElement,
	info: { baseStaffIndex: number; staffCount: number },
	measureObjs: readonly Measure[],
	divisions: number,
	score: Score,
	warnOnce: WarnOnce
): void {
	const durationText = childText(forwardEl, 'duration');
	if (durationText === undefined) return;
	const staffNumber = Math.max(1, intText(childText(forwardEl, 'staff'), 1));
	const k = Math.min(staffNumber - 1, measureObjs.length - 1);
	const targetMeasure = measureObjs[k] ?? measureObjs[0];
	if (!targetMeasure) return;
	const voice = Math.max(1, intText(childText(forwardEl, 'voice'), 1));
	const value = deriveValueFromDuration(durationText, divisions, undefined, 0, warnOnce);
	score.appendNote(targetMeasure, { pitch: null, value, voice, dots: 0 });
}

// --- Ties and slurs, resolved once every note exists ----------------------

type BuiltNoteRecord = {
	readonly id: NoteId;
	readonly staffIndex: number;
	readonly voice: number;
	readonly pitch: Pitch | null;
	readonly tieStart: boolean;
	readonly tieStop: boolean;
	readonly slurStarts: readonly number[];
	readonly slurStops: readonly number[];
};
type WarnOnce = (key: string, message: string) => void;

/**
 * For every note that starts a tie, find the next note in the same staff and
 * voice with an equal pitch that carries a tie-stop, and wire the two through
 * `Score.setTie`. Mirrors `buildScore`'s forward-resolution loop.
 */
function linkTies(builtNotes: readonly BuiltNoteRecord[], score: Score): void {
	for (let i = 0; i < builtNotes.length; i++) {
		const source = builtNotes[i]!;
		if (!source.tieStart || source.pitch === null) continue;
		for (let j = i + 1; j < builtNotes.length; j++) {
			const candidate = builtNotes[j]!;
			if (candidate.staffIndex !== source.staffIndex || candidate.voice !== source.voice) continue;
			if (candidate.pitch === null || !pitchesMatch(candidate.pitch, source.pitch)) continue;
			if (!candidate.tieStop) continue;
			score.setTie(source.id, candidate.id);
			break;
		}
	}
}

/**
 * Pair `<slur type="start">`/`<slur type="stop">` by their `number`, per staff,
 * with a stack per number (so a reused or nested number still pairs
 * innermost-first), and hand each pair to `Score.addSlur`.
 */
function linkSlurs(builtNotes: readonly BuiltNoteRecord[], score: Score): void {
	for (let staffIndex = 0; staffIndex < score.staves.length; staffIndex++) {
		const stackByNumber = new Map<number, NoteId[]>();
		for (const note of builtNotes) {
			if (note.staffIndex !== staffIndex) continue;
			// Stops before starts on the same note: a note can close one slur and
			// open another under the same number.
			for (const number of note.slurStops) {
				const stack = stackByNumber.get(number);
				const startId = stack && stack.pop();
				if (startId !== undefined) score.addSlur(startId, note.id);
			}
			for (const number of note.slurStarts) {
				const stack = stackByNumber.get(number) ?? [];
				stack.push(note.id);
				stackByNumber.set(number, stack);
			}
		}
	}
}

// --- Small parsers / helpers -------------------------------------------------

const CLEF_SIGNATURES: ReadonlyArray<{
	readonly sign: string;
	readonly line: string;
	readonly octaveChange?: string;
	readonly clef: ClefType;
}> = [
	{ sign: 'G', line: '2', clef: 'treble' },
	{ sign: 'G', line: '2', octaveChange: '-1', clef: 'treble8' },
	{ sign: 'F', line: '4', clef: 'bass' }
];

function mapClef(clefEl: XmlElement, warnOnce: WarnOnce): ClefType {
	const sign = childText(clefEl, 'sign') ?? '';
	const line = childText(clefEl, 'line') ?? '';
	const octaveChange = childText(clefEl, 'clef-octave-change');
	const normalizedOctave = octaveChange === undefined || octaveChange === '0' ? undefined : octaveChange;
	for (const candidate of CLEF_SIGNATURES) {
		if (candidate.sign === sign && candidate.line === line && candidate.octaveChange === normalizedOctave) {
			return candidate.clef;
		}
	}
	warnOnce(
		`clef:${sign}/${line}/${octaveChange ?? ''}`,
		`importMusicXml: unrecognized clef <sign>${sign}</sign><line>${line}</line>; defaulting to treble`
	);
	return 'treble';
}

function parseTime(timeEl: XmlElement): TimeSignature | undefined {
	const beatsText = childText(timeEl, 'beats');
	const beatTypeText = childText(timeEl, 'beat-type');
	if (beatsText === undefined || beatTypeText === undefined) return undefined;
	const beats = Number.parseInt(beatsText, 10);
	const beatType = Number.parseInt(beatTypeText, 10);
	if (!Number.isFinite(beats) || !Number.isFinite(beatType) || beatType <= 0) return undefined;
	return { beats, beatType };
}

/**
 * The tempo, in quarter-note BPM, from the first `<metronome><per-minute>`
 * anywhere in the document, or failing that the first `<sound tempo="...">`.
 * First one found wins; `undefined` if the document states none.
 */
function findTempo(root: XmlElement): number | undefined {
	for (const metronome of descendants(root, 'metronome')) {
		const perMinute = childText(metronome, 'per-minute');
		if (perMinute !== undefined) {
			const bpm = Number.parseFloat(perMinute);
			if (Number.isFinite(bpm)) return bpm;
		}
	}
	for (const sound of descendants(root, 'sound')) {
		if (sound.attrs.tempo !== undefined) {
			const bpm = Number.parseFloat(sound.attrs.tempo);
			if (Number.isFinite(bpm)) return bpm;
		}
	}
	return undefined;
}

/**
 * Recover a `NoteValue` for a `<note>` that has no `<type>` (a tolerant path;
 * every file `exportMusicXml` writes carries `<type>`). `durationWholes` is
 * `duration / (divisions * 4)`, un-scaled by any tuplet ratio, and the value
 * whose dotted duration matches within 1e-6 wins. Nothing matching means a
 * warn-once and a `quarter` fallback.
 */
function deriveValueFromDuration(
	durationText: string | undefined,
	divisions: number,
	tuplet: TupletRatio | undefined,
	dots: 0 | 1 | 2,
	warnOnce: WarnOnce
): NoteValue {
	if (durationText !== undefined && divisions > 0) {
		let wholes = Number.parseFloat(durationText) / (divisions * 4);
		if (Number.isFinite(wholes)) {
			if (tuplet) wholes *= tuplet.actualNotes / tuplet.normalNotes;
			const dotMultiplier = 2 - 2 ** -dots;
			for (const value of NOTE_VALUES) {
				if (Math.abs(NOTE_VALUE_WHOLES[value] * dotMultiplier - wholes) < 1e-6) return value;
			}
		}
	}
	warnOnce(
		'note-value-fallback',
		'importMusicXml: a <note> had no <type> and no duration that maps to a note value; using quarter'
	);
	return 'quarter';
}

function isNoteValue(text: string): text is NoteValue {
	return (NOTE_VALUES as readonly string[]).includes(text);
}

function pitchesMatch(a: Pitch, b: Pitch): boolean {
	return a.step === b.step && a.alter === b.alter && a.octave === b.octave;
}

function timeSignaturesEqual(a: TimeSignature, b: TimeSignature): boolean {
	return a.beats === b.beats && a.beatType === b.beatType;
}

function intText(text: string | null | undefined, fallback: number): number {
	if (text === undefined || text === null) return fallback;
	const parsed = Number.parseInt(text, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function range(start: number, count: number): number[] {
	return Array.from({ length: count }, (_, i) => start + i);
}

function firstMeasureAttributes(partEl: XmlElement): XmlElement | undefined {
	const firstMeasure = child(partEl, 'measure');
	return firstMeasure ? child(firstMeasure, 'attributes') : undefined;
}
