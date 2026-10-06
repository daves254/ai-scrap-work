import type { AnyNode, Element } from "domhandler";
import { parseHtml } from "./html.js";

export interface StripOptions {
  /** Only remove CSS (<style>, stylesheet <link>s, style=""); keep legacy presentational HTML. */
  cssOnly?: boolean;
  /** Also remove class attributes. */
  classes?: boolean;
}

export interface StripReport {
  styleElements: number;
  stylesheetLinks: number;
  styleAttributes: number;
  presentationalAttributes: number;
  unwrappedElements: number;
  classAttributes: number;
}

export interface StripResult {
  html: string;
  report: StripReport;
}

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Obsolete HTML attributes that only control appearance, by element ("*" = any HTML element). */
const PRESENTATIONAL_ATTRS: Record<string, string[]> = {
  "*": ["align", "valign", "bgcolor"],
  body: ["background", "text", "link", "vlink", "alink", "marginwidth", "marginheight",
    "leftmargin", "topmargin", "rightmargin", "bottommargin"],
  table: ["border", "cellpadding", "cellspacing", "width", "height", "frame", "rules", "background"],
  td: ["width", "height", "nowrap", "background"],
  th: ["width", "height", "nowrap", "background"],
  tr: ["height", "background"],
  thead: ["background"],
  tbody: ["background"],
  tfoot: ["background"],
  col: ["width"],
  colgroup: ["width"],
  hr: ["noshade", "size", "width", "color"],
  img: ["border", "hspace", "vspace"],
  object: ["border", "hspace", "vspace"],
  iframe: ["frameborder", "marginwidth", "marginheight"],
  br: ["clear"],
  ul: ["type", "compact"],
  pre: ["width"],
};

/** Obsolete purely presentational elements: their tags are removed, their content kept. */
const UNWRAP = new Set(["font", "center", "big", "tt", "strike", "blink", "marquee"]);
/** Removed entirely (void elements with no content to keep). */
const REMOVE_VOID = new Set(["basefont"]);

const isStylesheetLink = (el: Element) => {
  const rel = ` ${(el.attribs.rel ?? "").toLowerCase()} `;
  if (rel.includes(" stylesheet ")) return true;
  const as = (el.attribs.as ?? "").toLowerCase();
  return as === "style" && /\s(preload|prefetch|modulepreload)\s/.test(rel);
};

type Edit = [start: number, end: number];
type Offsets = { startOffset: number; endOffset: number };

/**
 * Remove all CSS from an HTML document: <style> blocks (HTML and SVG), stylesheet
 * <link>s, style="" attributes, and — unless `cssOnly` — obsolete presentational
 * attributes (bgcolor, align, cellpadding, …) and elements (<font>, <center>, …).
 *
 * Works by cutting ranges out of the original text, so everything else in the
 * document stays exactly as it was.
 */
export function stripStyles(html: string, opts: StripOptions = {}): StripResult {
  const doc = parseHtml(html, { scriptingEnabled: false });
  const report: StripReport = {
    styleElements: 0,
    stylesheetLinks: 0,
    styleAttributes: 0,
    presentationalAttributes: 0,
    unwrappedElements: 0,
    classAttributes: 0,
  };
  const edits: Edit[] = [];

  /** Cut [start, end); if that leaves a whitespace-only line, cut the whole line. */
  const cut = (start: number, end: number) => {
    const lineStart = html.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = html.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = html.length;
    if (/^[ \t]*$/.test(html.slice(lineStart, start)) && /^[ \t\r]*$/.test(html.slice(end, lineEnd))) {
      edits.push([lineStart, Math.min(lineEnd + 1, html.length)]);
    } else {
      edits.push([start, end]);
    }
  };

  const cutAttr = (el: Element, name: string) => {
    // parse5 records per-attribute offsets; domhandler's type doesn't declare them.
    const attrs = (el.sourceCodeLocation as { attrs?: Record<string, Offsets> } | null | undefined)?.attrs;
    const loc = attrs?.[name];
    if (!loc) return false;
    let start = loc.startOffset;
    while (start > 0 && /\s/.test(html[start - 1])) start--;
    edits.push([start, loc.endOffset]);
    return true;
  };

  const visit = (node: AnyNode) => {
    if (node.type === "tag" || node.type === "style" || node.type === "script") {
      const el = node as Element;
      const loc = el.sourceCodeLocation;
      const isHtml = el.namespace === HTML_NS;

      if (el.name === "style") {
        if (loc) cut(loc.startOffset, loc.endOffset);
        report.styleElements++;
        return;
      }
      if (isHtml && el.name === "link" && isStylesheetLink(el)) {
        if (loc) cut(loc.startOffset, loc.endOffset);
        report.stylesheetLinks++;
        return;
      }
      if (isHtml && el.name === "meta" && (el.attribs["http-equiv"] ?? "").toLowerCase() === "default-style") {
        if (loc) cut(loc.startOffset, loc.endOffset);
        return;
      }

      if ("style" in el.attribs && cutAttr(el, "style")) report.styleAttributes++;
      if (opts.classes && "class" in el.attribs && cutAttr(el, "class")) report.classAttributes++;

      if (isHtml && !opts.cssOnly) {
        if (REMOVE_VOID.has(el.name)) {
          if (loc) cut(loc.startOffset, loc.endOffset);
          report.unwrappedElements++;
          return;
        }
        for (const name of [...PRESENTATIONAL_ATTRS["*"], ...(PRESENTATIONAL_ATTRS[el.name] ?? [])]) {
          if (name in el.attribs && cutAttr(el, name)) report.presentationalAttributes++;
        }
        if (UNWRAP.has(el.name) && loc?.startTag) {
          cut(loc.startTag.startOffset, loc.startTag.endOffset);
          if (loc.endTag) cut(loc.endTag.startOffset, loc.endTag.endOffset);
          report.unwrappedElements++;
        }
      }
    }
    // Covers element children as well as <template> content fragments.
    for (const child of (node as any).children ?? []) visit(child);
  };
  visit(doc);

  // Apply from the end; drop edits that fall inside one already applied
  // (e.g. an attribute on a tag that is being removed).
  edits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Edit[] = [];
  for (const e of edits) {
    const last = merged[merged.length - 1];
    if (last && e[0] < last[1]) last[1] = Math.max(last[1], e[1]);
    else merged.push(e);
  }
  let out = html;
  for (let i = merged.length - 1; i >= 0; i--) out = out.slice(0, merged[i][0]) + out.slice(merged[i][1]);

  return { html: out, report };
}
