import {
	DYNAMIC_KINDS,
	eventArticulations,
	eventFermata,
	graceRuns,
	measureCapacityWholes,
	noteEvents,
	type Articulation,
	type DynamicKind,
	type Note,
	type NoteId,
	type Pitch,
	type Score,
	type Staff,
	type WedgeKind
} from '../model/index.js';
import { measurePlayOrder, type PlayedMeasure } from './play-order.js';
import { durationToSeconds } from './tempo.js';

/**
 * One sounding attack: a pitch starting at `startSeconds` and lasting
 * `durationSeconds`. A rest produces no `OnsetEvent` at all (it only advances
 * the cursor that gives the *next* note its `startSeconds`), and a tied-into
 * note (see `Score.tiedFromNote`) produces no event of its own either: its
 * duration is folded into the event of the note that tied into it, exactly
 * because a tie means "one continuous sound", not two. `pitch` is therefore
 * never `null` here, unlike `Note.pitch`.
 *
 * Deliberately just these four fields, matching the plan's own acceptance
 * criteria: no `staffIndex`/`voice` is carried, since nothing downstream of
 * this slice (a Web Audio scheduler, a later slice's job) needs to know which
 * staff or voice produced an onset, only when it sounds and for how long.
 */
export interface OnsetEvent {
	readonly noteId: NoteId;
	readonly pitch: Pitch;
	readonly startSeconds: number;
	readonly durationSeconds: number;
	/**
	 * Loudness relative to an ordinary note (M6 Slice 5): present only when
	 * it differs from 1, i.e. for an accented attack (`ACCENT_VELOCITY`,
	 * `MARCATO_VELOCITY`) and, since M6 Slice 6, for a note under a dynamic or
	 * hairpin (`DYNAMIC_LEVELS`, multiplied with the accent). `playOnsetEvent`
	 * scales its peak gain by it; the synth has no other notion of velocity,
	 * so this is the whole of it.
	 */
	readonly velocity?: number;
	/**
	 * Which played measure this attack falls in (M6 Slice 14): an index into
	 * `measurePlayOrder(score)`, telling the passes of a repeated note apart.
	 * Present only when the score's play order differs from its written order
	 * (it has a repeat that is taken), so a score without repeats keeps the
	 * exact events it had before.
	 */
	readonly playIndex?: number;
}

/**
 * How articulations and fermatas change playback (M6 Slice 5). Deliberately
 * a few fixed factors, not a performance model:
 *
 *  - A staccato note sounds for `STACCATO_FRACTION` of its written length, a
 *    staccatissimo for `STACCATISSIMO_FRACTION`, a detached-legato (tenuto
 *    plus staccato) for `DETACHED_LEGATO_FRACTION`; the rest of its time is
 *    silence, so the next onset is unchanged. A tenuto plays its full length,
 *    which is what every unmarked note already does in this synth (no gap
 *    between notes), so it changes nothing.
 *  - An accent multiplies the attack's `velocity` by `ACCENT_VELOCITY`, a
 *    marcato by `MARCATO_VELOCITY`.
 *  - A fermata stretches the span its note or rest occupies by
 *    `FERMATA_FACTOR`, for the *whole score*, not just its own voice: every
 *    voice on every staff sounding during that span is held with it, and
 *    everything after it starts later by the added time. Overlapping fermata
 *    spans (the usual case: every part has one on the same chord) are merged
 *    first so they stretch once, not once per voice.
 *
 * A mark on a chord applies to every head (`eventArticulations`/
 * `eventFermata`). Within a tie chain, each tied segment uses its own
 * event's marks, so a staccato on the last note of a tie shortens only that
 * segment's share.
 */
export const STACCATO_FRACTION = 0.5;
export const STACCATISSIMO_FRACTION = 0.25;
export const DETACHED_LEGATO_FRACTION = 0.75;
export const ACCENT_VELOCITY = 1.3;
export const MARCATO_VELOCITY = 1.5;
export const FERMATA_FACTOR = 2;

