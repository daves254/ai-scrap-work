import { parse } from "parse5";
import { adapter } from "parse5-htmlparser2-tree-adapter";
import type { Document, Element } from "domhandler";
import { selectAll, selectOne } from "css-select";

/**
 * Parse HTML into an htmlparser2-compatible DOM with source offsets.
 * `scriptingEnabled: false` parses <noscript> contents as markup instead of text.
 */
export function parseHtml(html: string, { scriptingEnabled = true } = {}): Document {
  return parse(html, { treeAdapter: adapter, sourceCodeLocationInfo: true, scriptingEnabled });
}

export function findAll(selector: string, doc: Document): Element[] {
  return selectAll<any, Element>(selector, doc);
}

export function findOne(selector: string, doc: Document): Element | null {
  return selectOne<any, Element>(selector, doc);
}

export function textOf(el: Element): string {
  return el.children.map((c: any) => (c.type === "text" ? c.data : "")).join("");
}
