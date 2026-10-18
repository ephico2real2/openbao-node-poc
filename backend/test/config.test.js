// config.js refuses unsafe settings at startup. Each case runs in a fresh
// process, because the config is read once from the environment at import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const configUrl = new URL('../src/config.js', import.meta.url).href;
const check = (env) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { assertSafeEnvironment } = await import(${JSON.stringify(configUrl)});
    try { assertSafeEnvironment(); console.log('OK'); } catch (e) { console.log(e.message); }`],
  { env: { PATH: process.env.PATH, SECRETS_ENV: 'dev', DB_SECRET_RESOURCE: 'notes-db', REDIS_SECRET_RESOURCE: 'notes-cache', ...env }, encoding: 'utf8' });
  return r.stdout.trim();
};
const bao = { SECRETS_PROVIDER: 'openbao', BAO_ADDR: 'http://openbao:8200', BAO_ROLE_ID: 'secure-notes-app', BAO_SECRET_ID_FILE: '/home/node/bao-secret-id' };

test('openbao: an address, a role ID and a secret ID FILE is a valid configuration (mode defaults to api)', () => {
  assert.equal(check(bao), 'OK');
});

test('openbao: a token or a secret ID in the environment is refused', () => {
  for (const name of ['BAO_TOKEN', 'VAULT_TOKEN', 'BAO_SECRET_ID', 'VAULT_SECRET_ID']) {
    assert.match(check({ ...bao, [name]: 'example-only' }), new RegExp(`${name} is set`), name);
  }
});

test('openbao: the secret ID file, the role and the address are required; aws modes are refused', () => {
  assert.match(check({ ...bao, BAO_SECRET_ID_FILE: '' }), /BAO_SECRET_ID_FILE is required/);
  assert.match(check({ ...bao, BAO_ROLE_ID: '' }), /BAO_ROLE_ID is required/);
  assert.match(check({ ...bao, BAO_ADDR: '' }), /BAO_ADDR is required/);
  assert.match(check({ ...bao, SECRETS_MODE: 'sdk' }), /SECRETS_MODE must be 'api'/);
  assert.match(check({ SECRETS_PROVIDER: 'consul' }), /SECRETS_PROVIDER must be/);
});

test('openbao in production: plain HTTP to the server is refused, https is accepted', () => {
  assert.match(check({ ...bao, NODE_ENV: 'production' }), /BAO_ADDR must be https/);
  assert.equal(check({ ...bao, NODE_ENV: 'production', BAO_ADDR: 'https://openbao.example.com:8200' }), 'OK');
});

test('aws stays the default provider, with sdk mode', () => {
  assert.equal(check({}), 'OK');
  assert.match(check({ SECRETS_MODE: 'api' }), /SECRETS_MODE must be 'sdk' or 'agent'/);
});