/**
 * How dynamics and hairpins change playback (M6 Slice 6): a loudness level
 * per staff, multiplied into each attack's `velocity` (with any accent's).
 * Deliberately simple and fixed:
 *
 *  - A plain dynamic sets the staff's level from `DYNAMIC_LEVELS` (pp 0.35,
 *    p 0.5, mp 0.62, mf 0.75, f 0.88, ff 1.0, ...), held until the staff's
 *    next dynamic. Music before a staff's first dynamic keeps level 1, the
 *    synth's own full level, so a score without dynamics sounds as before.
 *  - An accent dynamic (sf, sfz, sffz, fz, rf, rfz) is a momentary level for
 *    the attacks at its onset only (`DYNAMIC_ACCENTS`), after which the held
 *    level resumes. The combinations play both: fp/sfp/sfpp/sfzp attack at
 *    the first level and then hold the second.
 *  - `pf` (più forte) holds one ladder step above the level in force; `n`
 *    (niente) holds `NIENTE_LEVEL`.
 *  - A hairpin interpolates the held level linearly in written time from the
 *    level in force at its start to its target: the staff's next plain
 *    dynamic at or after its stop and before any later hairpin starts, else
 *    one ladder step up (crescendo) or down (diminuendo) from the start
 *    level. Past the stop the target is held until the next dynamic.
 *
 * Levels are per staff (all its voices), with no carry-over between staves.
 */
export const DYNAMIC_LEVELS: Readonly<Partial<Record<DynamicKind, number>>> = {
	pppppp: 0.1,
	ppppp: 0.14,
	pppp: 0.18,
	ppp: 0.25,
	pp: 0.35,
	p: 0.5,
	mp: 0.62,
	mf: 0.75,
	f: 0.88,
	ff: 1,
	fff: 1.1,
	ffff: 1.2,
	fffff: 1.3,
	ffffff: 1.4
};
/** Accent and combination dynamics: the attack level at their own onset,
 *  and the level held after (`undefined`: the previous level resumes). */
export const DYNAMIC_ACCENTS: Readonly<Partial<Record<DynamicKind, { attack: number; hold?: DynamicKind }>>> = {
	sf: { attack: 1 },
	sfz: { attack: 1 },
	fz: { attack: 1 },
	rf: { attack: 1 },
	rfz: { attack: 1 },
	sffz: { attack: 1.1 },
	fp: { attack: 0.88, hold: 'p' },
	sfp: { attack: 1, hold: 'p' },
	sfpp: { attack: 1, hold: 'pp' },
	sfzp: { attack: 1, hold: 'p' }
};
export const NIENTE_LEVEL = 0.05;

/**
 * How grace notes play (M6 Slice 8). Every grace plays *on the beat*,
 * stealing its time from the start of its principal (the classical rule, and
 * the one MusicXML's `steal-time-following` describes), so nothing before the
 * principal moves and the principal starts late by the run's total:
 *
 *  - A lone grace without a slash (an appoggiatura) takes half its
 *    principal (`APPOGGIATURA_FRACTION`), two thirds before a dotted
 *    principal (`DOTTED_APPOGGIATURA_FRACTION`), the C. P. E. Bach / Türk
 *    rule every engraving guide repeats.
 *  - Anything else (an acciaccatura, or a run of two or more graces, which
 *    is played quick whatever its slashes) gives each grace
 *    `ACCIACCATURA_WHOLES` (a 32nd), shrunk so the run never takes more than
 *    `GRACE_RUN_MAX_FRACTION` of the principal.
 *  - A grace stating `steal-time-following` takes that percentage of its
 *    principal instead. `steal-time-previous` and `make-time` are kept for
 *    the round trip but not played (a grace before the beat would shorten a
 *    note in another measure).
 *  - Whatever the rules add up to, a run takes at most
 *    `GRACE_TOTAL_MAX_FRACTION` of its principal (scaled down evenly), so the
 *    principal is always heard.
 *
 * A run with no principal in its measure (OMR writes a grace for the next
 * downbeat at the end of the bar) ornaments its voice's first event in the
 * next measure. A grace never opens a tie chain; graces play at the
 * principal's dynamic level, without its articulations.
 */
