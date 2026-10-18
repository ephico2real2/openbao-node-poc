// DEMO ONLY: an in-process stand-in for a rotation function, so you can watch
// rotation and the app's recovery without deploying anything.
//
// It follows the four-step contract AWS rotation functions use, on whichever
// secrets manager the app runs against (the store hides the difference):
//   createSecret  -> store the new value as pending   (AWS: AWSPENDING; OpenBao: <name>/pending)
//   setSecret     -> change the password on the database / cache
//   testSecret    -> log in with the pending value
//   finishSecret  -> make it current                 (AWS: move AWSCURRENT; OpenBao: next KV version, check-and-set)
//
// In production, rotation is done by something that holds the admin credential
// (RDS managed rotation, a rotation Lambda, OpenBao's database secrets engine):
// the application's identity never gets write access or the admin secrets. That
// is why this module only loads when DEMO_MODE=true, which is refused in production.

import { readFileSync } from 'node:fs';
import pg from 'pg';
import Redis from 'ioredis';
import { HttpError } from '../http.js';
import { redisPasswordHash, scramSha256Verifier } from './crypto.js';

const short = (id) => String(id).slice(0, 8);

export function createRotator({ config, redactor, logger, events, store, provider, leases }) {
  const log = logger.child({ component: 'rotator' });
  const L = store?.labels ?? {};
  let busy = false;

  const pgSsl = config.db.ssl
    ? { rejectUnauthorized: true, ca: config.db.sslCaFile ? readFileSync(config.db.sslCaFile, 'utf8') : undefined }
    : false;

  async function readSecret(secretId) {
    const r = await store.read(secretId);
    redactor.registerSecretObject(r.value, JSON.stringify(r.value));
    return r;
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

  // Step v2: a dynamic user is not rotated, it is replaced. The demo revokes
  // the current lease, as an operator would after a leak: OpenBao drops the
  // user and ends its sessions; the app finds out on its next query and asks
  // for a new user.
  async function revokeLease(alias, secretId) {
    if (busy) throw new HttpError(409, 'a rotation is already running');
    busy = true;
    const steps = [];
    try {
      const id = await leases.revoke(secretId);
      const what = alias === 'db' ? 'Postgres' : 'Redis';
      steps.push({ name: 'revokeLease', detail: `Revoked lease ${id}: ${config.product} dropped this instance's ${what} user and ended its sessions`, at: new Date().toISOString() });
      events.record('rotation', 'revokeLease', `[${alias}] Revoked lease ${id}: ${config.product} dropped this instance's ${what} user`);
      log.info({ alias, secretId, lease: id, event: 'rotation.demo.revoked' }, 'demo: lease revoked');
      return {
        alias,
        revokedLease: id,
        newVersionId: id,
        steps,
        next: `The app still holds the revoked user. Its next ${what} login fails, so it asks ${config.product} for a new user and retries.`,
      };
    } catch (err) {
      throw new HttpError(502, `revoking the lease failed: ${err.message}`, 'rotation_failed');
    } finally {
      busy = false;
    }
  }

  const isDynamic = (secretId) => Boolean(leases && provider?.status().find((s) => s.secretId === secretId)?.lease);

  // SECRETS_MODE=file: the app has no identity in the secrets manager, so the
  // demo can't rotate from here. Rotation happens there (k8s-check runs a Job)
  // and arrives as a changed file.
  const noStore = () => new HttpError(409, `SECRETS_MODE=file: the app has no ${config.product} identity, so it cannot rotate. Rotate in ${config.product}; External Secrets Operator updates the mounted file and the app re-reads it.`, 'file_mode');

  async function rotate(alias) {
    const target = targets[alias];
    if (!target) throw new HttpError(404, `unknown secret alias '${alias}'`);
    if (!store) throw noStore();
    const secretId = config.secretIds[alias];
    if (isDynamic(secretId)) return revokeLease(alias, secretId);
    const adminId = target.adminSecretId();
    if (!adminId) throw new HttpError(400, `no admin secret configured for '${alias}'`);
    if (busy) throw new HttpError(409, 'a rotation is already running');
    busy = true;

    const steps = [];
    const step = (name, detail) => {
      steps.push({ name, detail, at: new Date().toISOString() });
      events.record('rotation', name, `[${alias}] ${detail}`);
    };
    let movedCurrent = false;
    let pendingId;

    try {
      // 1. createSecret
      const current = await readSecret(secretId);
      const password = await store.randomPassword();
      redactor.register(password); // before it can appear anywhere
      const pending = { ...current.value, password };
      pendingId = await store.putPending(secretId, pending);
      step('createSecret', `Generated a new password and stored it as ${L.pending} (${short(pendingId)})`);

      // 2. setSecret
      const admin = (await readSecret(adminId)).value;
      await target.setSecret(admin, pending);
      step('setSecret', target.setDetail);

      // 3. testSecret
      await target.testSecret(pending);
      step('testSecret', 'Logged in with the pending credential successfully');

      // 4. finishSecret
      const newVersion = await store.promote(secretId, pending, current.versionId);
      movedCurrent = true;
      step('finishSecret', `${L.current} is now version ${short(newVersion)}; ${short(current.versionId)} became ${L.previous}`);

      if (target.revokeOld) {
        await target.revokeOld(admin, current.value);
        step('revokeOld', 'Removed the old password from the Redis ACL user');
      }

      log.info({ alias, secretId, newVersionId: newVersion }, 'demo rotation complete');
      return {
        alias,
        newVersionId: newVersion,
        previousVersionId: current.versionId,
        steps,
        next:
          'The app still holds the OLD value in its cache. Open connections keep working, but the next new connection ' +
          'will be rejected, and the app will refresh the secret and retry. Click "Drop connections" to force that now.',
      };
    } catch (err) {
      step('failed', `Rotation stopped: ${err.message}`);
      if (!movedCurrent && pendingId) {
        // The current value is untouched, so clients are unaffected. Clean up the pending copy.
        await store.discardPending(secretId).catch(() => {});
      }
      log.error({ err, alias, event: 'rotation.demo.failed' }, 'demo rotation failed');
      throw new HttpError(502, `rotation failed at step ${steps.length + 1}: ${err.message}`, 'rotation_failed');
    } finally {
      busy = false;
    }
  }

  /** Kill the app's open DB/Redis connections so the next request must reconnect. */
  async function dropConnections() {
    if (!store) throw noStore();
    // The users the app is logged in as right now (static or dynamic).
    const dbApp = (await provider.get(config.secretIds.db)).reveal();
    const redisApp = (await provider.get(config.secretIds.redis)).reveal();
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
