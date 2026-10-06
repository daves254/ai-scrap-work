import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { toStaticSelector, transferStyles } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const source = (css: string, head = "") => `<html><head>${head}<style>${css}</style></head><body></body></html>`;
const target = (body: string) => `<!doctype html><html><head><title>B</title></head><body>${body}</body></html>`;

async function run(css: string, body: string, extra: Partial<Parameters<typeof transferStyles>[0]> = {}) {
  return transferStyles({ sourceHtml: source(css), targetHtml: target(body), ...extra });
}

test("copies class, id, tag, attribute and combinator selectors that match", async () => {
  const { css, report } = await run(
    `.a{color:red} .missing{color:blue} #main{width:1px} #nope{width:2px}
     p{margin:0} table{border:0} [data-x="1"]{top:0} [data-y]{top:1px}
     .a > span{left:0} .a + .a{right:0} div ~ em{bottom:0}`,
    `<div class="a" id="main" data-x="1"><span>s</span></div><p>p</p>`,
  );
  for (const kept of [".a{", "#main{", "p{", '[data-x="1"]', ".a > span"]) assert.ok(css.includes(kept), kept);
  for (const gone of [".missing", "#nope", "table", "[data-y]", ".a + .a", "div ~ em"]) {
    assert.ok(!css.includes(gone), gone);
  }
  assert.equal(report.selectorsDropped, 6);
});