export const APPOGGIATURA_FRACTION = 1 / 2;
export const DOTTED_APPOGGIATURA_FRACTION = 2 / 3;
export const ACCIACCATURA_WHOLES = 1 / 32;
export const GRACE_RUN_MAX_FRACTION = 1 / 2;
export const GRACE_TOTAL_MAX_FRACTION = 3 / 4;

/** Each grace's played length in written wholes, for a run before a
 *  principal lasting `principalWholes` (see `APPOGGIATURA_FRACTION`). */
export function graceLengthsWholes(graces: readonly Note[], principal: Note): number[] {
	const principalWholes = principal.durationWholes;
	const lone = graces.length === 1 && !graces[0]!.grace!.slash;
	const lengths = graces.map((grace) => {
		const stated = grace.grace!.stealTimeFollowing;
		if (stated !== null) return (Math.max(0, stated) / 100) * principalWholes;
		if (lone) return principalWholes * (principal.dots > 0 ? DOTTED_APPOGGIATURA_FRACTION : APPOGGIATURA_FRACTION);
		return Math.min(ACCIACCATURA_WHOLES, (principalWholes * GRACE_RUN_MAX_FRACTION) / graces.length);
	});
	const total = lengths.reduce((a, b) => a + b, 0);
	const cap = principalWholes * GRACE_TOTAL_MAX_FRACTION;
	return total > cap && total > 0 ? lengths.map((l) => (l * cap) / total) : lengths;
}

/** The plain ladder, softest first, for one-step moves. */
const LADDER: readonly DynamicKind[] = DYNAMIC_KINDS.filter((kind) => DYNAMIC_LEVELS[kind] !== undefined);

/** The ladder level one step from `level` (`dir` +1 louder, -1 softer). */
function stepLevel(level: number, dir: 1 | -1): number {
	const levels = LADDER.map((kind) => DYNAMIC_LEVELS[kind]!);
	if (dir > 0) return levels.find((l) => l > level + 1e-9) ?? level;
	return [...levels].reverse().find((l) => l < level - 1e-9) ?? level;
}

/**
 * One staff's loudness over written time (wholes from the top of the
 * unfolded score): `at(x)` is the level for an attack at `x`. Marks are
 * placed once per pass, so the level in force is whatever was last set in
 * played order (a repeat's first bar takes the level its own last bar left). Built once per staff from its
 * dynamics and hairpins; see `DYNAMIC_LEVELS` for the rules.
 */
