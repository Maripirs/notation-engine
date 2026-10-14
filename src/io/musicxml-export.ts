// Turning the model into a MusicXML `score-partwise` document.
//
// This is the first half of Phase 5's format bridge: the model is the source
// of truth and every field it carries maps to a known MusicXML element, so
// export is fully specified in a way import is not. Getting it in first also
// gives import a round-trip oracle (`import(export(fixture))` should match
// `fixture`) rather than import being checked only against hand-written XML.
//
// The `io` layer depends only on `model`, the same one-way layering `playback`
// already follows: no canvas, no layout geometry, no DOM. The one deliberate,
// reviewed exception is the four imports from `../layout/index.js` below
// (`computeBeamGroups`, `stemDirectionForNotes`, `middleLineForClef`,
// `BeamGroup`). Those are pure model-to-data functions: they take notes and a
// middle-line reference number and return beam runs and a stem direction, with
// no pixels or `ss` anywhere in sight. MusicXML's `<beam>` and `<stem>`
// elements need exactly that grouping and that direction, and the beam-break
// rule (a rest or a beat boundary ends a run) is subtle enough that a second
// copy of it here would be strictly worse than sharing the one in `layout.ts`:
// the two could drift, and a reader chasing "why did this note beam" would have
// two rules to check instead of one.
//
// The output is built as an array of already-indented lines through a small
// internal `XmlBuilder`, and pretty-printed with a two-space indent because a
// human reads these files (in a diff, or when a fixture assertion fails) as
// often as MuseScore or Verovio does. Text and attribute values are escaped;
// nothing else about the model can produce a character that needs it today,
// but emitting unescaped `&`/`<` into a format whose whole point is being
// portable would be a latent corruption waiting for the first part named
// "Trumpet & Horn".

import {
	diatonicIndex,
	measureCapacityWholes,
	type ClefType,
	type Note,
	type NoteId,
	type NoteValue,
	type Part,
	type Score,
	type TimeSignature
} from '../model/index.js';
import {
	computeBeamGroups,
	middleLineForClef,
	stemDirectionForNotes,
	type BeamGroup
} from '../layout/index.js';

/**
 * Serialize `score` as a MusicXML 4.0 `score-partwise` document.
 *
 * Covers everything the model can currently represent: the emitted parts and
 * their staves, per-staff clefs, initial and mid-score key/time signatures,
 * `tempoBpm` as a metronome direction, notes and rests with
 * `<type>`/`<dot>`/`<time-modification>`, computed `<beam>` and `<stem>`,
 * `<tie>`/`<tied>` and `<slur>` spans, `<staff>` numbers for multi-staff
 * parts, and all five barline shapes. `<divisions>` is one value per part, the
 * LCM of every note's exact duration denominator in that part, so every
 * `<duration>` comes out a whole number.
 */
export function exportMusicXml(score: Score): string {
	const xml = new XmlBuilder();
	xml.raw('<?xml version="1.0" encoding="UTF-8"?>');
	xml.raw(
		'<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" ' +
			'"http://www.musicxml.org/dtds/partwise.dtd">'
	);
	xml.open('score-partwise', { version: '4.0' });

	const emitted = planEmittedParts(score);
	const groups = planPartGroups(score, emitted);

	writePartList(xml, emitted, groups);
	for (let partIndex = 0; partIndex < emitted.length; partIndex++) {
		writePart(xml, score, emitted, partIndex);
	}

	xml.close('score-partwise');
	return xml.toString();
}

// --- Part normalization -----------------------------------------------------

/**
 * One `<part>` this export actually emits, after normalizing `score.parts`
 * (a loose visual-grouping structure) into an instrument-list shape.
 *
 * `staffIndices` is ascending and is every staff this one `<part>` speaks for:
 * a named model `Part` spanning two staves becomes one `EmittedPart` with both,
 * emitted once at its lowest staff index, not two.
 */
interface EmittedPart {
	readonly id: string;
	readonly name: string;
	readonly staffIndices: readonly number[];
}