test("splits selector lists, keeping only the matching parts", async () => {
  const { css } = await run(`.a, .b, #c { color: red }`, `<i class="a"></i><i id="c"></i>`);
  assert.match(css, /^\.a,\s*#c \{ color: red \}$/);
});

test("runtime pseudo-classes and pseudo-elements are treated as possibly matching", async () => {
  const { css } = await run(
    `.btn:hover{a:1} .btn::before{a:2} input:checked + label{a:3} .x:focus-within{a:4}
     li:not(:hover){a:5} .nope:hover{a:6} ::selection{a:7} a ::after{a:8}`,
    `<a class="btn"><span>go</span></a><input type="checkbox"><label>l</label><ul><li>i</li></ul>`,
  );
  for (const n of [1, 2, 3, 5, 7, 8]) assert.ok(css.includes(`a:${n}`), `a:${n}`);
  assert.ok(!css.includes("a:4"));
  assert.ok(!css.includes("a:6"));
});

test("structural pseudo-classes are evaluated against the target", async () => {
  const { css } = await run(
    `li:first-child{a:1} li:nth-child(3){a:2} div:empty{a:3} p:only-child{a:4} section:has(> h1){a:5} section:has(h2){a:6}`,
    `<ul><li>1</li><li>2</li></ul><div></div><section><h1>t</h1></section>`,
  );
  assert.ok(css.includes("a:1"));
  assert.ok(!css.includes("a:2"));
  assert.ok(css.includes("a:3"));
  assert.ok(!css.includes("a:4"));
  assert.ok(css.includes("a:5"));
  assert.ok(!css.includes("a:6"));
});

test("toStaticSelector strips runtime parts and fills empty compounds", () => {
  assert.equal(toStaticSelector(".a:hover"), ".a");
  assert.equal(toStaticSelector(":hover"), "*");
  assert.equal(toStaticSelector("a > ::before"), "a>*");
  assert.equal(toStaticSelector("a ::after"), "a *");
  assert.equal(toStaticSelector("li:not(:focus):first-child"), "li:first-child");
  assert.equal(toStaticSelector("li:not(.x)"), "li:not(.x)");
  assert.equal(toStaticSelector(":is(.a:hover, .b)"), ":is(.a,.b)");
});

test("keeps @media/@supports only when something inside matches", async () => {
  const { css } = await run(
    `@media (min-width: 1px) { .a{x:1} .z{x:2} }
     @media print { .z{x:3} }
     @supports (display:grid) { @media screen { .a{x:4} } }`,
    `<i class="a"></i>`,
  );
  assert.ok(css.includes("x:1"));
  assert.ok(!css.includes("x:2"));
  assert.ok(!css.includes("print"));
  assert.ok(css.includes("@supports (display:grid)") && css.includes("x:4"));
});

test("keeps @keyframes, @font-face and @property only when referenced", async () => {
  const { css, report } = await run(
    `@keyframes used { to { opacity: 0 } }
     @keyframes unused { to { opacity: 1 } }
     @-webkit-keyframes used { to { opacity: 0 } }
     @font-face { font-family: "Brand Sans"; src: url(a.woff2); }
     @font-face { font-family: Other; src: url(b.woff2); }
     @property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
     @property --unused { syntax: "*"; inherits: false; }
     .a { animation: used 1s; font: 12px/1 "Brand Sans", serif; transform: rotate(var(--angle)); }
     .z { animation-name: unused; font-family: Other; }`,
    `<i class="a"></i>`,
  );
  assert.ok(css.includes("@keyframes used"));
  assert.ok(css.includes("@-webkit-keyframes used"));
  assert.ok(css.includes('"Brand Sans"; src'));
  assert.ok(css.includes("@property --angle"));
  assert.ok(!css.includes("unused"));
  assert.ok(!css.includes("Other"));
  assert.deepEqual(report.droppedAtRules.sort(), ["@font-face other", "@keyframes unused", "@property --unused"]);
});

test("safelist keeps selectors for classes added at runtime", async () => {
  const { css } = await run(`.is-open{a:1} .is-closed{a:2} .other{a:3}`, `<div></div>`, {
    safelist: [/^\.is-/],
  });
  assert.ok(css.includes("a:1") && css.includes("a:2"));
  assert.ok(!css.includes("a:3"));
});

test("selectors it cannot evaluate are kept with a warning", async () => {
  const { css, warnings } = await run(`svg|rect{a:1}`, `<div></div>`);
  assert.ok(css.includes("a:1"));
  assert.equal(warnings.length, 1);
});

test("inserts at end of <head> by default and at start with position=start", async () => {
  const end = await run(`.a{a:1}`, `<i class="a"></i>`);
  assert.match(end.html, /<title>B<\/title>\n<style data-style-transfer="source">[\s\S]*<\/style>\n<\/head>/);
  const start = await run(`.a{a:1}`, `<i class="a"></i>`, { position: "start" });
  assert.match(start.html, /<head>\n<style data-style-transfer/);
});

test("leaves the rest of the target untouched and handles a missing <head>", async () => {
  const body = `<!-- keep &amp; me --><DIV CLASS="a" data-q='x'>&nbsp;</DIV>`;
  const { html } = await transferStyles({ sourceHtml: source(`.a{a:1}`), targetHtml: body });
  assert.equal(html.replace(/<style[\s\S]*?<\/style>\n/, ""), body);
  assert.ok(html.startsWith("<style"));
});

test("re-running replaces the previous block instead of adding another", async () => {
  const first = await run(`.a{a:1}`, `<i class="a"></i>`);
  const second = await transferStyles({ sourceHtml: source(`.a{a:2}`), targetHtml: first.html });
  assert.equal(second.html.match(/<style/g)?.length, 1);
  assert.ok(second.html.includes("a:2") && !second.html.includes("a:1"));
});

test("<style media> is preserved as @media and </style> inside CSS is escaped", async () => {
  const { css, html } = await transferStyles({
    sourceHtml: `<style media="print">.a{color:red}</style>`,
    targetHtml: target(`<i class="a"></i>`),
    extraCss: [{ css: `.a::after{content:"</style>"}` }],
  });
  assert.match(css, /^@media print \{/);
  // The block must close exactly once: the "</style>" inside the string is escaped.
  assert.equal(html.match(/<\/style/gi)?.length, 1);
  assert.match(css, /content:"(\\3c |<\\)\/style>"/);
});

test("reads <link> stylesheets and rebases relative url()s to the output location", async () => {
  const sourcePath = path.join(here, "../examples/source/page.html");
  const targetPath = path.join(here, "../examples/target/index.html");
  const { css, report } = await transferStyles({
    sourceHtml: await readFile(sourcePath, "utf8"),
    sourcePath,
    targetHtml: await readFile(targetPath, "utf8"),
    outputPath: targetPath,
  });
  assert.ok(css.includes(".badge"));
  assert.ok(!css.includes(".modal"));
  assert.ok(css.includes("url(../source/fonts/inter.woff2)"));
  assert.ok(css.includes("url(../source/img/hero.jpg)"));
  assert.ok(!css.includes("Unused Font"));
  assert.ok(report.droppedSelectors.includes("#sidebar"));
});
