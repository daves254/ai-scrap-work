import path from "node:path";
import postcss, { type AtRule, type Container, type Root } from "postcss";
import type { SheetSource } from "./collect.js";
import type { SelectorMatcher } from "./match.js";

export interface PruneReport {
  selectorsKept: number;
  selectorsDropped: number;
  rulesKept: number;
  rulesDropped: number;
  /** Selectors from the source that matched nothing in the target. */
  droppedSelectors: string[];
  /** e.g. "@keyframes spin" — removed because nothing kept refers to it. */
  droppedAtRules: string[];
}

/** At-rules that only group other rules; dropped once they are empty. */
const GROUPING_AT_RULES = new Set([
  "media", "supports", "layer", "container", "document", "-moz-document", "scope", "starting-style",
]);

const isKeyframes = (name: string) => /^(-[a-z]+-)?keyframes$/i.test(name);

// ---------------------------------------------------------------------------
// Building one stylesheet out of all the source chunks
// ---------------------------------------------------------------------------

const URL_FN = /url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi;

function rebaseUrl(url: string, base: string | null, outBase: string | null): string {
  if (!url || !base || /^(data:|#|[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return url;
  if (/^https?:/i.test(base)) return new URL(url, base).href;
  // Root-relative paths mean the same thing wherever the CSS lives.
  if (url.startsWith("/") || !outBase || path.resolve(base) === path.resolve(outBase)) return url;
  const [, file, suffix] = url.match(/^([^?#]*)(.*)$/)!;
  const rel = path.relative(outBase, path.resolve(base, file)).split(path.sep).join("/");
  return (rel || ".") + suffix;
}

function rebaseValue(value: string, base: string | null, outBase: string | null): string {
  return value.replace(URL_FN, (_m, q: string, url: string) => `url(${q}${rebaseUrl(url, base, outBase)}${q})`);
}

export function buildStylesheet(
  sheets: SheetSource[],
  outBase: string | null,
  warn: (msg: string) => void,
): Root {
  const imports: AtRule[] = [];
  const out = postcss.root();

  for (const sheet of sheets) {
    let root: Root;
    try {
      root = postcss.parse(sheet.css, { from: sheet.label });
    } catch (err) {
      warn(`could not parse CSS from ${sheet.label}: ${(err as Error).message}`);
      continue;
    }

    root.walkComments((c) => {
      c.remove();
    });
    root.walkDecls((d) => {
      if (d.value.includes("url(")) d.value = rebaseValue(d.value, sheet.base, outBase);
    });

    const body = postcss.root();
    for (const node of [...root.nodes]) {
      if (node.type === "atrule" && node.name.toLowerCase() === "charset") continue;
      if (node.type === "atrule" && node.name.toLowerCase() === "import") {
        node.params = rebaseValue(node.params, sheet.base, outBase).replace(
          /^(['"])(.*?)\1/,
          (_m, q: string, url: string) => `${q}${rebaseUrl(url, sheet.base, outBase)}${q}`,
        );
        if (sheet.media) warn(`@import ${node.params} in media="${sheet.media}" sheet copied without that media`);
        warn(`@import ${node.params} copied as-is; its contents are not filtered`);
        imports.push(node.remove());
        continue;
      }
      body.append(node.remove());
    }

    if (sheet.media && sheet.media.toLowerCase() !== "all") {
      const media = postcss.atRule({ name: "media", params: sheet.media, raws: { afterName: " ", between: " " } });
      media.append(body.nodes);
      out.append(media);
    } else {
      out.append(body.nodes);
    }
  }

  out.prepend(imports);
  return out;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function insideKeyframes(node: { parent?: Container | Root | undefined }): boolean {
  for (let p = node.parent; p; p = (p as any).parent) {
    if (p.type === "atrule" && isKeyframes((p as AtRule).name)) return true;
  }
  return false;
}

function removeEmpty(container: Container): void {
  container.each((node) => {
    if (node.type !== "rule" && node.type !== "atrule") return;
    if (node.nodes) removeEmpty(node);
    const empty = node.nodes !== undefined && node.nodes.length === 0;
    if (!empty) return;
    if (node.type === "rule" || GROUPING_AT_RULES.has(node.name.toLowerCase())) node.remove();
  });
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

export function prune(root: Root, matcher: SelectorMatcher): PruneReport {
  const report: PruneReport = {
    selectorsKept: 0,
    selectorsDropped: 0,
    rulesKept: 0,
    rulesDropped: 0,
    droppedSelectors: [],
    droppedAtRules: [],
  };

  // 1. Selector rules: keep only the selectors that can apply to the target.
  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    if (rule.parent?.type === "rule") return; // nested rule: follows its parent

    const all = rule.selectors;
    const kept = all.filter((s) => matcher.matches(s));
    report.selectorsKept += kept.length;
    report.selectorsDropped += all.length - kept.length;
    for (const s of all) if (!kept.includes(s)) report.droppedSelectors.push(s);

    if (kept.length === 0) {
      report.rulesDropped++;
      rule.remove();
    } else {
      report.rulesKept++;
      if (kept.length !== all.length) rule.selectors = kept;
    }
  });
  removeEmpty(root);

  // 2. At-rules that exist only to be referenced (@keyframes, @font-face, …):
  //    keep them only if something we kept still refers to them.
  const definitionAtRule = (name: string) =>
    isKeyframes(name) || ["font-face", "property", "counter-style"].includes(name.toLowerCase());

  const usedValues = (includeKeyframes: boolean) => {
    const values: string[] = [];
    const props = new Set<string>();
    root.walkDecls((d) => {
      for (let p = d.parent as any; p; p = p.parent) {
        if (p.type === "atrule" && definitionAtRule(p.name) && !(includeKeyframes && isKeyframes(p.name))) return;
      }
      values.push(d.value);
      props.add(d.prop);
    });
    const tokens = new Set(values.flatMap((v) => v.split(/[\s,()/]+/).map(unquote)).filter(Boolean));
    return { text: values.join("\n").toLowerCase(), tokens, props };
  };

  const drop = (at: AtRule, label: string) => {
    report.droppedAtRules.push(label);
    at.remove();
  };

  let used = usedValues(false);
  root.walkAtRules((at) => {
    if (isKeyframes(at.name) && !used.tokens.has(unquote(at.params))) drop(at, `@${at.name} ${at.params}`);
  });

  used = usedValues(true);
  root.walkAtRules((at) => {
    const name = at.name.toLowerCase();
    if (name === "font-face") {
      let family = "";
      at.walkDecls(/^font-family$/i, (d) => {
        family = unquote(d.value).toLowerCase();
      });
      const re = new RegExp(`(^|[\\s,"'])${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s,"'!;])`, "m");
      if (family && !re.test(used.text)) drop(at, `@font-face ${family}`);
    } else if (name === "property") {
      const prop = at.params.trim();
      if (!used.tokens.has(prop) && !used.props.has(prop)) drop(at, `@property ${prop}`);
    } else if (name === "counter-style") {
      if (!used.tokens.has(at.params.trim())) drop(at, `@counter-style ${at.params}`);
    }
  });
  removeEmpty(root);

  return report;
}
