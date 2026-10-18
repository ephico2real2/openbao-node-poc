// Step v2: the lease keeper and the cache with dynamic database users, against
// a fake OpenBao client and a fake clock (the compose (openbao-dynamic) CI job
// runs the real thing against Postgres and Valkey).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeaseKeeper } from '../src/secrets/bao/leases.js';
import { createKvFetcher } from '../src/secrets/bao/kv.js';
import { SecretsProvider } from '../src/secrets/provider.js';
import { Redactor } from '../src/secrets/redactor.js';
import { createLogger } from '../src/log.js';

function fakeWorld({ ttl = 30, maxTtl = 90 } = {}) {
  let t = Date.now(); // the cache reads the real clock; start the fake one there
  let n = 0;
  const timers = [];
  const leases = new Map(); // id -> { issuedAt, expiresAt, revoked }
  const calls = [];
  const client = {
    async request(method, path, { body } = {}) {
      calls.push({ method, path, body });
      if (path.startsWith('database/creds/')) {
        const id = `${path}/L${++n}`;
        leases.set(id, { issuedAt: t, expiresAt: t + ttl * 1000 });
        return { lease_id: id, lease_duration: ttl, renewable: true, data: { username: `v-approle-user-${n}`, password: `pw-${n}-0123456789abcdef` } };
      }
      if (path === 'sys/leases/renew') {
        const l = leases.get(body.lease_id);
        if (!l || l.revoked) throw Object.assign(new Error('lease not found'), { status: 400 });
        const cap = l.issuedAt + maxTtl * 1000;
        l.expiresAt = Math.min(t + body.increment * 1000, cap);
        return { lease_id: body.lease_id, lease_duration: Math.round((l.expiresAt - t) / 1000), renewable: true };
      }
      if (path === 'sys/leases/revoke') {
        const l = leases.get(body.lease_id);
        if (l) l.revoked = true;
        return undefined;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const fakeTimers = {
    setTimeout(fn, ms) {
      const h = { at: t + ms, fn, cleared: false };
      timers.push(h);
      return h;
    },
    clearTimeout(h) {
      if (h) h.cleared = true;
    },
  };
  // Advance the clock, firing due timers in order (and awaiting their promises).
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((h) => !h.cleared && !h.fired && h.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = Math.max(t, due.at);
      due.fired = true;
      await due.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    t = end;
  }
  return { client, timers: fakeTimers, now: () => t, advance, leases, calls };
}

test('a lease is renewed at 2/3 of its TTL; at the max TTL the app asks for a new user, and the old lease is revoked after the drain', async () => {
  const w = fakeWorld();
  const keeper = createLeaseKeeper(w.client, { now: w.now, timers: w.timers, graceMs: 15_000 });
  const expiring = [];
  keeper.onExpiring((id, reason) => expiring.push(reason));

  const first = await keeper.issue('database/creds/notes-app', 'database/creds/notes-app');
  assert.equal(first.data.username, 'v-approle-user-1');
  assert.equal(keeper.status('database/creds/notes-app').renewInSeconds, 20);

  await w.advance(20_000); // first renewal
  assert.equal(keeper.status('database/creds/notes-app').renewals, 1);
  await w.advance(60_000); // renewals continue until the max TTL caps one
  const st = keeper.status('database/creds/notes-app');
  assert.equal(st.maxTtlReached, true, 'a shorter renewal means the max TTL is near');
  assert.ok(st.reissueInSeconds <= st.ttlSeconds);
  await w.advance(10_000);
  assert.deepEqual(expiring, ['lease-max-ttl'], 'asks for a new user before the lease ends');

  await keeper.issue('database/creds/notes-app', 'database/creds/notes-app'); // what the cache does next
  assert.equal(w.leases.get('database/creds/notes-app/L1').revoked, undefined, 'the old user drains first');
  await w.advance(15_000);
  assert.equal(w.leases.get('database/creds/notes-app/L1').revoked, true, 'then its lease is revoked');
});

test('a failed renewal (the lease was revoked) asks for a new user at once', async () => {
  const w = fakeWorld();
  const keeper = createLeaseKeeper(w.client, { now: w.now, timers: w.timers });
  const expiring = [];
  keeper.onExpiring((id, reason) => expiring.push(reason));
  await keeper.issue('database/creds/notes-cache', 'database/creds/notes-cache');
  w.leases.get('database/creds/notes-cache/L1').revoked = true; // an operator revoked it
  await w.advance(20_000);
  assert.deepEqual(expiring, ['lease-renew-failed']);
});

test('the cache keeps a leased user until the keeper asks for a new one, then emits a change; revokeAll on shutdown', async () => {
  const w = fakeWorld();
  const keeper = createLeaseKeeper(w.client, { now: w.now, timers: w.timers });
  const fetcher = createKvFetcher(w.client, { leases: keeper });
  const provider = new SecretsProvider({ fetcher, ttlSeconds: 1, redactor: new Redactor(), logger: createLogger({ level: 'error', out: { write() {} } }) });
  const id = 'database/creds/notes-app';

  const a = (await provider.get(id)).reveal();
  assert.equal(a.username, 'v-approle-user-1');
  const st = provider.status().find((s) => s.secretId === id);
  assert.deepEqual(st.versionStages, ['lease']);
  assert.ok(st.lease && !JSON.stringify(st).includes('pw-1'), 'status shows the lease, never the password');

  // Still within the lease: no new user, even though the plain TTL (1 s) has passed.
  await w.advance(5_000);
  assert.equal((await provider.get(id)).reveal().username, 'v-approle-user-1');

  const changes = [];
  provider.on('loaded', (e) => changes.push(e));
  w.leases.get(`${id}/L1`).revoked = true;
  await w.advance(20_000); // renewal fails -> refresh
  await new Promise((r) => setImmediate(r));
  assert.equal(changes.at(-1)?.changed, true);
  assert.equal(provider.peek(id).username, 'v-approle-user-2');

  await keeper.revokeAll();
  assert.equal(w.leases.get(`${id}/L2`).revoked, true, 'shutdown revokes the current lease');
  assert.equal(await fetcher.describe(id), undefined, 'a lease has no KV metadata');
});

test('lease log lines name the provider (Vault on step v4)', async () => {
  const w = fakeWorld();
  const lines = [];
  const logger = { child: () => logger, info: (o, m) => lines.push(m), warn: () => {}, debug: () => {} };
  const keeper = createLeaseKeeper(w.client, { logger, product: 'Vault', now: w.now, timers: w.timers });
  await keeper.issue('database/creds/notes-app', 'database/creds/notes-app');
  assert.ok(lines.includes('Vault issued a database user for this instance'), lines.join(' | '));
});

