import {
	eventArticulations,
	eventFermata,
	measureCapacityWholes,
	noteEvents,
	type Articulation,
	type NoteId,
	type Pitch,
	type Score,
	type Staff
} from '../model/index.js';
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
	 * Loudness relative to an ordinary note (M6 Slice 5): present only for an
	 * accented attack (`ACCENT_VELOCITY`, `MARCATO_VELOCITY`), absent meaning
	 * 1. `playOnsetEvent` scales its peak gain by it; the synth has no other
	 * notion of velocity, so this is the whole of it.
	 */
	readonly velocity?: number;
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
 * Where each measure index starts, in whole notes from the top of the score.
 *
 * A measure lasts as long as its longest voice on any staff (so a pickup or
 * an under-full measure is not padded to the time signature), falling back to
 * the time signature's capacity when no staff has any notes there. Measure
 * starts are shared by every staff and voice, which is what keeps a voice
 * that is silent for several measures (has no notes at all there, not even
 * rests) from drifting: it re-anchors to the right bar line each measure
 * instead of resuming from wherever its own last note left off.
 */
function measureStartsWholes(score: Score): number[] {
	const measureCount = Math.max(0, ...score.staves.map((staff) => staff.measures.length));
	const starts: number[] = [];
	let cursor = 0;
	for (let index = 0; index < measureCount; index++) {
		starts.push(cursor);
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
		cursor += longest > 0 ? longest : measureCapacityWholes(score.timeAt(index));
	}
	return starts;
}

/**
 * The score's fermata spans as a time warp: `warp(x)` maps a written
 * position (wholes from the top of the score) to a played one, adding
 * `FERMATA_FACTOR - 1` times however much of every fermata span lies before
 * `x`. Spans are merged first (see the constants' comment above), so two
 * voices' fermatas on one chord stretch it once. Identity (`x => x`) when the
 * score has none, the common case.
 */
function fermataWarp(score: Score, measureStarts: readonly number[]): (x: number) => number {
	const spans: [number, number][] = [];
	for (const staff of score.staves) {
		for (const measure of staff.measures) {
			const cursors = new Map<number, number>();
			for (const chord of noteEvents(measure.notes)) {
				const anchor = chord[0]!;
				const start = cursors.get(anchor.voice) ?? measureStarts[measure.index]!;
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
	const measureStarts = measureStartsWholes(score);
	const warp = fermataWarp(score, measureStarts);
	const seconds = (wholes: number): number => durationToSeconds(wholes, bpm);

	for (const staff of score.staves) {
		for (const voice of voicesInStaff(staff)) {
			let cursorWholes = 0;
			// The still-accumulating events tie chains are extending, keyed by
			// the id of the note each one expects next (the tie's target), so a
			// continuation finds exactly the event its own source opened. Keyed
			// rather than a single "open" slot since M6 Slice 2: a tied chord
			// keeps one tie chain open per head at once, and each head's
			// continuation must extend its own head's event, not a neighbour's.
			let openByTarget = new Map<NoteId, number>();

			for (const measure of staff.measures) {
				cursorWholes = measureStarts[measure.index]!;
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
					const startSeconds = seconds(warp(cursorWholes));
					const spanSeconds = seconds(warp(cursorWholes + anchor.durationWholes)) - startSeconds;
					const velocity = attackVelocity(marks);

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
								...(velocity !== 1 ? { velocity } : {})
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
			}
		}
	}

	return events;
}
