#!/usr/bin/env node
// LOCAL DEV ONLY. One-shot bootstrap for docker compose / local runs:
//
//  1. Generates random passwords with the secrets manager's own generator.
//  2. Stores them as secrets in the secrets manager (SECRETS_PROVIDER: the
//     AWS Secrets Manager stand-in, OpenBao or Vault):
//       db           app login (least privilege on the notes table)
//       dbAdmin      Postgres superuser (used only by the demo rotator)
//       redis        Redis ACL user limited to notes:* keys
//       redisAdmin   Redis default user (used only by the demo rotator)
//     named by the convention, e.g. /rds/dev/notes-db/app (docs/reference/secret-naming.md)
//  3. Applies them to Postgres and Redis, then "burns" the bootstrap
//     passwords by rotating the superusers to the new random admin values.
//
// After this runs, the only copy of every credential is in the secrets manager.
// Passwords are sent to the servers as hashes (SCRAM verifier / ACL #sha256).
//
// Step v2 (BAO_DYNAMIC=true): the seed job also connects OpenBao's database
// secrets engine to Postgres and Valkey, through an admin user made only for
// OpenBao (bao_admin / bao-admin), defines the two roles the app asks for
// users from, then has OpenBao rotate that admin's password: from then on
// nobody but OpenBao can create or drop database users.
//
// On OpenBao / Vault the seed job also plays "whoever provisions the app": it
// logs in ONCE with the bootstrap AppRole (a secret ID that works one time,
// from a file), and hands the app its own AppRole secret ID in a file (mode
// 0400) on a volume only the app mounts. No token or secret ID is in any env.

