// A tiny, shipped XML parser.
//
// The engine is environment-agnostic: the test suite runs in Node, which has no
// `DOMParser`, and the library must not reach for a browser global at runtime
// either. MusicXML import therefore needs a real parser that is part of this
// package, not borrowed from the host. The good news is that the subset of XML
// a `score-partwise` document (and the extra noise Audiveris sprinkles in)
// actually uses is small: elements, attributes, text, comments, a prolog, a
// DOCTYPE, the five named entities plus numeric character references, and
// occasionally CDATA. That is the whole grammar handled below. Namespaces,
// entity *declarations*, and mixed-content edge cases a general serializer
// would need are deliberately out of scope, the same way `musicxml-export.ts`
// ships a minimal writer rather than a general one so the format and the code
// that reads it move together.
//
// The parser builds an immutable tree in one left-to-right pass over the
// source string, keeping a stack of open elements. A close tag that does not
// match the top of the stack, or any element still open at end of input, is a
// hard error: a malformed document is a caller bug (or a truncated file), not
// something to paper over, mirroring the export test's `assertWellFormed`.

/**
 * One element node. The tree is fully immutable: every array and record is
 * frozen at build time so a consumer can walk it freely without defensive
 * copies. Text-only content lives in `text`; there are no separate text nodes,
 * because nothing in MusicXML needs to know *where* between two child elements
 * a whitespace run sat.
 */
export interface XmlElement {
	readonly name: string;
	readonly attrs: Readonly<Record<string, string>>;
	readonly children: readonly XmlElement[];
	/** Concatenated direct text content, entity-decoded, whitespace preserved.
	 *  Text inside descendant elements is not included; only character data that
	 *  is an immediate child of this element. */
	readonly text: string;
}

/** A mutable element used only while building; frozen into an `XmlElement` on close. */
interface MutableElement {
	name: string;
	attrs: Record<string, string>;
	children: MutableElement[];
	text: string;
}

/**
 * Parse `source` and return its single root element.
 *
 * Throws on anything that is not well-formed: an unclosed tag, a close tag that
 * does not match the currently open element, a document with no element at all,
 * or a stray `<` that does not begin a valid construct.
 */
export function parseXml(source: string): XmlElement {
	const parser = new Parser(source);
	return parser.parseDocument();
}

class Parser {
	private readonly src: string;
	private pos = 0;

	constructor(source: string) {
		this.src = source;
	}

	parseDocument(): XmlElement {
		this.skipProlog();
		const root = this.parseElement();
		// Trailing whitespace, comments and PIs after the root are legal; anything
		// else (a second root element, stray text) is not, but is harmless enough
		// to ignore for this internal parser. We only need the root back.
		return root;
	}

	/**
	 * Consume everything that can legally precede the root element: whitespace,
	 * the `<?xml ... ?>` declaration, other processing instructions, comments,
	 * and a `<!DOCTYPE ...>` declaration (including one carrying an internal
	 * `[ ... ]` subset, which can itself contain `>` characters, so the scan has
	 * to balance brackets rather than stop at the first `>`).
	 */
	private skipProlog(): void {
		for (;;) {
			this.skipWhitespace();
			if (this.startsWith('<?')) {
				this.skipProcessingInstruction();
			} else if (this.startsWith('<!--')) {
				this.skipComment();
			} else if (this.startsWithIgnoreCase('<!DOCTYPE')) {
				this.skipDoctype();
			} else {
				return;
			}
		}
	}

	private skipProcessingInstruction(): void {
		const end = this.src.indexOf('?>', this.pos);
		if (end === -1) throw new Error('xml: unterminated processing instruction (no matching "?>")');
		this.pos = end + 2;
	}

	private skipComment(): void {
		const end = this.src.indexOf('-->', this.pos);
		if (end === -1) throw new Error('xml: unterminated comment (no matching "-->")');
		this.pos = end + 3;
	}