/**
 * Walk staves `0..N-1` and assign each to exactly one emitted `<part>`: the
 * first named model `Part` whose `staffIndices` include it, or a synthetic
 * single-staff part when no named model part covers it. A named model part
 * with several staves is emitted once, at its lowest staff index, carrying all
 * of them.
 *
 * Part ids are `P1`, `P2`, ... in emission order. Synthetic parts are named
 * `Part 1`, `Part 2`, ... counting only the synthetic ones, so a score with
 * one named and one unnamed staff gets `Soprano` then `Part 1`, not `Part 2`.
 */
function planEmittedParts(score: Score): EmittedPart[] {
	const emitted: EmittedPart[] = [];
	const staffToPartIndex = new Map<number, number>();
	let syntheticCount = 0;

	for (let staffIndex = 0; staffIndex < score.staves.length; staffIndex++) {
		if (staffToPartIndex.has(staffIndex)) continue;
		const named = score.parts.find(
			(part) => part.name !== undefined && part.name !== '' && part.staffIndices.includes(staffIndex)
		);
		const id = `P${emitted.length + 1}`;
		if (named) {
			const staffIndices = [...named.staffIndices].sort((a, b) => a - b);
			emitted.push({ id, name: named.name!, staffIndices });
			for (const covered of staffIndices) {
				if (!staffToPartIndex.has(covered)) staffToPartIndex.set(covered, emitted.length - 1);
			}
		} else {
			syntheticCount++;
			emitted.push({ id, name: `Part ${syntheticCount}`, staffIndices: [staffIndex] });
			staffToPartIndex.set(staffIndex, emitted.length - 1);
		}
	}
	return emitted;
}

/** A `<part-group>` bracket/brace wrapping a contiguous run of emitted parts. */
interface PartGroupPlan {
	readonly number: number;
	readonly symbol: 'brace' | 'bracket';
	readonly firstEmittedIndex: number;
	readonly lastEmittedIndex: number;
}

/**
 * Which model `Part`s become a `<part-group>` rather than an emitted `<part>`:
 * any with two or more `staffIndices` that is not itself one of the emitted
 * parts (i.e. it is unnamed, or it spans staves belonging to more than one
 * emitted part). A model part with fewer than two staves is not a grouping at
 * all and is skipped.
 *
 * `symbol` replicates the one-liner `computePartGroupDecorations` in
 * `layout.ts` uses: exactly two staves reads as a keyboard pair and gets
 * `brace`, three or more reads as an ensemble group and gets `bracket`. That
 * function is not exported or reused here on purpose: it also returns pixel
 * geometry this layer has no business seeing, and the rule itself is one line.
 */
function planPartGroups(score: Score, emitted: readonly EmittedPart[]): PartGroupPlan[] {
	const emittedStaffSets = emitted.map((part) => new Set(part.staffIndices));
	// A model part is "one of the emitted parts" when some emitted part covers
	// exactly the same staves it does.
	const isEmitted = (part: Part): boolean => {
		const wanted = [...part.staffIndices].sort((a, b) => a - b).join(',');
		return emitted.some((e) => [...e.staffIndices].sort((a, b) => a - b).join(',') === wanted);
	};

	const groups: PartGroupPlan[] = [];
	for (const part of score.parts) {
		if (part.staffIndices.length < 2) continue;
		if (isEmitted(part)) continue;
		const coveredIndices: number[] = [];
		for (let i = 0; i < emittedStaffSets.length; i++) {
			if (part.staffIndices.some((staffIndex) => emittedStaffSets[i]!.has(staffIndex))) {
				coveredIndices.push(i);
			}
		}
		if (coveredIndices.length === 0) continue;
		groups.push({
			number: groups.length + 1,
			symbol: part.staffIndices.length === 2 ? 'brace' : 'bracket',
			firstEmittedIndex: coveredIndices[0]!,
			lastEmittedIndex: coveredIndices[coveredIndices.length - 1]!
		});
	}
	return groups;
}

function writePartList(
	xml: XmlBuilder,
	emitted: readonly EmittedPart[],
	groups: readonly PartGroupPlan[]
): void {
	xml.open('part-list');
	for (let i = 0; i < emitted.length; i++) {
		for (const group of groups) {
			if (group.firstEmittedIndex === i) {
				xml.open('part-group', { type: 'start', number: String(group.number) });
				xml.leaf('group-symbol', group.symbol);
				xml.close('part-group');
			}
		}
		xml.open('score-part', { id: emitted[i]!.id });
		xml.leaf('part-name', emitted[i]!.name);
		xml.close('score-part');
		for (const group of groups) {
			if (group.lastEmittedIndex === i) {
				xml.selfClose('part-group', { type: 'stop', number: String(group.number) });
			}
		}
	}
	xml.close('part-list');
}

