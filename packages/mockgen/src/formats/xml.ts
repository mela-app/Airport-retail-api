/**
 * A minimal XML builder: messages are built as node trees and rendered with every attribute value and
 * text node escaped, so no markup is ever assembled from unescaped strings.
 */
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&apos;'],
]);

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ENTITIES.get(ch) ?? ch);
}

export type XmlAttrs = readonly (readonly [string, string])[];

export interface XmlNode {
  name: string;
  attrs?: XmlAttrs;
  text?: string;
  children?: readonly (XmlNode | null | false)[];
}

/** Element helper: `x('Gate', [], '42')`, `x('Resource', [['DepartureOrArrival', 'Departure']], undefined, [...])`. */
export function x(
  name: string,
  attrs: XmlAttrs = [],
  text?: string,
  children?: readonly (XmlNode | null | false)[],
): XmlNode {
  return { name, attrs, ...(text === undefined ? {} : { text }), ...(children ? { children } : {}) };
}

const isLetter = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
const isNameChar = (c: string) => isLetter(c) || (c >= '0' && c <= '9') || c === '.' || c === '-';

/** XML names as this builder allows them: a letter or underscore, then letters, digits, `_`, `.` or `-`. */
function isXmlName(name: string): boolean {
  const chars = [...name];
  const first = chars.at(0);
  return first !== undefined && isLetter(first) && chars.every(isNameChar);
}

function startTag(node: XmlNode, close: '>' | '/>'): string {
  if (!isXmlName(node.name)) throw new Error('invalid XML element name');
  const attrs = (node.attrs ?? []).map(([key, value]) => {
    if (!isXmlName(key)) throw new Error('invalid XML attribute name');
    return [' ', key, '="', escapeXml(value), '"'].join('');
  });
  return ['<', node.name, ...attrs, close].join('');
}

function render(node: XmlNode, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  const children = (node.children ?? []).filter((c): c is XmlNode => Boolean(c));
  if (children.length > 0) {
    out.push([pad, startTag(node, '>')].join(''));
    for (const child of children) render(child, depth + 1, out);
    out.push([pad, '</', node.name, '>'].join(''));
  } else if (node.text !== undefined) {
    out.push([pad, startTag(node, '>'), escapeXml(node.text), '</', node.name, '>'].join(''));
  } else {
    out.push([pad, startTag(node, '/>')].join(''));
  }
}

/** Render a document with an XML declaration. */
export function renderXml(root: XmlNode): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  render(root, 0, out);
  return [out.join('\n'), '\n'].join('');
}
