import { inspect } from 'node:util';
import { HttpError } from './http.js';
import { runSecurityChecks } from './security/checks.js';

const NOTES_CACHE_KEY = 'notes:list';
const ALIASES = ['db', 'redis'];

export function registerRoutes(router, { config, provider, db, cache, events, logger, redactor, rotator, shipper, fileSink, baoClient }) {
  const log = logger.child({ component: 'api' });

  // ---- health -------------------------------------------------------------
  // Liveness: the process is up and serving. No dependencies, so a database
  // blip makes the pod unready (below) rather than getting it restarted.
  router.get('/api/livez', async () => ({ status: 'ok' }));

  // Readiness: Postgres and Redis both answer with the current credentials.
  router.get('/api/health', async (ctx) => {
    const [dbOk, redisOk] = await Promise.all([
      db.ping().then(() => true, () => false),
      cache.ping().then(() => true, () => false),
    ]);
    if (!(dbOk && redisOk)) ctx.status = 503;
    return { status: dbOk && redisOk ? 'ok' : 'degraded', postgres: dbOk, redis: redisOk };
  });

  router.get('/api/config', async () => ({
    secretsProvider: config.secretsProvider,
    secretsMode: config.secretsMode,
    bao: baoClient ? baoClient.status() : null,
    secretsDir: config.secretsMode === 'file' ? config.secretsDir : undefined,
    platform: config.platform,
    region: config.region,
    environment: config.nodeEnv,
    usingLocalMock: Boolean(config.awsEndpoint),
    demoMode: config.demo.enabled,
    logLevel: config.logging.level,
    revealSecrets: config.logging.revealSecrets,
    secrets: Object.fromEntries(ALIASES.map((a) => [a, config.secretIds[a]])),
    logFormat: config.logging.format,
    logShipping: shipper ? shipper.stats() : null,
    logFile: fileSink ? fileSink.stats() : null,
    secretNaming: {
      environment: config.secretNaming.environment ?? null,
      pattern: config.secretNaming.pattern ?? null,
      sources: config.secretNaming.sources,
    },
  }));

  // ---- the actual application: notes with a Redis read-through cache --------
  router.get('/api/notes', async () => {
    const t = performance.now();
    let notes = await cache.getJSON(NOTES_CACHE_KEY);
    let source = 'redis';
    if (!notes) {
      const r = await db.query('SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 50');
      notes = r.rows;
      source = 'postgres';
      await cache.setJSON(NOTES_CACHE_KEY, notes, 30);
    }
    return { source, ms: +(performance.now() - t).toFixed(1), notes };
  });

  router.post('/api/notes', async (ctx) => {
    const text = typeof ctx.body?.body === 'string' ? ctx.body.body.trim() : '';
    if (!text || text.length > 280) throw new HttpError(400, 'note must be 1-280 characters');
    const r = await db.query('INSERT INTO notes (body) VALUES ($1) RETURNING id, body, created_at', [text]);
    await cache.del(NOTES_CACHE_KEY);
    ctx.status = 201;
    return r.rows[0];
  });

  // ---- secrets metadata (never values) -------------------------------------
  // Cache DescribeSecret so dashboard polling stays cheap: the cache is per
  // process, shared by every viewer, and dropped whenever the version changes.
  // 5 s in the demo (the rotation lab shows changes live), 60 s otherwise:
  // at most 2 secrets x 60 calls an hour per instance while a dashboard is open.
  const DESCRIBE_TTL_MS = config.demo.enabled ? 5_000 : 60_000;
  const describeCache = new Map();
  provider.on('loaded', ({ secretId }) => describeCache.delete(secretId));
  async function remoteMeta(secretId) {
    const hit = describeCache.get(secretId);
    if (hit && Date.now() - hit.at < DESCRIBE_TTL_MS) return hit.meta;
    const meta = await provider.describe(secretId).catch(() => undefined);
    describeCache.set(secretId, { at: Date.now(), meta });
    return meta;
  }

  router.get('/api/secrets', async () => {
    const status = provider.status();
    const secrets = await Promise.all(
      ALIASES.map(async (alias) => {
        const secretId = config.secretIds[alias];
        const local = status.find((s) => s.secretId === secretId);
        const remote = await remoteMeta(secretId);
        return {
          alias,
          ...local,
          remote,
          staleInCache: Boolean(remote?.currentVersionId && local && remote.currentVersionId !== local.versionId),
        };
      }),
    );
    return { mode: config.secretsMode, provider: config.secretsProvider, ttlSeconds: config.cache.ttlSeconds, secrets };
  });

  const lastManualRefresh = new Map();
  router.post('/api/secrets/:alias/refresh', async (ctx) => {
    const { alias } = ctx.params;
    if (!ALIASES.includes(alias)) throw new HttpError(404, 'unknown secret');
    const last = lastManualRefresh.get(alias) ?? 0;
    if (Date.now() - last < 2_000) throw new HttpError(429, 'slow down');
    lastManualRefresh.set(alias, Date.now());
    await provider.refresh(config.secretIds[alias], 'manual-refresh');
    return { ok: true };
  });

  router.get('/api/events', async (ctx) => ({ events: events.list(Number(ctx.query.get('since') ?? 0)) }));

  router.get('/api/security/checks', async () => ({ checks: await runSecurityChecks({ config, redactor, provider, baoClient, logSinks: { otlp: shipper?.stats(), file: fileSink?.stats() } }) }));

  // ---- demo-only endpoints ---------------------------------------------------
  if (!config.demo.enabled) return;

  // ?only=credentials: the debug lines about credentials (which secret, which
  // keys, masked), found in the whole buffer so request noise can't push them out.
  const CREDENTIAL_LINE = /"msg":"(secret consumed|secret loaded|secret refreshed[^"]*|postgres connecting with|redis authenticating with|agent request[^"]*|credential sources[^"]*|LOG_REVEAL_SECRETS[^"]*)"/;
  router.get('/api/logs', async (ctx) =>
    ctx.query.get('only') === 'credentials'
      ? { lines: logger.recent(2000).filter((l) => CREDENTIAL_LINE.test(l)).slice(-150) }
      : { lines: logger.recent(150) },
  );

  router.post('/api/demo/rotate/:alias', async (ctx) => {
    try {
      return await rotator.rotate(ctx.params.alias);
    } finally {
      describeCache.delete(config.secretIds[ctx.params.alias]);
    }
  });

  router.post('/api/demo/drop-connections', async () => rotator.dropConnections());

  router.post('/api/demo/leak-test', async () => {
    const secret = await provider.get(config.secretIds.db);
    const raw = secret.reveal(); // deliberately misused below
    const attempts = [];

    attempts.push({ attempt: 'JSON.stringify({ dbSecret })', output: JSON.stringify({ dbSecret: secret }) });
    attempts.push({ attempt: 'console.log(dbSecret)  // util.inspect', output: inspect(secret) });
    attempts.push({ attempt: '`password is ${dbSecret}`', output: `password is ${secret}` });

    const err = new Error(`connect ECONNREFUSED postgres://${raw.username}:${raw.password}@${config.db.host ?? raw.host}:5432/notes`);
    attempts.push({
      attempt: 'logger.error({ err })  // error message contains a connection string with the raw password',
      output: log.error({ err }, 'simulated: library error containing a connection string'),
    });
    attempts.push({
      attempt: 'logger.warn({ dbPassword: raw.password })',
      output: log.warn({ user: raw.username, dbPassword: raw.password }, 'simulated: developer logs the credential'),
    });
    attempts.push({
      attempt: 'logger.info(`... ${raw.password}`)  // password pasted into the message text',
      output: log.info(`simulated: password inlined into a message: ${raw.password}`),
    });

    // Computed on the raw outputs, before the response itself is scrubbed.
    const leaked = attempts.filter((a) => typeof a.output === 'string' && a.output.includes(raw.password)).length;
    events.record('demo', 'leak-test', `Ran ${attempts.length} leak attempts; ${leaked} exposed the password`);
    return { leaked, attempts };
  });
}