// --- Per-part music -------------------------------------------------------

function writePart(
	xml: XmlBuilder,
	score: Score,
	emitted: readonly EmittedPart[],
	partIndex: number
): void {
	const part = emitted[partIndex]!;
	const isFirstPart = partIndex === 0;
	const partStaves = part.staffIndices;
	const multiStaff = partStaves.length > 1;
	const firstStaffIndex = partStaves[0]!;

	// `<divisions>` is per part, so it is the LCM of every note's denominator
	// across every staff and every measure this part owns.
	const everyNote: Note[] = [];
	for (const staffIndex of partStaves) {
		for (const measure of score.staves[staffIndex]!.measures) everyNote.push(...measure.notes);
	}
	const divisions = divisionsForNotes(everyNote);
	const measureCount = score.staves[firstStaffIndex]!.measures.length;

	xml.open('part', { id: part.id });
	for (let m = 0; m < measureCount; m++) {
		xml.open('measure', { number: String(m + 1) });

		// A repeat-start barline is conventionally attached to the measure it
		// opens (MusicXML's `<barline location="left">`), and the model keeps it
		// on `Measure.startBarline` for the same reason, so it leads the measure.
		if (score.staves[firstStaffIndex]!.measures[m]!.startBarline === 'repeatStart') {
			xml.open('barline', { location: 'left' });
			xml.leaf('bar-style', 'heavy-light');
			xml.selfClose('repeat', { direction: 'forward' });
			xml.close('barline');
		}

		writeMeasureAttributes(xml, score, part, m, divisions, multiStaff);

		// The metronome mark rides in the very first measure of the very first
		// part only: it is a score-wide value with no per-part or per-measure
		// form in the model.
		if (isFirstPart && m === 0) {
			xml.open('direction', { placement: 'above' });
			xml.open('direction-type');
			xml.open('metronome');
			xml.leaf('beat-unit', 'quarter');
			xml.leaf('per-minute', String(score.tempoBpm));
			xml.close('metronome');
			xml.close('direction-type');
			xml.selfClose('sound', { tempo: String(score.tempoBpm) });
			xml.close('direction');
		}

		writeMeasureNotes(xml, score, partStaves, m, divisions, multiStaff);

		writeRightBarline(xml, score.endBarlineAt(m, firstStaffIndex));
		xml.close('measure');
	}
	xml.close('part');
}

/**
 * The `<attributes>` block, if this measure needs one. Measure 0 always does
 * (divisions, key, time, `<staves>` for a multi-staff part, one `<clef>` per
 * staff, in that DTD-mandated order). A later measure gets a fresh, minimal
 * `<attributes>` only when its own model object carries a key and/or time
 * change, or any of the part's staves changes clef here (M5 Slice 5), and
 * then only the changed elements: no divisions, and a `<clef>` only for the
 * staves whose clef actually changed.
 */
