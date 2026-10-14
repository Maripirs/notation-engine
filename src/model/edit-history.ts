// A bounded undo/redo stack of whole-`Score` snapshots.
//
// The engine's edit loop mutates a live `Score` in place (see `Score`'s own
// header): an edit is a field assignment, and the edit op reports which
// measure it touched so the caller can re-lay-out just that region. That is
// great for redraw cost, but it means there is no natural "previous state" to
// go back to. `EditHistory` supplies one by cloning the whole score around
// each edit.
//
// Why whole-score snapshots rather than a log of inverse operations: Phase 0
// has exactly one edit op (`transposeNote`), and `Score.clone` is O(notes)
// and id-preserving, so a snapshot is cheap and always correct. An
// operation-log undo would need every future edit op to also define its exact
// inverse, which is a much bigger commitment than this slice needs. If
// snapshot memory ever matters, the `cap` bound already caps it.
//
// Ownership / snapshot discipline (the two design calls the plan asks to be
// stated explicitly):
//
//  1. `EditHistory` owns the live `Score`. `current` returns it; callers edit
//     it *only* through `record`, which is the sole entry point that knows to
//     snapshot first.
//  2. Snapshots are clones on the way in. `record` clones `current` *before*
//     handing the live score to `edit`, so the stored snapshot can never be
//     reached by that edit. On the way out, `undo`/`redo` do NOT clone: the
//     score they return simply *becomes* the new live `current` (it has left
//     both stacks, so nothing else references it), and the next `record`
//     clones it like any other current state. So a caller can keep editing a
//     score returned by `undo`/`redo` through `record` without corrupting any
//     snapshot still on a stack.
//
// `dirty` is defined against a saved *baseline* snapshot, compared by musical
// content (`assertScoresEquivalent`), not object identity: undoing back to the
// state that was last `markSaved()` clears `dirty` again even though the
// score object is a different clone.

import { assertScoresEquivalent } from './score-equivalence.js';
import type { Score } from './score.js';

export interface EditHistoryOptions {
	/** Maximum number of undoable steps kept. Recording past this drops the
	 *  oldest snapshot. Default 100. */
	readonly cap?: number;
}

const DEFAULT_CAP = 100;

export class EditHistory {
	readonly #cap: number;
	/** The live current score. Owned here; mutated only via `record`. */
	#current: Score;
	/** Snapshots of states *before* each kept edit, oldest first. */
	readonly #undoStack: Score[] = [];
	/** Snapshots of states undone away from, most-recently-undone last. */
	readonly #redoStack: Score[] = [];
	/** The state `markSaved()` last blessed as "on disk". Compared to
	 *  `#current` by musical content to answer `dirty`. */
	#savedBaseline: Score;

	constructor(initial: Score, options: EditHistoryOptions = {}) {
		this.#cap = Math.max(1, Math.floor(options.cap ?? DEFAULT_CAP));
		// Two independent clones: `initial` is never retained, and the baseline
		// must not alias `#current`.
		this.#current = initial.clone();
		this.#savedBaseline = this.#current.clone();
	}

	/** The live current score. Edit it only through `record`. */
	get current(): Score {
		return this.#current;
	}

	/**
	 * Snapshot `current`, run `edit` against the live score, and keep the
	 * snapshot on the undo stack only if `edit` reports a change. "Reports a
	 * change" means it returned something other than `null`, `undefined` or
	 * `false` (so `transposeNote` returning measure index `0` still counts).
	 * Keeping a snapshot clears the redo stack and, past `cap`, drops the
	 * oldest snapshot. Returns whatever `edit` returned, so a caller can still
	 * read e.g. the changed measure index from `transposeNote`.
	 */
	record<T>(edit: (score: Score) => T): T {
		const snapshot = this.#current.clone();
		const result = edit(this.#current);
		if (result !== null && result !== undefined && (result as unknown) !== false) {
			this.#undoStack.push(snapshot);
			if (this.#undoStack.length > this.#cap) this.#undoStack.shift();
			this.#redoStack.length = 0;
		}
		return result;
	}

	/** Restore the previous snapshot; returns the new `current`, or `null` if
	 *  there is nothing to undo. */
	undo(): Score | null {
		const previous = this.#undoStack.pop();
		if (previous === undefined) return null;
		this.#redoStack.push(this.#current);
		this.#current = previous;
		return this.#current;
	}

	/** Re-apply the last undone snapshot; returns the new `current`, or `null`
	 *  if there is nothing to redo. */
	redo(): Score | null {
		const next = this.#redoStack.pop();
		if (next === undefined) return null;
		this.#undoStack.push(this.#current);
		this.#current = next;
		return this.#current;
	}

	get canUndo(): boolean {
		return this.#undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.#redoStack.length > 0;
	}

	/** Mark the current state as the saved baseline, so `dirty` reads false
	 *  until the score next diverges from it. */
	markSaved(): void {
		this.#savedBaseline = this.#current.clone();
	}

	/** Whether `current` differs, in musical content, from the last
	 *  `markSaved()` baseline (the initial state if `markSaved` was never
	 *  called). Compared with `assertScoresEquivalent`, not object identity. */
	get dirty(): boolean {
		try {
			assertScoresEquivalent(this.#current, this.#savedBaseline);
			return false;
		} catch {
			return true;
		}
	}
}
