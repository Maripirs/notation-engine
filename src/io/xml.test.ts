import { describe, expect, it } from 'vitest';
import { child, childText, children, descendants, parseXml } from './xml.js';

describe('parseXml', () => {
	it('parses nested elements and exposes direct text only', () => {
		const root = parseXml('<a>hello <b>inner</b> world</a>');
		expect(root.name).toBe('a');
		// Direct text is the concatenation of `a`'s own character data, not `b`'s.
		expect(root.text).toBe('hello  world');
		expect(root.children).toHaveLength(1);
		expect(root.children[0]!.name).toBe('b');
		expect(root.children[0]!.text).toBe('inner');
	});

	it('reads attributes with both quote styles', () => {
		const root = parseXml(`<note id="P1" x='2' y="3 4"/>`);
		expect(root.attrs).toEqual({ id: 'P1', x: '2', y: '3 4' });
		expect(root.children).toHaveLength(0);
	});

	it('handles self-closing tags mixed with open/close', () => {
		const root = parseXml('<measure><note/><note>C</note><rest/></measure>');
		expect(root.children.map((c) => c.name)).toEqual(['note', 'note', 'rest']);
		expect(root.children[1]!.text).toBe('C');
	});

	it('decodes named and numeric entities in text and attributes', () => {
		const root = parseXml(
			'<p title="Trumpet &amp; Horn">a &lt; b &gt; c &quot;q&quot; &apos;a&apos; &#65; &#x41;</p>'
		);
		expect(root.attrs.title).toBe('Trumpet & Horn');
		expect(root.text).toBe(`a < b > c "q" 'a' A A`);
	});

	it('leaves an unknown entity verbatim rather than throwing', () => {
		const root = parseXml('<p>5 &plusmn; 1</p>');
		expect(root.text).toBe('5 &plusmn; 1');
	});

	it('skips the XML declaration, comments and processing instructions', () => {
		const root = parseXml(
			`<?xml version="1.0" encoding="UTF-8"?>\n<!-- a comment -->\n<?php noop ?>\n<root><!-- inner -->x</root>`
		);
		expect(root.name).toBe('root');
		expect(root.text).toBe('x');
	});

	it('skips a plain DOCTYPE', () => {
		const root = parseXml(
			'<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise/>'
		);
		expect(root.name).toBe('score-partwise');
	});

	it('skips a DOCTYPE carrying an internal subset with > characters inside', () => {
		const root = parseXml(
			'<!DOCTYPE root [\n  <!ENTITY foo "bar">\n  <!ELEMENT root (#PCDATA)>\n]>\n<root>hi</root>'
		);
		expect(root.name).toBe('root');
		expect(root.text).toBe('hi');
	});

	it('treats CDATA as literal text', () => {
		const root = parseXml('<p><![CDATA[ <not> & </a parsed> ]]></p>');
		expect(root.text).toBe(' <not> & </a parsed> ');
	});

	it('throws on a mismatched close tag', () => {
		expect(() => parseXml('<a><b></a></b>')).toThrow(/does not match open tag/);
	});

	it('throws on an unclosed tag at end of input', () => {
		expect(() => parseXml('<a><b></b>')).toThrow(/unclosed tags|end of input/);
	});

	it('throws on an unquoted attribute value', () => {
		expect(() => parseXml('<a foo=bar></a>')).toThrow(/not quoted/);
	});

	it('throws when there is no root element', () => {
		expect(() => parseXml('<?xml version="1.0"?>\n<!-- nothing here -->\n')).toThrow();
	});
});

describe('navigation helpers', () => {
	const tree = parseXml(
		'<part><measure n="1"><note>C</note><note>D</note></measure><measure n="2"><note>E</note></measure></part>'
	);

	it('child returns the first matching direct child', () => {
		expect(child(tree, 'measure')!.attrs.n).toBe('1');
		expect(child(tree, 'nope')).toBeUndefined();
	});

	it('children returns all matching direct children', () => {
		expect(children(tree, 'measure')).toHaveLength(2);
		// `note` is not a direct child of `part`.
		expect(children(tree, 'note')).toHaveLength(0);
	});

	it('childText trims and returns undefined for a missing child', () => {
		const withSpace = parseXml('<x><y>  spaced  </y></x>');
		expect(childText(withSpace, 'y')).toBe('spaced');
		expect(childText(withSpace, 'z')).toBeUndefined();
	});

	it('descendants finds matching elements at any depth', () => {
		expect(descendants(tree, 'note').map((n) => n.text)).toEqual(['C', 'D', 'E']);
	});
});