function staffDynamics(
	score: Score,
	staffIndex: number,
	order: readonly PlayedMeasure[],
	playStarts: readonly number[]
): ((x: number) => number) | null {
	const staff = score.staves[staffIndex]!;
	const marks: { x: number; kind: DynamicKind }[] = [];
	order.forEach(({ measureIndex }, k) => {
		for (const mark of staff.measures[measureIndex]?.dynamics ?? []) marks.push({ x: playStarts[k]! + mark.onset, kind: mark.kind });
	});
	// A hairpin plays from each pass through its start measure to the next
	// played occurrence of its stop measure; one cut off by a jump back is
	// dropped (skipping an ending forward does not cut it).
	const wedges: { kind: WedgeKind; start: number; stop: number }[] = [];
	for (const w of score.wedges) {
		if (w.staffIndex !== staffIndex) continue;
		order.forEach(({ measureIndex }, k) => {
			if (measureIndex !== w.start.measureIndex) return;
			for (let j = k; j < order.length; j++) {
				if (j > k && order[j]!.measureIndex <= order[j - 1]!.measureIndex) return;
				if (order[j]!.measureIndex !== w.stop.measureIndex) continue;
				wedges.push({ kind: w.kind, start: playStarts[k]! + w.start.onset, stop: playStarts[j]! + w.stop.onset });
				return;
			}
		});
	}
	wedges.sort((a, b) => a.start - b.start);
	if (marks.length === 0 && wedges.length === 0) return null;
	marks.sort((a, b) => a.x - b.x);

	// Held-level breakpoints: (x, level) steps, then hairpin ramps over them.
	const steps: { x: number; level: number }[] = [];
	const accents = new Map<number, number>();
	let level = 1;
	for (const { x, kind } of marks) {
		const plain = DYNAMIC_LEVELS[kind];
		const accent = DYNAMIC_ACCENTS[kind];
		if (plain !== undefined) level = plain;
		else if (accent) {
			accents.set(Math.round(x * 1e9), accent.attack);
			if (accent.hold) level = DYNAMIC_LEVELS[accent.hold]!;
		} else if (kind === 'pf') level = stepLevel(level, 1);
		else if (kind === 'n') level = NIENTE_LEVEL;
		steps.push({ x, level });
	}
	// The held level in force at x, before any hairpin.
	const heldAt = (x: number): number => {
		let found = 1;
		for (const step of steps) {
			if (step.x > x + 1e-9) break;
			found = step.level;
		}
		return found;
	};
	const ramps = wedges.map((wedge, i) => {
		const from = heldAt(wedge.start);
		const nextStart = wedges[i + 1]?.start ?? Number.POSITIVE_INFINITY;
		const target = marks.find(
			(m) => m.x >= wedge.stop - 1e-9 && m.x < nextStart - 1e-9 && DYNAMIC_LEVELS[m.kind] !== undefined
		);
		const to = target ? DYNAMIC_LEVELS[target.kind]! : stepLevel(from, wedge.kind === 'crescendo' ? 1 : -1);
		return { ...wedge, from, to };
	});
	return (x) => {
		const accent = accents.get(Math.round(x * 1e9));
		if (accent !== undefined) return accent;
		// Whatever was set last at or before x: a dynamic, or a hairpin start
		// (which wins a tie with a dynamic at its own onset, the `p<` shape).
		let lastStep: { x: number; level: number } | undefined;
		for (const step of steps) {
			if (step.x > x + 1e-9) break;
			lastStep = step;
		}
		let lastRamp: (typeof ramps)[number] | undefined;
		for (const ramp of ramps) {
			if (ramp.start > x + 1e-9) break;
			lastRamp = ramp;
		}
		if (lastRamp && (!lastStep || lastStep.x <= lastRamp.start + 1e-9)) {
			if (x >= lastRamp.stop) return lastRamp.to;
			return lastRamp.from + ((lastRamp.to - lastRamp.from) * (x - lastRamp.start)) / (lastRamp.stop - lastRamp.start);
		}
		return lastStep?.level ?? 1;
	};
}

/** The fraction of its written length an event with these marks sounds for. */
function soundingFraction(marks: readonly Articulation[]): number {
	if (marks.includes('staccatissimo')) return STACCATISSIMO_FRACTION;
	if (marks.includes('staccato')) return STACCATO_FRACTION;
	if (marks.includes('detached-legato')) return DETACHED_LEGATO_FRACTION;
	return 1;
}

function attackVelocity(marks: readonly Articulation[]): number {
	if (marks.includes('strong-accent')) return MARCATO_VELOCITY;
	if (marks.includes('accent')) return ACCENT_VELOCITY;
	return 1;
}

/**
 * Every distinct `Note.voice` value present across `staff`'s own measures, in
 * first-seen order. A staff's voices are not assumed to be `1`/`2`: nothing
 * stops a single staff carrying 3 or more (see `computePlaybackTimeline`'s
 * own comment), so this scans rather than hardcoding a fixed set. A plain
 * `Set` is used purely for its `add`-is-a-no-op-on-a-duplicate behaviour;
 * like every other `Set`/`Map`/array in this file, its iteration order is
 * insertion order, so "first-seen order" falls out for free rather than
 * needing a second pass to sort.
 */
/**
 * How long each measure index lasts, in whole notes.
 *
 * A measure lasts as long as its longest voice on any staff (so a pickup or
 * an under-full measure is not padded to the time signature), falling back to
 * the time signature's capacity when no staff has any notes there. Measure
 * starts (these lengths laid end to end in play order) are shared by every
 * staff and voice, which is what keeps a voice
 * that is silent for several measures (has no notes at all there, not even
 * rests) from drifting: it re-anchors to the right bar line each measure
 * instead of resuming from wherever its own last note left off.
 */