	/**
	 * Skip a `<!DOCTYPE ...>`. The tricky case is an internal subset:
	 * `<!DOCTYPE score-partwise PUBLIC "..." "..." [ <!ENTITY ...> ]>`. The
	 * `[...]` can contain `>` characters, so we scan character by character,
	 * tracking whether we are inside the bracketed subset, and only accept the
	 * `>` that closes the declaration itself.
	 */
	private skipDoctype(): void {
		let i = this.pos + '<!DOCTYPE'.length;
		let inSubset = false;
		for (; i < this.src.length; i++) {
			const ch = this.src[i];
			if (ch === '[') inSubset = true;
			else if (ch === ']') inSubset = false;
			else if (ch === '>' && !inSubset) {
				this.pos = i + 1;
				return;
			}
		}
		throw new Error('xml: unterminated DOCTYPE declaration');
	}

	/**
	 * Parse one element (the caller has already skipped to its opening `<`) and
	 * everything nested inside it, up to and including its close tag. Returns the
	 * frozen node.
	 */
	private parseElement(): XmlElement {
		if (!this.startsWith('<')) {
			throw new Error(`xml: expected an element at offset ${this.pos}, found ${JSON.stringify(this.peek(16))}`);
		}
		const stack: MutableElement[] = [];
		let root: MutableElement | undefined;

		for (;;) {
			if (this.pos >= this.src.length) {
				const open = stack.map((el) => `<${el.name}>`).join(' ');
				throw new Error(`xml: unexpected end of input with unclosed tags: ${open || '(none)'}`);
			}

			if (this.startsWith('<!--')) {
				this.skipComment();
				continue;
			}
			if (this.startsWith('<?')) {
				this.skipProcessingInstruction();
				continue;
			}
			if (this.startsWith('<![CDATA[')) {
				const end = this.src.indexOf(']]>', this.pos);
				if (end === -1) throw new Error('xml: unterminated CDATA section');
				const literal = this.src.slice(this.pos + '<![CDATA['.length, end);
				const top = stack[stack.length - 1];
				if (top) top.text += literal;
				this.pos = end + 3;
				continue;
			}
			if (this.startsWith('</')) {
				const name = this.readCloseTag();
				const top = stack.pop();
				if (!top) throw new Error(`xml: close tag </${name}> with no open element`);
				if (top.name !== name) {
					throw new Error(`xml: close tag </${name}> does not match open tag <${top.name}>`);
				}
				if (stack.length === 0) {
					root = top;
					break;
				}
				continue;
			}
			if (this.startsWith('<')) {
				const { element, selfClosing } = this.readOpenTag();
				const parent = stack[stack.length - 1];
				if (parent) parent.children.push(element);
				else if (root && stack.length === 0) {
					// A second top-level element after the root has already closed.
					throw new Error(`xml: unexpected second root element <${element.name}>`);
				}
				if (!selfClosing) {
					stack.push(element);
				} else if (stack.length === 0) {
					root = element;
					break;
				}
				continue;
			}

			// Character data belonging to the element currently on top of the stack.
			const nextLt = this.src.indexOf('<', this.pos);
			const chunkEnd = nextLt === -1 ? this.src.length : nextLt;
			const raw = this.src.slice(this.pos, chunkEnd);
			const top = stack[stack.length - 1];
			if (top) top.text += decodeEntities(raw);
			this.pos = chunkEnd;
		}

		if (!root) throw new Error('xml: no root element found');
		return freeze(root);
	}

	/** Read `<name attr="v" ...>` or `<name .../>`. Position is at the `<`. */
	private readOpenTag(): { element: MutableElement; selfClosing: boolean } {
		this.pos++; // consume '<'
		const name = this.readName();
		if (!name) throw new Error(`xml: malformed open tag at offset ${this.pos}`);
		const attrs: Record<string, string> = {};

		for (;;) {
			this.skipWhitespace();
			const ch = this.src[this.pos];
			if (ch === undefined) throw new Error(`xml: unterminated open tag <${name}`);
			if (ch === '>') {
				this.pos++;
				return { element: { name, attrs, children: [], text: '' }, selfClosing: false };
			}
			if (ch === '/') {
				if (this.src[this.pos + 1] !== '>') {
					throw new Error(`xml: malformed self-closing tag <${name}`);
				}
				this.pos += 2;
				return { element: { name, attrs, children: [], text: '' }, selfClosing: true };
			}
			const attrName = this.readName();
			if (!attrName) {
				throw new Error(`xml: malformed attribute in <${name}> near ${JSON.stringify(this.peek(16))}`);
			}
			this.skipWhitespace();
			if (this.src[this.pos] !== '=') {
				throw new Error(`xml: attribute "${attrName}" in <${name}> has no value (expected '=')`);
			}
			this.pos++; // consume '='
			this.skipWhitespace();
			const quote = this.src[this.pos];
			if (quote !== '"' && quote !== "'") {
				throw new Error(`xml: attribute "${attrName}" in <${name}> value is not quoted`);
			}
			this.pos++;
			const close = this.src.indexOf(quote, this.pos);
			if (close === -1) throw new Error(`xml: unterminated attribute value for "${attrName}" in <${name}>`);
			attrs[attrName] = decodeEntities(this.src.slice(this.pos, close));
			this.pos = close + 1;
		}
	}

