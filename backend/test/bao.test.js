// The OpenBao client, KV fetcher and store: unit tests against a fake HTTP
// server, plus an integration test against a REAL OpenBao server when
// BAO_BIN points at the `bao` binary (CI downloads it; checksum-verified).
// The integration test uses dev/openbao/config.hcl itself, so the lab's
// self-init, policies and roles are what is tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createBaoClient } from '../src/secrets/bao/client.js';
import { createKvFetcher, createKvStore } from '../src/secrets/bao/kv.js';
import { Redactor } from '../src/secrets/redactor.js';

const here = dirname(fileURLToPath(import.meta.url));
const secretFile = (value) => {
  const f = join(mkdtempSync(join(tmpdir(), 'bao-')), 'secret-id');
  writeFileSync(f, `${value}\n`, { mode: 0o400 });
  return f;
};

// ---------------------------------------------------------------- unit tests
function fakeBao(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const srv = createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      calls.push({ method: req.method, url: req.url, token: req.headers['x-vault-token'], body: body ? JSON.parse(body) : undefined });
      const [status, json] = handler(req, calls);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(json === undefined ? '' : JSON.stringify(json));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, calls, addr: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('login reads the secret ID from a file, registers the token and secret ID with the redactor, and re-logs in on 403', async () => {
  let tokenN = 0;
  let firstRead = true;
  const { srv, calls, addr } = await fakeBao((req) => {
    if (req.url === '/v1/auth/approle/login') return [200, { auth: { client_token: `tok-${++tokenN}-abcdefgh`, lease_duration: 900, renewable: true, policies: ['secure-notes-app'] } }];
    if (req.url === '/v1/secret/data/rds/dev/notes-db/app') {
      if (firstRead) { firstRead = false; return [403, { errors: ['permission denied'] }]; }
      return [200, { data: { data: { username: 'notes_app', password: 'pw-from-bao-123' }, metadata: { version: 3, created_time: '2026-10-18T19:00:00Z' } } }];
    }
    return [404, { errors: [] }];
  });
  const redactor = new Redactor();
  const client = createBaoClient({ addr, roleId: 'secure-notes-app', secretIdFile: secretFile('sid-0123456789abcdef'), redactor, scheduleRenewal: false });
  const fetcher = createKvFetcher(client);
  const r = await fetcher.fetch('/rds/dev/notes-db/app');
  assert.equal(r.versionId, '3');
  assert.deepEqual(r.versionStages, ['current']);
  assert.equal(JSON.parse(r.secretString).password, 'pw-from-bao-123');
  assert.equal(calls.filter((c) => c.url === '/v1/auth/approle/login').length, 2, 'a 403 triggers one fresh login');
  assert.deepEqual(calls[0].body, { role_id: 'secure-notes-app', secret_id: 'sid-0123456789abcdef' });
  assert.equal(redactor.scrubString('x sid-0123456789abcdef tok-2-abcdefgh x'), 'x [REDACTED] [REDACTED] x');
  const st = client.status();
  assert.equal(st.loggedIn, true);
  assert.ok(!JSON.stringify(st).includes('tok-'), 'status never shows the token');
  srv.close();
});

test('renew-self extends the token; at the max TTL the client logs in again', async () => {
  let t = 0;
  let renewals = 0;
  const { srv, calls, addr } = await fakeBao((req) => {
    if (req.url === '/v1/auth/approle/login') return [200, { auth: { client_token: `tok-${calls.length}`, lease_duration: 900, renewable: true } }];
    if (req.url === '/v1/auth/token/renew-self') {
      renewals++;
      return [200, { auth: { client_token: 'same', lease_duration: renewals === 1 ? 900 : 100, renewable: true } }];
    }
    return [404, {}];
  });
  const client = createBaoClient({ addr, roleId: 'r', secretIdFile: secretFile('s'), scheduleRenewal: false, now: () => t });
  await client.login();
  t = 600_000;
  await client.renew(); // 900 s from t=600 s: extended
  assert.equal(client.status().renewals, 1);
  t = 900_000;
  await client.renew(); // only 100 s: no longer extends past the old expiry -> log in again
  assert.equal(calls.filter((c) => c.url === '/v1/auth/approle/login').length, 2);
  srv.close();
});

test('a missing secret ID file is a clear error, not a request with an empty secret', async () => {
  const client = createBaoClient({ addr: 'http://127.0.0.1:1', roleId: 'r', secretIdFile: '/nonexistent/secret-id', scheduleRenewal: false });
  await assert.rejects(client.login(), /cannot read the AppRole secret ID file/);
});

// ------------------------------------------------- against a real OpenBao
const BIN = process.env.BAO_BIN;
test('real OpenBao: the lab config self-initialises; bootstrap once; app reads, rotates with check-and-set', { skip: !BIN && 'set BAO_BIN to the bao binary to run' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'baolab-'));
  for (const d of ['file', 'logs', 'config']) mkdirSync(join(dir, d));
  const port = 18200 + Math.floor(Math.random() * 500);
  const cfg = readFileSync(join(here, '../../dev/openbao/config.hcl'), 'utf8')
    .replaceAll('/openbao/', `${dir}/`)
    .replaceAll('0.0.0.0:8200', `127.0.0.1:${port}`)
    .replaceAll('http://openbao:8200', `http://127.0.0.1:${port}`)
    .replaceAll('http://openbao:8201', `http://127.0.0.1:${port + 1}`);
  writeFileSync(join(dir, 'config.hcl'), cfg);
  writeFileSync(join(dir, 'file', 'unseal.key'), randomBytes(32));
  const bootstrap = randomBytes(16).toString('hex');
  writeFileSync(join(dir, 'config', 'seed-secret-id'), bootstrap);
  const server = spawn(BIN, ['server', `-config=${join(dir, 'config.hcl')}`], { env: { PATH: process.env.PATH }, stdio: 'ignore' });
  try {
    const addr = `http://127.0.0.1:${port}`;
    const seed = createBaoClient({ addr, roleId: 'secure-notes-seed', secretIdFile: join(dir, 'config', 'seed-secret-id'), scheduleRenewal: false });
    for (let i = 0; ; i++) {
      try { await seed.login(); break; } catch (err) { if (i > 60) throw err; await new Promise((r) => setTimeout(r, 500)); }
    }
    await assert.rejects(
      createBaoClient({ addr, roleId: 'secure-notes-seed', secretIdFile: join(dir, 'config', 'seed-secret-id'), scheduleRenewal: false }).login(),
      /invalid role or secret ID/, 'the bootstrap secret ID works once',
    );
    const seedStore = createKvStore(seed);
    const id = '/rds/dev/notes-db/app';
    assert.equal(await seedStore.exists(id), false);
    const pw = await seedStore.randomPassword();
    assert.match(pw, /^[0-9a-f]{32}$/);
    await seedStore.create(id, { username: 'notes_app', password: pw });
    await assert.rejects(seedStore.create(id, { username: 'x', password: 'y' }), /check-and-set/, 'create never overwrites');

    const sid = await seed.request('POST', 'auth/approle/role/secure-notes-app/secret-id', { body: {} });
    const appFile = secretFile(sid.data.secret_id);
    const app = createBaoClient({ addr, roleId: 'secure-notes-app', secretIdFile: appFile, scheduleRenewal: false });
    const fetcher = createKvFetcher(app);
    const v1 = await fetcher.fetch(id);
    assert.equal(v1.versionId, '1');
    assert.equal(JSON.parse(v1.secretString).password, pw);
    assert.equal((await fetcher.describe(id)).currentVersionId, '1');
    await assert.rejects(app.request('GET', 'secret/data/some/other/app'), /HTTP 403/, 'the app policy reads only its own paths');

    // The demo rotation's store calls, as the app (the lab policy lets it).
    const store = createKvStore(app);
    const next = await store.randomPassword();
    await store.putPending(id, { username: 'notes_app', password: next });
    assert.equal(JSON.parse((await fetcher.fetch(id)).secretString).password, pw, 'pending is not current');
    assert.equal(await store.promote(id, { username: 'notes_app', password: next }, '1'), '2');
    assert.equal(JSON.parse((await fetcher.fetch(id)).secretString).password, next);
    assert.equal(await store.exists(`${id}/pending`), false, 'the pending copy is gone');
    await assert.rejects(store.promote(id, { username: 'x', password: 'z' }, '1'), /check-and-set/, 'a stale rotation cannot overwrite');

    await app.renew();
    assert.equal(app.status().renewals, 1);

    const audit = readFileSync(join(dir, 'logs', 'audit.log'), 'utf8');
    for (const v of [pw, next, bootstrap, sid.data.secret_id]) assert.ok(!audit.includes(v), 'the audit log holds HMACs, never values');
  } finally {
    server.kill('SIGTERM');
  }
});
