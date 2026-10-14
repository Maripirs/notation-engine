import { describe, expect, it } from 'vitest';
import {
	createBarlineShowcaseScore,
	createDurationShowcaseScore,
	createFullDemoScore,
	createKeyTimeChangeShowcaseScore,
	createSatbBracketShowcaseScore,
	createSlurShowcaseScore,
	createTieShowcaseScore,
	createTwoVoiceShowcaseScore
} from '../demo-score.js';
import { assertScoresEquivalent, buildScore, parsePitch, Score } from '../model/index.js';
import { exportMusicXml } from './musicxml-export.js';
import { importMusicXml } from './musicxml-import.js';

// --- Test-local XML tooling ----------------------------------------------
//
// A whole-document well-formedness check plus a few tiny query helpers, all
// test-only: the point is to prove the emitter's own strings hang together
// (every tag closed, in the right nesting, every attribute quoted) without
// pulling in a parser or a schema validator, and to make the structural
// assertions below read as questions about the tree rather than string
// bashing. `assertWellFormed` walks the raw string once, skipping the XML
// declaration and the DOCTYPE, matching every tag against one regex (which
// only accepts quoted attribute values), and keeping a stack so a close tag
// that does not match the top, or any tag still open at the end, throws.

const TAG = /^<(\/?)([A-Za-z][\w-]*)((?:\s+[A-Za-z_][\w-]*="[^"<]*")*)\s*(\/?)>/;

function assertWellFormed(xml: string): void {
	const stack: string[] = [];
	let i = 0;
	while (i < xml.length) {
		const lt = xml.indexOf('<', i);
		if (lt === -1) break;
		if (xml.startsWith('<?', lt)) {
			const end = xml.indexOf('?>', lt);
			if (end === -1) throw new Error('unterminated processing instruction');
			i = end + 2;
			continue;
		}
		if (xml.startsWith('<!', lt)) {
			const end = xml.indexOf('>', lt);
			if (end === -1) throw new Error('unterminated markup declaration');
			i = end + 1;
			continue;
		}
		const match = TAG.exec(xml.slice(lt));
		if (!match) {
			throw new Error(`malformed tag (or unquoted attribute) near: ${xml.slice(lt, lt + 48)}`);
		}
		const [full, slash, name, , selfClose] = match;
		if (slash) {
			const top = stack.pop();
			if (top !== name) throw new Error(`</${name}> closes <${top ?? 'nothing'}>`);
		} else if (!selfClose) {
			stack.push(name!);
		}
		i = lt + full.length;
	}
	if (stack.length > 0) throw new Error(`unclosed tags at end: ${stack.join(', ')}`);
}

/** Count non-overlapping matches of `re` (which must be global) in `xml`. */
function count(xml: string, re: RegExp): number {
	return (xml.match(re) ?? []).length;
}

/** Every `<name ...>...</name>` substring, in document order. `name` is
 *  assumed never to nest inside itself (true for `part`/`measure`/`attributes`/
 *  `note`/`backup` here), so a flat open/close scan is enough. */
function blocksOf(xml: string, name: string): string[] {
	const tokens = /<(\/?)([A-Za-z][\w-]*)(?:\s+[A-Za-z_][\w-]*="[^"<]*")*\s*(\/?)>/g;
	const blocks: string[] = [];
	let openStart = -1;
	let token: RegExpExecArray | null;
	while ((token = tokens.exec(xml)) !== null) {
		const [, slash, tagName, selfClose] = token;
		if (tagName !== name) continue;
		if (!slash && !selfClose) openStart = token.index;
		else if (slash && openStart !== -1) {
			blocks.push(xml.slice(openStart, tokens.lastIndex));
			openStart = -1;
		}
	}
	return blocks;
}

/** Inner text of the first `<name>...</name>` (no nested elements). */
function textOf(xml: string, name: string): string | null {
	const match = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xml);
	return match ? match[1]! : null;
}

/** Inner text of every `<name>...</name>`, in document order. */
function allTextOf(xml: string, name: string): string[] {
	const re = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, 'g');
	const out: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = re.exec(xml)) !== null) out.push(match[1]!);
	return out;
}

function totalNotes(score: Score, staffIndex = 0): number {
	return score.staves[staffIndex]!.measures.reduce((sum, measure) => sum + measure.notes.length, 0);
}

// A self-check: the well-formedness checker has to actually reject bad input,
// or every "is well-formed" assertion below is vacuous.
describe('assertWellFormed (the checker itself)', () => {
	it('accepts a minimal well-formed document', () => {
		expect(() => assertWellFormed('<?xml version="1.0"?>\n<a><b/></a>\n')).not.toThrow();
	});
	it('rejects a mismatched close tag', () => {
		expect(() => assertWellFormed('<a><b></a></b>')).toThrow();
	});
	it('rejects an unclosed tag', () => {
		expect(() => assertWellFormed('<a><b></b>')).toThrow();
	});
	it('rejects an unquoted attribute value', () => {
		expect(() => assertWellFormed('<a foo=bar></a>')).toThrow();
	});
});

