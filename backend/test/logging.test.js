// Structured logs: the OTLP shipper only ever sees redacted lines, the pretty
// format, recipient masks, and every event name used in the code is catalogued.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redactor } from '../src/secrets/redactor.js';
import { createLogger } from '../src/log.js';
import { createOtlpShipper, toLogRecord } from '../src/logship/otlp.js';
import { prettyLine } from '../src/logfmt.js';
import { ALL_EVENTS, ALERTS, PATTERN_ALERTS, seconds } from '../src/alerts/catalogue.js';

const SECRET_VALUE = 'Xq7RtY2pLm9WvB4nKs8DhF3jGc6ZeA1u';

function captureSink() {
  const lines = [];
  return { lines, write: (l) => lines.push(l) };
}

test('sinks get the redacted line, never a revealed one', () => {
  const redactor = new Redactor();
  redactor.register(SECRET_VALUE);
  const sink = captureSink();
  const out = captureSink();
  const logger = createLogger({ redactor, level: 'debug', revealSecrets: true, out, sinks: [sink] });
  logger.error({ event: 'secrets.fetch.failed' }, `boom with ${SECRET_VALUE} inside`);
  logger.revealUnsafe({ password: SECRET_VALUE }, 'lab line');
  assert.equal(sink.lines.length, 1, 'only the normal line reaches the sink');
  assert.ok(!sink.lines[0].includes(SECRET_VALUE));
  assert.match(sink.lines[0], /\[REDACTED\]/);
  assert.ok(out.lines[1].includes(SECRET_VALUE), 'the revealed line is on stdout only');
});

test('OTLP mapping: severity, event name, flattened attributes, fatal', () => {
  const rec = toLogRecord(JSON.stringify({
    time: '2026-10-18T13:00:00.123Z', level: 'warn', app: 'secure-notes', component: 'secrets',
    secretId: '/rds/dev/notes-db/app', err: { name: 'TimeoutError', code: 'ETIMEDOUT' }, keys: ['a', 'b'],
    event: 'secrets.fetch.stale', msg: 'secret fetch failed, serving last good value',
  }));
  assert.equal(rec.severityNumber, 13);
  assert.equal(rec.severityText, 'WARN');
  assert.equal(rec.timeUnixNano, '1792328400123000000');
  assert.equal(rec.eventName, 'secrets.fetch.stale');
  assert.deepEqual(rec.body, { stringValue: 'secret fetch failed, serving last good value' });
  const attrs = Object.fromEntries(rec.attributes.map((a) => [a.key, a.value]));
  assert.deepEqual(attrs['err.code'], { stringValue: 'ETIMEDOUT' });
  assert.deepEqual(attrs.keys, { stringValue: '["a","b"]' });
  assert.equal(attrs.msg, undefined);
  const fatal = toLogRecord(JSON.stringify({ time: '2026-10-18T13:00:00Z', level: 'error', fatal: true, msg: 'x' }));
  assert.equal(fatal.severityNumber, 21);
});

test('shipper batches, keeps the newest when full, and retries a failed batch', async () => {
  const bodies = [];
  let fail = true;
  const fetchImpl = async (_url, init) => {
    if (fail) return { ok: false, status: 503 };
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };
  const shipper = createOtlpShipper({ endpoint: 'http://collector:4318/', maxBuffer: 3, intervalMs: 60_000, fetchImpl, resource: { 'service.name': 'secure-notes' } });
  for (let i = 0; i < 5; i++) shipper.write(JSON.stringify({ time: '2026-10-18T13:00:00Z', level: 'info', msg: `line ${i}` }));
  assert.equal(shipper.stats().buffered, 3);
  await shipper.flush();
  assert.equal(shipper.stats().failedBatches, 1);
  assert.equal(shipper.stats().buffered, 3, 'a failed batch goes back');
  fail = false;
  await shipper.drain(1000);
  shipper.close();
  const records = bodies.flatMap((b) => b.resourceLogs[0].scopeLogs[0].logRecords);
  assert.deepEqual(records.map((r) => r.body.stringValue), ['line 2', 'line 3', 'line 4']);
  assert.equal(bodies[0].resourceLogs[0].resource.attributes[0].key, 'service.name');
  assert.equal(shipper.stats().endpoint, 'http://collector:4318/v1/logs');
});

test('pretty format: one readable line', () => {
  const line = prettyLine({
    time: '2026-10-18T08:21:04.123Z', level: 'warn', app: 'secure-notes', component: 'secrets',
    secretId: '/rds/dev/notes-db/app', event: 'secrets.fetch.stale', msg: 'secret fetch failed, serving last good value',
  });
  assert.equal(line, '08:21:04.123 WARN  secrets  secret fetch failed, serving last good value · secretId=/rds/dev/notes-db/app event=secrets.fetch.stale');
});

test('every event name used in the code is in the catalogue', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = [];
  const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.js') && files.push(join(d, f))));
  walk(src);
  // Every dotted string literal in an event namespace counts, wherever it is
  // (a field, a ternary, a helper argument): no syntax can slip past.
  const namespaces = new Set([...ALL_EVENTS].map((e) => e.split('.')[0]));
  const used = new Set();
  for (const f of files) {
    if (f.endsWith('catalogue.js')) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/['"`]([a-z]+(?:\.[a-z]+)+)['"`]/g)) {
      const parts = m[1].split('.');
      const fileName = ['env', 'json', 'yaml', 'yml', 'js'].includes(parts.at(-1)); // e.g. 'config.env'
      if (namespaces.has(parts[0]) && !fileName) used.add(m[1]);
    }
  }
  assert.ok(used.size >= 10, `found ${used.size} event names`);
  const unknown = [...used].filter((e) => !ALL_EVENTS.has(e));
  assert.deepEqual(unknown, [], 'every event the code uses is in the catalogue');
  // ...and the other way: each catalogued alert is actually logged somewhere.
  const missing = Object.keys(ALERTS).filter((e) => !used.has(e));
  assert.deepEqual(missing, [], 'every catalogued alert is emitted by the code');
  for (const a of [...Object.values(ALERTS), ...Object.values(PATTERN_ALERTS)]) {
    assert.ok(seconds(a.when.window), `window ${a.when.window}`);
    assert.ok(a.title.length < 80, a.title);
  }
});

test('file sink: the line is on disk before the call returns (an exit right after keeps it)', async () => {
  const { mkdtempSync, readFileSync: read } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { createFileSink } = await import('../src/logship/file.js');
  const path = join(mkdtempSync(join(tmpdir(), 'sink-')), 'app.jsonl');
  const sink = createFileSink(path);
  sink.write('{"event":"config.unsafe"}');
  assert.equal(read(path, 'utf8'), '{"event":"config.unsafe"}\n', 'written synchronously');
  assert.deepEqual(sink.stats(), { path, errors: 0, lastError: undefined });
  const broken = createFileSink('/nonexistent-dir/app.jsonl');
  broken.write('x');
  assert.ok(broken.stats().errors >= 1, 'errors are counted, never thrown');
});