	/** Read `</name>` and return `name`. Position is at the `<`. */
	private readCloseTag(): string {
		this.pos += 2; // consume '</'
		const name = this.readName();
		if (!name) throw new Error(`xml: malformed close tag at offset ${this.pos}`);
		this.skipWhitespace();
		if (this.src[this.pos] !== '>') throw new Error(`xml: malformed close tag </${name}`);
		this.pos++;
		return name;
	}

	private readName(): string {
		const start = this.pos;
		// XML names are permissive; this covers every name MusicXML and Audiveris
		// emit (letters, digits, '-', '_', '.', ':').
		while (this.pos < this.src.length && /[A-Za-z0-9_.:-]/.test(this.src[this.pos]!)) {
			this.pos++;
		}
		return this.src.slice(start, this.pos);
	}

	private skipWhitespace(): void {
		while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
	}

	private startsWith(token: string): boolean {
		return this.src.startsWith(token, this.pos);
	}

	private startsWithIgnoreCase(token: string): boolean {
		return this.src.slice(this.pos, this.pos + token.length).toUpperCase() === token.toUpperCase();
	}

	private peek(n: number): string {
		return this.src.slice(this.pos, this.pos + n);
	}
}

/**
 * Decode the five predefined XML entities plus numeric character references
 * (`&#NN;` decimal, `&#xNN;` hex). An unrecognized `&...;` run is left verbatim
 * rather than throwing: a stray ampersand in a real-world file should not sink
 * an import, and the export side already escapes everything it emits.
 */
export function decodeEntities(text: string): string {
	if (text.indexOf('&') === -1) return text;
	return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, body: string) => {
		switch (body) {
			case 'amp':
				return '&';
			case 'lt':
				return '<';
			case 'gt':
				return '>';
			case 'quot':
				return '"';
			case 'apos':
				return "'";
		}
		if (body[0] === '#') {
			const codePoint =
				body[1] === 'x' || body[1] === 'X'
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
				return String.fromCodePoint(codePoint);
			}
		}
		return match;
	});
}

/** Recursively freeze a mutable build node into an `XmlElement`. */
function freeze(node: MutableElement): XmlElement {
	return Object.freeze({
		name: node.name,
		attrs: Object.freeze(node.attrs),
		children: Object.freeze(node.children.map(freeze)),
		text: node.text
	});
}

// --- Small navigation helpers -------------------------------------------------
//
// A DOM-free tree needs a couple of obvious lookups so callers are not writing
// `el.children.find(...)` everywhere. Kept to the three that `musicxml-import`
// actually uses.

/** The first direct child element named `name`, or `undefined`. */
export function child(el: XmlElement, name: string): XmlElement | undefined {
	return el.children.find((c) => c.name === name);
}

/** Every direct child element named `name`, in document order. */
export function children(el: XmlElement, name: string): XmlElement[] {
	return el.children.filter((c) => c.name === name);
}

/** The text of the first direct child named `name`, trimmed, or `undefined` if
 *  there is no such child. An empty/whitespace-only child yields `''`. */
export function childText(el: XmlElement, name: string): string | undefined {
	const found = child(el, name);
	return found ? found.text.trim() : undefined;
}

/** Every descendant element named `name`, at any depth, in document order. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
	const out: XmlElement[] = [];
	const walk = (node: XmlElement): void => {
		for (const c of node.children) {
			if (c.name === name) out.push(c);
			walk(c);
		}
	};
	walk(el);
	return out;
}
