// Epic B7: the audit shipper and the alert console (unit tests; the end-to-end
// test with real OpenBao, VictoriaLogs and vmalert is dev/detect/test-detection.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTailShipper } from '../src/detect/shipper.js';
import { createAlertConsole } from '../src/detect/console.js';

test('shipper: sends only complete new lines, waits for a partial one, re-reads a recreated file, and resends after a failure', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.log');
  const posts = [];
  let fail = false;
  const fetchImpl = async (url, { body }) => {
    if (fail) return { ok: false, status: 503 };
    posts.push(body);
    return { ok: true, status: 204 };
  };
  const s = createTailShipper({ file, url: 'http://vl/insert/jsonline', fetchImpl });
  assert.equal(await s.tick(), 0, 'no file yet is not an error');

  writeFileSync(file, '{"type":"request","n":1}\n{"type":"response","n":1}\n{"type":"req');
  assert.equal(await s.tick(), 2);
  assert.equal(posts[0], '{"type":"request","n":1}\n{"type":"response","n":1}\n');

  appendFileSync(file, 'uest","n":2}\n');
  assert.equal(await s.tick(), 1);
  assert.equal(posts[1], '{"type":"request","n":2}\n', 'the partial line is joined, not split');

  appendFileSync(file, '{"type":"response","n":2}\n');
  fail = true;
  await assert.rejects(s.tick(), /HTTP 503/);
  fail = false;
  assert.equal(await s.tick(), 1, 'the failed batch is sent again');

  writeFileSync(file, '{"type":"request","n":3}\n'); // recreated, shorter
  assert.equal(await s.tick(), 1);
  assert.equal(posts.at(-1), '{"type":"request","n":3}\n');
  assert.equal(s.stats().shipped, 5);
});

test('console: receives vmalert alerts (Alertmanager API shape), de-duplicates repeats, escapes HTML', () => {
  const c = createAlertConsole();
  const alert = {
    labels: { alertname: 'SecretReadByUnexpectedIdentity', severity: 'critical', role: 'ops-admin', path: 'secret/data/rds/dev/notes-db/app' },
    annotations: { summary: 'A secret was read by <ops-admin>', description: 'Not the app.' },
    startsAt: '2026-10-18T21:00:00Z',
  };
  assert.equal(c.receive([alert]), 1);
  c.receive([alert]); // vmalert re-sends a firing alert
  assert.equal(c.count(), 1);
  assert.equal(c.list()[0].times, 2);
  const html = c.html();
  assert.ok(html.includes('SecretReadByUnexpectedIdentity'));
  assert.ok(html.includes('&lt;ops-admin&gt;') && !html.includes('<ops-admin>'), 'annotations are escaped');
  assert.throws(() => c.receive({ not: 'an array' }), /JSON array/);
  assert.ok(createAlertConsole().html().includes('No alerts'));
});