function writeMeasureAttributes(
	xml: XmlBuilder,
	score: Score,
	part: EmittedPart,
	m: number,
	divisions: number,
	multiStaff: boolean
): void {
	const firstStaffIndex = part.staffIndices[0]!;

	if (m === 0) {
		xml.open('attributes');
		xml.leaf('divisions', String(divisions));
		xml.open('key');
		xml.leaf('fifths', String(score.keyFifthsAt(0, firstStaffIndex)));
		xml.close('key');
		const time = score.timeAt(0, firstStaffIndex);
		xml.open('time');
		xml.leaf('beats', String(time.beats));
		xml.leaf('beat-type', String(time.beatType));
		xml.close('time');
		if (multiStaff) xml.leaf('staves', String(part.staffIndices.length));
		for (let k = 0; k < part.staffIndices.length; k++) {
			writeClef(xml, score.clefAt(0, part.staffIndices[k]!), k + 1);
		}
		xml.close('attributes');
		return;
	}

	// Mid-score change: read the measure object directly off the part's first
	// staff. A change is `!== undefined`; the walk-back accessors are for
	// "what is in force here", which is not the question at a change boundary.
	const measure = score.staves[firstStaffIndex]!.measures[m]!;
	// Clef changes (M5 Slice 5) are per staff, unlike key/time, so every staff
	// of the part is checked, each against its own previous measure's
	// *resolved* clef: a `setClefRange` restore at `to + 1` writes an explicit
	// clef equal to what was already in force, which is no change at all and
	// emits nothing.
	const clefChanges: { readonly clef: ClefType; readonly number: number }[] = [];
	for (let k = 0; k < part.staffIndices.length; k++) {
		const staffIndex = part.staffIndices[k]!;
		const clef = score.clefAt(m, staffIndex);
		if (clef !== score.clefAt(m - 1, staffIndex)) clefChanges.push({ clef, number: k + 1 });
	}
	if (measure.keyFifths === undefined && measure.time === undefined && clefChanges.length === 0) return;
	xml.open('attributes');
	if (measure.keyFifths !== undefined) {
		xml.open('key');
		xml.leaf('fifths', String(measure.keyFifths));
		xml.close('key');
	}
	if (measure.time !== undefined) {
		xml.open('time');
		xml.leaf('beats', String(measure.time.beats));
		xml.leaf('beat-type', String(measure.time.beatType));
		xml.close('time');
	}
	for (const change of clefChanges) writeClef(xml, change.clef, change.number);
	xml.close('attributes');
}

const CLEF_MARKUP: Readonly<
	Record<ClefType, { readonly sign: string; readonly line: number; readonly octaveChange?: number }>
> = {
	treble: { sign: 'G', line: 2 },
	bass: { sign: 'F', line: 4 },
	treble8: { sign: 'G', line: 2, octaveChange: -1 }
};

function writeClef(xml: XmlBuilder, clef: ClefType, number: number): void {
	const markup = CLEF_MARKUP[clef];
	xml.open('clef', { number: String(number) });
	xml.leaf('sign', markup.sign);
	xml.leaf('line', String(markup.line));
	if (markup.octaveChange !== undefined) {
		xml.leaf('clef-octave-change', String(markup.octaveChange));
	}
	xml.close('clef');
}

/**
 * One measure column's note streams. For every `(staff, voice)` pair in the
 * part, in staff order then first-seen voice order, emit that stream's notes;
 * before every stream except the very first, emit a `<backup>` of the full
 * measure so the next stream starts back at the downbeat. That one rule covers
 * both a single staff's extra voices and a multi-staff part's second staff,
 * and composes if a part ever has both at once (no current fixture does).
 */
function writeMeasureNotes(
	xml: XmlBuilder,
	score: Score,
	partStaves: readonly number[],
	m: number,
	divisions: number,
	multiStaff: boolean
): void {
	let firstStream = true;
	for (let k = 0; k < partStaves.length; k++) {
		const staffIndex = partStaves[k]!;
		const staff = score.staves[staffIndex]!;
		const measure = staff.measures[m]!;
		const time = score.timeAt(m, staffIndex);
		const fullMeasureDuration = Math.round(measureCapacityWholes(time) * 4 * divisions);
		const middleLine = middleLineForClef(score.clefAt(m, staffIndex));

		for (const [, voiceNotes] of groupNotesByVoice(measure.notes)) {
			if (!firstStream) {
				xml.open('backup');
				xml.leaf('duration', String(fullMeasureDuration));
				xml.close('backup');
			}
			firstStream = false;

			const beamPlan = buildBeamPlan(voiceNotes, time, middleLine);
			for (let ni = 0; ni < voiceNotes.length; ni++) {
				writeNote(xml, score, voiceNotes, ni, {
					divisions,
					multiStaff,
					staffNumber: k + 1,
					middleLine,
					beamPlan
				});
			}
		}
	}
}

/** Group a measure's notes by `note.voice`, first-seen order preserved, each
 *  voice's own notes kept in their original relative order. Mirrors
 *  `notesByVoice` in `layout.ts`; not imported from there because that one is a
 *  private layout helper and this rule is three lines. */
function groupNotesByVoice(notes: readonly Note[]): Map<number, Note[]> {
	const byVoice = new Map<number, Note[]>();
	for (const note of notes) {
		const list = byVoice.get(note.voice);
		if (list) list.push(note);
		else byVoice.set(note.voice, [note]);
	}
	return byVoice;
}

