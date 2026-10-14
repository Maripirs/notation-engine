// Exact note durations for the MusicXML bridge.
//
// Export has always needed these (a `<divisions>` that makes every
// `<duration>` whole has to be derived from exact denominators, never from the
// float `Note.durationWholes`). Since M6 Slice 3 import needs them too: a
// passthrough element's onset is the exact time of the model events before it
// in its voice, and comparing onsets across an export -> import round trip
// only works if both sides count time the same exact way. So they live here,
// shared, rather than as a private copy in each file.

import type { Fraction, Note, NoteValue } from '../model/index.js';

/** A non-negative rational, `num / den`, kept reduced with `den > 0`. Exactly
 *  the model's `Fraction`; the alias names its use here (counting time). */
export type Rational = Fraction;

export const ZERO: Rational = { num: 0, den: 1 };

export function gcd(a: number, b: number): number {
	a = Math.abs(a);
	b = Math.abs(b);
	while (b !== 0) {
		[a, b] = [b, a % b];
	}
	return a === 0 ? 1 : a;
}

export function lcm(a: number, b: number): number {
	return (a / gcd(a, b)) * b;
}

export function reduce(r: Rational): Rational {
	const g = gcd(r.num, r.den);
	return { num: r.num / g, den: r.den / g };
}

export function mul(a: Rational, b: Rational): Rational {
	return reduce({ num: a.num * b.num, den: a.den * b.den });
}

export function add(a: Rational, b: Rational): Rational {
	return reduce({ num: a.num * b.den + b.num * a.den, den: a.den * b.den });
}

export function sub(a: Rational, b: Rational): Rational {
	return reduce({ num: a.num * b.den - b.num * a.den, den: a.den * b.den });
}

/** Negative, zero or positive as `a` is less than, equal to or greater than `b`. */
export function compare(a: Rational, b: Rational): number {
	return a.num * b.den - b.num * a.den;
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
export function noteDurationQuarters(note: Note): Rational {
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
export function quartersFromWholes(wholes: number): Rational {
	const quarters = wholes * 4;
	for (let den = 1; den <= 1024; den++) {
		const num = Math.round(quarters * den);
		if (Math.abs(num / den - quarters) < 1e-9) return reduce({ num, den });
	}
	return reduce({ num: Math.round(quarters * 1024), den: 1024 });
}

/** Quarters to the model's unit (whole notes), and back. */
export function quartersToWholes(quarters: Rational): Rational {
	return reduce({ num: quarters.num, den: quarters.den * 4 });
}

export function wholesToQuarters(wholes: Rational): Rational {
	return reduce({ num: wholes.num * 4, den: wholes.den });
}
