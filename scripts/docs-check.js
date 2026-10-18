#!/usr/bin/env node
// Check the docs: every relative Markdown link (and #anchor) resolves, and every
// Mermaid diagram renders.
//
//   node scripts/docs-check.js                 # links only
//   PLAYWRIGHT_MODULE=/path/node_modules/playwright \
//   MERMAID_JS=/path/node_modules/mermaid/dist/mermaid.min.js \
//   node scripts/docs-check.js                 # links and diagrams
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const SKIP = new Set(['node_modules', '.git', '.tmp', 'output']);

function* markdownFiles(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* markdownFiles(p);
    else if (extname(p) === '.md') yield p;
  }
}

// Lines outside fenced code blocks, plus the mermaid blocks themselves.
function parse(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const prose = [];
  const mermaid = [];
  let fence = null;
  lines.forEach((l, i) => {
    const m = l.match(/^\s*(```+|~~~+)\s*(\S*)/);
    if (m && !fence) {
      fence = { mark: m[1], lang: m[2], start: i + 1, body: [] };
      return;
    }
    if (m && fence && l.trim().startsWith(fence.mark)) {
      if (fence.lang === 'mermaid') mermaid.push({ line: fence.start, code: fence.body.join('\n') });
      fence = null;
      return;
    }
    if (fence) fence.body.push(l);
    else prose.push({ n: i + 1, text: l.replace(/`[^`]*`/g, '') });
  });
  return { prose, mermaid };
}

// GitHub's heading anchors.
const anchorCache = new Map();
function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const seen = new Map();
  const set = new Set();
  for (const { text } of parse(file).prose) {
    const h = text.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!h) continue;
    const base = h[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-');
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    set.add(k ? `${base}-${k}` : base);
  }
  anchorCache.set(file, set);
  return set;
}

const problems = [];
const diagrams = [];
let links = 0;
for (const file of markdownFiles(ROOT)) {
  const rel = relative(ROOT, file);
  const raw = readFileSync(file, 'utf8').split('\n');
  const { prose, mermaid } = parse(file);
  mermaid.forEach((d) => diagrams.push({ file: rel, ...d }));
  for (const { n } of prose) {
    const line = raw[n - 1].replace(/`[^`]*`/g, (m) => (/\]\(/.test(m) ? m : ''));
    for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|computer:)/.test(target)) continue;
      links++;
      const [path, hash] = target.split('#');
      const dest = path ? resolve(dirname(file), decodeURI(path)) : file;
      if (!existsSync(dest)) {
        problems.push(`${rel}:${n}: ${target} → no such file`);
        continue;
      }
      if (hash && extname(dest) === '.md' && !anchors(dest).has(hash)) {
        problems.push(`${rel}:${n}: ${target} → no heading #${hash} in ${relative(ROOT, dest)}`);
      }
    }
  }
}
console.log(`links: ${links} relative links checked, ${problems.length} broken`);

if (process.env.PLAYWRIGHT_MODULE && process.env.MERMAID_JS) {
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({ content: readFileSync(process.env.MERMAID_JS, 'utf8') });
  await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }));
  let ok = 0;
  for (const [i, d] of diagrams.entries()) {
    const err = await page.evaluate(async ({ code, id }) => {
      try {
        const { svg } = await window.mermaid.render(id, code);
        return /Syntax error/i.test(svg) ? 'rendered a syntax-error diagram' : null;
      } catch (e) {
        return String(e?.message ?? e).split('\n').slice(0, 4).join(' ');
      }
    }, { code: d.code, id: `d${i}` });
    if (err) problems.push(`${d.file}:${d.line}: mermaid: ${err}`);
    else ok++;
  }
  await browser.close();
  console.log(`mermaid: ${ok}/${diagrams.length} diagrams rendered`);
} else {
  console.log(`mermaid: ${diagrams.length} diagrams found; set PLAYWRIGHT_MODULE and MERMAID_JS to render them`);
}

for (const p of problems) console.log(`::error::${p}`);
process.exit(problems.length ? 1 : 0);
