import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Document } from "domhandler";
import { findAll, textOf } from "./html.js";

/** One chunk of CSS pulled out of the source document. */
export interface SheetSource {
  css: string;
  /** Where relative url()s in this CSS resolve from: a directory path or an absolute URL. */
  base: string | null;
  /** `media` attribute of the <style>/<link>, if any. */
  media: string | null;
  /** Human-readable origin, used in warnings. */
  label: string;
}

export interface CollectOptions {
  /** Path of the source HTML file; needed to resolve relative <link href>. */
  sourcePath?: string;
  /** Download http(s) stylesheets referenced by <link>. */
  fetchRemote?: boolean;
  warn: (msg: string) => void;
}

const REMOTE = /^(https?:)?\/\//i;

export async function collectSheets(doc: Document, opts: CollectOptions): Promise<SheetSource[]> {
  const sourceDir = opts.sourcePath ? path.dirname(path.resolve(opts.sourcePath)) : null;
  const sheets: SheetSource[] = [];

  for (const el of findAll('style, link[rel~="stylesheet" i]', doc)) {
    const media = el.attribs.media?.trim() || null;

    if (el.name === "style") {
      const type = el.attribs.type?.trim().toLowerCase();
      if (type && type !== "text/css") continue;
      // Skip a block a previous run injected into this same file.
      if ("data-style-transfer" in el.attribs) continue;
      sheets.push({ css: textOf(el), base: sourceDir, media, label: "<style>" });
      continue;
    }

    if (/\balternate\b/i.test(el.attribs.rel ?? "")) continue;
    const href = el.attribs.href?.trim();
    if (!href) continue;

    if (REMOTE.test(href)) {
      const url = href.startsWith("//") ? `https:${href}` : href;
      if (!opts.fetchRemote) {
        opts.warn(`skipped remote stylesheet ${url} (pass --fetch-remote to include it)`);
        continue;
      }
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        sheets.push({ css: await res.text(), base: url, media, label: url });
      } catch (err) {
        opts.warn(`could not fetch ${url}: ${(err as Error).message}`);
      }
      continue;
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      opts.warn(`skipped stylesheet with unsupported URL scheme: ${href}`);
      continue;
    }
    if (!sourceDir) {
      opts.warn(`skipped <link href="${href}">: source path unknown, cannot resolve it`);
      continue;
    }
    const file = path.resolve(sourceDir, decodeURI(href.replace(/[?#].*$/, "")));
    try {
      sheets.push({ css: await readFile(file, "utf8"), base: path.dirname(file), media, label: file });
    } catch (err) {
      opts.warn(`could not read ${file}: ${(err as Error).message}`);
    }
  }

  return sheets;
}
