#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { stripStyles } from "./strip.js";

const USAGE = `Usage: style-strip <input.html | -> [options]

Removes all styling from an HTML document: <style> blocks, stylesheet <link>s,
style="" attributes, and obsolete presentational HTML (bgcolor, align, <font>,
<center>, …). Everything else is left exactly as it was.

Options:
  -o, --out <file>   Write the result here (default: stdout)
  -i, --in-place     Overwrite the input file
      --css-only     Only remove CSS; keep presentational attributes/elements
      --classes      Also remove class attributes
  -q, --quiet        Don't print the summary
  -h, --help         Show this help

Use "-" as the input to read from stdin.
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      "in-place": { type: "boolean", short: "i" },
      "css-only": { type: "boolean" },
      classes: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  const [input] = positionals;
  if (values["in-place"] && (values.out || input === "-")) {
    process.stderr.write("--in-place needs a file input and cannot be combined with --out\n");
    return 2;
  }

  const html = input === "-" ? await text(process.stdin) : await readFile(input, "utf8");
  const { html: out, report: r } = stripStyles(html, {
    cssOnly: values["css-only"],
    classes: values.classes,
  });

  const outPath = values["in-place"] ? input : values.out;
  if (outPath) await writeFile(outPath, out);
  else process.stdout.write(out);

  if (!values.quiet) {
    const parts = [
      `${r.styleElements} <style>`,
      `${r.stylesheetLinks} stylesheet link(s)`,
      `${r.styleAttributes} style attribute(s)`,
    ];
    if (!values["css-only"]) {
      parts.push(`${r.presentationalAttributes} presentational attribute(s)`, `${r.unwrappedElements} presentational element(s)`);
    }
    if (values.classes) parts.push(`${r.classAttributes} class attribute(s)`);
    process.stderr.write(`style-strip: removed ${parts.join(", ")}${outPath ? ` -> ${outPath}` : ""}\n`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`style-strip: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