function measureLengthsWholes(score: Score): number[] {
	const measureCount = Math.max(0, ...score.staves.map((staff) => staff.measures.length));
	const lengths: number[] = [];
	for (let index = 0; index < measureCount; index++) {
		let longest = 0;
		for (const staff of score.staves) {
			const measure = staff.measures[index];
			if (!measure) continue;
			const perVoice = new Map<number, number>();
			// Per event, not per note: a chord's heads share one duration.
			for (const [anchor] of noteEvents(measure.notes)) {
				perVoice.set(anchor!.voice, (perVoice.get(anchor!.voice) ?? 0) + anchor!.durationWholes);
			}
			longest = Math.max(longest, ...perVoice.values());
		}
		lengths.push(longest > 0 ? longest : measureCapacityWholes(score.timeAt(index)));
	}
	return lengths;
}

/**
 * The score's fermata spans as a time warp: `warp(x)` maps a written
 * position (wholes from the top of the unfolded score, see
 * `computePlaybackTimeline`) to a played one (one span per pass), adding
 * `FERMATA_FACTOR - 1` times however much of every fermata span lies before
 * `x`. Spans are merged first (see the constants' comment above), so two
 * voices' fermatas on one chord stretch it once. Identity (`x => x`) when the
 * score has none, the common case.
 */
function fermataWarp(score: Score, order: readonly PlayedMeasure[], playStarts: readonly number[]): (x: number) => number {
	const spans: [number, number][] = [];
	for (const staff of score.staves) {
		for (let k = 0; k < order.length; k++) {
			const measure = staff.measures[order[k]!.measureIndex];
			if (!measure) continue;
			const cursors = new Map<number, number>();
			for (const chord of noteEvents(measure.notes)) {
				const anchor = chord[0]!;
				const start = cursors.get(anchor.voice) ?? playStarts[k]!;
				const end = start + anchor.durationWholes;
				cursors.set(anchor.voice, end);
				if (eventFermata(chord) !== null && end > start) spans.push([start, end]);
			}
		}
	}
	if (spans.length === 0) return (x) => x;
	spans.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const [start, end] of spans) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return (x) => {
		let added = 0;
		for (const [start, end] of merged) {
			if (x <= start) break;
			added += (Math.min(x, end) - start) * (FERMATA_FACTOR - 1);
		}
		return x + added;
	};
}

function voicesInStaff(staff: Staff): number[] {
	const voices = new Set<number>();
	for (const measure of staff.measures) {
		for (const note of measure.notes) {
			voices.add(note.voice);
		}
	}
	return [...voices];
}

