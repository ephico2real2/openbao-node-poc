#!/usr/bin/env node
// End-to-end check against a running instance with DEMO_MODE=true:
//   node scripts/smoke-test.js [http://localhost:3000]
//
// Verifies: the app works, rotation of both credentials, automatic recovery
// after connections drop, and that no leak attempt exposes a password.

const base = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3000';
let failures = 0;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.message ?? ''}`);
  return json;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok    ${name}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log(`Smoke test against ${base}`);

const cfg = await call('GET', '/api/config');
assert(cfg.demoMode, 'DEMO_MODE must be enabled for the smoke test');
console.log(`  mode: ${cfg.secretsMode}${cfg.usingLocalMock ? ' (local mock)' : ''}`);

await check('health: postgres and redis reachable', async () => {
  const h = await call('GET', '/api/health');
  assert(h.status === 'ok', JSON.stringify(h));
});

await check('notes: write to postgres, read through redis', async () => {
  await call('POST', '/api/notes', { body: `smoke ${new Date().toISOString()}` });
  const first = await call('GET', '/api/notes');
  const second = await call('GET', '/api/notes');
  assert(first.source === 'postgres' && second.source === 'redis', `${first.source} then ${second.source}`);
  return `${first.source} -> ${second.source}`;
});

// Step v2: dynamic users. The demo then revokes leases instead of rotating.
const dynamic = (await call('GET', '/api/secrets')).secrets.some((s) => s.lease);
let since = Math.max(0, ...(await call('GET', '/api/events')).events.map((e) => e.id));

// SECRETS_MODE=file: the app has no identity in the secrets manager, so it
// can't rotate; k8s-check rotates in OpenBao and watches the file change.
const fileMode = cfg.secretsMode === 'file';
if (fileMode) console.log('  skip  rotation and drop-connections: SECRETS_MODE=file (the rotation happens in OpenBao; k8s-check runs it)');

for (const alias of fileMode ? [] : ['db', 'redis']) {
  const what = dynamic ? `revoke the ${alias} lease (OpenBao drops the user)` : `rotate ${alias} secret (createSecret -> setSecret -> testSecret -> finishSecret)`;
  await check(what, async () => {
    const r = await call('POST', `/api/demo/rotate/${alias}`);
    const names = r.steps.map((s) => s.name);
    assert(names.includes(dynamic ? 'revokeLease' : 'finishSecret'), names.join(','));
    const s = (await call('GET', '/api/secrets')).secrets.find((x) => x.alias === alias);
    if (s.remote) assert(s.staleInCache, 'expected the app cache to still hold the old version');
    return dynamic ? `revoked lease ${r.revokedLease}` : `new version ${r.newVersionId.slice(0, 8)}`;
  });
}

if (!fileMode) await check('drop connections, then app recovers with the rotated credentials', async () => {
  await call('POST', '/api/demo/drop-connections');
  await call('POST', '/api/notes', { body: 'written after rotation + dropped connections' });
  const notes = await call('GET', '/api/notes');
  assert(notes.notes.length > 0, 'no notes');
  // Redis reconnects in the background: give it a few seconds.
  let ev = [];
  let recovered = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ev = (await call('GET', `/api/events?since=${since}`)).events;
    recovered = ev.filter((e) => e.type === 'recovered').map((e) => e.source);
    if (recovered.includes('db') && recovered.includes('redis')) break;
  }
  assert(recovered.includes('db'), `db did not report recovery: ${JSON.stringify(ev.map((e) => e.type))}`);
  assert(recovered.includes('redis'), `redis did not report recovery: ${JSON.stringify(ev.map((e) => e.type))}`);
  return `recovered: ${[...new Set(recovered)].join(', ')}`;
});

await check('secrets dashboard shows the new versions in cache', async () => {
  const { secrets } = await call('GET', '/api/secrets');
  for (const s of secrets) assert(!s.staleInCache, `${s.alias} still stale`);
  assert(!JSON.stringify(secrets).match(/"password"/i), 'status leaked a password field');
});

await check('leak test: no attempt exposes the password', async () => {
  const leak = await call('POST', '/api/demo/leak-test');
  assert(leak.leaked === 0, `${leak.leaked} attempt(s) leaked`);
  return `${leak.attempts.length} attempts, 0 leaks`;
});

await check('security posture: no check fails', async () => {
  const { checks } = await call('GET', '/api/security/checks');
  const fails = checks.filter((c) => c.status === 'fail');
  assert(fails.length === 0, `failing: ${fails.map((f) => `${f.id} (${f.detail})`).join('; ')}`);
  return `${checks.length} checks, none failing`;
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
