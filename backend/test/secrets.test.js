// Unit tests for the secrets layer. Run: npm test  (node --test, no extra deps)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { SecretsProvider } from '../src/secrets/provider.js';
import { SecretValue } from '../src/secrets/SecretValue.js';
import { Redactor } from '../src/secrets/redactor.js';
import { createLogger } from '../src/log.js';

const sink = { lines: [], write(l) { this.lines.push(l); } };

function fakeFetcher(initial = 'pw-version-1') {
  const f = {
    kind: 'fake',
    calls: 0,
    value: initial,
    version: 1,
    fail: false,
    delayMs: 0,
    async fetch() {
      f.calls++;
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      if (f.fail) throw Object.assign(new Error('endpoint unreachable'), { name: 'NetworkError' });
      return {
        name: 'app/db',
        arn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:app/db-abc123',
        versionId: `v${f.version}`,
        versionStages: ['AWSCURRENT'],
        secretString: JSON.stringify({ username: 'app', password: f.value }),
      };
    },
  };
  return f;
}

function setup(opts = {}) {
  const redactor = new Redactor();
  const logger = createLogger({ redactor, out: sink, level: 'debug' });
  const fetcher = fakeFetcher();
  const provider = new SecretsProvider({ fetcher, redactor, logger, ttlSeconds: 300, maxStaleSeconds: 3600, ...opts });
  return { redactor, logger, fetcher, provider };
}

test('caches values and returns SecretValue', async () => {
  const { provider, fetcher } = setup();
  const a = await provider.get('app/db');
  const b = await provider.get('app/db');
  assert.ok(a instanceof SecretValue);
  assert.equal(a, b);
  assert.equal(fetcher.calls, 1);
  assert.equal(a.reveal().password, 'pw-version-1');
});

test('single-flight: concurrent cold reads make one API call', async () => {
  const { provider, fetcher } = setup();
  fetcher.delayMs = 30;
  await Promise.all(Array.from({ length: 50 }, () => provider.get('app/db')));
  assert.equal(fetcher.calls, 1);
});

test('refresh() bypasses the cache and picks up a rotated value', async () => {
  const { provider, fetcher } = setup();
  await provider.get('app/db');
  fetcher.value = 'pw-version-2';
  fetcher.version = 2;
  assert.equal((await provider.get('app/db')).reveal().password, 'pw-version-1'); // still cached
  assert.equal((await provider.refresh('app/db', 'test')).reveal().password, 'pw-version-2');
  assert.equal(provider.status()[0].versionId, 'v2');
});

test('stale-on-error: serves last good value when Secrets Manager is down', async () => {
  const { provider, fetcher } = setup({ ttlSeconds: 0.01 });
  await provider.get('app/db');
  await new Promise((r) => setTimeout(r, 20));
  fetcher.fail = true;
  const v = await provider.get('app/db');
  assert.equal(v.reveal().password, 'pw-version-1');
  assert.match(provider.status()[0].lastError, /endpoint unreachable/);
});

test('forced refresh failure is not hidden', async () => {
  const { provider, fetcher } = setup();
  await provider.get('app/db');
  fetcher.fail = true;
  await assert.rejects(provider.refresh('app/db'), /endpoint unreachable/);
});

test('cold start failure throws (fail fast)', async () => {
  const { provider, fetcher } = setup();
  fetcher.fail = true;
  await assert.rejects(provider.get('app/db'), /endpoint unreachable/);
});

test('SecretValue never serializes its contents', () => {
  const s = new SecretValue({ password: 'super-secret-value' });
  assert.equal(JSON.stringify({ s }), '{"s":"[REDACTED]"}');
  assert.equal(`${s}`, '[REDACTED]');
  assert.equal(String(s), '[REDACTED]');
  assert.doesNotMatch(inspect(s), /super-secret-value/);
  assert.doesNotMatch(inspect({ nested: { s } }, { depth: 5 }), /super-secret-value/);
  assert.throws(() => {
    'use strict';
    s.reveal().password = 'x';
  }, TypeError); // frozen
});

test('status() never contains secret material', async () => {
  const { provider } = setup();
  await provider.get('app/db');
  const dump = JSON.stringify(provider.status());
  assert.doesNotMatch(dump, /pw-version-1/);
});

test('logger redacts loaded secrets wherever they appear', async () => {
  const { provider, logger } = setup();
  const pw = (await provider.get('app/db')).reveal().password;
  const lines = [
    logger.info(`inline ${pw}`),
    logger.warn({ dbPassword: pw }),
    logger.error({ err: new Error(`postgres://app:${pw}@db:5432/x`) }),
    logger.info({ nested: { deeper: [{ note: `x${pw}y` }] } }),
  ];
  for (const l of lines) assert.doesNotMatch(l, /pw-version-1/, l);
});

test('redactor masks credentials in URLs even if never registered', () => {
  const r = new Redactor();
  assert.equal(r.scrubString('redis://user:hunter2@cache:6379'), 'redis://user:[REDACTED]@cache:6379');
});

test('redactor drops library fields such as err.command from errors', () => {
  const r = new Redactor();
  const err = Object.assign(new Error('WRONGPASS'), { command: { name: 'auth', args: ['app', 'not-registered-pw'] } });
  assert.doesNotMatch(JSON.stringify(r.scrub({ err })), /not-registered-pw/);
});