/**
 * Walk `score`'s notes in true playback order and produce a flat list of
 * onset events: when each pitched note starts sounding and for how long, in
 * real seconds at `score.tempoBpm`.
 *
 * This is deliberately *not* built on `Score.notesInOrder()`: that method
 * flattens one staff's measures into a single array with every voice's notes
 * interleaved in append order (see its own doc comment), which answers "what
 * order do these two notes appear in the model" (what a slur's span needs),
 * not "when does each one sound" (what this function needs). A two-voice
 * measure's `measure.notes` holds voice 1's notes in order, then voice 2's,
 * not interleaved by onset (`createTwoVoiceShowcaseScore` in
 * `src/demo-score.ts` is exactly this shape), so onset order can only be
 * recovered by walking one `(staffIndex, voice)` pair at a time, each with
 * its own timeline.
 *
 * Each `(staffIndex, voice)` pair present in the score gets its own
 * independent pass: a running `cursorWholes` counts that voice's own elapsed
 * duration alone, starting at 0 and advanced by every note or rest's own
 * `durationWholes` as it is passed, whether or not that note produces an
 * event. Converting the cursor through `durationToSeconds` at the moment a
 * note is reached is what gives it its `startSeconds`; since every voice's
 * (and every staff's) cursor starts at the same 0, two voices that both open
 * on the downbeat land their first event's `startSeconds` at the same value
 * automatically, with no separate cross-voice synchronization step needed
 * (`layoutScore` in `src/layout/layout.ts` already guarantees every staff has
 * the same measure count, so this walk never has to reconcile a ragged
 * staff against another).
 *
 * A rest advances `cursorWholes` but produces no event. A pitched note that
 * `score.tiedFromNote(note.id)` reports as a tie's receiving end is a
 * continuation, not a new attack: its `durationSeconds` is folded onto the
 * event still open from the tie's source note (working for a chain of 3 or
 * more tied notes, not just a pair, since the open event stays open across
 * every consecutive continuation) rather than starting a fresh event. A note
 * that is not a continuation always starts a fresh event; if it is itself
 * `isTied` (ties forward), that fresh event is left open so the very next
 * note, if it continues the tie, extends it, otherwise it is already a
 * closed, complete event.
 *
 * Chords (M6 Slice 2) are walked as events (`noteEvents`): every head of a
 * chord gets its own `OnsetEvent` at the same `startSeconds`, all lasting the
 * anchor's duration, and the cursor advances once per chord. A tied chord
 * keeps one open event per head, each extended only by its own head's tie
 * target.
 *
 * Articulations and fermatas (M6 Slice 5) shape the result as described at
 * `STACCATO_FRACTION`: positions are first computed in written wholes, then
 * passed through the fermata warp, then turned into seconds.
 *
 * Repeats and voltas (M6 Slice 14) are unfolded: the measures play in
 * `measurePlayOrder` order, laid end to end, so a repeated note has one event
 * per pass (same `noteId`, later `startSeconds`, and `playIndex` telling them
 * apart). A jump breaks every tie chain: a note tied over the jump ends at its
 * own length, and its target, reached later, starts a fresh event. Fermatas,
 * dynamics, hairpins and graces left at a bar's end apply per pass, in played
 * order.
 *
 * The returned array's order falls out of construction (staves in
 * `score.staves` order, each staff's voices in first-seen order, each
 * voice's notes in measure-then-position order) rather than from an explicit
 * sort: every loop here is over a plain array or a `Set`, both insertion-
 * ordered in JS, so the result is deterministic without needing a
 * `startSeconds` sort of its own. Callers should still key any ordering
 * assumption of their own off each event's own `startSeconds`, not off array
 * position: cross-`(staffIndex, voice)` interleaving is not itself
 * meaningful, only each event's own timing is.
 */
