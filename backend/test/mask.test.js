// Debug logging of credentials: key names in full, values masked; and the
// LOG_REVEAL_SECRETS flag, which only works outside production. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsProvider } from '../src/secrets/provider.js';
import { Redactor } from '../src/secrets/redactor.js';
import { createAgentFetcher } from '../src/secrets/fetchers.js';
import { createLogger } from '../src/log.js';
import { maskValue, partlyMask, describeKeys } from '../src/secrets/mask.js';

const PASSWORD = 'Xq7RtY2pLm9WvB4nKs8DhF3jGc6ZeA1u'; // 32 chars
const SECRET = { username: 'notes_app', password: PASSWORD, host: 'postgres', port: 5432, dbname: 'notes', engine: 'postgres' };

function setup({ level = 'debug', revealSecrets = false } = {}) {
  const lines = [];
  const redactor = new Redactor();
  const logger = createLogger({ redactor, level, revealSecrets, out: { write: (l) => lines.push(l) } });
  const fetcher = {
    kind: 'sdk',
    async fetch() {
      return { name: 'app/db', arn: 'arn:aws:secretsmanager:::secret:app/db', versionId: 'v1', versionStages: ['AWSCURRENT'], secretString: JSON.stringify(SECRET) };
    },
  };
  const provider = new SecretsProvider({ fetcher, redactor, logger });
  return { lines, logger, provider, parsed: () => lines.map((l) => JSON.parse(l)) };
}

