import path from "node:path";
import { collectSheets } from "./collect.js";
import { parseHtml } from "./html.js";
import { injectStyle } from "./inject.js";
import { SelectorMatcher } from "./match.js";
import { buildStylesheet, prune, type PruneReport } from "./prune.js";

export { toStaticSelector } from "./match.js";

export interface TransferOptions {
  /** HTML whose styles are copied (A). */
  sourceHtml: string;
  /** File path of A; used to resolve <link href> and relative url()s. */
  sourcePath?: string;
  /** HTML that receives the styles (B). */
  targetHtml: string;
  /** Where the result will be written; relative url()s are rewritten to work from there. */
  outputPath?: string;
  /** Extra stylesheets to treat as part of A. */
  extraCss?: { css: string; path?: string }[];
  /** Selectors matching any of these are always kept (e.g. classes added by JS). */
  safelist?: RegExp[];
  /** "end" (default): A's rules come after B's own styles. "start": before them. */
  position?: "start" | "end";
  /** Download http(s) stylesheets that A links to. */
  fetchRemote?: boolean;
  /** Called for each non-fatal problem. Defaults to collecting into `warnings`. */
  onWarning?: (msg: string) => void;
}

export interface TransferResult {
  /** B with the matching styles injected. */
  html: string;
  /** Just the CSS that was copied. */
  css: string;
  report: PruneReport;
  warnings: string[];
}

export async function transferStyles(opts: TransferOptions): Promise<TransferResult> {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    warnings.push(msg);
    opts.onWarning?.(msg);
  };

  const sourceDoc = parseHtml(opts.sourceHtml);
  const targetDoc = parseHtml(opts.targetHtml);

  const sheets = await collectSheets(sourceDoc, {
    sourcePath: opts.sourcePath,
    fetchRemote: opts.fetchRemote,
    warn,
  });
  for (const extra of opts.extraCss ?? []) {
    sheets.push({
      css: extra.css,
      base: extra.path ? path.dirname(path.resolve(extra.path)) : null,
      media: null,
      label: extra.path ?? "extra css",
    });
  }

  const outBase = opts.outputPath ? path.dirname(path.resolve(opts.outputPath)) : null;
  const root = buildStylesheet(sheets, outBase, warn);
  const report = prune(root, new SelectorMatcher(targetDoc, opts.safelist ?? [], warn));

  // Removing rules leaves their surrounding whitespace behind; re-space the top level.
  root.each((node, i) => {
    node.raws.before = i === 0 ? "" : "\n\n";
  });
  const css = root.toString().trim();
  const label = opts.sourcePath ? path.basename(opts.sourcePath) : "source";
  const html = css
    ? injectStyle(opts.targetHtml, targetDoc, css, { position: opts.position ?? "end", label })
    : opts.targetHtml;

  return { html, css, report, warnings };
}
