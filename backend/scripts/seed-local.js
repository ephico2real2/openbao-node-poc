#!/usr/bin/env node
// LOCAL DEV ONLY. One-shot bootstrap for docker compose / local runs:
//
//  1. Generates random passwords with GetRandomPassword.
//  2. Stores them as secrets in the (mock) Secrets Manager:
//       db           app login (least privilege on the notes table)
//       dbAdmin      Postgres superuser (used only by the demo rotator)
//       redis        Redis ACL user limited to notes:* keys
//       redisAdmin   Redis default user (used only by the demo rotator)
//     named by the convention, e.g. /rds/dev/notes-db/app (docs/reference/secret-naming.md)
//  3. Applies them to Postgres and Redis, then "burns" the bootstrap
//     passwords by rotating the superusers to the new random admin values.
//
// After this runs, the only copy of every credential is in Secrets Manager.
// Passwords are sent to the servers as hashes (SCRAM verifier / ACL #sha256).

import pg from 'pg';
import Redis from 'ioredis';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  DescribeSecretCommand,
  GetRandomPasswordCommand,
} from '@aws-sdk/client-secrets-manager';
import { redisPasswordHash, scramSha256Verifier } from '../src/demo/crypto.js';
import { NOTES_SCHEMA } from '../src/schema.js';
import { resolveSecretIds } from '../src/secrets/naming.js';

const env = process.env;
const must = (k) => {
  if (!env[k]) throw new Error(`${k} is required`);
  return env[k];
};

const sm = new SecretsManagerClient({ region: env.AWS_REGION ?? 'us-east-1', endpoint: must('AWS_MOCK_ENDPOINT') });

// The same names the app will look up: explicit IDs, or the naming convention.
const naming = resolveSecretIds(env);
if (naming.error) throw new Error(naming.error);
const ids = naming.ids;
for (const k of ['db', 'dbAdmin', 'redis', 'redisAdmin']) {
  if (!ids[k]) throw new Error(`no secret name for ${k}: set SECRETS_ENV (naming convention) or the *_SECRET_ID variables`);
}
console.log(`[seed] secret names (${naming.pattern ?? 'explicit'}): ${Object.values(ids).join(', ')}`);

const pgHost = env.SEED_PG_HOST ?? '127.0.0.1';
const pgPort = Number(env.SEED_PG_PORT ?? 5432);
const redisHost = env.SEED_REDIS_HOST ?? '127.0.0.1';
const redisPort = Number(env.SEED_REDIS_PORT ?? 6379);
// Hostnames the APP should use (differ from the seeder's in docker compose).
const appPgHost = env.APP_PG_HOST ?? pgHost;
const appRedisHost = env.APP_REDIS_HOST ?? redisHost;

const APP_DB_USER = 'notes_app';
const APP_REDIS_USER = 'notes-app';
const DB_NAME = env.DB_NAME ?? 'notes';

async function exists(secretId) {
  try {
    await sm.send(new DescribeSecretCommand({ SecretId: secretId }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function randomPassword() {
  const r = await sm.send(new GetRandomPasswordCommand({ PasswordLength: 32, ExcludePunctuation: true }));
  return r.RandomPassword;
}

async function waitFor(name, fn, tries = 30) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw new Error(`${name} not reachable: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main() {
  await waitFor('Secrets Manager mock', () => sm.send(new GetRandomPasswordCommand({ PasswordLength: 8 })));

  if (await exists(ids.db)) {
    console.log(`[seed] ${ids.db} already exists; nothing to do (reset with: docker compose down -v)`);
    return;
  }

  const pw = {
    db: await randomPassword(),
    dbAdmin: await randomPassword(),
    redis: await randomPassword(),
    redisAdmin: await randomPassword(),
  };

  // --- Secrets first, so a credential is never applied without being recorded.
  const put = (Name, value, Description) =>
    sm.send(new CreateSecretCommand({ Name, Description, SecretString: JSON.stringify(value) }));
  await put(ids.db, { engine: 'postgres', host: appPgHost, port: 5432, dbname: DB_NAME, username: APP_DB_USER, password: pw.db }, 'App login for the notes database');
  await put(ids.dbAdmin, { engine: 'postgres', host: appPgHost, port: 5432, dbname: DB_NAME, username: 'postgres', password: pw.dbAdmin }, 'Postgres superuser (rotation only)');
  await put(ids.redis, { host: appRedisHost, port: 6379, username: APP_REDIS_USER, password: pw.redis }, 'App ACL user for Redis');
  await put(ids.redisAdmin, { host: appRedisHost, port: 6379, username: 'default', password: pw.redisAdmin }, 'Redis default user (rotation only)');
  console.log('[seed] created 4 secrets');

  // --- Postgres
  const admin = new pg.Client({
    host: pgHost,
    port: pgPort,
    database: DB_NAME,
    user: env.PG_BOOTSTRAP_USER ?? 'postgres',
    password: must('PG_BOOTSTRAP_PASSWORD'),
  });
  await waitFor('Postgres', () => admin.connect(), 30);
  const lit = (s) => admin.escapeLiteral(s);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
        CREATE ROLE ${APP_DB_USER} LOGIN;
      END IF;
    END $$;`);
  await admin.query(`ALTER ROLE ${APP_DB_USER} WITH LOGIN PASSWORD ${lit(scramSha256Verifier(pw.db))}`);
  await admin.query(NOTES_SCHEMA);
  // Least privilege: the app can read and add notes, nothing else.
  await admin.query(`REVOKE ALL ON notes FROM ${APP_DB_USER}`);
  await admin.query(`GRANT SELECT, INSERT ON notes TO ${APP_DB_USER}`);
  await admin.query(`GRANT USAGE ON SEQUENCE notes_id_seq TO ${APP_DB_USER}`);
  await admin.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  const { rows } = await admin.query('SELECT count(*)::int AS n FROM notes');
  if (rows[0].n === 0) {
    await admin.query(`INSERT INTO notes (body) VALUES
      ('Hello! This note came from Postgres using a password the app fetched from Secrets Manager.'),
      ('Reload the list: the second read is served from Redis, also authenticated with a Secrets Manager credential.')`);
  }
  // Burn the bootstrap password.
  await admin.query(`ALTER ROLE ${admin.escapeIdentifier(env.PG_BOOTSTRAP_USER ?? 'postgres')} WITH PASSWORD ${lit(scramSha256Verifier(pw.dbAdmin))}`);
  await admin.end();
  console.log('[seed] postgres: role, table, grants done; bootstrap password replaced');

  // --- Redis
  const r = new Redis({
    host: redisHost,
    port: redisPort,
    username: 'default',
    password: must('REDIS_BOOTSTRAP_PASSWORD'),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  r.on('error', () => {});
  await waitFor('Redis', () => r.connect(), 30);
  await r.call(
    'ACL', 'SETUSER', APP_REDIS_USER, 'reset', 'on', `#${redisPasswordHash(pw.redis)}`,
    '~notes:*', 'resetchannels', '-@all', '+@read', '+@write', '+@connection', '-@dangerous', '+info',
  );
  await r.call('ACL', 'SETUSER', 'default', 'resetpass', `#${redisPasswordHash(pw.redisAdmin)}`);
  await r.call('ACL', 'SAVE').catch(() => console.log('[seed] redis: no aclfile configured, ACL kept in memory only'));
  r.disconnect();
  console.log('[seed] redis: ACL user created (notes:* keys only); bootstrap password replaced');
  console.log('[seed] done. Every credential now lives only in Secrets Manager.');
}

main().catch((err) => {
  console.error(`[seed] failed: ${err.message}`);
  process.exit(1);
});
