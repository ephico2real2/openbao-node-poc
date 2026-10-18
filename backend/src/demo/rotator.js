// DEMO ONLY: an in-process stand-in for a Secrets Manager rotation Lambda, so
// you can watch rotation and the app's recovery without deploying anything.
//
// It follows the same four-step contract AWS rotation functions use:
//   createSecret  -> new version labelled AWSPENDING
//   setSecret     -> change the password on the database / cache
//   testSecret    -> log in with the AWSPENDING value
//   finishSecret  -> move AWSCURRENT to the new version (old becomes AWSPREVIOUS)
//
// In AWS, rotation is done by RDS managed rotation or a rotation Lambda, which
// holds the admin credential. The application role in infra/ never gets
// PutSecretValue or access to admin secrets. That is why this module only
// loads when DEMO_MODE=true, which is refused in production.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import Redis from 'ioredis';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  GetRandomPasswordCommand,
  PutSecretValueCommand,
  UpdateSecretVersionStageCommand,
} from '@aws-sdk/client-secrets-manager';
import { HttpError } from '../http.js';
import { redisPasswordHash, scramSha256Verifier } from './crypto.js';

const short = (id) => String(id).slice(0, 8);

export function createRotator({ config, redactor, logger, events }) {
  const log = logger.child({ component: 'rotator' });
  const sm = new SecretsManagerClient({ region: config.region, endpoint: config.awsEndpoint });
  let busy = false;

  const pgSsl = config.db.ssl
    ? { rejectUnauthorized: true, ca: config.db.sslCaFile ? readFileSync(config.db.sslCaFile, 'utf8') : undefined }
    : false;

  async function readSecret(secretId, stage = 'AWSCURRENT') {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId, VersionStage: stage }));
    const value = JSON.parse(r.SecretString);
    redactor.registerSecretObject(value, r.SecretString);
    return { value, versionId: r.VersionId };
  }

  const pgClient = (creds) =>
    new pg.Client({
      host: config.db.host ?? creds.host,
      port: Number(config.db.port ?? creds.port ?? 5432),
      database: config.db.name ?? creds.dbname,
      user: creds.username,
      password: creds.password,
      ssl: pgSsl,
      connectionTimeoutMillis: 5_000,
    });

  const redisClient = (creds) =>
    new Redis({
      host: config.redis.host ?? creds.host,
      port: Number(config.redis.port ?? creds.port ?? 6379),
      username: creds.username,
      password: creds.password,
      tls: config.redis.tls ? { servername: config.redis.host ?? creds.host } : undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });

  async function withPg(creds, fn) {
    const c = pgClient(creds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => {});
    }
  }

  async function withRedis(creds, fn) {
    const c = redisClient(creds);
    c.on('error', () => {}); // surfaced via the rejected promise instead
    await c.connect();
    try {
      return await fn(c);
    } finally {
      c.disconnect();
    }
  }

  const targets = {
    db: {
      adminSecretId: () => config.demo.dbAdminSecretId,
      setSecret: (admin, pending) =>
        withPg(admin, (c) =>
          c.query(`ALTER ROLE ${c.escapeIdentifier(pending.username)} WITH PASSWORD ${c.escapeLiteral(scramSha256Verifier(pending.password))}`),
        ),
      setDetail: 'Set the new password on the Postgres role, sent as a SCRAM-SHA-256 verifier (never plaintext)',
      testSecret: (pending) => withPg(pending, (c) => c.query('SELECT 1')),
      revokeOld: null, // single-user rotation: ALTER ROLE already replaced the old password
    },
    redis: {
      adminSecretId: () => config.demo.redisAdminSecretId,
      setSecret: (admin, pending) =>
        withRedis(admin, async (c) => {
          await c.call('ACL', 'SETUSER', pending.username, `#${redisPasswordHash(pending.password)}`);
          await c.call('ACL', 'SAVE').catch(() => {}); // only works when Redis uses an aclfile
        }),
      setDetail: 'Added the new password to the Redis ACL user as a SHA-256 hash; the old one still works (dual-password window)',
      testSecret: (pending) => withRedis(pending, (c) => c.ping()),
      revokeOld: (admin, old) =>
        withRedis(admin, async (c) => {
          await c.call('ACL', 'SETUSER', old.username, `!${redisPasswordHash(old.password)}`);
          await c.call('ACL', 'SAVE').catch(() => {});
        }),
    },
  };

  async function rotate(alias) {
    const target = targets[alias];
    if (!target) throw new HttpError(404, `unknown secret alias '${alias}'`);
    const secretId = config.secretIds[alias];
    const adminId = target.adminSecretId();
    if (!adminId) throw new HttpError(400, `no admin secret configured for '${alias}'`);
    if (busy) throw new HttpError(409, 'a rotation is already running');
    busy = true;

    const steps = [];
    const step = (name, detail) => {
      steps.push({ name, detail, at: new Date().toISOString() });
      events.record('rotation', name, `[${alias}] ${detail}`);
    };
    const token = randomUUID();
    let movedCurrent = false;

    try {
      // 1. createSecret
      const current = await readSecret(secretId);
      const { RandomPassword } = await sm.send(
        new GetRandomPasswordCommand({ PasswordLength: 32, ExcludePunctuation: true, IncludeSpace: false }),
      );
      redactor.register(RandomPassword); // before it can appear anywhere
      const pending = { ...current.value, password: RandomPassword };
      await sm.send(
        new PutSecretValueCommand({
          SecretId: secretId,
          ClientRequestToken: token,
          SecretString: JSON.stringify(pending),
          VersionStages: ['AWSPENDING'],
        }),
      );
      step('createSecret', `Generated a new password and stored it as version ${short(token)} labelled AWSPENDING`);

      // 2. setSecret
      const admin = (await readSecret(adminId)).value;
      await target.setSecret(admin, pending);
      step('setSecret', target.setDetail);

      // 3. testSecret
      await target.testSecret(pending);
      step('testSecret', 'Logged in with the AWSPENDING credential successfully');

      // 4. finishSecret
      await sm.send(
        new UpdateSecretVersionStageCommand({
          SecretId: secretId,
          VersionStage: 'AWSCURRENT',
          MoveToVersionId: token,
          RemoveFromVersionId: current.versionId,
        }),
      );
      movedCurrent = true;
      await sm.send(
        new UpdateSecretVersionStageCommand({ SecretId: secretId, VersionStage: 'AWSPENDING', RemoveFromVersionId: token }),
      );
      step('finishSecret', `AWSCURRENT now points to ${short(token)}; ${short(current.versionId)} became AWSPREVIOUS`);

      if (target.revokeOld) {
        await target.revokeOld(admin, current.value);
        step('revokeOld', 'Removed the old password from the Redis ACL user');
      }

      log.info({ alias, secretId, newVersionId: token }, 'demo rotation complete');
      return {
        alias,
        newVersionId: token,
        previousVersionId: current.versionId,
        steps,
        next:
          'The app still holds the OLD value in its cache. Open connections keep working, but the next new connection ' +
          'will be rejected, and the app will refresh the secret and retry. Click "Drop connections" to force that now.',
      };
    } catch (err) {
      step('failed', `Rotation stopped: ${err.message}`);
      if (!movedCurrent) {
        // Same as AWS: AWSCURRENT is untouched, so clients are unaffected. Clean up the pending label.
        await sm
          .send(new UpdateSecretVersionStageCommand({ SecretId: secretId, VersionStage: 'AWSPENDING', RemoveFromVersionId: token }))
          .catch(() => {});
      }
      log.error({ err, alias, event: 'rotation.demo.failed' }, 'demo rotation failed');
      throw new HttpError(502, `rotation failed at step ${steps.length + 1}: ${err.message}`, 'rotation_failed');
    } finally {
      busy = false;
    }
  }

  /** Kill the app's open DB/Redis connections so the next request must reconnect. */
  async function dropConnections() {
    const dbApp = (await readSecret(config.secretIds.db)).value;
    const redisApp = (await readSecret(config.secretIds.redis)).value;
    const dbAdmin = (await readSecret(config.demo.dbAdminSecretId)).value;
    const redisAdmin = (await readSecret(config.demo.redisAdminSecretId)).value;

    const pgKilled = await withPg(dbAdmin, async (c) => {
      const r = await c.query(
        'SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()',
        [dbApp.username],
      );
      return r.rows[0].n;
    });
    const redisKilled = await withRedis(redisAdmin, (c) => c.call('CLIENT', 'KILL', 'USER', redisApp.username)).catch(() => 0);

    events.record('demo', 'connections-dropped', `Terminated ${pgKilled} Postgres and ${redisKilled} Redis connection(s) owned by the app`);
    return { postgres: pgKilled, redis: Number(redisKilled) };
  }

  return { rotate, dropConnections };
}
