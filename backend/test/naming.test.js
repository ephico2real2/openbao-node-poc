// The secret naming convention: patterns, presets, precedence, config files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSecretName, resolveSecretIds, parseSimpleYaml, loadConfigFile, PRESETS } from '../src/secrets/naming.js';

const files = (map) => (p) => {
  if (!(p in map)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return map[p];
};

test('the default pattern builds /service/env/resource/name for every slot', () => {
  const r = resolveSecretIds({ SECRETS_ENV: 'prod', DB_SECRET_RESOURCE: 'notes-db', REDIS_SECRET_RESOURCE: 'notes-cache' });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.ids, {
    db: '/rds/prod/notes-db/app',
    redis: '/elasticache/prod/notes-cache/app',
    dbAdmin: '/rds/prod/notes-db/admin',
    redisAdmin: '/elasticache/prod/notes-cache/admin',
  });
  assert.equal(r.sources.db, 'pattern');
});

test('presets and custom patterns', () => {
  const base = { SECRETS_ENV: 'uat', DB_SECRET_RESOURCE: 'orders' };
  assert.equal(resolveSecretIds({ ...base, SECRETS_NAME_PATTERN: 'service-resource-env' }).ids.db, '/rds/orders/uat/app');
  assert.equal(resolveSecretIds({ ...base, SECRETS_NAME_PATTERN: 'env-service-resource' }).ids.db, '/uat/rds/orders/app');
  assert.equal(resolveSecretIds({ ...base, SECRETS_NAME_PATTERN: '{app}/{env}/{service}-{resource}/{name}', SECRETS_APP: 'shop' }).ids.db, 'shop/uat/rds-orders/app');
  assert.equal(Object.keys(PRESETS).length, 4);
});

test('an explicit ID wins over the pattern (e.g. the rds!… secret RDS names itself)', () => {
  const rds = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:rds!db-0a1b-AbCdEf';
  const r = resolveSecretIds({ SECRETS_ENV: 'prod', DB_SECRET_ID: rds, REDIS_SECRET_RESOURCE: 'notes-cache' });
  assert.equal(r.ids.db, rds);
  assert.equal(r.sources.db, 'explicit');
  assert.equal(r.ids.redis, '/elasticache/prod/notes-cache/app');
});

test('without SECRETS_ENV or IDs nothing is resolved (startup reports it)', () => {
  const r = resolveSecretIds({});
  assert.deepEqual(r.ids, {});
  assert.equal(r.error, undefined);
});

test('rejects an unknown environment, an unknown token, a slash in a value and a pattern without {env}', () => {
  assert.match(resolveSecretIds({ SECRETS_ENV: 'staging' }).error, /not one of dev, uat, qa, prod/);
  assert.equal(resolveSecretIds({ SECRETS_ENV: 'staging', SECRETS_ALLOWED_ENVS: 'dev,staging,prod' }).error, undefined);
  assert.match(resolveSecretIds({ SECRETS_ENV: 'dev', SECRETS_NAME_PATTERN: '/{team}/{env}/{name}' }).error, /unknown token \{team\}/);
  assert.match(resolveSecretIds({ SECRETS_ENV: 'dev', DB_SECRET_RESOURCE: 'a/b' }).error, /no "\/"/);
  assert.throws(() => renderSecretName('/{service}/{name}', { service: 'rds', name: 'app' }), /must contain \{env\}/);
});

test('warns about a name that looks like an ARN suffix', () => {
  const r = resolveSecretIds({ SECRETS_ENV: 'dev', DB_SECRET_NAME: 'app-secret', REDIS_SECRET_NAME: 'app' });
  assert.equal(r.ids.db, '/rds/dev/secure-notes/app-secret');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /ARN/);
});

test('YAML config file; env vars override it', () => {
  const yaml = [
    '# where the secrets are, never what they are',
    'secrets:',
    '  env: qa',
    '  pattern: "/{service}/{resource}/{env}/{name}"',
    '  db:',
    '    resource: billing-db   # the RDS instance',
    '  redis:',
    "    resource: 'billing-cache'",
    '    name: app',
  ].join('\n');
  const read = files({ '/etc/app/config.yaml': yaml });
  const r = resolveSecretIds({ APP_CONFIG_FILE: '/etc/app/config.yaml' }, { read });
  assert.equal(r.error, undefined);
  assert.equal(r.ids.db, '/rds/billing-db/qa/app');
  assert.equal(r.ids.redis, '/elasticache/billing-cache/qa/app');
  const o = resolveSecretIds({ APP_CONFIG_FILE: '/etc/app/config.yaml', SECRETS_ENV: 'prod' }, { read });
  assert.equal(o.ids.db, '/rds/billing-db/prod/app');
});

test('JSON and .env config files', () => {
  const read = files({
    '/c.json': JSON.stringify({ secrets: { env: 'dev', db: { id: 'explicit/db' }, redis: { resource: 'c' } } }),
    '/config.env': 'SECRETS_ENV=uat\nDB_SECRET_RESOURCE=orders\n',
  });
  const j = resolveSecretIds({ APP_CONFIG_FILE: '/c.json' }, { read });
  assert.equal(j.ids.db, 'explicit/db');
  assert.equal(j.ids.redis, '/elasticache/dev/c/app');
  assert.equal(resolveSecretIds({ APP_CONFIG_FILE: '/config.env' }, { read }).ids.db, '/rds/uat/orders/app');
});

test('a config file must not hold credentials, and the YAML subset is strict', () => {
  const read = files({
    '/bad.yaml': 'secrets:\n  db:\n    password: hunter2\n',
    '/url.json': JSON.stringify({ secrets: { redis: { id: 'redis://:pw@host:6379' } } }),
    '/app.env': 'SECRETS_ENV=dev\nDB_PASSWORD=hunter2\n',
  });
  assert.match(resolveSecretIds({ APP_CONFIG_FILE: '/app.env' }, { read }).error, /DB_PASSWORD" looks like a credential/);
  assert.match(resolveSecretIds({ APP_CONFIG_FILE: '/bad.yaml' }, { read }).error, /secrets\.db\.password" looks like a credential/);
  assert.match(resolveSecretIds({ APP_CONFIG_FILE: '/url.json' }, { read }).error, /URL with a password/);
  assert.throws(() => parseSimpleYaml('a:\n  - x\n'), /:2: expected "key: value"/);
  assert.throws(() => parseSimpleYaml('a: &x 1\n'), /plain scalar/);
  assert.throws(() => parseSimpleYaml('a: 1\na: 2\n'), /appears twice/);
  assert.throws(() => loadConfigFile('/x.toml', () => ''), /unsupported/);
});