export function computePlaybackTimeline(score: Score): OnsetEvent[] {
	const bpm = score.tempoBpm;
	const events: OnsetEvent[] = [];
	// The measures in played order (M6 Slice 14), laid end to end: each
	// occurrence of a measure starts where the previous played one ended.
	const order = measurePlayOrder(score);
	const lengths = measureLengthsWholes(score);
	const playStarts: number[] = [];
	let playCursor = 0;
	for (const { measureIndex } of order) {
		playStarts.push(playCursor);
		playCursor += lengths[measureIndex]!;
	}
	const unfolded = order.some((played, k) => played.measureIndex !== k) || order.length !== lengths.length;
	const warp = fermataWarp(score, order, playStarts);
	const seconds = (wholes: number): number => durationToSeconds(wholes, bpm);

	for (const staff of score.staves) {
		// The staff's dynamics (M6 Slice 6), or `null` for none.
		const dynamicLevel = staffDynamics(score, staff.index, order, playStarts);
		for (const voice of voicesInStaff(staff)) {
			let cursorWholes = 0;
			// The still-accumulating events tie chains are extending, keyed by
			// the id of the note each one expects next (the tie's target), so a
			// continuation finds exactly the event its own source opened. Keyed
			// rather than a single "open" slot since M6 Slice 2: a tied chord
			// keeps one tie chain open per head at once, and each head's
			// continuation must extend its own head's event, not a neighbour's.
			let openByTarget = new Map<NoteId, number>();
			// Grace notes (M6 Slice 8) waiting for their principal: a run before
			// an event in this measure, or one left over from the end of the
			// previous measure (see `APPOGGIATURA_FRACTION`).
			let pendingGraces: Note[] = [];

			for (let k = 0; k < order.length; k++) {
				const measure = staff.measures[order[k]!.measureIndex];
				if (!measure) continue;
				// A jump (a repeat taken, or an ending skipped) breaks every tie
				// chain: the note it was waiting for is not what plays next.
				if (k > 0 && order[k]!.measureIndex !== order[k - 1]!.measureIndex + 1) openByTarget = new Map();
				const at = unfolded ? { playIndex: k } : {};
				cursorWholes = playStarts[k]!;
				const gracesBefore = new Map<NoteId, readonly Note[]>();
				const trailingGraces: Note[] = [];
				for (const run of graceRuns(measure.notes)) {
					if (run.voice !== voice) continue;
					if (run.principal) gracesBefore.set(run.principal.id, run.notes);
					else trailingGraces.push(...run.notes);
				}
				// One step per event (M6 Slice 2), not per note: every head of a
				// chord sounds at the same `cursorWholes`, and the cursor
				// advances once by the anchor's duration after all of them.
				for (const chord of noteEvents(measure.notes)) {
					const anchor = chord[0]!;
					if (anchor.voice !== voice) continue;
					const stillOpen = new Map<NoteId, number>();
					// Played span of this event (the fermata warp applied), and
					// how much of it sounds (a staccato's shortening).
					const marks = eventArticulations(chord);
					const level = dynamicLevel ? dynamicLevel(cursorWholes) : 1;
					// Grace notes before this event play from its onset, and the
					// event itself starts once they are done.
					const graces = [...pendingGraces, ...(gracesBefore.get(anchor.id) ?? [])];
					pendingGraces = [];
					let stolenWholes = 0;
					if (graces.length > 0) {
						const lengths = graceLengthsWholes(graces, anchor);
						graces.forEach((grace, i) => {
							const from = cursorWholes + stolenWholes;
							const to = from + lengths[i]!;
							const graceStart = seconds(warp(from));
							events.push({
								noteId: grace.id,
								pitch: grace.pitch!,
								startSeconds: graceStart,
								durationSeconds: seconds(warp(to)) - graceStart,
								...(level !== 1 ? { velocity: level } : {}),
								...at
							});
							stolenWholes = to - cursorWholes;
						});
					}
					const startSeconds = seconds(warp(cursorWholes + stolenWholes));
					const spanSeconds = seconds(warp(cursorWholes + anchor.durationWholes)) - startSeconds;
					const velocity = attackVelocity(marks) * level;

					for (const note of chord) {
						if (note.isRest) continue;
						// A member's own `value` only picks its notehead; the
						// chord's duration is the anchor's.
						const noteDurationSeconds = spanSeconds * soundingFraction(marks);
						const openIndex = openByTarget.get(note.id);

						let eventIndex: number;
						if (openIndex !== undefined) {
							const open = events[openIndex]!;
							events[openIndex] = { ...open, durationSeconds: open.durationSeconds + noteDurationSeconds };
							eventIndex = openIndex;
						} else {
							events.push({
								noteId: note.id,
								// Non-null: rests were skipped above.
								pitch: note.pitch!,
								startSeconds,
								durationSeconds: noteDurationSeconds,
								...(velocity !== 1 ? { velocity } : {}),
								...at
							});
							eventIndex = events.length - 1;
						}
						// Only a note that itself ties forward keeps its event open,
						// and only for its own tie target; anything else closes it,
						// so a later, unrelated note is never mistaken for a
						// continuation.
						if (note.tiedToId !== null) stillOpen.set(note.tiedToId, eventIndex);
					}

					openByTarget = stillOpen;
					cursorWholes += anchor.durationWholes;
				}
				pendingGraces.push(...trailingGraces);
			}
		}
	}

	return events;
}

/**
 * Where playback should start to play from `noteId` (M6 Slice 15): the
 * `startSeconds` of its earliest event, so a note inside a repeat starts at
 * its first pass, not a later one. Hand the result to `PlaybackEngine.seek`.
 * `undefined` when the note has no event of its own: a rest, or a note only
 * reached as a tie's continuation (it sounds inside its source's event; on a
 * later pass entered by a jump it can strike afresh, and that is then what
 * this returns).
 */
export function firstOnsetSeconds(events: readonly OnsetEvent[], noteId: NoteId): number | undefined {
	let first: number | undefined;
	for (const event of events) {
		if (event.noteId === noteId && (first === undefined || event.startSeconds < first)) first = event.startSeconds;
	}
	return first;
}
