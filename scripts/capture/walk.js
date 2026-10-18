// walk.js — drive a browser through the pages named in a spec (YAML or JSON) and leave a PNG and an evidence line
// per page, with the page's EXPECTATIONS measured: a page that fails one is a failed page and the walk exits 2, so
// the captures are a test, not only pictures. Adapted from ephico2real2/cilium-implementation-poc
// (scripts/capture/walk.js), minus its Grafana-specific panel reading.
//
//   S=<out dir> BASE=http://localhost:3000 node scripts/capture/walk.js scripts/capture/dashboard.yaml
//
// spec: viewport {width, height}; pages: [ {name, url, before: ms, fullPage, viewport,
//       actions: [ {click: "visible text, exact"}, {clickSelector: css}, {fill: [sel, value]}, {wait: ms},
//                  {waitForText: "text", timeout: ms}, {scrollToBottom: css} ],
//       element: css (screenshot only that element),
//       screenshot: true, expect: { text: [strings the page's text must contain],
//                                   absent: [strings it must NOT contain] } } ]
// ${VAR} anywhere in the spec expands from the environment.
const { chromium } = require('playwright');
const fs = require('fs');

const S = process.env.S || '.';
const expand = (s) => String(s).replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '');
const specFile = process.argv[2] || 'scripts/capture/dashboard.yaml';
const raw = expand(fs.readFileSync(specFile, 'utf8'));
const spec = /\.ya?ml$/.test(specFile) ? require('js-yaml').load(raw) : JSON.parse(raw);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function check(page, text) {
  const e = page.expect || {};
  const why = [];
  for (const s of e.text || []) if (!text.includes(s)) why.push(`text "${s}" not on the page`);
  for (const s of e.absent || []) if (text.includes(s)) why.push(`text "${s}" is on the page`);
  return why;
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: spec.viewport || { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const consoleErrors = [];
  p.on('pageerror', (e) => consoleErrors.push(e.message));
  let failures = 0;

  for (const page of spec.pages) {
    try {
      await p.setViewportSize(page.viewport || spec.viewport || { width: 1280, height: 900 });
      await p.goto(page.url, { waitUntil: 'load', timeout: 60000 });
      await p.waitForTimeout(page.before ?? 2500);
      for (const a of page.actions || []) {
        if (a.click) await p.getByText(new RegExp('^' + esc(a.click) + '$')).filter({ visible: true }).first().click({ timeout: a.timeout || 10000 });
        if (a.clickSelector) await p.locator(a.clickSelector).first().click({ timeout: a.timeout || 10000 });
        if (a.fill) await p.fill(a.fill[0], a.fill[1]);
        if (a.waitForText) await p.getByText(a.waitForText).first().waitFor({ timeout: a.timeout || 20000 });
        if (a.wait) await p.waitForTimeout(a.wait);
        if (a.scrollToBottom) await p.locator(a.scrollToBottom).first().evaluate((n) => { n.scrollTop = n.scrollHeight; });
      }
      if (page.screenshot !== false) {
        if (page.element) await p.locator(page.element).first().screenshot({ path: `${S}/${page.name}.png` });
        else await p.screenshot({ path: `${S}/${page.name}.png`, fullPage: !!page.fullPage });
      }
      const text = await p.evaluate(() => document.body.innerText);
      // Evidence: the expected strings as found on the page, else the page's first lines.
      const wanted = (page.expect && page.expect.text) || [];
      const line = wanted.length
        ? `found ${wanted.filter((w) => text.includes(w)).map((w) => JSON.stringify(w)).join(', ')}`
        : text.split('\n').filter((l) => l.trim()).slice(0, 6).join(' | ');
      const why = check(page, text);
      if (why.length) {
        failures++;
        console.log(`${page.name}: ${line}`);
        console.log(`${page.name}: FAILED — ${why.join('; ')}`);
      } else {
        console.log(`${page.name}: ${line}${page.expect ? ' — expectations met' : ''}`);
      }
    } catch (e) {
      failures++;
      console.log(`${page.name}: FAILED — ${e.message.split('\n')[0]}`);
      try {
        await p.screenshot({ path: `${S}/${page.name}-failed.png`, fullPage: true });
      } catch {}
    }
  }

  if (consoleErrors.length) {
    failures++;
    console.log(`page script errors: FAILED — ${consoleErrors.slice(0, 3).join(' | ')}`);
  }
  await b.close();
  if (failures) {
    console.log(`${failures} page(s) failed`);
    process.exit(2);
  }
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
