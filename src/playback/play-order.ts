import type { Score } from '../model/index.js';

/**
 * One measure as it is played (M6 Slice 14): which measure index sounds, and
 * on which pass of its repeated section (1 for the first time through, and
 * for any measure outside a repeat).
 */
export interface PlayedMeasure {
	readonly measureIndex: number;
	readonly pass: number;
}

/**
 * The order `score`'s measures are played in, with repeats and voltas
 * unfolded. The rules, read off the top staff (every staff carries the same
 * barline and ending fields):
 *
 *  - A section opens at the score start, at a `repeatStart`, or right after a
 *    section closes (a `repeatEnd` taken for the last time, or an ending
 *    played on a later pass that runs on instead of jumping back). A
 *    `repeatEnd` jumps back to the open section's start while that section
 *    has been played fewer than `repeatTimes` (default 2) times; so it
 *    returns to the nearest `repeatStart` after the last completed repeat, or
 *    to the score start when there is none.
 *  - On pass k, a measure inside an ending whose numbers lack k is skipped,
 *    the whole ending with it (including any `repeatEnd` it holds).
 *  - Nested repeats are not modelled: a `repeatStart` always opens a new
 *    section, so an outer repeat returns only to the latest start inside it.
 *    The walk still ends (every jump advances the pass, and a capped number
 *    of measures is played whatever the input).
 *
 * The `repeatEnd` is read off `Measure.endBarline` directly, not through
 * `Score.endBarlineAt`: at a back-to-back `:||:` boundary the drawn barline
 * is the next measure's `repeatStart`, but this measure still closes its
 * section. A score with no repeats plays every measure once, in order.
 */
export function measurePlayOrder(score: Score): PlayedMeasure[] {
	const measureCount = Math.max(0, ...score.staves.map((staff) => staff.measures.length));
	const measures = score.staves[0]?.measures ?? [];
	// Each measure index's ending (its numbers and last measure), if any.
	const endingAt = new Map<number, { numbers: readonly number[]; last: number }>();
	for (const ending of score.endings()) {
		for (let i = ending.first; i <= ending.last; i++) endingAt.set(i, { numbers: ending.start.numbers, last: ending.last });
	}
	const timesAt = (i: number): number => Math.max(1, measures[i]?.repeatTimes ?? 2);
	const maxTimes = Math.max(2, ...measures.map((_, i) => timesAt(i)));
	const cap = measureCount * (maxTimes + 1);

	const order: PlayedMeasure[] = [];
	let sectionStart = 0;
	let pass = 1;
	let i = 0;
	while (i < measureCount && order.length < cap) {
		const measure = measures[i];
		if (measure?.startBarline === 'repeatStart' && i !== sectionStart) {
			sectionStart = i;
			pass = 1;
		}
		const ending = endingAt.get(i);
		if (ending && !ending.numbers.includes(pass)) {
			i = ending.last + 1;
			continue;
		}
		order.push({ measureIndex: i, pass });
		if (measure?.endBarline === 'repeatEnd') {
			if (pass < timesAt(i)) {
				pass++;
				i = sectionStart;
				continue;
			}
			sectionStart = i + 1;
			pass = 1;
		} else if (ending && ending.last === i && pass > 1) {
			// A later pass's ending that runs on: the section is done.
			sectionStart = i + 1;
			pass = 1;
		}
		i++;
	}
	return order;
}
