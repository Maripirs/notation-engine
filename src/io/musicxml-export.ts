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
	graceRuns,
	noteEvents,
	type ClefType,
	type Measure,
	type MeasurePassthrough,
	type Note,
	type NoteId,
	type OpaqueElement,
	type DirectionSource,
	type GraceNote,
	type Part,
	type Placement,
	type Score,
	type TimeSignature
} from '../model/index.js';
import {
	computeBeamGroups,
	middleLineForClef,
	stemDirectionForNotes,
	type BeamGroup
} from '../layout/index.js';
import {
	add,
	compare,
	lcm,
	noteDurationQuarters,
	quartersFromWholes,
	quartersToWholes,
	sub,
	wholesToQuarters,
	ZERO,
	type Rational
} from './rational.js';

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
 *
 * Plus, since M6 Slice 3, every passthrough payload an import kept (see
 * `src/model/passthrough.ts`), written back verbatim at its anchor and in its
 * schema position: the score header before `<part-list>`, a part's or
 * group's extras inside its `<score-part>`/`<part-group>`, a measure's
 * positional elements at their onset in their voice stream, attribute and
 * barline extras merged into the `<attributes>`/`<barline>` written here, and
 * a note's extras slotted between the children written here.
 */
export function exportMusicXml(score: Score): string {
	const xml = new XmlBuilder();
	xml.raw('<?xml version="1.0" encoding="UTF-8"?>');
	xml.raw(
		'<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" ' +
			'"http://www.musicxml.org/dtds/partwise.dtd">'
	);
	xml.open('score-partwise', { version: '4.0' });

	// MusicXML puts the header (`<work>`, `<identification>`, `<defaults>`,
	// `<credit>`, ...) before `<part-list>`, in that order, which is the order
	// an import kept it in.
	for (const el of score.headerPassthrough) xml.element(el);

	const emitted = planEmittedParts(score);
	const groups = planPartGroups(score, emitted);

	writePartList(xml, emitted, groups);
	// The tempo direction is written only when no passthrough already states
	// the model's tempo: an imported score's own metronome mark comes back
	// verbatim (with whatever `<words>` it carried), and a second, synthesized
	// one would double it. A score that states no tempo still gets one.
	const writeTempo = passthroughTempo(score) !== score.tempoBpm;
	for (let partIndex = 0; partIndex < emitted.length; partIndex++) {
		writePart(xml, score, emitted, partIndex, writeTempo);
	}

	xml.close('score-partwise');
	return xml.toString();
}

/**
 * The tempo an export's passthrough states, found the way `importMusicXml`'s
 * `findTempo` finds one (the first `<metronome>` with a `<per-minute>`, else
 * the first `<sound tempo>`), so "would re-import read the model's tempo back
 * out of the passthrough" is answered by the same rule. Measures are scanned
 * staff by staff, which is document order for every score export writes.
 */
function passthroughTempo(score: Score): number | undefined {
	let soundTempo: number | undefined;
	const visit = (el: OpaqueElement): number | undefined => {
		if (el.name === 'metronome') {
			const perMinute = el.children.find((c) => c.name === 'per-minute');
			const bpm = perMinute ? Number.parseFloat(perMinute.text.trim()) : Number.NaN;
			if (Number.isFinite(bpm)) return bpm;
		}
		if (el.name === 'sound' && soundTempo === undefined && el.attrs.tempo !== undefined) {
			const bpm = Number.parseFloat(el.attrs.tempo);
			if (Number.isFinite(bpm)) soundTempo = bpm;
		}
		for (const c of el.children) {
			const found = visit(c);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	for (const staff of score.staves) {
		for (const measure of staff.measures) {
			for (const anchor of measure.passthrough) {
				const found = visit(anchor.element);
				if (found !== undefined) return found;
			}
		}
	}
	return soundTempo;
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
	/** The model part's `<score-part>` extras (M6 Slice 3). */
	readonly passthrough: readonly OpaqueElement[];
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
 * A synthetic part still carries the passthrough of an unnamed model part
 * covering exactly its staff (an imported `<score-part>` with an empty name).
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
			emitted.push({ id, name: named.name!, staffIndices, passthrough: named.passthrough ?? NO_EXTRAS });
			for (const covered of staffIndices) {
				if (!staffToPartIndex.has(covered)) staffToPartIndex.set(covered, emitted.length - 1);
			}
		} else {
			syntheticCount++;
			const unnamed = score.parts.find(
				(part) => part.staffIndices.length === 1 && part.staffIndices[0] === staffIndex
			);
			emitted.push({
				id,
				name: `Part ${syntheticCount}`,
				staffIndices: [staffIndex],
				passthrough: unnamed?.passthrough ?? NO_EXTRAS
			});
			staffToPartIndex.set(staffIndex, emitted.length - 1);
		}
	}
	return emitted;
}

const NO_EXTRAS: readonly OpaqueElement[] = Object.freeze([]);