interface BeamMembership {
	readonly position: 'begin' | 'continue' | 'end';
	readonly direction: 'up' | 'down';
}

/**
 * Per note id, its place in a beam group for this measure/voice, if any.
 *
 * `computeBeamGroups` (layout's own beam-break rule, shared here on purpose,
 * see this file's header) returns runs of two or more notes; the first member
 * emits `<beam number="1">begin</beam>`, the last `end`, everything between
 * `continue`. Only the primary beam is emitted: a secondary `<beam
 * number="2">` over, say, two 16ths inside an eighth group is a documented
 * simplification for this slice, the same call this repo makes elsewhere for
 * beam levels it does not yet draw.
 */
function buildBeamPlan(
	voiceNotes: readonly Note[],
	time: TimeSignature,
	middleLine: number
): Map<NoteId, BeamMembership> {
	const plan = new Map<NoteId, BeamMembership>();
	const groups: readonly BeamGroup[] = computeBeamGroups(voiceNotes, time, middleLine);
	for (const group of groups) {
		group.notes.forEach((note, i) => {
			const position = i === 0 ? 'begin' : i === group.notes.length - 1 ? 'end' : 'continue';
			plan.set(note.id, { position, direction: group.direction });
		});
	}
	return plan;
}

interface NoteContext {
	readonly divisions: number;
	readonly multiStaff: boolean;
	readonly staffNumber: number;
	readonly middleLine: number;
	readonly beamPlan: Map<NoteId, BeamMembership>;
}

/**
 * One `<note>`. MusicXML fixes the child order and it is not the order a reader
 * would guess, so the sequence below is deliberate and load-bearing:
 * pitch-or-rest, duration, `<tie>` (the sounding element), voice, type, dots,
 * time-modification, stem, staff, beam, then `<notations>` (the visual
 * elements, `<tied>`/`<tuplet>`/`<slur>`). Anything absent is simply skipped.
 */
function writeNote(
	xml: XmlBuilder,
	score: Score,
	voiceNotes: readonly Note[],
	ni: number,
	ctx: NoteContext
): void {
	const note = voiceNotes[ni]!;
	const previous = ni > 0 ? voiceNotes[ni - 1] : undefined;
	const next = ni < voiceNotes.length - 1 ? voiceNotes[ni + 1] : undefined;

	xml.open('note');

	if (note.pitch === null) {
		// A whole-measure rest (M6 Slice 1) says so, so a reader fills the bar
		// with it whatever the time signature, rather than trusting a `<type>`.
		xml.selfClose('rest', note.isMeasureRest ? { measure: 'yes' } : undefined);
	} else {
		xml.open('pitch');
		xml.leaf('step', note.pitch.step);
		if (note.pitch.alter !== 0) xml.leaf('alter', String(note.pitch.alter));
		xml.leaf('octave', String(note.pitch.octave));
		xml.close('pitch');
	}

	const quarters = noteDurationQuarters(note);
	xml.leaf('duration', String((quarters.num * ctx.divisions) / quarters.den));

	const tiedInto = score.tiedFromNote(note.id) !== undefined;
	if (tiedInto) xml.selfClose('tie', { type: 'stop' });
	if (note.tiedToId !== null) xml.selfClose('tie', { type: 'start' });

	xml.leaf('voice', String(note.voice));
	// `NoteValue` and MusicXML's `<type>` names coincide exactly, rests
	// included: a real file carries `<type>` on a rest too, so this does not
	// special-case them. The one exception is a whole-measure rest: its
	// `value` is a drawing convention (`'whole'`), not its length, so writing
	// `<type>whole</type>` into a 3/4 bar would state a duration the
	// `<duration>` contradicts. MusicXML makes `<type>` optional for exactly
	// this case, and MuseScore omits it too.
	if (!note.isMeasureRest) xml.leaf('type', note.value);
	for (let d = 0; d < note.dots; d++) xml.selfClose('dot');

	if (note.tuplet) {
		xml.open('time-modification');
		xml.leaf('actual-notes', String(note.tuplet.actualNotes));
		xml.leaf('normal-notes', String(note.tuplet.normalNotes));
		xml.close('time-modification');
	}

	// No stem on a rest or a whole note; a beamed note takes its group's shared
	// direction, everything else the ordinary pitch-vs-middle-line rule.
	if (note.pitch !== null && note.value !== 'whole') {
		const membership = ctx.beamPlan.get(note.id);
		const direction = membership
			? membership.direction
			: stemDirectionForNotes([diatonicIndex(note.pitch)], ctx.middleLine);
		xml.leaf('stem', direction);
	}

	if (ctx.multiStaff) xml.leaf('staff', String(ctx.staffNumber));

	const membership = ctx.beamPlan.get(note.id);
	if (membership) xml.leaf('beam', membership.position, { number: '1' });

	// A tuplet "run" is consecutive same-voice, same-measure notes each with a
	// `tuplet` set; the run's first note starts it and its last stops it. A
	// lone tupleted note is a run of one and carries both.
	const tupletRunStart = note.tuplet !== null && (previous === undefined || previous.tuplet === null);
	const tupletRunStop = note.tuplet !== null && (next === undefined || next.tuplet === null);

	const slurStops: number[] = [];
	const slurStarts: number[] = [];
	score.slurs.forEach((slur, index) => {
		const number = (index % 6) + 1;
		if (slur.endNoteId === note.id) slurStops.push(number);
		if (slur.startNoteId === note.id) slurStarts.push(number);
	});

	const hasNotations =
		tiedInto ||
		note.tiedToId !== null ||
		tupletRunStart ||
		tupletRunStop ||
		slurStops.length > 0 ||
		slurStarts.length > 0;
	if (hasNotations) {
		xml.open('notations');
		if (tiedInto) xml.selfClose('tied', { type: 'stop' });
		if (note.tiedToId !== null) xml.selfClose('tied', { type: 'start' });
		if (tupletRunStart) xml.selfClose('tuplet', { type: 'start', number: '1' });
		if (tupletRunStop) xml.selfClose('tuplet', { type: 'stop', number: '1' });
		for (const number of slurStops) xml.selfClose('slur', { type: 'stop', number: String(number) });
		for (const number of slurStarts) xml.selfClose('slur', { type: 'start', number: String(number) });
		xml.close('notations');
	}

	xml.close('note');
}

