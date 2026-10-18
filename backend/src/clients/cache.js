// Redis (ElastiCache) access with credentials from Secrets Manager.
//
// ioredis reads `options.username` / `options.password` each time it
// (re)connects. When Redis rejects the credential (WRONGPASS / NOAUTH, i.e. it
// was rotated), we force-refresh the secret, update those options, and let the
// client's normal reconnect pick up the new password. Commands that failed
// with an auth error are retried once.
//
// Note: ioredis attaches the failed command, including its arguments, to reply
// errors. For an AUTH command those arguments are the credentials. The logger's
// Error serializer only keeps name/message/code/stack, and value-based
// redaction catches anything that slips through.

import Redis from 'ioredis';

const isAuthError = (err) => /WRONGPASS|NOAUTH|invalid username-password/i.test(err?.message ?? '');

export async function createCache({ provider, secretId, config, logger, events }) {
  const log = logger.child({ component: 'redis' });
  const s = (await provider.get(secretId)).reveal();
  const host = config.redis.host ?? s.host;
  const port = Number(config.redis.port ?? s.port ?? 6379);
  const logUse = (why) =>
    provider.logUse(log, secretId, { username: 'username', password: 'password' }, { host, port, tls: Boolean(config.redis.tls), why }, 'redis authenticating with');

  const client = new Redis({
    host,
    port,
    username: s.username,
    password: s.password,
    tls: config.redis.tls ? { servername: host } : undefined, // ElastiCache in-transit encryption
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });

  let refreshing = null;
  let recovering = false;
  function refreshCredentials(reason) {
    refreshing ??= (async () => {
      recovering = true;
      events.record('redis', 'auth-failed', 'Redis rejected the cached password, so the app force-refreshed the secret');
      const fresh = (await provider.refresh(secretId, reason)).reveal();
      client.options.username = fresh.username;
      client.options.password = fresh.password;
      logUse('after refresh');
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  client.on('error', (err) => {
    if (isAuthError(err)) {
      log.warn({ event: 'cache.auth.rejected' }, 'redis rejected cached credential; refreshing from Secrets Manager');
      refreshCredentials('redis-auth-failure').catch((e) => log.error({ err: e, event: 'cache.refresh.failed' }, 'credential refresh failed'));
    } else {
      log.warn({ err }, 'redis connection error');
    }
  });
  client.on('ready', () => {
    log.info('redis connection ready');
    if (recovering) {
      recovering = false;
      log.info({ event: 'cache.auth.recovered' }, 'redis accepted the refreshed credential');
      events.record('redis', 'recovered', 'Reconnected to Redis with the rotated credential');
    }
  });

  // The very first credential can already be stale (the agent's cache still
  // holds a pre-rotation value, or a bootstrap job is still applying the user),
  // so startup gets the same refresh path. When Redis rejects AUTH, ioredis
  // closes the socket and connect() rejects with "Connection is closed." rather
  // than the auth error itself; the reconnect it schedules uses the refreshed
  // options, so wait for that instead of failing startup.
  logUse('first connection');
  try {
    await client.connect();
  } catch (err) {
    if (!isAuthError(err) && !recovering) throw err;
    await (refreshing ?? refreshCredentials('redis-auth-failure'));
    if (client.status !== 'ready') {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('redis not ready 30 s after a credential refresh')), 30_000);
        client.once('ready', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async function run(fn) {
    try {
      return await fn(client);
    } catch (err) {
      if (!isAuthError(err)) throw err;
      await refreshCredentials('redis-auth-failure');
      return fn(client); // queued until the client reconnects with the new credential
    }
  }

  return {
    async getJSON(key) {
      const raw = await run((c) => c.get(key));
      return raw == null ? null : JSON.parse(raw);
    },
    setJSON: (key, value, ttlSeconds) => run((c) => c.set(key, JSON.stringify(value), 'EX', ttlSeconds)),
    del: (key) => run((c) => c.del(key)),
    ping: () => run((c) => c.ping()),
    close: () => client.quit(),
  };
}