import pg from 'pg';
import Redis from 'ioredis';
import { existsSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { redisPasswordHash, scramSha256Verifier } from '../src/demo/crypto.js';
import { createAwsStore } from '../src/secrets/aws-store.js';
import { createBaoClient } from '../src/secrets/bao/client.js';
import { createKvStore } from '../src/secrets/bao/kv.js';
import { NOTES_SCHEMA } from '../src/schema.js';
import { resolveSecretIds } from '../src/secrets/naming.js';

const env = process.env;
const must = (k) => {
  if (!env[k]) throw new Error(`${k} is required`);
  return env[k];
};

const PROVIDER = (env.SECRETS_PROVIDER ?? 'aws').toLowerCase();
const DYNAMIC = PROVIDER !== 'aws' && /^(1|true|yes)$/i.test(env.BAO_DYNAMIC ?? '');
const DB_MOUNT = env.BAO_DB_MOUNT ?? 'database';
const NAME = PROVIDER === 'aws' ? 'Secrets Manager' : PROVIDER === 'vault' ? 'Vault' : 'OpenBao';
let bao; // the seed job's own OpenBao/Vault session (bootstrap AppRole)
const store =
  PROVIDER === 'aws'
    ? createAwsStore({ region: env.AWS_REGION ?? 'us-east-1', endpoint: must('AWS_MOCK_ENDPOINT') })
    : createKvStore(
        (bao = createBaoClient({
          addr: must('BAO_ADDR'),
          roleId: env.BAO_SEED_ROLE_ID ?? 'secure-notes-seed',
          secretIdFile: must('BAO_BOOTSTRAP_SECRET_ID_FILE'),
          scheduleRenewal: false,
        })),
        { mount: env.BAO_KV_MOUNT ?? 'secret' },
      );

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

const randomPassword = () => store.randomPassword();

/** OpenBao/Vault: mint the app's AppRole secret ID and hand it over in a file (0400). */
async function provisionAppSecretId() {
  const file = must('BAO_APP_SECRET_ID_FILE');
  const role = env.BAO_APP_ROLE ?? 'secure-notes-app';
  const out = await bao.mintSecretId(role, { issued_by: 'seed' });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${out.secretId}\n`, { mode: 0o400 });
  await rename(tmp, file); // atomic: the app never reads a half-written file
  console.log(`[seed] ${NAME}: minted the app's AppRole secret ID (accessor ${out.accessor.slice(0, 8)}…) into ${file} (mode 0400)`);
}

/** Step v2: OpenBao's database secrets engine, connected and handed over. */
async function configureDatabaseEngine(pw) {
  const ttl = env.BAO_DB_DEFAULT_TTL ?? '30s'; // lab: short, so a few minutes show renewals
  const maxTtl = env.BAO_DB_MAX_TTL ?? '90s'; //  and a re-issue at the max TTL
  const write = (path, body) => bao.request('POST', `${DB_MOUNT}/${path}`, { body });

  await write('config/notes-db', {
    plugin_name: 'postgresql-database-plugin',
    allowed_roles: 'notes-app',
    connection_url: `postgresql://{{username}}:{{password}}@${appPgHost}:5432/${DB_NAME}?sslmode=disable`,
    username: 'bao_admin',
    password: pw.baoDb,
    password_authentication: 'scram-sha-256', // OpenBao sends Postgres a SCRAM verifier, never the password
  });
  await write('roles/notes-app', {
    db_name: 'notes-db',
    default_ttl: ttl,
    max_ttl: maxTtl,
    creation_statements: [`CREATE ROLE "{{name}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' IN ROLE notes_rw`],
    revocation_statements: [
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '{{name}}'`,
      `DROP ROLE IF EXISTS "{{name}}"`,
    ],
  });
  await write('rotate-root/notes-db', {});
  console.log(`[seed] ${NAME}: database engine connected to Postgres as bao_admin; role notes-app (TTL ${ttl}, max ${maxTtl}); bao_admin's password rotated, only ${NAME} knows it`);

  await write('config/notes-cache', {
    plugin_name: 'valkey-database-plugin',
    allowed_roles: 'notes-cache',
    host: appRedisHost,
    port: 6379,
    username: 'bao-admin',
    password: pw.baoCache,
  });
  await write('roles/notes-cache', {
    db_name: 'notes-cache',
    default_ttl: ttl,
    max_ttl: maxTtl,
    creation_statements: JSON.stringify(['~notes:*', 'resetchannels', '-@all', '+@read', '+@write', '+@connection', '-@dangerous', '+info']),
  });
  await write('rotate-root/notes-cache', {});
  // The rotated admin password is only in the server's memory until ACL SAVE
  // writes it to the ACL file; the default user (its password just burned
  // into the secrets manager) saves it, so a restart keeps OpenBao working.
  const r = new Redis({ host: redisHost, port: redisPort, username: 'default', password: pw.redisAdmin, lazyConnect: true, maxRetriesPerRequest: 1 });
  r.on('error', () => {});
  await r.connect();
  await r.call('ACL', 'SAVE').catch(() => {});
  r.disconnect();
  console.log(`[seed] ${NAME}: database engine connected to Redis/Valkey as bao-admin; role notes-cache; bao-admin's password rotated`);
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
  if (bao) {
    // The bootstrap secret ID works once. If it was already spent and the app
    // has its own secret ID, this stack was seeded on an earlier start.
    try {
      await waitFor(NAME, () => bao.login('bootstrap'), 60);
    } catch (err) {
      if (/invalid role or secret ID/i.test(err.message) && existsSync(must('BAO_APP_SECRET_ID_FILE'))) {
        console.log(`[seed] ${NAME}: the bootstrap secret ID is spent and the app has its own; already seeded (reset with: docker compose down -v)`);
        return;
      }
      throw err;
    }
    console.log(`[seed] ${NAME}: logged in with the one-time bootstrap AppRole (that secret ID no longer works)`);
  } else {
    await waitFor(NAME, () => store.randomPassword());
  }

  if (await store.exists(ids.db)) {
    console.log(`[seed] ${ids.db} already exists; nothing to do (reset with: docker compose down -v)`);
    if (bao) await provisionAppSecretId();
    return;
  }

  const pw = {
    db: await randomPassword(),
    dbAdmin: await randomPassword(),
    redis: await randomPassword(),
    redisAdmin: await randomPassword(),
    // Step v2: OpenBao's own admin logins; rotated by OpenBao right after setup.
    baoDb: DYNAMIC ? await randomPassword() : undefined,
    baoCache: DYNAMIC ? await randomPassword() : undefined,
  };

  // --- Secrets first, so a credential is never applied without being recorded.
  const put = (Name, value, Description) => store.create(Name, value, Description);
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
      (${lit(`Hello! This note came from Postgres using a password the app fetched from ${NAME}.`)}),
      (${lit(`Reload the list: the second read is served from Redis, also authenticated with a ${NAME} credential.`)})`);
  }
  if (DYNAMIC) {
    // The group role every dynamic user joins (the same least privilege as
    // notes_app), and OpenBao's admin: it may create users in that group, drop
    // them, and end their sessions. Nothing else.
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'notes_rw') THEN CREATE ROLE notes_rw NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bao_admin') THEN CREATE ROLE bao_admin LOGIN CREATEROLE; END IF;
      END $$;`);
    await admin.query(`GRANT SELECT, INSERT ON notes TO notes_rw`);
    await admin.query(`GRANT USAGE ON SEQUENCE notes_id_seq TO notes_rw`);
    await admin.query(`ALTER ROLE bao_admin WITH LOGIN CREATEROLE PASSWORD ${lit(scramSha256Verifier(pw.baoDb))}`);
    await admin.query(`GRANT notes_rw TO bao_admin WITH ADMIN OPTION`);
    await admin.query(`GRANT pg_signal_backend TO bao_admin`); // revocation ends the dropped user's sessions
    console.log('[seed] postgres: group role notes_rw and OpenBao\'s admin bao_admin created');
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
  if (DYNAMIC) {
    // OpenBao's admin on Redis/Valkey: ACL commands only, no keys.
    await r.call('ACL', 'SETUSER', 'bao-admin', 'reset', 'on', `#${redisPasswordHash(pw.baoCache)}`,
      'resetchannels', '-@all', '+acl', '+ping', '+auth', '+hello', '+client|setname', '+client|kill');
  }
  await r.call('ACL', 'SETUSER', 'default', 'resetpass', `#${redisPasswordHash(pw.redisAdmin)}`);
  await r.call('ACL', 'SAVE').catch(() => console.log('[seed] redis: no aclfile configured, ACL kept in memory only'));
  r.disconnect();
  console.log('[seed] redis: ACL user created (notes:* keys only); bootstrap password replaced');
  if (DYNAMIC) await configureDatabaseEngine(pw);
  if (bao) await provisionAppSecretId();
  console.log(`[seed] done. Every credential now lives only in ${NAME}.`);
}

main().catch((err) => {
  console.error(`[seed] failed: ${err.message}`);
  process.exit(1);
});
