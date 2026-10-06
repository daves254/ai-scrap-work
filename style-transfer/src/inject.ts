import type { Document, Element } from "domhandler";
import { findOne } from "./html.js";

export interface InjectOptions {
  /** Put the block at the start of <head> (B's own styles win) or the end (A's styles win). */
  position: "start" | "end";
  /** Written to the block's data-style-transfer attribute. */
  label: string;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * Insert `css` into the target HTML as a <style> block, editing the original
 * text in place so the rest of the document stays byte-for-byte unchanged.
 * A block from a previous run is replaced instead of duplicated.
 */
export function injectStyle(html: string, doc: Document, css: string, opts: InjectOptions): string {
  const block =
    `<style data-style-transfer="${escapeAttr(opts.label)}">\n` +
    css.replace(/<\/(style)/gi, "<\\/$1") +
    `\n</style>`;

  const previous = findOne("style[data-style-transfer]", doc)?.sourceCodeLocation;
  if (previous) return html.slice(0, previous.startOffset) + block + html.slice(previous.endOffset);

  const at = insertionOffset(doc, opts.position);
  const before = html.slice(0, at);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  return before + lead + block + "\n" + html.slice(at);
}

function insertionOffset(doc: Document, position: "start" | "end"): number {
  const head = findOne("head", doc);
  const loc = head?.sourceCodeLocation;

  if (head && loc?.startTag && position === "start") return loc.startTag.endOffset;
  if (head && position === "end") {
    if (loc?.endTag) return loc.endTag.startOffset;
    const last = [...head.children].reverse().find((c) => c.sourceCodeLocation);
    if (last) return last.sourceCodeLocation!.endOffset;
    if (loc?.startTag) return loc.startTag.endOffset;
  }

  // No usable <head> in the source text: a <style> right after <html> (or the
  // doctype, or at the very top) still ends up in the implied head.
  const html = findOne("html", doc) as Element | null;
  if (html?.sourceCodeLocation?.startTag) return html.sourceCodeLocation.startTag.endOffset;
  const doctype = doc.children.find((c) => c.type === "directive");
  return doctype?.sourceCodeLocation?.endOffset ?? 0;
}