test('masking rules: passwords fully, hosts and ports in full, the rest partly', () => {
  const key = Buffer.alloc(32, 1);
  assert.match(maskValue('password', PASSWORD, key), /^\*{8} \(32 chars, fp=[0-9a-f]{8}\)$/);
  assert.match(maskValue('token', 'abcdefgh', key), /^\*{8} \(8 chars, fp=/);
  assert.equal(maskValue('host', 'db.internal', key), 'db.internal');
  assert.equal(maskValue('port', 5432, key), '5432');
  assert.equal(maskValue('username', 'notes_app', key), 'no*****pp');
  assert.equal(partlyMask('admin'), 'a****');
  assert.equal(partlyMask('ab'), '**');
  // same value, same fingerprint; another value, another one
  assert.equal(maskValue('password', PASSWORD, key), maskValue('password', PASSWORD, key));
  assert.notEqual(maskValue('password', PASSWORD, key), maskValue('password', `${PASSWORD}x`, key));
  assert.deepEqual(describeKeys({ a: 1, password: 'secret-1' }, key).map((s) => s.split('=')[0]), ['a', 'password']);
});

test('debug: "secret consumed" names every key, masks every value, never prints the password', async () => {
  const { lines, provider, parsed } = setup();
  await provider.get('app/db');
  const consumed = parsed().find((r) => r.msg === 'secret consumed');
  assert.ok(consumed, 'a "secret consumed" line is written at debug level');
  assert.equal(consumed.secretId, 'app/db');
  assert.equal(consumed.versionId, 'v1');
  assert.equal(consumed.source, 'sdk');
  assert.deepEqual(consumed.keys.map((k) => k.split('=')[0]), ['username', 'password', 'host', 'port', 'dbname', 'engine']);
  assert.ok(consumed.keys.includes('username=no*****pp'));
  assert.ok(consumed.keys.includes('host=postgres'));
  assert.ok(consumed.keys.some((k) => /^password=\*{8} \(32 chars, fp=[0-9a-f]{8}\)$/.test(k)));
  for (const l of lines) assert.ok(!l.includes(PASSWORD), `no line contains the password: ${l}`);
});

test('debug: a client login line shows which keys feed which setting, masked', async () => {
  const { lines, logger, provider, parsed } = setup();
  await provider.get('app/db');
  provider.logUse(logger.child({ component: 'db' }), 'app/db', { user: 'username', password: 'password' }, { host: 'postgres' }, 'postgres connecting with');
  const use = parsed().find((r) => r.msg === 'postgres connecting with');
  assert.deepEqual(use.using.map((u) => u.split('=')[0]), ['user<-username', 'password<-password']);
  assert.match(use.using[1], /\*{8} \(32 chars/);
  for (const l of lines) assert.ok(!l.includes(PASSWORD));
});

test('info level: no credential detail at all', async () => {
  const { provider, parsed } = setup({ level: 'info' });
  await provider.get('app/db');
  assert.ok(!parsed().some((r) => r.msg === 'secret consumed'));
});

test('LOG_REVEAL_SECRETS: the real value appears ONLY in the "(values revealed)" lines, never in the ring', async () => {
  const { lines, logger, provider, parsed } = setup({ revealSecrets: true });
  await provider.get('app/db');
  logger.info({ note: `pasted ${PASSWORD}` }, 'an ordinary line'); // still redacted
  const withValue = lines.filter((l) => l.includes(PASSWORD));
  assert.equal(withValue.length, 1);
  const revealed = JSON.parse(withValue[0]);
  assert.equal(revealed.msg, 'secret consumed (values revealed)');
  assert.equal(revealed.revealed, true);
  assert.match(revealed.warning, /NOT masked/);
  assert.ok(revealed.keys.some((k) => k.endsWith(`value=${PASSWORD}`)));
  assert.ok(parsed().some((r) => r.msg === 'an ordinary line' && r.note === 'pasted [REDACTED]'));
  // /api/logs serves logger.recent(): revealed lines are never kept there
  assert.ok(!logger.recent(300).some((l) => l.includes(PASSWORD)));
});

test('without the flag there is no unredacted path at all', () => {
  const { logger } = setup({ revealSecrets: false });
  assert.equal(logger.revealUnsafe, undefined);
  assert.equal(logger.child({ a: 1 }).revealUnsafe, undefined);
});

test('the app refuses LOG_REVEAL_SECRETS in production', async () => {
  const saved = { ...process.env };
  try {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_MOCK_ENDPOINT', 'DEMO_MODE']) delete process.env[k];
    Object.assign(process.env, { NODE_ENV: 'production', LOG_REVEAL_SECRETS: 'true', DB_SECRET_ID: 'a', REDIS_SECRET_ID: 'b' });
    const { assertSafeEnvironment } = await import(`../src/config.js?prod=${Date.now()}`);
    assert.throws(() => assertSafeEnvironment(), /LOG_REVEAL_SECRETS must not be enabled in production/);
    process.env.NODE_ENV = 'development';
    const dev = await import(`../src/config.js?dev=${Date.now()}`);
    assert.doesNotThrow(() => dev.assertSafeEnvironment());
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('agent mode: the SSRF token is logged masked, with the file it came from', async () => {
  const token = 'tok-' + 'k'.repeat(40);
  const dir = mkdtempSync(join(tmpdir(), 'awcp-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, token);
  const server = http.createServer((req, res) => {
    res.writeHead(req.headers['x-aws-parameters-secrets-token'] === token ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Name: 'app/db', ARN: 'arn', VersionId: 'v1', VersionStages: ['AWSCURRENT'], SecretString: '{}' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const lines = [];
    const logger = createLogger({ redactor: new Redactor(), level: 'debug', out: { write: (l) => lines.push(l) } });
    const fetcher = createAgentFetcher({ url: `http://127.0.0.1:${server.address().port}`, tokenFile, logger });
    await fetcher.fetch('app/db');
    const rec = lines.map((l) => JSON.parse(l)).find((r) => r.component === 'agent');
    assert.equal(rec.tokenFile, tokenFile);
    assert.match(rec.ssrfTokenMasked, /^\*{8} \(44 chars, fp=[0-9a-f]{8}\)$/);
    assert.ok(!lines.some((l) => l.includes(token)));
  } finally {
    server.close();
  }
});
