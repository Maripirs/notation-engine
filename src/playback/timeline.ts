import { measureCapacityWholes, type NoteId, type Pitch, type Score, type Staff } from '../model/index.js';
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
			for (const note of measure.notes) {
				perVoice.set(note.voice, (perVoice.get(note.voice) ?? 0) + note.durationWholes);
			}
			longest = Math.max(longest, ...perVoice.values());
		}
		cursor += longest > 0 ? longest : measureCapacityWholes(score.timeAt(index));
	}
	return starts;
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

	for (const staff of score.staves) {
		for (const voice of voicesInStaff(staff)) {
			let cursorWholes = 0;
			// Index into `events` of the still-accumulating event a tie chain is
			// extending, or `null` when nothing is currently open. At most one
			// event is ever open at a time per `(staff, voice)` pass, since a tie's
			// continuation is always the very next note in this same voice's walk.
			let openIndex: number | null = null;

			for (const measure of staff.measures) {
				cursorWholes = measureStarts[measure.index]!;
				for (const note of measure.notes) {
					if (note.voice !== voice) continue;

					if (note.isRest) {
						cursorWholes += note.durationWholes;
						openIndex = null;
						continue;
					}

					const noteDurationSeconds = durationToSeconds(note.durationWholes, bpm);
					const isTieContinuation = score.tiedFromNote(note.id) !== undefined;

					if (isTieContinuation && openIndex !== null) {
						const open = events[openIndex]!;
						events[openIndex] = { ...open, durationSeconds: open.durationSeconds + noteDurationSeconds };
					} else {
						events.push({
							noteId: note.id,
							// Non-null: `note.isRest` (pitch === null) was already handled above.
							pitch: note.pitch!,
							startSeconds: durationToSeconds(cursorWholes, bpm),
							durationSeconds: noteDurationSeconds
						});
						openIndex = events.length - 1;
					}

					cursorWholes += note.durationWholes;
					// Only a note that itself ties forward keeps its event open for a
					// following continuation to extend; anything else closes it, so a
					// later, unrelated note is never mistaken for a continuation just
					// because some earlier event happened to still be the "open" one.
					if (!note.isTied) openIndex = null;
				}
			}
		}
	}

	return events;
}
