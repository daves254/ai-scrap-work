import { test } from "node:test";
import assert from "node:assert/strict";
import { stripStyles } from "../src/index.js";

test("removes <style>, stylesheet <link>s and style attributes, leaving the rest byte-identical", () => {
  const input = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="a.css">
  <link rel="preload" as="style" href="b.css">
  <link rel="alternate stylesheet" href="c.css" title="alt">
  <link rel="icon" href="favicon.ico">
  <style>body { color: red }</style>
  <title>T</title>
</head>
<body>
  <p style="color: blue" data-x='1'>Hello &amp; <b STYLE='x'>bye</b></p>
  <!-- <style>comments are left alone</style> -->
</body>
</html>
`;
  const { html, report } = stripStyles(input);
  assert.equal(
    html,
    `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="icon" href="favicon.ico">
  <title>T</title>
</head>
<body>
  <p data-x='1'>Hello &amp; <b>bye</b></p>
  <!-- <style>comments are left alone</style> -->
</body>
</html>
`,
  );
  assert.equal(report.styleElements, 1);
  assert.equal(report.stylesheetLinks, 3);
  assert.equal(report.styleAttributes, 2);
});

test("removes styles inside SVG, <noscript> and <template>", () => {
  const { html } = stripStyles(
    `<svg width="10"><style>rect{fill:red}</style><rect style="x" fill="blue"/></svg>` +
      `<noscript><link rel=stylesheet href=n.css></noscript>` +
      `<template><p style="color:red">t</p></template>`,
  );
  assert.equal(
    html,
    `<svg width="10"><rect fill="blue"/></svg><noscript></noscript><template><p>t</p></template>`,
  );
});

test("removes obsolete presentational attributes and unwraps presentational elements", () => {
  const { html, report } = stripStyles(
    `<body bgcolor="#fff" text="black"><table border=1 cellpadding="2" width="100%"><tr><td align=center nowrap>x</td></tr></table>` +
      `<font color="red" face="Arial">red <i>text</i></font><center>mid</center><basefont size=3>` +
      `<img src="a.png" width="10" height="20" border="0" alt=""></body>`,
  );
  assert.equal(
    html,
    `<body><table><tr><td>x</td></tr></table>red <i>text</i>mid<img src="a.png" width="10" height="20" alt=""></body>`,
  );
  assert.equal(report.presentationalAttributes, 8);
  assert.equal(report.unwrappedElements, 3);
});

test("SVG attributes that share names with obsolete HTML ones are kept", () => {
  const svg = `<svg width="10" height="10"><rect width="5" height="5" align="x"/></svg>`;
  assert.equal(stripStyles(svg).html, svg);
});

test("cssOnly keeps presentational HTML; classes removes class attributes", () => {
  const input = `<td align="left" class="a b" style="x">1</td>`;
  const wrapped = `<table><tr>${input}</tr></table>`;
  assert.equal(stripStyles(wrapped, { cssOnly: true }).html, `<table><tr><td align="left" class="a b">1</td></tr></table>`);
  assert.equal(stripStyles(wrapped, { classes: true }).html, `<table><tr><td>1</td></tr></table>`);
});

test("unwrapping an element that sits on its own lines drops those lines", () => {
  const { html } = stripStyles(`<div>\n  <center>\n    <p>x</p>\n  </center>\n</div>`);
  assert.equal(html, `<div>\n    <p>x</p>\n</div>`);
});