describe('exportMusicXml', () => {
	it('emits a well-formed single-part document for createFullDemoScore', () => {
		const score = createFullDemoScore();
		const xml = exportMusicXml(score);
		assertWellFormed(xml);

		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
		expect(xml).toContain('<!DOCTYPE score-partwise PUBLIC');
		expect(xml).toContain('<score-partwise version="4.0">');

		// One synthetic part (the model has only the default unnamed
		// single-staff part), so exactly one <part> and no <part-group>.
		expect(count(xml, /<part\s+id="/g)).toBe(1);
		expect(count(xml, /<part-group/g)).toBe(0);
		expect(xml).toContain('<part-name>Part 1</part-name>');

		expect(count(xml, /<measure\s+number="/g)).toBe(score.measures.length);
		expect(count(xml, /<note>/g)).toBe(totalNotes(score));

		const divisions = textOf(xml, 'divisions');
		expect(divisions).not.toBeNull();
		expect(Number.isInteger(Number(divisions))).toBe(true);
		expect(Number(divisions)).toBeGreaterThan(0);

		// The first <key>/<time> are the score's initial values.
		expect(textOf(xml, 'fifths')).toBe(String(score.keyFifthsAt(0, 0)));
		expect(textOf(xml, 'beats')).toBe(String(score.timeAt(0, 0).beats));
		expect(textOf(xml, 'beat-type')).toBe(String(score.timeAt(0, 0).beatType));

		// The true last measure resolves to a final barline (light-heavy, no
		// repeat).
		const lastMeasure = blocksOf(xml, 'measure').at(-1)!;
		expect(lastMeasure).toContain('<bar-style>light-heavy</bar-style>');
		expect(lastMeasure).not.toContain('<repeat');
	});

	it('normalizes createSatbBracketShowcaseScore into four bracketed parts', () => {
		const xml = exportMusicXml(createSatbBracketShowcaseScore());
		assertWellFormed(xml);

		expect(count(xml, /<part\s+id="/g)).toBe(4);
		expect(allTextOf(xml, 'part-name')).toEqual(['Soprano', 'Alto', 'Tenor', 'Bass']);

		expect(count(xml, /<part-group type="start"/g)).toBe(1);
		expect(count(xml, /<part-group type="stop"/g)).toBe(1);
		expect(xml).toContain('<group-symbol>bracket</group-symbol>');

		const parts = blocksOf(xml, 'part');
		expect(parts).toHaveLength(4);
		for (const part of parts) {
			expect(count(part, /<measure\s+number="/g)).toBe(1);
			expect(count(part, /<note>/g)).toBe(4);
		}

		// Tenor is treble8 (octave-down), Bass is an F clef on line 4.
		expect(parts[2]).toContain('<clef-octave-change>-1</clef-octave-change>');
		expect(parts[3]).toContain('<sign>F</sign>');
		expect(parts[3]).toContain('<line>4</line>');
	});

	it('emits a fresh minimal <attributes> at each mid-score key/time change', () => {
		const xml = exportMusicXml(createKeyTimeChangeShowcaseScore());
		assertWellFormed(xml);

		const attributes = blocksOf(xml, 'attributes');
		// Measure 0 (full), the key-change measure, the time-change measure.
		expect(attributes).toHaveLength(3);

		// First measure keeps the initial values.
		expect(attributes[0]).toContain('<fifths>1</fifths>');
		expect(attributes[0]).toContain('<beats>4</beats>');
		expect(attributes[0]).toContain('<divisions>');

		// Key change: only <key>, no <divisions>, no <time>.
		expect(attributes[1]).toContain('<fifths>2</fifths>');
		expect(attributes[1]).not.toContain('<divisions>');
		expect(attributes[1]).not.toContain('<time>');

		// Time change: only <time>, no <key>, no <divisions>.
		expect(attributes[2]).toContain('<beats>3</beats>');
		expect(attributes[2]).toContain('<beat-type>4</beat-type>');
		expect(attributes[2]).not.toContain('<fifths>');
		expect(attributes[2]).not.toContain('<divisions>');

		const measures = blocksOf(xml, 'measure');
		expect(measures[1]).toContain('<fifths>2</fifths>');
		expect(measures[3]).toContain('<beats>3</beats>');
	});

	it('maps every barline type to the right markup', () => {
		const xml = exportMusicXml(createBarlineShowcaseScore());
		assertWellFormed(xml);
		const measures = blocksOf(xml, 'measure');

		// Measure 1: a double barline on the right.
		expect(measures[0]).toContain('<barline location="right">');
		expect(measures[0]).toContain('<bar-style>light-light</bar-style>');

		// Measure 2: an ordinary boundary emits no <barline> at all.
		expect(measures[1]).not.toContain('<barline');

		// Measure 3: a repeat-start on the left.
		expect(measures[2]).toContain('<barline location="left">');
		expect(measures[2]).toContain('<bar-style>heavy-light</bar-style>');
		expect(measures[2]).toContain('<repeat direction="forward"/>');

		// Measure 4: a repeat-end on the right.
		expect(measures[3]).toContain('<bar-style>light-heavy</bar-style>');
		expect(measures[3]).toContain('<repeat direction="backward"/>');

		// `final` (no showcase measure sets it; a one-measure score resolves
		// its own last boundary to it).
		const finalXml = exportMusicXml(buildScore([[['C4', 'whole']]]));
		expect(finalXml).toContain('<bar-style>light-heavy</bar-style>');
		expect(finalXml).not.toContain('<repeat');
	});

	it('emits paired tie/tied markup for a tie across a barline', () => {
		const xml = exportMusicXml(createTieShowcaseScore());
		assertWellFormed(xml);
		const measures = blocksOf(xml, 'measure');

		// The source note (2nd measure): starts a tie, nothing stops on it.
		expect(measures[1]).toContain('<tie type="start"/>');
		expect(measures[1]).toContain('<tied type="start"/>');
		expect(measures[1]).not.toContain('<tie type="stop"/>');

		// Its resolution (3rd measure): stops the tie.
		expect(measures[2]).toContain('<tie type="stop"/>');
		expect(measures[2]).toContain('<tied type="stop"/>');
	});

	it('emits triplet time-modification and a tuplet run for createDurationShowcaseScore', () => {
		const score = createDurationShowcaseScore();
		const xml = exportMusicXml(score);
		assertWellFormed(xml);

		const tripletMeasure = blocksOf(xml, 'measure')[1]!;
		expect(count(tripletMeasure, /<time-modification>/g)).toBe(6);
		expect(tripletMeasure).toContain('<actual-notes>3</actual-notes>');
		expect(tripletMeasure).toContain('<normal-notes>2</normal-notes>');
		expect(count(tripletMeasure, /<tuplet type="start" number="1"\/>/g)).toBe(1);
		expect(count(tripletMeasure, /<tuplet type="stop" number="1"\/>/g)).toBe(1);

		// Divisions is chosen so every <duration> is a whole number, and the
		// pre-round value is within 1e-6 of that integer.
		const divisions = Number(textOf(xml, 'divisions'));
		for (const note of score.staves[0]!.measures[1]!.notes) {
			const raw = note.durationWholes * 4 * divisions;
			expect(Math.abs(raw - Math.round(raw))).toBeLessThan(1e-6);
		}
		for (const duration of allTextOf(tripletMeasure, 'duration')) {
			expect(duration).toMatch(/^\d+$/);
		}
	});

	it('emits primary <beam> begin/continue/end across a clean beamed run', () => {
		const xml = exportMusicXml(createDurationShowcaseScore());
		assertWellFormed(xml);
		const measures = blocksOf(xml, 'measure');

		// Measure 1 beams the 16th/32nd/64th together (a run of three).
		const firstMeasure = measures[0]!;
		const begin = firstMeasure.indexOf('<beam number="1">begin</beam>');
		const cont = firstMeasure.indexOf('<beam number="1">continue</beam>');
		const end = firstMeasure.indexOf('<beam number="1">end</beam>');
		expect(begin).toBeGreaterThanOrEqual(0);
		expect(cont).toBeGreaterThan(begin);
		expect(end).toBeGreaterThan(cont);

		// Measure 3 is four plain eighth-note beats: four begin/end pairs, no
		// interior continue.
		const eighthsMeasure = measures[2]!;
		expect(count(eighthsMeasure, /<beam number="1">begin<\/beam>/g)).toBe(4);
		expect(count(eighthsMeasure, /<beam number="1">end<\/beam>/g)).toBe(4);
		expect(count(eighthsMeasure, /<beam number="1">continue<\/beam>/g)).toBe(0);
	});

	it('emits <slur> spans from score.slurs', () => {
		const xml = exportMusicXml(createSlurShowcaseScore());
		assertWellFormed(xml);

		const firstMeasureNotes = blocksOf(blocksOf(xml, 'measure')[0]!, 'note');
		expect(firstMeasureNotes[0]).toContain('<slur type="start" number="1"/>');
		expect(firstMeasureNotes[3]).toContain('<slur type="stop" number="1"/>');
	});

	it('emits a per-staff <clef> in a minimal <attributes> wherever a staff\'s resolved clef changes (M5 Slice 5)', () => {
		// One two-staff part (so the changed staff is addressed as `number="2"`),
		// four measures per staff.
		const score = new Score({ keyFifths: 0, time: { beats: 4, beatType: 4 } });
		score.appendStaff('bass');
		score.addPart([0, 1], 'Piano');
		for (let m = 0; m < 4; m++) {
			score.appendNote(score.appendMeasure(0), { pitch: parsePitch('C5'), value: 'whole' });
			score.appendNote(score.appendMeasure(1), { pitch: parsePitch('C3'), value: 'whole' });
		}
		// The bass staff switches to treble for measure 1 only; measure 2's
		// restore is a change back, measure 3 is no change at all.
		score.setClefRange(1, 1, 1, 'treble');
		const xml = exportMusicXml(score);
		assertWellFormed(xml);

		const measures = blocksOf(xml, 'measure');
		const changeAttrs = blocksOf(measures[1]!, 'attributes')[0]!;
		expect(changeAttrs).toContain('<clef number="2">');
		expect(changeAttrs).not.toContain('<clef number="1">');
		expect(changeAttrs).toContain('<sign>G</sign>');
		expect(changeAttrs).not.toContain('<divisions>');

		const restoreAttrs = blocksOf(measures[2]!, 'attributes')[0]!;
		expect(restoreAttrs).toContain('<clef number="2">');
		expect(restoreAttrs).toContain('<sign>F</sign>');

		expect(blocksOf(measures[3]!, 'attributes')).toHaveLength(0);

		// And the import side reads `number="2"` back onto the right staff.
		const reimported = importMusicXml(xml);
		assertScoresEquivalent(reimported, score);
		expect([0, 1, 2, 3].map((m) => reimported.clefAt(m, 1))).toEqual(['bass', 'treble', 'bass', 'bass']);
		expect([0, 1, 2, 3].map((m) => reimported.clefAt(m, 0))).toEqual(['treble', 'treble', 'treble', 'treble']);
	});

	it('emits a multi-staff part as one <part> with <staves>, per-staff <clef> and <staff>', () => {
		const score = new Score({ keyFifths: 0, time: { beats: 4, beatType: 4 } });
		score.appendStaff('bass');
		score.addPart([0, 1], 'Piano');
		const treble = score.appendMeasure(0);
		for (const pitch of ['C5', 'D5', 'E5', 'F5']) {
			score.appendNote(treble, { pitch: parsePitch(pitch), value: 'quarter' });
		}
		const bass = score.appendMeasure(1);
		for (const pitch of ['C3', 'D3', 'E3', 'F3']) {
			score.appendNote(bass, { pitch: parsePitch(pitch), value: 'quarter' });
		}

		const xml = exportMusicXml(score);
		assertWellFormed(xml);

		expect(count(xml, /<part\s+id="/g)).toBe(1);
		expect(count(xml, /<part-group/g)).toBe(0);
		expect(xml).toContain('<part id="P1">');
		expect(xml).toContain('<part-name>Piano</part-name>');

		const attributes = blocksOf(xml, 'attributes')[0]!;
		expect(attributes).toContain('<staves>2</staves>');
		expect(attributes).toContain('<clef number="1">');
		expect(attributes).toContain('<clef number="2">');

		expect(count(xml, /<staff>1<\/staff>/g)).toBe(4);
		expect(count(xml, /<staff>2<\/staff>/g)).toBe(4);

		const measure = blocksOf(xml, 'measure')[0]!;
		const backup = blocksOf(measure, 'backup')[0]!;
		expect(backup).toContain('<duration>4</duration>');
		expect(measure.indexOf('<backup>')).toBeGreaterThan(measure.indexOf('<staff>1</staff>'));
		expect(measure.indexOf('<staff>2</staff>')).toBeGreaterThan(measure.indexOf('<backup>'));
	});

	it('separates two voices with a full-measure <backup>', () => {
		const xml = exportMusicXml(createTwoVoiceShowcaseScore());
		assertWellFormed(xml);

		const measure = blocksOf(xml, 'measure')[0]!;
		expect(measure).toContain('<backup>');
		expect(blocksOf(measure, 'backup')[0]).toContain('<duration>8</duration>');

		const voice1At = measure.indexOf('<voice>1</voice>');
		const backupAt = measure.indexOf('<backup>');
		const voice2At = measure.indexOf('<voice>2</voice>');
		expect(voice1At).toBeGreaterThanOrEqual(0);
		expect(backupAt).toBeGreaterThan(voice1At);
		expect(voice2At).toBeGreaterThan(backupAt);

		expect(count(measure, /<voice>1<\/voice>/g)).toBe(2);
		expect(count(measure, /<voice>2<\/voice>/g)).toBe(8);
	});
});
