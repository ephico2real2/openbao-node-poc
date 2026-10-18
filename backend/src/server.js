import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config, assertSafeEnvironment } from './config.js';
import { createLogger } from './log.js';
import { createEventLog } from './events.js';
import { Redactor, createSecretsProvider, createSecretsStore, createBaoClientFromConfig, createLeaseKeeperFromConfig } from './secrets/index.js';
import { createDb } from './clients/db.js';
import { createCache } from './clients/cache.js';
import { createHttpServer, createRouter } from './http.js';
import { registerRoutes } from './routes.js';
import { NOTES_SCHEMA } from './schema.js';
import { createOtlpShipper } from './logship/otlp.js';
import { createFileSink } from './logship/file.js';

const version = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return undefined;
  }
})();

// Optional copy of every (redacted) record to an OpenTelemetry Collector.
const shipper = config.logging.otlpEndpoint
  ? createOtlpShipper({
      endpoint: config.logging.otlpEndpoint,
      resource: {
        'service.name': 'secure-notes',
        'service.version': version,
        'deployment.environment.name': config.secretNaming.environment ?? config.nodeEnv,
      },
    })
  : undefined;

const redactor = new Redactor();
const fileSink = config.logging.file ? createFileSink(config.logging.file) : undefined;
const logger = createLogger({
  redactor,
  ringSize: 2000,
  level: config.logging.level,
  revealSecrets: config.logging.revealSecrets && config.nodeEnv !== 'production',
  base: { app: 'secure-notes' },
  format: config.logging.format === 'pretty' ? 'pretty' : 'json',
  sinks: [shipper, fileSink].filter(Boolean),
});

// Exit after giving the log shipper a moment, so the line that explains the
// exit reaches the log store (and can raise its alert).
async function exitAfterLogs(code) {
  await logger.drain(2000);
  process.exit(code);
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception; exiting');
  void exitAfterLogs(1);
});

try {
  assertSafeEnvironment();
} catch (err) {
  logger.error({ event: 'config.unsafe', fatal: true }, err.message);
  await exitAfterLogs(78); // EX_CONFIG: systemd will not hot-loop on a config error with RestartPreventExitStatus=78
}

logger.debug(
  {
    secretsProvider: config.secretsProvider,
    secretsMode: config.secretsMode,
    secretIds: config.secretIds,
    secretIdSources: config.secretNaming.sources,
    namingPattern: config.secretNaming.pattern,
    endpoint: config.secretsProvider !== 'aws'
      ? config.bao.addr
      : (config.awsEndpoint ?? (config.secretsMode === 'agent' ? config.agent.url : `secretsmanager.${config.region} (SDK default)`)),
    logLevel: config.logging.level,
  },
  'credential sources: which secrets this process will consume',
);
logger.info(
  { secretIds: config.secretIds, sources: config.secretNaming.sources, environment: config.secretNaming.environment, pattern: config.secretNaming.pattern },
  'secret IDs resolved',
);
for (const w of config.secretNaming.warnings) logger.warn({}, `secret naming: ${w}`);
if (config.logging.revealSecrets) {
  // The alert event only when the flag has an effect (LOG_LEVEL=debug).
  logger.warn(
    { logLevel: config.logging.level, ...(config.logging.level === 'debug' ? { event: 'secrets.reveal.enabled' } : {}) },
    config.logging.level === 'debug'
      ? 'LOG_REVEAL_SECRETS=true: secret values will be written to this log. Lab use only; never in production.'
      : 'LOG_REVEAL_SECRETS=true has no effect unless LOG_LEVEL=debug',
  );
}

const events = createEventLog();
const baoClient = createBaoClientFromConfig({ config, redactor, logger });
const leases = createLeaseKeeperFromConfig({ baoClient, logger, config });
const provider = createSecretsProvider({ config, redactor, logger, baoClient, leases });
provider.on('loaded', ({ secretId, reason, changed, versionId }) => {
  const alias = Object.entries(config.secretIds).find(([, id]) => id === secretId)?.[0] ?? secretId;
  const dynamic = provider.status().find((s) => s.secretId === secretId)?.lease;
  if (dynamic) {
    events.record(
      'secrets',
      changed ? 'new-lease' : 'leased',
      changed
        ? `${config.product} issued a new ${alias} user, lease ${versionId.slice(0, 8)} (${reason}); the old user is retired`
        : `${config.product} issued this instance its own ${alias} user, lease ${versionId.slice(0, 8)} (${reason})`,
    );
    return;
  }
  events.record(
    'secrets',
    changed ? 'new-version' : 'loaded',
    changed
      ? `Picked up new version ${versionId.slice(0, 8)} of the ${alias} secret (${reason})`
      : `Loaded the ${alias} secret, version ${versionId.slice(0, 8)} (${reason})`,
  );
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fail fast if we cannot read our secrets, but tolerate a few seconds of
// startup ordering (e.g. the network or a local mock coming up).
async function warmUp() {
  for (let attempt = 1; ; attempt++) {
    try {
      await Promise.all([provider.get(config.secretIds.db), provider.get(config.secretIds.redis)]);
      provider.startupDone();
      return;
    } catch (err) {
      if (attempt >= 8) throw err;
      logger.warn({ attempt, err }, 'could not load secrets yet; retrying'); // no event: only the give-up below alerts
      await sleep(Math.min(500 * 2 ** attempt, 8_000));
    }
  }
}

try {
  await warmUp();
} catch (err) {
  logger.error({ err, event: 'secrets.load.fatal', fatal: true }, 'unable to load secrets from Secrets Manager; exiting');
  await exitAfterLogs(1);
}

const db = createDb({ provider, secretId: config.secretIds.db, config, logger, events });
const cache = await createCache({ provider, secretId: config.secretIds.redis, config, logger, events });
await db.ping();
if (config.db.autoMigrate) {
  // Check first: a least-privilege login may read the table but not CREATE in the schema.
  const { rows } = await db.query(`SELECT to_regclass('public.notes') IS NOT NULL AS present`);
  if (!rows[0].present) await db.query(NOTES_SCHEMA);
  logger.info('database schema ensured');
}

const rotator = config.demo.enabled
  ? (await import('./demo/rotator.js')).createRotator({ config, redactor, logger, events, provider, leases, store: await createSecretsStore({ config, baoClient }) })
  : undefined;

const router = createRouter();
registerRoutes(router, { config, provider, db, cache, events, logger, redactor, rotator, shipper, fileSink, baoClient });

const here = path.dirname(fileURLToPath(import.meta.url));
const server = createHttpServer({
  router,
  staticDir: process.env.STATIC_DIR ?? path.resolve(here, '../../frontend'),
  logger,
  redactor,
  isProduction: config.nodeEnv === 'production',
});

server.listen(config.port, config.host, () => {
  logger.info(
    { host: config.host, port: config.port, secretsProvider: config.secretsProvider, secretsMode: config.secretsMode, demoMode: config.demo.enabled },
    'secure-notes listening',
  );
});

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close();
  await Promise.allSettled([db.close(), cache.close()]);
  // Dynamic users: revoke our leases, so this instance's database users are dropped now.
  await leases?.revokeAll().catch(() => {});
  baoClient?.close();
  await exitAfterLogs(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
