// Lyrics in the model (M6 Slice 9): the `Lyric` shape and its helpers, and
// how the Slice 7 correction ops carry them. Clone and equivalence are in
// edit-history.test.ts.

import { describe, expect, it } from 'vitest';
import {
	compareVerses,
	eventLyrics,
	lyricContinuesWord,
	lyricDisplayText,
	lyricStartsExtender,
	makeLyric,
	mergeLyrics,
	NO_LYRICS
} from './lyrics.js';
import { buildScore, noteEvents } from './score.js';

describe('Lyric', () => {
	it('fills MusicXML\'s defaults and freezes', () => {
		const lyric = makeLyric({ text: 'la' });
		expect(lyric).toEqual({ verse: '1', syllabic: 'single', text: 'la', elisions: [], extend: null, source: null });
		expect(Object.isFrozen(lyric)).toBe(true);
	});

	it('orders verses numerically, before named ones', () => {
		expect(['10', 'chorus', '2', '1', 'a'].sort(compareVerses)).toEqual(['1', '2', '10', 'a', 'chorus']);
	});

	it('knows what follows a syllable and how an elision reads', () => {
		expect(lyricContinuesWord(makeLyric({ text: 'Al', syllabic: 'begin' }))).toBe(true);
		expect(lyricContinuesWord(makeLyric({ text: 'le', syllabic: 'middle' }))).toBe(true);
		expect(lyricContinuesWord(makeLyric({ text: 'ia', syllabic: 'end' }))).toBe(false);
		// An elision's last syllable decides: "in_a-" continues, "sing_a" does not.
		expect(lyricContinuesWord(makeLyric({ text: 'in', elisions: [{ text: 'a', syllabic: 'begin' }] }))).toBe(true);
		expect(lyricDisplayText(makeLyric({ text: 'sing', elisions: [{ text: 'a', syllabic: 'single' }] }))).toBe('sing‿a');
		expect(lyricStartsExtender(makeLyric({ text: 'light', extend: 'start' }))).toBe(true);
		expect(lyricStartsExtender(makeLyric({ text: 'light', extend: 'untyped' }))).toBe(true);
		expect(lyricStartsExtender(makeLyric({ text: '', extend: 'stop' }))).toBe(false);
		expect(lyricStartsExtender(makeLyric({ text: 'x', extend: 'stop' }))).toBe(false);
	});

	it('reads one lyric per verse off a chord, the first head\'s winning', () => {
		const score = buildScore([[[['C4', 'E4'], 'whole']]]);
		const [anchor, member] = score.measures[0]!.notes;
		anchor!.lyrics = [makeLyric({ verse: '2', text: 'two' })];
		member!.lyrics = [makeLyric({ text: 'one' }), makeLyric({ verse: '2', text: 'other' })];
		const [event] = noteEvents(score.measures[0]!.notes);
		expect(eventLyrics(event!).map((l) => l.text)).toEqual(['one', 'two']);
	});

	it('merges a removed head\'s verses into the head that stays', () => {
		const into = [makeLyric({ text: 'kept' })];
		expect(mergeLyrics(into, [])).toBe(into);
		expect(mergeLyrics(into, [makeLyric({ text: 'lost' }), makeLyric({ verse: '2', text: 'two' })]).map((l) => l.text)).toEqual([
			'kept',
			'two'
		]);
	});
});

describe('lyrics on a Score', () => {
	const build = () =>
		buildScore([
			[
				[['C4', 'E4'], 'half', { lyrics: [{ text: 'Glo', syllabic: 'begin' }, { verse: '2', text: 'Hal', syllabic: 'begin' }] }],
				['D4', 'half', { lyrics: [{ text: 'ry', syllabic: 'end' }] }]
			]
		]);

	it('puts a chord literal\'s lyrics on its anchor only', () => {
		const [anchor, member] = build().measures[0]!.notes;
		expect(anchor!.lyrics.map((l) => l.text)).toEqual(['Glo', 'Hal']);
		expect(member!.lyrics).toBe(NO_LYRICS);
	});

	it('noteToRest drops the note\'s lyrics', () => {
		const score = build();
		const d = score.measures[0]!.notes[2]!;
		score.noteToRest(d.id);
		expect(score.findNote(d.id)!.lyrics).toEqual([]);
	});

	it('removeChordMember on the anchor hands its lyrics to the promoted head', () => {
		const score = build();
		const [anchor, member] = score.measures[0]!.notes;
		score.removeChordMember(anchor!.id);
		expect(score.findNote(member!.id)!.lyrics.map((l) => l.text)).toEqual(['Glo', 'Hal']);
	});

	it('removeChordMember (and noteToRest) on a member moves its lyrics to the anchor, the anchor\'s verse winning', () => {
		const score = build();
		const [anchor, member] = score.measures[0]!.notes;
		member!.lyrics = [makeLyric({ text: 'lost' }), makeLyric({ verse: '3', text: 'three' })];
		score.noteToRest(member!.id);
		expect(score.findNote(anchor!.id)!.lyrics.map((l) => `${l.verse}:${l.text}`)).toEqual(['1:Glo', '2:Hal', '3:three']);
	});
});
