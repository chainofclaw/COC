#!/usr/bin/env node
// Build COC_business_plan.zh.md → PDF
// Usage: node build.mjs <input.md> <output.pdf>

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import markdownItAnchor from 'markdown-it-anchor';

const __dirname = dirname(fileURLToPath(import.meta.url));

const inputPath = resolve(process.argv[2] || '../coc-bp-input.md');
const outputPath = resolve(process.argv[3] || '../coc-bp-output.pdf');
const tmpHtml = resolve(__dirname, '_tmp_build.html');

if (!existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  process.exit(1);
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false, // disable to avoid touching Chinese punctuation
  breaks: false,
}).use(markdownItAnchor, {
  permalink: false,
});

const markdownContent = readFileSync(inputPath, 'utf-8');
const renderedBody = md.render(markdownContent);

// Extract document title from first H1
const titleMatch = markdownContent.match(/^#\s+(.+)$/m);
const docTitle = titleMatch ? titleMatch[1].trim() : 'COC Document';

const css = `
@page {
  size: A4;
  margin: 18mm 14mm 20mm 14mm;

  @bottom-center {
    content: counter(page) " / " counter(pages);
    font-family: "Noto Sans CJK SC", sans-serif;
    font-size: 9pt;
    color: #888;
  }
}

@page :first {
  margin-top: 30mm;
}

* {
  box-sizing: border-box;
}

html {
  font-size: 11pt;
}

body {
  font-family: "Noto Sans CJK SC", "Noto Sans CJK SC Regular", "PingFang SC",
               "Microsoft YaHei", sans-serif;
  font-size: 11pt;
  line-height: 1.65;
  color: #1a1a1a;
  margin: 0;
  padding: 0;
  /* Critical for Chinese text wrapping */
  word-wrap: break-word;
  overflow-wrap: break-word;
  word-break: normal;
}

/* Headings */
h1, h2, h3, h4, h5, h6 {
  font-family: "Noto Sans CJK SC", sans-serif;
  font-weight: 700;
  color: #0a1628;
  line-height: 1.35;
  margin-top: 1.4em;
  margin-bottom: 0.6em;
  page-break-after: avoid;
  break-after: avoid;
}

h1 {
  font-size: 22pt;
  border-bottom: 3px solid #0a1628;
  padding-bottom: 0.4em;
  margin-top: 0;
  margin-bottom: 1em;
  page-break-before: always;
  break-before: page;
}

h1:first-of-type {
  page-break-before: avoid;
  break-before: avoid;
}

h2 {
  font-size: 17pt;
  border-bottom: 2px solid #d5d9e0;
  padding-bottom: 0.3em;
  margin-top: 1.6em;
  page-break-before: auto;
}

h3 {
  font-size: 14pt;
  margin-top: 1.3em;
}

h4 {
  font-size: 12pt;
  color: #2a3340;
  margin-top: 1.1em;
}

h5, h6 {
  font-size: 11pt;
  color: #4a5360;
}

/* Paragraphs */
p {
  margin: 0.5em 0 0.8em 0;
  text-align: justify;
  text-justify: inter-ideograph;
  orphans: 3;
  widows: 3;
}

/* Strong and emphasis */
strong, b {
  font-weight: 700;
  color: #0a1628;
}

em, i {
  font-style: normal;
  color: #5a6068;
}

/* Lists */
ul, ol {
  margin: 0.5em 0 0.8em 0;
  padding-left: 1.6em;
}

li {
  margin: 0.25em 0;
  line-height: 1.6;
}

li > p {
  margin: 0.2em 0;
}

/* Inline code */
code {
  font-family: "Noto Sans Mono CJK SC", "Noto Sans Mono", "Consolas", monospace;
  font-size: 0.9em;
  background: #f4f6f8;
  padding: 0.1em 0.4em;
  border-radius: 3px;
  border: 1px solid #e2e6ea;
  color: #c7254e;
  white-space: nowrap;
}

/* Code blocks — CRITICAL: must use CJK monospace for ASCII frame chars */
pre {
  font-family: "Noto Sans Mono CJK SC", "Noto Sans Mono", "Consolas", monospace;
  font-size: 6.8pt;
  line-height: 1.42;
  background: #f6f8fa;
  border: 1px solid #d5d9e0;
  border-radius: 4px;
  padding: 0.7em 0.85em;
  margin: 0.7em 0;
  overflow: visible;
  white-space: pre;
  page-break-inside: avoid;
  break-inside: avoid;
  font-feature-settings: "tnum";
  -webkit-font-feature-settings: "tnum";
  /* Allow horizontal extension and prevent clipping */
  max-width: 100%;
  word-wrap: normal;
  word-break: keep-all;
}

pre code {
  font-family: inherit;
  font-size: inherit;
  background: none;
  border: none;
  padding: 0;
  color: #1a1a1a;
  white-space: pre;
}

/* Blockquotes */
blockquote {
  margin: 0.8em 0;
  padding: 0.5em 1em;
  border-left: 4px solid #f5a623;
  background: #fdf8ef;
  color: #333;
  page-break-inside: avoid;
  break-inside: avoid;
}

blockquote p {
  margin: 0.3em 0;
}

blockquote strong {
  color: #8a5a00;
}

/* Tables — critical for BP */
table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.9em 0;
  font-size: 9.5pt;
  line-height: 1.45;
  page-break-inside: auto;
  break-inside: auto;
  table-layout: auto;
}

thead {
  display: table-header-group;
}

tr {
  page-break-inside: avoid;
  break-inside: avoid;
}

th {
  background: #0a1628;
  color: #ffffff;
  font-weight: 700;
  text-align: left;
  padding: 0.55em 0.7em;
  border: 1px solid #0a1628;
  vertical-align: top;
}

td {
  padding: 0.5em 0.7em;
  border: 1px solid #d5d9e0;
  vertical-align: top;
  word-wrap: break-word;
  overflow-wrap: anywhere;
}

tr:nth-child(even) td {
  background: #f9fafb;
}

/* Horizontal rule */
hr {
  border: none;
  border-top: 1px solid #d5d9e0;
  margin: 1.5em 0;
  page-break-after: avoid;
  break-after: avoid;
}

/* Links */
a {
  color: #0066cc;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

/* Cover page styling: first H1 + the lines under it */
.cover-meta {
  font-size: 11pt;
  color: #555;
  margin-top: 0.3em;
}

/* Avoid page break between heading and following content */
h1 + p, h2 + p, h3 + p, h4 + p,
h1 + table, h2 + table, h3 + table, h4 + table,
h1 + ul, h2 + ul, h3 + ul, h4 + ul,
h1 + pre, h2 + pre, h3 + pre, h4 + pre,
h1 + blockquote, h2 + blockquote, h3 + blockquote, h4 + blockquote {
  page-break-before: avoid;
  break-before: avoid;
}

/* Print-friendly emoji rendering */
.emoji, .markdown-emoji {
  font-family: "Noto Color Emoji", "Apple Color Emoji", sans-serif;
}
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${docTitle}</title>
<style>${css}</style>
</head>
<body>
${renderedBody}
</body>
</html>
`;

writeFileSync(tmpHtml, html, 'utf-8');
console.log(`✓ HTML generated: ${tmpHtml} (${html.length} bytes)`);

// Render to PDF via Chrome headless
const chromeBin = '/usr/bin/google-chrome';
const cmd = [
  chromeBin,
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--no-pdf-header-footer',
  '--font-render-hinting=none',
  '--hide-scrollbars',
  `--print-to-pdf=${outputPath}`,
  `--print-to-pdf-no-header`,
  `file://${tmpHtml}`,
].join(' ');

console.log(`→ ${cmd}`);

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log(`✓ PDF generated: ${outputPath}`);
} catch (e) {
  console.error('PDF generation failed:', e.message);
  process.exit(1);
}
