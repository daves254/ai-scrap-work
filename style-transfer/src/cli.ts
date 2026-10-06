#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { transferStyles } from "./index.js";

const USAGE = `Usage: style-transfer <source.html> <target.html> [options]

Copies every CSS rule from <source.html> whose selector matches something in
<target.html> (classes, ids, tags, attributes, combinators, …) into the target.

Options:
  -o, --out <file>       Write the result here (default: stdout)
  -i, --in-place         Overwrite <target.html>
      --css-only         Output only the extracted CSS, not the HTML
      --css <file>       Extra stylesheet to treat as part of the source (repeatable)
  -s, --safelist <re>    Always keep selectors matching this regex (repeatable)
      --prepend          Insert at the start of <head> so the target's own styles win
      --fetch-remote     Download http(s) stylesheets the source links to
  -v, --verbose          List dropped selectors and at-rules
  -q, --quiet            Don't print the summary or warnings
  -h, --help             Show this help
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      "in-place": { type: "boolean", short: "i" },
      "css-only": { type: "boolean" },
      css: { type: "string", multiple: true },
      safelist: { type: "string", short: "s", multiple: true },
      prepend: { type: "boolean" },
      "fetch-remote": { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 2) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (values["in-place"] && values.out) {
    process.stderr.write("--in-place and --out cannot be combined\n");
    return 2;
  }

  const [sourcePath, targetPath] = positionals;
  const outPath = values["in-place"] ? targetPath : values.out;
  const log = (msg: string) => {
    if (!values.quiet) process.stderr.write(msg + "\n");
  };

  const result = await transferStyles({
    sourceHtml: await readFile(sourcePath, "utf8"),
    sourcePath,
    targetHtml: await readFile(targetPath, "utf8"),
    // With stdout output, assume it ends up next to the target.
    outputPath: outPath ?? targetPath,
    extraCss: await Promise.all(
      (values.css ?? []).map(async (p) => ({ css: await readFile(p, "utf8"), path: p })),
    ),
    safelist: (values.safelist ?? []).map((re) => new RegExp(re)),
    position: values.prepend ? "start" : "end",
    fetchRemote: values["fetch-remote"],
    onWarning: (msg) => log(`warning: ${msg}`),
  });

  const output = values["css-only"] ? result.css + "\n" : result.html;
  if (outPath) await writeFile(outPath, output);
  else process.stdout.write(output);

  const r = result.report;
  log(
    `style-transfer: kept ${r.selectorsKept} selector(s) in ${r.rulesKept} rule(s); ` +
      `dropped ${r.selectorsDropped} selector(s), ${r.rulesDropped} rule(s), ${r.droppedAtRules.length} at-rule(s)` +
      (outPath ? ` -> ${outPath}` : ""),
  );
  if (values.verbose) {
    for (const s of r.droppedSelectors) log(`  dropped selector: ${s}`);
    for (const a of r.droppedAtRules) log(`  dropped ${a}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`style-transfer: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
