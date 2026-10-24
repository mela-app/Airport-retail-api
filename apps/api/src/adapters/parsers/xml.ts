/**
 * A strict, minimal XML parser for feed messages (IATA AIDX).
 *
 * Security by construction: any DOCTYPE / DTD is rejected, so external entities (XXE) and entity-expansion
 * ("billion laughs") attacks cannot happen. Only the five predefined entities and numeric character
 * references are decoded. Input size and nesting depth are bounded.
 *
 * Supported: XML declaration and processing instructions (skipped), comments (skipped), CDATA, elements,
 * attributes, namespace prefixes (kept separately from the local name).
 */

export interface XmlElement {
  /** Local name (without namespace prefix). */
  name: string;
  prefix: string | null;
  attributes: ReadonlyMap<string, string>;
  children: XmlElement[];
  /** Concatenated text content directly inside this element (trimmed). */
  text: string;
}

export class XmlError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} at offset ${position}`);
    this.name = 'XmlError';
  }
}

export const XML_MAX_BYTES = 1_000_000;
export const XML_MAX_DEPTH = 64;

const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

const isNameStart = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_' || c === ':';
const isNameChar = (c: string) => isNameStart(c) || (c >= '0' && c <= '9') || c === '-' || c === '.';
const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

class Cursor {
  pos = 0;
  constructor(readonly src: string) {}

  get done(): boolean {
    return this.pos >= this.src.length;
  }

  peek(offset = 0): string {
    return this.src.charAt(this.pos + offset);
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  fail(message: string): never {
    throw new XmlError(message, this.pos);
  }

  expect(s: string): void {
    if (!this.startsWith(s)) this.fail(`expected "${s}"`);
    this.pos += s.length;
  }

  skipSpace(): void {
    while (!this.done && isSpace(this.peek())) this.pos += 1;
  }

  /** Advance past the next occurrence of `end`, returning the text before it. */
  until(end: string): string {
    const idx = this.src.indexOf(end, this.pos);
    if (idx < 0) this.fail(`unterminated construct, missing "${end}"`);
    const text = this.src.slice(this.pos, idx);
    this.pos = idx + end.length;
    return text;
  }

  name(): string {
    const start = this.pos;
    if (!isNameStart(this.peek())) this.fail('invalid name');
    while (!this.done && isNameChar(this.peek())) this.pos += 1;
    return this.src.slice(start, this.pos);
  }
}

function decodeEntities(raw: string, cur: Cursor): string {
  if (!raw.includes('&')) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp < 0) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp);
    if (semi < 0 || semi - amp > 12) cur.fail('malformed entity reference');
    const ref = raw.slice(amp + 1, semi);
    if (ref.startsWith('#')) {
      const hex = ref.startsWith('#x') || ref.startsWith('#X');
      const code = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff) cur.fail('invalid character reference');
      out += String.fromCodePoint(code);
    } else {
      const value = PREDEFINED.get(ref);
      if (value === undefined) cur.fail(`undefined entity "${ref}"`);
      out += value;
    }
    i = semi + 1;
  }
  return out;
}

function splitName(qname: string): { prefix: string | null; name: string } {
  const colon = qname.indexOf(':');
  return colon < 0
    ? { prefix: null, name: qname }
    : { prefix: qname.slice(0, colon), name: qname.slice(colon + 1) };
}

/** Skip the prolog / misc items allowed outside the root element. */
function skipMisc(cur: Cursor): void {
  for (;;) {
    cur.skipSpace();
    if (cur.startsWith('<?')) {
      cur.pos += 2;
      cur.until('?>');
    } else if (cur.startsWith('<!--')) {
      cur.pos += 4;
      cur.until('-->');
    } else if (cur.startsWith('<!')) {
      cur.fail('DOCTYPE and DTD declarations are not allowed');
    } else {
      return;
    }
  }
}

function parseAttributes(cur: Cursor): Map<string, string> {
  const attrs = new Map<string, string>();
  for (;;) {
    cur.skipSpace();
    const c = cur.peek();
    if (c === '>' || c === '/' || cur.done) return attrs;
    const qname = cur.name();
    cur.skipSpace();
    cur.expect('=');
    cur.skipSpace();
    const quote = cur.peek();
    if (quote !== '"' && quote !== "'") cur.fail('attribute value must be quoted');
    cur.pos += 1;
    const raw = cur.until(quote);
    if (raw.includes('<')) cur.fail('"<" is not allowed in attribute values');
    if (attrs.has(qname)) cur.fail(`duplicate attribute "${qname}"`);
    attrs.set(qname, decodeEntities(raw, cur));
  }
}

function parseElement(cur: Cursor, depth: number): XmlElement {
  if (depth > XML_MAX_DEPTH) cur.fail('document nested too deeply');
  cur.expect('<');
  const qname = cur.name();
  const attributes = parseAttributes(cur);
  const { prefix, name } = splitName(qname);
  const element: XmlElement = { name, prefix, attributes, children: [], text: '' };
  if (cur.startsWith('/>')) {
    cur.pos += 2;
    return element;
  }
  cur.expect('>');
  let text = '';
  for (;;) {
    if (cur.done) cur.fail(`unclosed element <${qname}>`);
    if (cur.startsWith('</')) {
      cur.pos += 2;
      const closing = cur.name();
      if (closing !== qname) cur.fail(`mismatched closing tag </${closing}> for <${qname}>`);
      cur.skipSpace();
      cur.expect('>');
      element.text = text.trim();
      return element;
    }
    if (cur.startsWith('<!--')) {
      cur.pos += 4;
      cur.until('-->');
    } else if (cur.startsWith('<![CDATA[')) {
      cur.pos += 9;
      text += cur.until(']]>');
    } else if (cur.startsWith('<!') || cur.startsWith('<?')) {
      cur.fail('declarations are not allowed inside elements');
    } else if (cur.peek() === '<') {
      element.children.push(parseElement(cur, depth + 1));
    } else {
      const next = cur.src.indexOf('<', cur.pos);
      const raw = cur.src.slice(cur.pos, next < 0 ? cur.src.length : next);
      cur.pos += raw.length;
      text += decodeEntities(raw, cur);
    }
  }
}

/** Parse a document and return its root element. Throws `XmlError` on anything malformed or disallowed. */
export function parseXml(source: string): XmlElement {
  if (source.length > XML_MAX_BYTES) throw new XmlError('document too large', 0);
  const cur = new Cursor(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  skipMisc(cur);
  if (cur.peek() !== '<') cur.fail('expected the root element');
  const root = parseElement(cur, 0);
  skipMisc(cur);
  if (!cur.done) cur.fail('content after the root element');
  return root;
}

/** First child element with the given local name. */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}

/** All child elements with the given local name. */
export function childrenNamed(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : [];
}

/** Text of the first child with the given name, or null when absent or empty. */
export function childText(el: XmlElement | undefined, name: string): string | null {
  const text = child(el, name)?.text;
  return text ? text : null;
}
