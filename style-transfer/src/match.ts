import selectorParser from "postcss-selector-parser";
import type { Document } from "domhandler";
import { findOne } from "./html.js";

type Selector = selectorParser.Selector;
type Pseudo = selectorParser.Pseudo;

/**
 * Pseudo-classes whose result depends only on the document's markup, so they
 * can be evaluated against the target HTML as-is.
 */
const STATIC_PSEUDOS = new Set([
  ":root", ":empty", ":scope", ":lang",
  ":first-child", ":last-child", ":only-child",
  ":first-of-type", ":last-of-type", ":only-of-type",
  ":nth-child", ":nth-last-child", ":nth-of-type", ":nth-last-of-type",
  ":required", ":optional",
]);

/** Pseudo-classes that take a selector list we can simplify recursively. */
const LOGICAL_PSEUDOS = new Set([":is", ":where", ":matches", ":-webkit-any", ":-moz-any", ":has"]);

/**
 * Everything else (:hover, :focus, :checked, ::before, ::-webkit-scrollbar, …)
 * depends on runtime state or targets a pseudo-element. Those are stripped
 * before matching, i.e. treated as "could match", so `.btn:hover` is kept
 * whenever B has a `.btn`.
 */
function isKnown(name: string): boolean {
  return STATIC_PSEUDOS.has(name) || LOGICAL_PSEUDOS.has(name) || name === ":not";
}

function hasRuntimePseudo(node: Pseudo): boolean {
  let found = false;
  node.walkPseudos((p) => {
    if (!isKnown(p.value.toLowerCase())) found = true;
  });
  return found;
}

function simplify(sel: Selector): void {
  const leadingCombinator = sel.first?.type === "combinator";

  for (const node of [...sel.nodes]) {
    if (node.type !== "pseudo") continue;
    const name = node.value.toLowerCase();
    if (name === ":not") {
      // `:not(:hover)` may or may not hold at runtime; assume it can.
      if (hasRuntimePseudo(node)) node.remove();
    } else if (LOGICAL_PSEUDOS.has(name)) {
      node.each((inner) => {
        if (inner.type === "selector") simplify(inner);
      });
    } else if (!STATIC_PSEUDOS.has(name)) {
      node.remove();
    }
  }

  // Removing pseudos can leave a compound empty (`a > ::before`, `:hover`);
  // fill those holes with `*` so the selector stays valid.
  let needCompound = !leadingCombinator;
  for (const node of [...sel.nodes]) {
    if (node.type === "combinator") {
      if (needCompound) sel.insertBefore(node, selectorParser.universal());
      needCompound = true;
    } else if (node.type !== "comment") {
      needCompound = false;
    }
  }
  if (needCompound) sel.append(selectorParser.universal());
}

/** Turn a CSS selector into one that can be statically tested against markup. */
export function toStaticSelector(selector: string): string {
  return selectorParser((root) => {
    root.each((sel) => simplify(sel));
  }).processSync(selector, { lossless: false });
}

export class SelectorMatcher {
  private cache = new Map<string, boolean>();
  private warned = new Set<string>();

  constructor(
    private doc: Document,
    private safelist: RegExp[],
    private warn: (msg: string) => void,
  ) {}

  /** True if `selector` (a single complex selector, no commas) can apply to the target. */
  matches(selector: string): boolean {
    const key = selector.trim();
    let hit = this.cache.get(key);
    if (hit === undefined) {
      hit = this.evaluate(key);
      this.cache.set(key, hit);
    }
    return hit;
  }

  private evaluate(selector: string): boolean {
    if (this.safelist.some((re) => re.test(selector))) return true;
    // Nested CSS (`&`) depends on the parent rule; let the parent decide.
    if (selector.includes("&")) return true;

    try {
      return findOne(toStaticSelector(selector), this.doc) !== null;
    } catch (err) {
      // Unsupported syntax (namespaces, very new pseudos, …): keep rather than lose styles.
      if (!this.warned.has(selector)) {
        this.warned.add(selector);
        this.warn(`kept selector it could not evaluate: ${selector} (${(err as Error).message})`);
      }
      return true;
    }
  }
}