/** A `<part-group>` bracket/brace wrapping a contiguous run of emitted parts. */
interface PartGroupPlan {
	readonly number: number;
	readonly symbol: 'brace' | 'bracket';
	readonly firstEmittedIndex: number;
	readonly lastEmittedIndex: number;
	/** The group part's `<part-group>` extras (M6 Slice 3). */
	readonly passthrough: readonly OpaqueElement[];
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
			lastEmittedIndex: coveredIndices[coveredIndices.length - 1]!,
			passthrough: part.passthrough ?? NO_EXTRAS
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
				const slots = new SlotMerger(xml, group.passthrough, PART_GROUP_ORDER);
				slots.before('group-symbol');
				xml.leaf('group-symbol', group.symbol);
				slots.rest();
				xml.close('part-group');
			}
		}
		xml.open('score-part', { id: emitted[i]!.id });
		const slots = new SlotMerger(xml, emitted[i]!.passthrough, SCORE_PART_ORDER);
		slots.before('part-name');
		xml.leaf('part-name', emitted[i]!.name);
		slots.rest();
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
	partIndex: number,
	writeTempo: boolean
): void {
	const part = emitted[partIndex]!;
	const isFirstPart = partIndex === 0;
	const partStaves = part.staffIndices;
	const multiStaff = partStaves.length > 1;
	const firstStaffIndex = partStaves[0]!;

	// `<divisions>` is per part, so it is the LCM of every note's denominator
	// across every staff and every measure this part owns (and of its
	// positional passthrough; see `divisionsForPart`).
	const everyNote: Note[] = [];
	const everyAnchor: MeasurePassthrough[] = [];
	// Dynamics and hairpin ends (M6 Slice 6), as synthetic positional anchors
	// per `staffIndex:measureIndex`; see `directionAnchorsForPart`.
	const directionAnchors = directionAnchorsForPart(score, partStaves, multiStaff);
	for (const list of directionAnchors.values()) everyAnchor.push(...list);
	// A mid-measure clef change's onset (M6 Slice 4) may need a `<backup>` to
	// reach it, so it must land on whole divisions too.
	const clefChangeOnsets: number[] = [];
	for (const staffIndex of partStaves) {
		for (const measure of score.staves[staffIndex]!.measures) {
			everyNote.push(...measure.notes);
			everyAnchor.push(...measure.passthrough);
			for (const change of measure.clefChanges) clefChangeOnsets.push(change.onset);
		}
	}
	const divisions = divisionsForPart(everyNote, everyAnchor, clefChangeOnsets);
	const measureCount = score.staves[firstStaffIndex]!.measures.length;

	xml.open('part', { id: part.id });
	for (let m = 0; m < measureCount; m++) {
		xml.open('measure', { number: String(m + 1) });
		const firstMeasure = score.staves[firstStaffIndex]!.measures[m]!;

		// Passthrough that led the source measure (a `<print new-system>`,
		// conventionally ahead of everything else) leads it again.
		for (const anchor of firstMeasure.passthrough) {
			if (anchor.lead) xml.element(rescaleDivisionValues(anchor.element, divisions / anchor.divisions));
		}

		// A repeat-start barline is conventionally attached to the measure it
		// opens (MusicXML's `<barline location="left">`), and the model keeps it
		// on `Measure.startBarline` for the same reason, so it leads the measure.
		writeBarlines(
			xml,
			firstMeasure.startBarline === 'repeatStart' ? { style: 'heavy-light', repeat: 'forward' } : undefined,
			firstMeasure.barlinePassthrough.filter((b) => b.attrs.location === 'left'),
			'left'
		);

		writeMeasureAttributes(xml, score, part, m, divisions, multiStaff);

		// The metronome mark rides in the very first measure of the very first
		// part only: it is a score-wide value with no per-part or per-measure
		// form in the model.
		if (writeTempo && isFirstPart && m === 0) {
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

		writeMeasureNotes(xml, score, partStaves, m, divisions, multiStaff, directionAnchors);

		writeBarlines(
			xml,
			rightBarlineMarkup(score.endBarlineAt(m, firstStaffIndex)),
			firstMeasure.barlinePassthrough.filter((b) => b.attrs.location !== 'left'),
			'right'
		);
		xml.close('measure');
	}
	xml.close('part');
}

/**
 * The `<attributes>` block, if this measure needs one. Measure 0 always does
 * (divisions, key, time, `<staves>` for a multi-staff part, one `<clef>` per
 * staff, in that DTD-mandated order). A later measure gets a fresh, minimal
 * `<attributes>` only when its own model object carries a key and/or time
 * change, or any of the part's staves states a clef here (M5 Slice 5), and
 * then only those elements: no divisions, and a `<clef>` only for the staves
 * whose measure states one.
 *
 * A stated clef is written even when it equals the clef already in force (a
 * `setClefRange` restore that turned out to be no change, or an imported
 * courtesy restatement): it costs one redundant, harmless element and keeps
 * the source's restatements across a round trip. The measure's
 * `attributesPassthrough` (M6 Slice 3: `<staff-details>`, `<transpose>`, ...)
 * is merged in schema order, and on its own is reason enough to write the
 * block.
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
	const measure = score.staves[firstStaffIndex]!.measures[m]!;
	const extras = measure.attributesPassthrough;

	if (m === 0) {
		xml.open('attributes');
		const slots = new SlotMerger(xml, extras, ATTRIBUTES_ORDER);
		slots.before('divisions');
		xml.leaf('divisions', String(divisions));
		slots.before('key');
		xml.open('key');
		xml.leaf('fifths', String(score.keyFifthsAt(0, firstStaffIndex)));
		xml.close('key');
		slots.before('time');
		const time = score.timeAt(0, firstStaffIndex);
		xml.open('time');
		xml.leaf('beats', String(time.beats));
		xml.leaf('beat-type', String(time.beatType));
		xml.close('time');
		slots.before('staves');
		if (multiStaff) xml.leaf('staves', String(part.staffIndices.length));
		slots.before('clef');
		for (let k = 0; k < part.staffIndices.length; k++) {
			writeClef(xml, score.clefAt(0, part.staffIndices[k]!), k + 1);
		}
		slots.rest();
		xml.close('attributes');
		return;
	}

	// Mid-score change: read the measure object directly off the part's first
	// staff. A change is `!== undefined`; the walk-back accessors are for
	// "what is in force here", which is not the question at a change boundary.
	// Clefs (M5 Slice 5) are per staff, unlike key/time, so every staff of the
	// part is checked.
	const clefChanges: { readonly clef: ClefType; readonly number: number }[] = [];
	for (let k = 0; k < part.staffIndices.length; k++) {
		const clef = score.staves[part.staffIndices[k]!]!.measures[m]!.clef;
		if (clef !== undefined) clefChanges.push({ clef, number: k + 1 });
	}
	if (
		measure.keyFifths === undefined &&
		measure.time === undefined &&
		clefChanges.length === 0 &&
		extras.length === 0
	) {
		return;
	}
	xml.open('attributes');
	const slots = new SlotMerger(xml, extras, ATTRIBUTES_ORDER);
	if (measure.keyFifths !== undefined) {
		slots.before('key');
		xml.open('key');
		xml.leaf('fifths', String(measure.keyFifths));
		xml.close('key');
	}
	if (measure.time !== undefined) {
		slots.before('time');
		xml.open('time');
		xml.leaf('beats', String(measure.time.beats));
		xml.leaf('beat-type', String(measure.time.beatType));
		xml.close('time');
	}
	if (clefChanges.length > 0) slots.before('clef');
	for (const change of clefChanges) writeClef(xml, change.clef, change.number);
	slots.rest();
	xml.close('attributes');
}

const CLEF_MARKUP: Readonly<
	Record<ClefType, { readonly sign: string; readonly line: number; readonly octaveChange?: number }>
> = {
	treble: { sign: 'G', line: 2 },
	bass: { sign: 'F', line: 4 },
	treble8: { sign: 'G', line: 2, octaveChange: -1 },
	alto: { sign: 'C', line: 3 },
	tenor: { sign: 'C', line: 4 }
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
 * before every stream except the very first, emit a `<backup>` to the downbeat
 * so the next stream starts there. That one rule covers both a single staff's
 * extra voices and a multi-staff part's second staff, and composes if a part
 * ever has both at once (no current fixture does). The backup is exactly as
 * long as the time cursor has advanced: a full measure after a complete voice,
 * and less after an incomplete one (an OMR measure a voice did not fill),
 * which a fixed full-measure backup would overshoot.
 *
 * Positional passthrough (M6 Slice 3) rides in its own stream: written just
 * before the event at its onset, after the last event when it sits at the
 * stream's end, and, when its onset falls inside a longer event, after the
 * stream via a `<backup>` to that onset (never a `<forward>`, which import
 * reads as a rest gap). A staff whose measure has no notes but does hold
 * passthrough gets a stream of its own with just that.
 */
function writeMeasureNotes(
	xml: XmlBuilder,
	score: Score,
	partStaves: readonly number[],
	m: number,
	divisions: number,
	multiStaff: boolean,
	directionAnchors: ReadonlyMap<string, readonly MeasurePassthrough[]>
): void {
	let cursor: Rational = ZERO;
	let firstStream = true;
	for (let k = 0; k < partStaves.length; k++) {
		const staffIndex = partStaves[k]!;
		const staff = score.staves[staffIndex]!;
		const measure = staff.measures[m]!;
		const time = score.timeAt(m, staffIndex);
		const middleLine = middleLineForClef(score.clefAt(m, staffIndex));

		const streams = [...groupNotesByVoice(measure.notes)];
		const anchorsByVoice = anchorsByStream(measure, streams.map(([voice]) => voice));
		addClefChangeAnchors(anchorsByVoice, measure, streams[0]?.[0], k + 1);
		addDirectionAnchors(anchorsByVoice, directionAnchors.get(`${staffIndex}:${m}`), streams.map(([voice]) => voice));
		if (streams.length === 0 && anchorsByVoice.size > 0) streams.push([[...anchorsByVoice.keys()][0]!, []]);

		for (const [voice, voiceNotes] of streams) {
			if (!firstStream && cursor.num > 0) {
				xml.open('backup');
				xml.leaf('duration', String(toDivisions(cursor, divisions)));
				xml.close('backup');
			}
			firstStream = false;

			// Stem and beam directions follow each note's own clef when the
			// measure changes clef partway (M6 Slice 4), as layout's do.
			const middleLineOf =
				measure.clefChanges.length === 0 ? middleLine : streamMiddleLines(score, m, staffIndex, voiceNotes);
			const beamPlan = buildBeamPlan(voiceNotes, time, middleLineOf);
			// Grace notes (M6 Slice 8) are written right before their principal,
			// after any positional passthrough at its onset (a grace belongs to
			// the note, a direction to the moment), or at the stream's end when
			// the run has no principal in the measure. No `<duration>`, so they
			// never move the cursor.
			const gracesBefore = new Map<NoteId, readonly Note[]>();
			let trailingGraces: readonly Note[] = [];
			const graceStem = graceStemDirection(voice, streams.length > 1);
			for (const run of graceRuns(voiceNotes)) {
				if (run.principal) gracesBefore.set(run.principal.id, run.notes);
				else trailingGraces = run.notes;
				addGraceBeams(beamPlan, run.notes, graceStem);
			}
			const writeGraces = (graces: readonly Note[] | undefined): void => {
				for (const grace of graces ?? []) {
					writeNote(xml, score, grace, {
						divisions,
						multiStaff,
						staffNumber: k + 1,
						middleLine: 0,
						beamPlan,
						chord: [grace],
						previousAnchor: undefined,
						nextAnchor: undefined,
						regenerateTuplets: false,
						graceStem
					});
				}
			};
			const anchors = anchorsByVoice.get(voice) ?? [];
			const writeAnchor = (anchor: MeasurePassthrough): void => {
				xml.element(rescaleDivisionValues(anchor.element, divisions / anchor.divisions));
			};
			const inside: MeasurePassthrough[] = [];
			let next = 0;
			let t: Rational = ZERO;
			// One event per onset (M6 Slice 2): a chord's heads are written
			// back to back, every one after the anchor carrying `<chord/>`, so a
			// reader advances its time cursor once per chord. That is also why
			// no `<backup>` above ever needs to know about chords: the chord's
			// members never moved the cursor.
			const events = noteEvents(voiceNotes);
			const sourceBracketed = tupletRunsWithSourceBrackets(events);
			for (let ei = 0; ei < events.length; ei++) {
				const chord = events[ei]!;
				while (next < anchors.length && compare(anchorOnset(anchors[next]!), t) < 0) inside.push(anchors[next++]!);
				while (next < anchors.length && compare(anchorOnset(anchors[next]!), t) === 0) writeAnchor(anchors[next++]!);
				writeGraces(gracesBefore.get(chord[0]!.id));
				for (const note of chord) {
					writeNote(xml, score, note, {
						divisions,
						multiStaff,
						staffNumber: k + 1,
						middleLine: typeof middleLineOf === 'number' ? middleLineOf : middleLineOf(chord[0]!),
						beamPlan,
						chord,
						previousAnchor: events[ei - 1]?.[0],
						nextAnchor: events[ei + 1]?.[0],
						regenerateTuplets: !sourceBracketed.has(ei)
					});
				}
				t = add(t, noteDurationQuarters(chord[0]!));
			}
			// At (or, clamped, past) the stream's end: in order, after the last
			// event. An onset past the end only arises when a stream is shorter
			// than the passthrough read into it, and moving it to the end is the
			// one placement that needs no `<forward>`.
			while (next < anchors.length && compare(anchorOnset(anchors[next]!), t) < 0) inside.push(anchors[next++]!);
			while (next < anchors.length) writeAnchor(anchors[next++]!);
			writeGraces(trailingGraces);
			// Inside an event: back up to each onset, latest first, so every
			// step is a `<backup>`. Equal onsets keep their order.
			inside.sort((a, b) => compare(anchorOnset(b), anchorOnset(a)));
			for (const anchor of inside) {
				const onset = anchorOnset(anchor);
				xml.open('backup');
				xml.leaf('duration', String(toDivisions(sub(t, onset), divisions)));
				xml.close('backup');
				t = onset;
				writeAnchor(anchor);
			}
			cursor = t;
		}
	}
}

/**
 * Indices of the events in tuplet runs (see `writeNote`) whose brackets came
 * from the source: some head in the run carries a passthrough `<tuplet>`.
 * The model holds a tuplet's ratio (`Note.tuplet`), not where its bracket
 * starts and stops, so it cannot tell two adjacent triplets from one long
 * run; the source's own `<tuplet>` elements (with their `<tuplet-actual>`
 * display children) are kept verbatim instead, and regenerating the run's
 * brackets as well would write them twice. A score built in code has no such
 * passthrough, so its runs are bracketed from the model as before.
 */
function tupletRunsWithSourceBrackets(events: readonly (readonly Note[])[]): Set<number> {
	const indices = new Set<number>();
	let runStart = -1;
	let runHasSource = false;
	const close = (end: number): void => {
		if (runStart !== -1 && runHasSource) for (let i = runStart; i < end; i++) indices.add(i);
		runStart = -1;
		runHasSource = false;
	};
	events.forEach((event, i) => {
		if (event[0]!.tuplet === null) {
			close(i);
			return;
		}
		if (runStart === -1) runStart = i;
		if (event.some(hasSourceTuplet)) runHasSource = true;
	});
	close(events.length);
	return indices;
}

function hasSourceTuplet(note: Note): boolean {
	return note.passthrough.some((el) => el.name === 'notations' && el.children.some((c) => c.name === 'tuplet'));
}

/** A positional payload's onset in quarters, this file's time unit. */
function anchorOnset(anchor: MeasurePassthrough): Rational {
	return wholesToQuarters(anchor.onset);
}

function toDivisions(quarters: Rational, divisions: number): number {
	return (quarters.num * divisions) / quarters.den;
}

/**
 * A measure's non-lead positional passthrough grouped by the voice stream
 * export will write it in, each list sorted by onset (stable, so equal onsets
 * keep source order). An anchor whose voice has no notes here (import never
 * makes one; a hand-built score could) joins the staff's first stream, or,
 * on a staff with no notes in this measure, one stream shared by all.
 */
function anchorsByStream(measure: Measure, voices: readonly number[]): Map<number, MeasurePassthrough[]> {
	const byVoice = new Map<number, MeasurePassthrough[]>();
	// No notes at all on this staff: everything shares one stream.
	const fallback = voices[0] ?? measure.passthrough.find((anchor) => !anchor.lead)?.voice ?? 1;
	for (const anchor of measure.passthrough) {
		if (anchor.lead) continue;
		const voice = voices.includes(anchor.voice) ? anchor.voice : fallback;
		const list = byVoice.get(voice);
		if (list) list.push(anchor);
		else byVoice.set(voice, [anchor]);
	}
	for (const list of byVoice.values()) list.sort((a, b) => compare(anchorOnset(a), anchorOnset(b)));
	return byVoice;
}

/**
 * Mid-measure clef changes (M6 Slice 4) ride the positional-anchor machinery
 * above: each becomes a synthetic `<attributes><clef>` anchor in the staff's
 * first stream, so it is written before the event at its onset, after the
 * stream's last event when it sits at the measure's end, or via a `<backup>`
 * when it falls inside a longer event. Those are exactly the placements the
 * importer reads back at the same onset (it gives an owned `<attributes>` the
 * onset a passthrough element at that point would get). Merged into the
 * stream's list stably after any passthrough at the same onset.
 */
function addClefChangeAnchors(
	anchorsByVoice: Map<number, MeasurePassthrough[]>,
	measure: Measure,
	firstVoice: number | undefined,
	staffNumber: number
): void {
	if (measure.clefChanges.length === 0) return;
	const voice = firstVoice ?? [...anchorsByVoice.keys()][0] ?? 1;
	const list = anchorsByVoice.get(voice) ?? [];
	for (const change of measure.clefChanges) {
		list.push({
			element: clefChangeElement(change.clef, staffNumber),
			onset: quartersToWholes(quartersFromWholes(change.onset)),
			voice,
			lead: false,
			divisions: 1
		});
	}
	list.sort((a, b) => compare(anchorOnset(a), anchorOnset(b)));
	anchorsByVoice.set(voice, list);
}

// --- Dynamics and hairpins (M6 Slice 6) ------------------------------------

/** One modelled mark's contribution to a `<direction>`: its regenerated
 *  `<direction-type>`, and where it goes. */
interface DirectionPiece {
	readonly staffIndex: number;
	readonly measureIndex: number;
	readonly onset: number;
	readonly voice: number;
	readonly source: DirectionSource | null;
	/** The direction's placement when this mark owns it (a dynamic or a
	 *  hairpin start), else `undefined` (a stop keeps its source's). */
	readonly placement: Placement | null | undefined;
	readonly directionType: OpaqueElement;
}

const leafElement = (name: string, attrs: Readonly<Record<string, string>> = {}): OpaqueElement => ({
	name,
	attrs,
	children: [],
	text: ''
});

/**
 * Every dynamic and hairpin end on `partStaves`, as one synthetic positional
 * anchor per `<direction>` to write, keyed by `staffIndex:measureIndex`. They
 * ride the passthrough anchor writer exactly as mid-measure clef changes do,
 * so export puts each `<direction>` at its onset in its stream and import
 * reads it back at the same anchor.
 *
 * A mark read from a file is written back into its own `DirectionSource`:
 * marks sharing one source element (several read from one `<direction>`)
 * become that one `<direction>` again, their regenerated `<direction-type>`s
 * put back at their original slots. A mark built in code gets a plain
 * `<direction>` of its own, with a `<staff>` in a multi-staff part.
 *
 * Hairpin `number`s are allocated here, per part, not kept from the source
 * (see `Wedge`): in start order, each hairpin takes the lowest number not
 * held by another hairpin whose span touches its own, ends included. Touching
 * hairpins never share a number, so the importer's pairing (time order, then
 * document order) matches them back up however their `<direction>`s at one
 * onset end up ordered in the document.
 */
function directionAnchorsForPart(
	score: Score,
	partStaves: readonly number[],
	multiStaff: boolean
): Map<string, MeasurePassthrough[]> {
	const pieces: DirectionPiece[] = [];
	for (const staffIndex of partStaves) {
		for (const measure of score.staves[staffIndex]!.measures) {
			for (const mark of measure.dynamics) {
				pieces.push({
					staffIndex,
					measureIndex: measure.index,
					onset: mark.onset,
					voice: mark.voice,
					source: mark.source,
					placement: mark.placement,
					directionType: directionTypeElement({
						name: 'dynamics',
						attrs: mark.source?.markAttrs ?? {},
						children: [leafElement(mark.kind)],
						text: ''
					})
				});
			}
		}
	}

	const wedges = score.wedges
		.filter((wedge) => partStaves.includes(wedge.staffIndex))
		.sort((a, b) => a.start.measureIndex - b.start.measureIndex || a.start.onset - b.start.onset);
	const position = (end: { readonly measureIndex: number; readonly onset: number }): number =>
		// A sortable scalar: measures never hold anywhere near 1e6 wholes.
		end.measureIndex * 1e6 + end.onset;
	const assigned: { readonly stop: number; readonly number: number }[] = [];
	for (const wedge of wedges) {
		const startAt = position(wedge.start);
		const taken = new Set(assigned.filter((a) => a.stop >= startAt - 1e-9).map((a) => a.number));
		let number = 1;
		while (taken.has(number)) number++;
		assigned.push({ stop: position(wedge.stop), number });
		const wedgeElement = (type: string, source: DirectionSource | null): OpaqueElement =>
			directionTypeElement(leafElement('wedge', { type, number: String(number), ...(source?.markAttrs ?? {}) }));
		pieces.push({
			staffIndex: wedge.staffIndex,
			measureIndex: wedge.start.measureIndex,
			onset: wedge.start.onset,
			voice: wedge.start.voice,
			source: wedge.start.source,
			placement: wedge.placement,
			directionType: wedgeElement(wedge.kind, wedge.start.source)
		});
		pieces.push({
			staffIndex: wedge.staffIndex,
			measureIndex: wedge.stop.measureIndex,
			onset: wedge.stop.onset,
			voice: wedge.stop.voice,
			source: wedge.stop.source,
			placement: undefined,
			directionType: wedgeElement('stop', wedge.stop.source)
		});
	}

	// Group pieces into `<direction>`s: by source element identity, or alone.
	const groups = new Map<object, DirectionPiece[]>();
	for (const piece of pieces) {
		const key = piece.source?.element ?? piece;
		const list = groups.get(key);
		if (list) list.push(piece);
		else groups.set(key, [piece]);
	}
	const byMeasure = new Map<string, MeasurePassthrough[]>();
	for (const group of groups.values()) {
		const first = group[0]!;
		const element = first.source
			? rebuildDirection(first.source.element, group)
			: freshDirection(first, multiStaff ? partStaves.indexOf(first.staffIndex) + 1 : undefined);
		const key = `${first.staffIndex}:${first.measureIndex}`;
		const anchor: MeasurePassthrough = {
			element,
			onset: quartersToWholes(quartersFromWholes(first.onset)),
			voice: first.voice,
			lead: false,
			divisions: first.source?.divisions ?? 1
		};
		const list = byMeasure.get(key);
		if (list) list.push(anchor);
		else byMeasure.set(key, [anchor]);
	}
	return byMeasure;
}

function directionTypeElement(child: OpaqueElement): OpaqueElement {
	return { name: 'direction-type', attrs: {}, children: [child], text: '' };
}

/** A source `<direction>` with its marks' `<direction-type>`s back in their
 *  slots, and the placement a mark owns back on it (first, as written). */
function rebuildDirection(kept: OpaqueElement, group: readonly DirectionPiece[]): OpaqueElement {
	const bySlot = [...group].sort((a, b) => a.source!.slot - b.source!.slot);
	const children: OpaqueElement[] = [];
	let next = 0;
	let piece = 0;
	const total = kept.children.length + bySlot.length;
	for (let i = 0; i < total; i++) {
		if (piece < bySlot.length && bySlot[piece]!.source!.slot === i) children.push(bySlot[piece++]!.directionType);
		else if (next < kept.children.length) children.push(kept.children[next++]!);
	}
	while (piece < bySlot.length) children.push(bySlot[piece++]!.directionType);
	const placement = group.find((p) => p.placement !== undefined && p.placement !== null)?.placement;
	const attrs = placement ? { placement, ...kept.attrs } : kept.attrs;
	return { ...kept, attrs, children };
}

/** A `<direction>` for a mark built in code. */
function freshDirection(piece: DirectionPiece, staffNumber: number | undefined): OpaqueElement {
	const children = [piece.directionType];
	if (staffNumber !== undefined) children.push({ name: 'staff', attrs: {}, children: [], text: String(staffNumber) });
	return {
		name: 'direction',
		attrs: piece.placement ? { placement: piece.placement } : {},
		children,
		text: ''
	};
}

/** Merge a staff measure's direction anchors into its streams, stably after
 *  any passthrough at the same onset. A voice with no notes on the staff
 *  falls back to its first stream, as `anchorsByStream` does. */
function addDirectionAnchors(
	anchorsByVoice: Map<number, MeasurePassthrough[]>,
	anchors: readonly MeasurePassthrough[] | undefined,
	voices: readonly number[]
): void {
	if (!anchors || anchors.length === 0) return;
	const fallback = voices[0] ?? [...anchorsByVoice.keys()][0] ?? anchors[0]!.voice;
	const touched = new Set<number>();
	for (const anchor of anchors) {
		const voice = voices.includes(anchor.voice) ? anchor.voice : fallback;
		const list = anchorsByVoice.get(voice) ?? [];
		list.push(anchor);
		anchorsByVoice.set(voice, list);
		touched.add(voice);
	}
	for (const voice of touched) anchorsByVoice.get(voice)!.sort((a, b) => compare(anchorOnset(a), anchorOnset(b)));
}

/** `<attributes><clef number>...</clef></attributes>` as an opaque element,
 *  the shape `writeClef` writes, for `addClefChangeAnchors`. */
function clefChangeElement(clef: ClefType, number: number): OpaqueElement {
	const markup = CLEF_MARKUP[clef];
	const leaf = (name: string, text: string): OpaqueElement => ({ name, attrs: {}, children: [], text });
	const clefChildren = [leaf('sign', markup.sign), leaf('line', String(markup.line))];
	if (markup.octaveChange !== undefined) clefChildren.push(leaf('clef-octave-change', String(markup.octaveChange)));
	return {
		name: 'attributes',
		attrs: {},
		children: [{ name: 'clef', attrs: { number: String(number) }, children: clefChildren, text: '' }],
		text: ''
	};
}

/** Each note's own clef's middle line in one voice stream of a measure that
 *  changes clef partway (M6 Slice 4), from the onset of its event. */
function streamMiddleLines(score: Score, m: number, staffIndex: number, voiceNotes: readonly Note[]): (note: Note) => number {
	const byId = new Map<NoteId, number>();
	let onset = 0;
	for (const event of noteEvents(voiceNotes)) {
		const middleLine = middleLineForClef(score.clefAtOnset(m, onset, staffIndex));
		for (const note of event) byId.set(note.id, middleLine);
		onset += event[0]!.durationWholes;
	}
	return (note) => byId.get(note.id) ?? middleLineForClef(score.clefAt(m, staffIndex));
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
	middleLine: number | ((note: Note) => number)
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

/**
 * A grace note's stem (M6 Slice 8): up, the standard for a grace in a single
 * voice whatever its pitch, so it never collides with the principal's stem
 * pattern; in a multi-voice measure it follows the voice's side like every
 * other stem there (odd up, even down). Mirrors layout's rule.
 */
function graceStemDirection(voice: number, multiVoice: boolean): 'up' | 'down' {
	return multiVoice && voice % 2 === 0 ? 'down' : 'up';
}

/** A run of two or more consecutive beamable grace notes is one beam group
 *  (layout draws it so); `computeBeamGroups` never sees graces, which are
 *  not events. */
function addGraceBeams(plan: Map<NoteId, BeamMembership>, graces: readonly Note[], direction: 'up' | 'down'): void {
	let start = 0;
	const flush = (end: number): void => {
		if (end - start >= 2) {
			for (let i = start; i < end; i++) {
				const position = i === start ? 'begin' : i === end - 1 ? 'end' : 'continue';
				plan.set(graces[i]!.id, { position, direction });
			}
		}
	};
	graces.forEach((grace, i) => {
		if (!isBeamableValue(grace.value)) {
			flush(i);
			start = i + 1;
		}
	});
	flush(graces.length);
}

function isBeamableValue(value: Note['value']): boolean {
	return value === 'eighth' || value === '16th' || value === '32nd' || value === '64th';
}

interface NoteContext {
	readonly divisions: number;
	readonly multiStaff: boolean;
	readonly staffNumber: number;
	readonly middleLine: number;
	readonly beamPlan: Map<NoteId, BeamMembership>;
	/** The event this note belongs to (`noteEvents`): just `[note]` for a
	 *  plain note or rest, the anchor then its members for a chord. */
	readonly chord: readonly Note[];
	/** Anchors of the voice's neighbouring events, for tuplet run edges. */
	readonly previousAnchor: Note | undefined;
	readonly nextAnchor: Note | undefined;
	/** False when the source's own `<tuplet>` brackets for this note's run
	 *  are in passthrough (`tupletRunsWithSourceBrackets`). */
	readonly regenerateTuplets: boolean;
	/** A grace note's stem direction (`graceStemDirection`); unset for
	 *  everything else. */
	readonly graceStem?: 'up' | 'down';
}

/**
 * One `<note>`. MusicXML fixes the child order and it is not the order a reader
 * would guess, so the sequence below is deliberate and load-bearing:
 * pitch-or-rest, duration, `<tie>` (the sounding element), voice, type, dots,
 * time-modification, stem, staff, beam, then `<notations>` (the visual
 * elements, `<tied>`/`<tuplet>`/`<slur>`, then `<articulations>`/`<fermata>`). Anything absent is simply skipped.
 *
 * `Note.passthrough` (M6 Slice 3) is slotted into that same order
 * (`NOTE_ORDER`): a `<cue/>` first, a `<notehead>` after `<stem>`, a `<lyric>`
 * after `<notations>`, an unmatched `<tie>` after the model's own. Two
 * passthrough names are merged rather than slotted, since the model writes
 * the same element: a `<rest>`'s display children go inside the `<rest>`
 * written here, and the first passthrough `<notations>` (already cut down to
 * what the model does not own) is merged into the model's `<notations>`, any
 * further one written right after it.
 */
function writeNote(xml: XmlBuilder, score: Score, note: Note, ctx: NoteContext): void {
	const anchor = ctx.chord[0]!;
	const isAnchor = note === anchor;
	const extras = note.passthrough;
	const restExtra = note.pitch === null ? extras.find((e) => e.name === 'rest') : undefined;
	const notationsExtras = extras.filter((e) => e.name === 'notations');
	const slots = new SlotMerger(
		xml,
		extras.length === 0 ? extras : extras.filter((e) => e.name !== 'rest' && e.name !== 'notations'),
		NOTE_ORDER
	);

	xml.open('note');

	// `<grace>` (M6 Slice 8) comes first of all, and a grace note has no
	// `<duration>` (it takes no time).
	slots.before('grace');
	if (note.grace !== null) xml.selfClose('grace', graceAttributes(note.grace, ctx.divisions));

	// `<chord/>` precedes `<pitch>` in MusicXML's fixed child order.
	slots.before('chord');
	if (note.chordWithPrevious) xml.selfClose('chord');

	slots.before('pitch');
	if (note.pitch === null) {
		// A whole-measure rest (M6 Slice 1) says so, so a reader fills the bar
		// with it whatever the time signature, rather than trusting a `<type>`.
		const restAttrs = note.isMeasureRest ? { ...restExtra?.attrs, measure: 'yes' } : restExtra?.attrs;
		if (restExtra && restExtra.children.length > 0) {
			xml.open('rest', restAttrs);
			for (const c of restExtra.children) xml.element(c);
			xml.close('rest');
		} else {
			xml.selfClose('rest', restAttrs);
		}
	} else {
		xml.open('pitch');
		xml.leaf('step', note.pitch.step);
		if (note.pitch.alter !== 0) xml.leaf('alter', String(note.pitch.alter));
		xml.leaf('octave', String(note.pitch.octave));
		xml.close('pitch');
	}

	// Every head of a chord states the chord's (the anchor's) duration, as
	// MusicXML expects; `<chord/>` is what keeps a reader from adding it twice.
	slots.before('duration');
	if (note.grace === null) xml.leaf('duration', String(toDivisions(noteDurationQuarters(anchor), ctx.divisions)));

	slots.before('tie');
	const tiedInto = score.tiedFromNote(note.id) !== undefined;
	if (tiedInto) xml.selfClose('tie', { type: 'stop' });
	if (note.tiedToId !== null) xml.selfClose('tie', { type: 'start' });

	slots.before('voice');
	xml.leaf('voice', String(note.voice));
	// `NoteValue` and MusicXML's `<type>` names coincide exactly, rests
	// included: a real file carries `<type>` on a rest too, so this does not
	// special-case them. The one exception is a whole-measure rest: its
	// `value` is a drawing convention (`'whole'`), not its length, so writing
	// `<type>whole</type>` into a 3/4 bar would state a duration the
	// `<duration>` contradicts. MusicXML makes `<type>` optional for exactly
	// this case, and MuseScore omits it too.
	slots.before('type');
	if (!note.isMeasureRest) xml.leaf('type', note.value);
	slots.before('dot');
	for (let d = 0; d < note.dots; d++) xml.selfClose('dot');

	slots.before('time-modification');
	if (note.tuplet) {
		xml.open('time-modification');
		xml.leaf('actual-notes', String(note.tuplet.actualNotes));
		xml.leaf('normal-notes', String(note.tuplet.normalNotes));
		xml.close('time-modification');
	}

	// No stem on a rest or a whole note; a beamed note takes its group's shared
	// direction, everything else the ordinary farthest-from-the-middle-line
	// rule over every head of its chord (one stem, so one direction, written
	// on each head the way MuseScore does). The anchor decides both, since
	// beam membership and stem presence are the chord's, not one head's.
	slots.before('stem');
	const membership = ctx.beamPlan.get(anchor.id);
	if (note.pitch !== null && anchor.value !== 'whole') {
		const direction = ctx.graceStem
			? ctx.graceStem
			: membership
				? membership.direction
			: stemDirectionForNotes(
					ctx.chord.flatMap((head) => (head.pitch ? [diatonicIndex(head.pitch)] : [])),
					ctx.middleLine
				);
		xml.leaf('stem', direction);
	}

	slots.before('staff');
	if (ctx.multiStaff) xml.leaf('staff', String(ctx.staffNumber));

	// `<beam>` only on the anchor: a chord is one beam member, and readers
	// (MuseScore among them) take the first note of a chord as its beam carrier.
	slots.before('beam');
	if (membership && isAnchor) xml.leaf('beam', membership.position, { number: '1' });

	// A tuplet "run" is consecutive same-voice, same-measure events whose
	// anchor has a `tuplet` set; the run's first event starts it and its last
	// stops it, both marked on that event's anchor only. A lone tupleted
	// event is a run of one and carries both.
	const previous = ctx.previousAnchor;
	const next = ctx.nextAnchor;
	const inRun = ctx.regenerateTuplets && isAnchor && note.tuplet !== null;
	const tupletRunStart = inRun && (previous === undefined || previous.tuplet === null);
	const tupletRunStop = inRun && (next === undefined || next.tuplet === null);

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
		slurStarts.length > 0 ||
		note.articulations.length > 0 ||
		note.fermata !== null;
	slots.before('notations');
	if (hasNotations) {
		const merged = notationsExtras[0];
		// A passthrough `<articulations>` holds the kinds the model does not
		// (M6 Slice 5's import cut it down), so when the model writes its own
		// they become one element again, as in the source; `<notations>`'
		// children are an unordered choice, so nothing else needs slotting.
		const extraArticulations =
			note.articulations.length > 0 ? merged?.children.find((c) => c.name === 'articulations') : undefined;
		xml.open('notations', merged?.attrs);
		if (tiedInto) xml.selfClose('tied', { type: 'stop' });
		if (note.tiedToId !== null) xml.selfClose('tied', { type: 'start' });
		if (tupletRunStart) xml.selfClose('tuplet', { type: 'start', number: '1' });
		if (tupletRunStop) xml.selfClose('tuplet', { type: 'stop', number: '1' });
		for (const number of slurStops) xml.selfClose('slur', { type: 'stop', number: String(number) });
		for (const number of slurStarts) xml.selfClose('slur', { type: 'start', number: String(number) });
		if (note.articulations.length > 0) {
			xml.open('articulations', extraArticulations?.attrs);
			for (const kind of note.articulations) xml.selfClose(kind);
			if (extraArticulations) for (const c of extraArticulations.children) xml.element(c);
			xml.close('articulations');
		}
		if (note.fermata !== null) xml.selfClose('fermata', { type: note.fermata });
		if (merged) for (const c of merged.children) if (c !== extraArticulations) xml.element(c);
		xml.close('notations');
		for (let i = 1; i < notationsExtras.length; i++) xml.element(notationsExtras[i]!);
	} else {
		for (const el of notationsExtras) xml.element(el);
	}

	slots.rest();
	xml.close('note');
}

/** `<grace>`'s attributes: `slash` only when set (the MusicXML default is
 *  no slash), then whichever steal/make times the source stated. `make-time`
 *  is in divisions, rounded to the nearest whole one. */
function graceAttributes(grace: GraceNote, divisions: number): Record<string, string> {
	const attrs: Record<string, string> = {};
	if (grace.stealTimePrevious !== null) attrs['steal-time-previous'] = String(grace.stealTimePrevious);
	if (grace.stealTimeFollowing !== null) attrs['steal-time-following'] = String(grace.stealTimeFollowing);
	if (grace.makeTime !== null) attrs['make-time'] = String(Math.round(grace.makeTime * 4 * divisions));
	if (grace.slash) attrs.slash = 'yes';
	return attrs;
}

/** The model's right-hand barline for a resolved end-barline type: `normal`
 *  (and the `repeatStart` a boundary resolves to when the *next* measure
 *  opens a repeat, which that measure's own left barline draws) is none at
 *  all, which is what a plain measure boundary looks like in MusicXML. */
function rightBarlineMarkup(end: ReturnType<Score['endBarlineAt']>): BarlineMarkup | undefined {
	switch (end) {
		case 'double':
			return { style: 'light-light' };
		case 'final':
			return { style: 'light-heavy' };
		case 'repeatEnd':
			return { style: 'light-heavy', repeat: 'backward' };
		default:
			return undefined;
	}
}

interface BarlineMarkup {
	readonly style: string;
	readonly repeat?: 'forward' | 'backward';
}

/**
 * The `<barline>`s at one location: the model's own (`markup`), with the
 * first passthrough barline there merged into it (its attributes, and its
 * children slotted around the model's `<bar-style>`/`<repeat>`, minus any
 * `bar-style`/`repeat` of its own the model now states), then any further
 * passthrough barline as-is. With no model barline, the passthrough ones are
 * written as they were read.
 */
function writeBarlines(
	xml: XmlBuilder,
	markup: BarlineMarkup | undefined,
	extras: readonly OpaqueElement[],
	location: 'left' | 'right'
): void {
	if (!markup) {
		for (const el of extras) xml.element(el);
		return;
	}
	const merged = extras[0];
	const mergedChildren = merged
		? merged.children.filter((c) => c.name !== 'bar-style' && !(markup.repeat && c.name === 'repeat'))
		: NO_EXTRAS;
	xml.open('barline', { ...merged?.attrs, location });
	const slots = new SlotMerger(xml, mergedChildren, BARLINE_ORDER);
	slots.before('bar-style');
	xml.leaf('bar-style', markup.style);
	slots.before('repeat');
	if (markup.repeat) xml.selfClose('repeat', { direction: markup.repeat });
	slots.rest();
	xml.close('barline');
	for (let i = 1; i < extras.length; i++) xml.element(extras[i]!);
}

// --- Passthrough helpers ------------------------------------------------------

/**
 * Child order the MusicXML 4.0 schema fixes for each container export merges
 * passthrough into. Only the order matters (a name's index is its slot); a
 * name not listed sorts last.
 */
const NOTE_ORDER = slotOrder([
	'grace',
	'cue',
	'chord',
	'pitch',
	'unpitched',
	'rest',
	'duration',
	'tie',
	'instrument',
	'footnote',
	'level',
	'voice',
	'type',
	'dot',
	'accidental',
	'time-modification',
	'stem',
	'notehead',
	'notehead-text',
	'staff',
	'beam',
	'notations',
	'lyric',
	'play',
	'listen'
]);

const ATTRIBUTES_ORDER = slotOrder([
	'footnote',
	'level',
	'divisions',
	'key',
	'time',
	'staves',
	'part-symbol',
	'instruments',
	'clef',
	'staff-details',
	'transpose',
	'for-part',
	'directive',
	'measure-style'
]);

const BARLINE_ORDER = slotOrder([
	'bar-style',
	'footnote',
	'level',
	'wavy-line',
	'segno',
	'coda',
	'fermata',
	'ending',
	'repeat'
]);

const SCORE_PART_ORDER = slotOrder([
	'identification',
	'part-link',
	'part-name',
	'part-name-display',
	'part-abbreviation',
	'part-abbreviation-display',
	'group',
	'score-instrument',
	'player',
	'midi-device',
	'midi-instrument'
]);

const PART_GROUP_ORDER = slotOrder([
	'group-name',
	'group-name-display',
	'group-abbreviation',
	'group-abbreviation-display',
	'group-symbol',
	'group-barline',
	'group-time',
	'footnote',
	'level'
]);

function slotOrder(names: readonly string[]): ReadonlyMap<string, number> {
	return new Map(names.map((name, i) => [name, i]));
}

/**
 * Interleaves passthrough elements with the ones export writes itself, in
 * schema order. The caller announces each element it is about to write with
 * `before(name)`, which first writes every pending passthrough element whose
 * slot comes earlier; `rest()` writes whatever is left. A passthrough element
 * sharing a slot with the model's (an unmatched `<tie>` next to the model's
 * ties) therefore lands after it, and elements in one slot keep their order.
 */
class SlotMerger {
	readonly #pending: readonly OpaqueElement[];
	#next = 0;

	constructor(
		private readonly xml: XmlBuilder,
		extras: readonly OpaqueElement[],
		private readonly order: ReadonlyMap<string, number>
	) {
		this.#pending =
			extras.length < 2 ? extras : [...extras].sort((a, b) => this.#slot(a.name) - this.#slot(b.name));
	}

	before(name: string): void {
		if (this.#next >= this.#pending.length) return;
		const slot = this.#slot(name);
		while (this.#next < this.#pending.length && this.#slot(this.#pending[this.#next]!.name) < slot) {
			this.xml.element(this.#pending[this.#next++]!);
		}
	}

	rest(): void {
		while (this.#next < this.#pending.length) this.xml.element(this.#pending[this.#next++]!);
	}

	#slot(name: string): number {
		return this.order.get(name) ?? this.order.size;
	}
}

/**
 * A positional payload's division-valued children (`<offset>` in a
 * `<direction>`/`<harmony>`, `<duration>` in a `<figured-bass>`) scaled by
 * `factor`, the part's `<divisions>` over the one it was read under. 1 in the
 * usual case (`divisionsForPart` folds the source divisions in), which returns
 * the payload itself untouched; otherwise only the path to a changed value is
 * copied.
 */
function rescaleDivisionValues(el: OpaqueElement, factor: number): OpaqueElement {
	if (factor === 1) return el;
	if (el.children.length === 0) {
		if (el.name !== 'offset' && el.name !== 'duration') return el;
		const value = Number(el.text.trim());
		return Number.isFinite(value) && el.text.trim() !== '' ? { ...el, text: String(value * factor) } : el;
	}
	let changed = false;
	const scaled = el.children.map((c) => {
		const out = rescaleDivisionValues(c, factor);
		if (out !== c) changed = true;
		return out;
	});
	return changed ? { ...el, children: scaled } : el;
}

// --- Exact-fraction divisions ---------------------------------------------

/**
 * `<divisions>` (divisions per quarter note) for a part: the LCM of every
 * note's exact-fraction denominator, so multiplying any note's duration by it
 * lands on a whole number. A part with no notes at all falls back to 1, since
 * an LCM over nothing is undefined and `<divisions>` still has to be positive.
 *
 * Positional passthrough (M6 Slice 3) joins in twice: its onsets must land on
 * whole divisions too (a `<backup>` may have to reach one), and the
 * `<divisions>` it was read under is folded in so that, in the usual case,
 * the part keeps the source's own value and a `<direction>`'s `<offset>`
 * (counted in divisions) is written back untouched. When the LCM still comes
 * out a multiple of it (an edit introduced a finer subdivision),
 * `rescaleDivisionValues` scales those values instead.
 */
function divisionsForPart(
	notes: readonly Note[],
	anchors: readonly MeasurePassthrough[],
	clefChangeOnsets: readonly number[]
): number {
	let divisions = 1;
	for (const note of notes) {
		divisions = lcm(divisions, noteDurationQuarters(note).den);
		// A grace's `make-time` (M6 Slice 8) is written in divisions too.
		if (note.grace?.makeTime != null) divisions = lcm(divisions, quartersFromWholes(note.grace.makeTime).den);
	}
	for (const anchor of anchors) {
		divisions = lcm(divisions, wholesToQuarters(anchor.onset).den);
		divisions = lcm(divisions, anchor.divisions);
	}
	for (const onset of clefChangeOnsets) divisions = lcm(divisions, quartersFromWholes(onset).den);
	return divisions;
}

// --- XML builder --------------------------------------------------------

function escapeText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function formatAttrs(attrs: Readonly<Record<string, string>> | undefined): string {
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

	open(tag: string, attrs?: Readonly<Record<string, string>>): void {
		this.lines.push(`${this.indent}<${tag}${formatAttrs(attrs)}>`);
		this.depth++;
	}

	close(tag: string): void {
		this.depth--;
		this.lines.push(`${this.indent}</${tag}>`);
	}

	leaf(tag: string, text: string, attrs?: Readonly<Record<string, string>>): void {
		this.lines.push(`${this.indent}<${tag}${formatAttrs(attrs)}>${escapeText(text)}</${tag}>`);
	}

	selfClose(tag: string, attrs?: Readonly<Record<string, string>>): void {
		this.lines.push(`${this.indent}<${tag}${formatAttrs(attrs)}/>`);
	}

	/**
	 * A passthrough element (M6 Slice 3), verbatim: its attributes, then its
	 * children recursively, or its text if it has none. An element with
	 * children carried only indentation as text (MusicXML has no mixed
	 * content), which is regenerated here rather than copied.
	 */
	element(el: OpaqueElement): void {
		if (el.children.length > 0) {
			this.open(el.name, el.attrs);
			for (const c of el.children) this.element(c);
			this.close(el.name);
		} else if (el.text !== '') {
			this.leaf(el.name, el.text, el.attrs);
		} else {
			this.selfClose(el.name, el.attrs);
		}
	}

	toString(): string {
		return this.lines.join('\n') + '\n';
	}
}
