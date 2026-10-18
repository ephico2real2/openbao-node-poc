// Postgres access with credentials from Secrets Manager.
//
// Key idea: pg.Pool accepts `password` as an async function that is called for
// every NEW connection. Pointing it at the secrets cache means a rotated
// password is picked up as soon as the cache is refreshed, without restarting
// the process or rebuilding the pool. If the database rejects the cached
// password (it was rotated after we cached it), we force a refresh and retry
// the query once.

import { readFileSync } from 'node:fs';
import pg from 'pg';

const AUTH_FAILED = new Set(['28P01', '28000']); // invalid_password, invalid_authorization_specification
const CONNECTION_DROPPED = new Set(['57P01', '57P02', '57P03', 'ECONNRESET', 'EPIPE']);

export function createDb({ provider, secretId, config, logger, events }) {
  const log = logger.child({ component: 'db' });
  let poolPromise = null;
  let poolUser;

  const ssl = config.db.ssl
    ? {
        rejectUnauthorized: true, // verify the RDS certificate; never disable this
        ca: config.db.sslCaFile ? readFileSync(config.db.sslCaFile, 'utf8') : undefined,
      }
    : false;

  async function buildPool() {
    const s = (await provider.get(secretId)).reveal();
    poolUser = s.username;
    const host = config.db.host ?? s.host;
    const port = Number(config.db.port ?? s.port ?? 5432);
    const database = config.db.name ?? s.dbname;
    const pool = new pg.Pool({
      host,
      port,
      database,
      user: s.username,
      // Called for every NEW connection: the debug line shows each login's key use.
      password: async () => {
        const password = (await provider.get(secretId)).reveal().password;
        provider.logUse(log, secretId, { user: 'username', password: 'password' }, { host, port, database, tls: Boolean(ssl) }, 'postgres connecting with');
        return password;
      },
      ssl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'secure-notes',
    });
    pool.on('error', (err) => log.warn({ err }, 'idle database connection closed'));
    return pool;
  }

  function getPool() {
    poolPromise ??= buildPool().catch((err) => {
      poolPromise = null;
      throw err;
    });
    return poolPromise;
  }

  async function query(text, params) {
    const pool = await getPool();
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (AUTH_FAILED.has(err.code)) {
        log.warn({ code: err.code, event: 'db.auth.rejected' }, 'database rejected cached credential; refreshing from Secrets Manager');
        events.record('db', 'auth-failed', 'Postgres rejected the cached password, so the app force-refreshed the secret');

        const fresh = (await provider.refresh(secretId, 'db-auth-failure')).reveal();
        if (fresh.username !== poolUser) {
          // Alternating-users rotation switched the login role: rebuild the pool.
          const old = pool;
          poolPromise = null;
          old.end().catch(() => {});
        }
        const result = await (await getPool()).query(text, params);
        events.record('db', 'recovered', 'Reconnected to Postgres with the rotated credential and retried the query');
        log.info({ event: 'db.auth.recovered' }, 'database accepted the refreshed credential');
        return result;
      }
      if (CONNECTION_DROPPED.has(err.code)) {
        log.warn({ code: err.code }, 'database connection dropped; retrying once');
        return pool.query(text, params);
      }
      throw err;
    }
  }

  return {
    query,
    async ping() {
      await query('SELECT 1');
      return true;
    },
    async close() {
      if (poolPromise) await (await poolPromise).end();
    },
  };
}