/**
 * Emit the right-hand `<barline>` for a resolved end-barline type. `normal`
 * (and the `repeatStart` a boundary resolves to when the *next* measure opens
 * a repeat, which that measure's own left barline draws) emit nothing at all,
 * which is what a plain measure boundary looks like in MusicXML.
 */
function writeRightBarline(
	xml: XmlBuilder,
	end: ReturnType<Score['endBarlineAt']>
): void {
	let style: string;
	let repeat: 'backward' | undefined;
	switch (end) {
		case 'double':
			style = 'light-light';
			break;
		case 'final':
			style = 'light-heavy';
			break;
		case 'repeatEnd':
			style = 'light-heavy';
			repeat = 'backward';
			break;
		default:
			return;
	}
	xml.open('barline', { location: 'right' });
	xml.leaf('bar-style', style);
	if (repeat) xml.selfClose('repeat', { direction: repeat });
	xml.close('barline');
}

// --- Exact-fraction divisions ---------------------------------------------

/**
 * A non-negative rational, kept exact so `<divisions>` can be derived without
 * ever going through the float `durationWholes`: a tripleted eighth's real
 * duration is 1/12 of a whole, which no `number` holds exactly, and rounding
 * that back to an integer `<duration>` only works if the divisor was chosen
 * from the exact denominator in the first place.
 */
interface Rational {
	readonly num: number;
	readonly den: number;
}

function gcd(a: number, b: number): number {
	a = Math.abs(a);
	b = Math.abs(b);
	while (b !== 0) {
		[a, b] = [b, a % b];
	}
	return a === 0 ? 1 : a;
}

function reduce(r: Rational): Rational {
	const g = gcd(r.num, r.den);
	return { num: r.num / g, den: r.den / g };
}

function mul(a: Rational, b: Rational): Rational {
	return reduce({ num: a.num * b.num, den: a.den * b.den });
}

function lcm(a: number, b: number): number {
	return (a / gcd(a, b)) * b;
}

/**
 * Each note value's plain duration in quarter notes, as an exact fraction
 * reconstructed from `NOTE_VALUE_WHOLES[value] * 4` rather than read off the
 * float: whole 4/1 down to 64th 1/16.
 */
