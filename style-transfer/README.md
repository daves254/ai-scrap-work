# style-transfer

Two tools for HTML styling:

- **`style-transfer`** copies the CSS rules from one page that apply to another (below).
- **`style-strip`** removes all styling from a page ([jump](#style-strip)).

Copy the CSS from one HTML page (**A**) into another (**B**), keeping only the
rules that apply to B. A rule is kept when its selector matches at least one
element in B. That covers classes, ids, tag names, attributes, combinators,
`:nth-child`, `:has()`, and any other selector.

```bash
npm install
npx tsx src/cli.ts A.html B.html -o B.styled.html
# or build it once and use the binary
npm run build && node dist/cli.js A.html B.html -i
```

## What it does

1. **Collects A's CSS.** It reads every `<style>` block and every `<link rel="stylesheet">`,
   in document order. Local files are resolved relative to A. Remote ones are skipped
   unless you pass `--fetch-remote`. A `media="…"` attribute is kept as an `@media` block.
2. **Matches each selector against B's DOM**, one selector at a time. B is parsed the way a
   browser would parse it, so `body`, `html` and `:root` exist even in a fragment. In
   `.a, .b, #c { … }`, only the parts that match are kept.
   - Pseudo-classes that depend on runtime state (`:hover`, `:focus`, `:checked`, `:disabled`, …)
     and pseudo-elements (`::before`, `::placeholder`, `::-webkit-scrollbar`, …) are ignored
     when matching. So `.btn:hover` is kept if B has a `.btn`.
   - Structural pseudo-classes (`:first-child`, `:nth-of-type()`, `:empty`, `:has()`, `:not()`, …)
     are evaluated against B.
   - If it can't evaluate a selector (for example a namespace selector like `svg|rect`), it keeps
     the rule and prints a warning, so styles are never lost silently.
3. **Cleans up.** `@media`, `@supports`, `@layer` and `@container` blocks are dropped once they are
   empty. `@keyframes`, `@font-face`, `@property` and `@counter-style` are kept only if a kept rule
   still uses them.
4. **Fixes paths.** Relative `url(...)`s are rewritten so they still work from where the output is
   written.
5. **Injects one `<style data-style-transfer>` block** into B's `<head>`. The rest of B is left
   byte-for-byte unchanged. If you run it again on the same file, the block is replaced, not
   duplicated.

## Options

| Option | Meaning |
| --- | --- |
| `-o, --out <file>` | Write the result here (default: stdout) |
| `-i, --in-place` | Overwrite B |
| `--css-only` | Output just the extracted CSS |
| `--css <file>` | Extra stylesheet to treat as part of A (repeatable) |
| `-s, --safelist <regex>` | Always keep matching selectors (repeatable), e.g. `-s '\.is-open'` for classes JS adds later |
| `--prepend` | Insert at the start of `<head>` so B's own styles win ties (default: end, so A's win) |
| `--fetch-remote` | Download http(s) stylesheets A links to |
| `-v, --verbose` | List every dropped selector and at-rule |
| `-q, --quiet` | No summary or warnings |

## Library use

```ts
import { transferStyles } from "./src/index.js";

const { html, css, report, warnings } = await transferStyles({
  sourceHtml, sourcePath: "A.html",
  targetHtml, outputPath: "B.html",
  safelist: [/^\.is-/],
});
```

## Limits

- Matching only sees B's static markup. If B adds classes or elements with JavaScript, use `--safelist`.
- Inline `style="…"` attributes in A aren't copied, because they belong to A's elements, not to
  selectors.
- `@import` rules are copied as they are (with paths rebased), but the files they import aren't filtered.

## Try it

```bash
npx tsx src/cli.ts examples/source/page.html examples/target/index.html -v
npm test
```

---

## style-strip

Removes all styling from an HTML document. It edits the original text in place, so everything else
(markup, comments, entities, whitespace) stays exactly as it was.

```bash
npx tsx src/strip-cli.ts page.html -o page.plain.html
cat page.html | npx tsx src/strip-cli.ts - > page.plain.html   # stdin -> stdout
node dist/strip-cli.js page.html -i                           # after npm run build
```

What it removes:

- `<style>` blocks, including ones inside SVG, `<noscript>` and `<template>`
- Stylesheet `<link>`s: `rel="stylesheet"`, `rel="alternate stylesheet"`, and `rel="preload"` with `as="style"`
- `<meta http-equiv="Default-Style">`
- Every `style="…"` attribute
- Obsolete presentational HTML attributes, such as `bgcolor`, `align`, `valign`, `<table border cellpadding
  cellspacing width>`, `<td nowrap>`, `<body text link>` and `<img border hspace>`. These are removed from
  HTML elements only: SVG's `width`/`height` are untouched, and so is `<img width height>`.
- Obsolete presentational elements: `<font>`, `<center>`, `<big>`, `<tt>`, `<strike>`, `<blink>` and
  `<marquee>` are unwrapped (the tags go, their content stays), and `<basefont>` is removed.

| Option | Meaning |
| --- | --- |
| `-o, --out <file>` | Write the result here (default: stdout) |
| `-i, --in-place` | Overwrite the input file |
| `--css-only` | Only remove CSS; keep the presentational attributes and elements |
| `--classes` | Also remove `class` attributes |
| `-q, --quiet` | No summary |

```ts
import { stripStyles } from "./src/index.js";
const { html, report } = stripStyles(input, { classes: true });
```

It doesn't touch scripts. CSS that JavaScript injects at runtime, or styles set on SVG attributes
like `fill`, will still apply.