const QUARTERS_PER_VALUE: Readonly<Record<NoteValue, Rational>> = {
	whole: { num: 4, den: 1 },
	half: { num: 2, den: 1 },
	quarter: { num: 1, den: 1 },
	eighth: { num: 1, den: 2 },
	'16th': { num: 1, den: 4 },
	'32nd': { num: 1, den: 8 },
	'64th': { num: 1, den: 16 }
};

/** The dot multiplier `2 - 2**-dots` as an exact fraction: 1/1, 3/2, 7/4. */
const DOT_MULTIPLIER: Readonly<Record<0 | 1 | 2, Rational>> = {
	0: { num: 1, den: 1 },
	1: { num: 3, den: 2 },
	2: { num: 7, den: 4 }
};

/** A note's duration in quarter notes, exact, dots and tuplet ratio folded in
 *  the same way `Note.durationWholes` folds them, but as a reduced fraction. */
function noteDurationQuarters(note: Note): Rational {
	if (note.measureRestWholes !== null) return quartersFromWholes(note.measureRestWholes);
	let quarters = mul(QUARTERS_PER_VALUE[note.value], DOT_MULTIPLIER[note.dots]);
	if (note.tuplet) {
		quarters = mul(quarters, { num: note.tuplet.normalNotes, den: note.tuplet.actualNotes });
	}
	return quarters;
}

/**
 * A whole-measure rest's length, which the model holds as a float (a time
 * signature's `beats / beatType`, e.g. 0.375 for 3/8), back as an exact
 * fraction of quarters: the smallest denominator that makes it whole. Any
 * real time signature's beat type is a small power of two (or, rarely, some
 * other small integer), so the search ends almost at once; the cap only
 * guards a corrupt value from looping, falling back to the float rounded at
 * 1/1024 of a quarter.
 */
function quartersFromWholes(wholes: number): Rational {
	const quarters = wholes * 4;
	for (let den = 1; den <= 1024; den++) {
		const num = Math.round(quarters * den);
		if (Math.abs(num / den - quarters) < 1e-9) return reduce({ num, den });
	}
	return reduce({ num: Math.round(quarters * 1024), den: 1024 });
}

/**
 * `<divisions>` (divisions per quarter note) for a part: the LCM of every
 * note's exact-fraction denominator, so multiplying any note's duration by it
 * lands on a whole number. A part with no notes at all falls back to 1, since
 * an LCM over nothing is undefined and `<divisions>` still has to be positive.
 */
function divisionsForNotes(notes: readonly Note[]): number {
	let divisions = 1;
	for (const note of notes) divisions = lcm(divisions, noteDurationQuarters(note).den);
	return divisions;
}

// --- XML builder --------------------------------------------------------

function escapeText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function formatAttrs(attrs: Record<string, string> | undefined): string {
	if (!attrs) return '';
	return Object.entries(attrs)
		.map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
		.join('');
}

/**
 * A minimal indenting XML writer: an array of already-prefixed lines plus a
 * depth counter. Not a general serializer, just enough shape for this one
 * document, kept internal so the emitted format and the code that reads it in
 * the tests move together.
 */
class XmlBuilder {
	private readonly lines: string[] = [];
	private depth = 0;

	private get indent(): string {
		return '  '.repeat(this.depth);
	}

	/** A line with no indentation and no escaping: the prolog and doctype. */
	raw(line: string): void {
		this.lines.push(line);
	}

	open(tag: string, attrs?: Record<string, string>): void {
		this.lines.push(`${this.indent}<${tag}${formatAttrs(attrs)}>`);
		this.depth++;
	}

	close(tag: string): void {
		this.depth--;
		this.lines.push(`${this.indent}</${tag}>`);
	}

	leaf(tag: string, text: string, attrs?: Record<string, string>): void {
		this.lines.push(`${this.indent}<${tag}${formatAttrs(attrs)}>${escapeText(text)}</${tag}>`);
	}

	selfClose(tag: string, attrs?: Record<string, string>): void {
		this.lines.push(`${this.indent}<${tag}${formatAttrs(attrs)}/>`);
	}

	toString(): string {
		return this.lines.join('\n') + '\n';
	}
}
