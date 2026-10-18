// Non-secret configuration only.
//
// Everything here is safe to see in `ps`, systemd units, CloudFormation outputs
// or a support ticket: secret IDs, hostnames, ports, feature flags.
// Credentials themselves are fetched at runtime from AWS Secrets Manager.

import { resolveSecretIds } from './secrets/naming.js';

const env = process.env;
// Secret IDs: explicit (DB_SECRET_ID…) or built from the naming convention
// (SECRETS_ENV + pattern + resource), from env vars or APP_CONFIG_FILE.
const naming = resolveSecretIds(env);

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
// Non-numeric values fall back to the default: in Kubernetes a Service named
// "redis" injects REDIS_PORT=tcp://10.96.x.x:6379 unless enableServiceLinks is off.
const num = (v, d) => {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? d : n;
};

// Where the app runs, for labels and advice only (never for security decisions).
// APP_PLATFORM overrides; the openshift overlay sets it.
function detectPlatform() {
  if (env.APP_PLATFORM) return env.APP_PLATFORM;
  if (env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
  if (env.AWS_MOCK_ENDPOINT) return 'compose';
  return 'ec2';
}

export const config = Object.freeze({
  nodeEnv: env.NODE_ENV ?? 'development',
  platform: detectPlatform(),
  port: num(env.PORT, 3000),
  // On EC2 the app listens on loopback only; you reach it through an SSM port
  // forward or a reverse proxy. Docker needs 0.0.0.0 inside the container.
  host: env.HOST ?? '127.0.0.1',

  region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1',

  // Which secrets manager: 'aws' (default) | 'openbao' | 'vault' (secrets/index.js).
  secretsProvider: (env.SECRETS_PROVIDER ?? 'aws').toLowerCase(),
  // For log lines and the dashboard's event messages.
  product: { aws: 'Secrets Manager', openbao: 'OpenBao', vault: 'Vault' }[(env.SECRETS_PROVIDER ?? 'aws').toLowerCase()] ?? 'the secrets manager',

  // How the app reads it.
  //   aws:           'sdk'   -> AWS SDK v3 GetSecretValue + in-process cache (default)
  //                  'agent' -> AWS Workload Credentials Provider on http://localhost:2773 (SSRF token)
  //   openbao/vault: 'api'   -> the HTTP API (KV v2), AppRole login, token renewal (default)
  //                  'file'  -> files in SECRETS_DIR, a Secret that External Secrets Operator
  //                             keeps in sync (step v3); the app has no OpenBao identity
  secretsDir: env.SECRETS_DIR ?? '/var/run/secrets/secure-notes',
  secretsMode: env.SECRETS_MODE ?? ((env.SECRETS_PROVIDER ?? 'aws').toLowerCase() === 'aws' ? 'sdk' : 'api'),

  // OpenBao / Vault: an address, a role and a FILE for the secret ID. No token
  // and no secret ID in the environment (assertSafeEnvironment refuses them).
  bao: Object.freeze({
    addr: env.BAO_ADDR ?? env.VAULT_ADDR,
    roleId: env.BAO_ROLE_ID,
    secretIdFile: env.BAO_SECRET_ID_FILE,
    // How the app logs in: 'approle' (secret ID from a file) or 'kubernetes'
    // (the pod's projected service-account token, step v3).
    auth: (env.BAO_AUTH ?? 'approle').toLowerCase(),
    authMount: env.BAO_AUTH_MOUNT || undefined, // default: the method's name
    k8sRole: env.BAO_K8S_ROLE,
    k8sTokenFile: env.BAO_K8S_TOKEN_FILE ?? '/var/run/secrets/openbao/token',
    kvMount: env.BAO_KV_MOUNT ?? 'secret',
    // Step v2: a secret ID under <dbMount>/creds/ is a dynamic database user with a lease.
    dbMount: env.BAO_DB_MOUNT ?? 'database',
    namespace: env.BAO_NAMESPACE || undefined,
  }),

  // ONLY for local development against the bundled mock. Never set on EC2.
  awsEndpoint: env.AWS_MOCK_ENDPOINT || undefined,

  agent: Object.freeze({
    url: env.AWCP_URL ?? 'http://localhost:2773',
    tokenFile: env.AWCP_TOKEN_FILE ?? '/var/run/awssmatoken',
  }),

  cache: Object.freeze({
    ttlSeconds: num(env.SECRET_CACHE_TTL_SECONDS, 300),
    // If Secrets Manager is briefly unreachable, keep serving the last good
    // value for this long instead of failing every request.
    maxStaleSeconds: num(env.SECRET_MAX_STALE_SECONDS, 3600),
  }),

  secretIds: Object.freeze({
    db: naming.ids.db,
    redis: naming.ids.redis,
  }),

  // How the IDs were found, for the startup log and /api/config (names, never values).
  secretNaming: Object.freeze({
    environment: naming.env,
    pattern: naming.pattern,
    sources: Object.freeze({ ...naming.sources }),
    configFile: env.APP_CONFIG_FILE,
    warnings: Object.freeze([...naming.warnings]),
    error: naming.error,
  }),

  db: Object.freeze({
    host: env.DB_HOST,
    port: num(env.DB_PORT, 5432),
    name: env.DB_NAME ?? 'notes',
    ssl: bool(env.DB_SSL),
    sslCaFile: env.DB_SSL_CA_FILE,
    // Create the notes table on startup (used on AWS; locally the seed job does it).
    autoMigrate: bool(env.DB_AUTO_MIGRATE),
  }),

  redis: Object.freeze({
    host: env.REDIS_HOST,
    port: num(env.REDIS_PORT, 6379),
    tls: bool(env.REDIS_TLS),
  }),

  logging: Object.freeze({
    level: env.LOG_LEVEL ?? 'info',
    // Lab troubleshooting only: debug credential lines also print the real
    // values. Refused in production (assertSafeEnvironment).
    revealSecrets: bool(env.LOG_REVEAL_SECRETS),
    // json (default) | pretty (one readable line per record; development only).
    format: env.LOG_FORMAT ?? 'json',
    // Optional: also ship each (redacted) record to an OpenTelemetry Collector,
    // e.g. http://otel-collector:4318. stdout stays the primary log.
    otlpEndpoint: env.LOG_OTLP_ENDPOINT || undefined,
    // Optional: also append each (redacted) record to this file, for a log agent
    // (the CloudWatch agent on EC2). stdout stays the primary log.
    file: env.LOG_FILE || undefined,
  }),

  // Demo-only features (rotation lab, leak test, log tail). Off by default and
  // refused in production; see assertSafeEnvironment().
  demo: Object.freeze({
    enabled: bool(env.DEMO_MODE),
    dbAdminSecretId: naming.ids.dbAdmin,
    redisAdminSecretId: naming.ids.redisAdmin,
  }),
});

// Environment variable names that must never carry credentials into this
// process. If any is set, we refuse to start: it means someone "fixed" a
// problem by pasting a password into the environment.
const FORBIDDEN_ENV = [
  'DB_PASSWORD', 'PGPASSWORD', 'DATABASE_URL', 'POSTGRES_PASSWORD',
  'REDIS_PASSWORD', 'REDIS_URL', 'REDISCLI_AUTH',
  // OpenBao / Vault credentials: a token or a secret ID in env is the same leak
  // as a password in env. The secret ID comes from BAO_SECRET_ID_FILE.
  'BAO_TOKEN', 'VAULT_TOKEN', 'BAO_SECRET_ID', 'VAULT_SECRET_ID',
];

export function assertSafeEnvironment() {
  const problems = [];

  for (const name of FORBIDDEN_ENV) {
    if (env[name]) problems.push(`${name} is set; credentials must come from the secrets manager, not the environment`);
  }

  if (config.secretNaming.error) problems.push(config.secretNaming.error);
  else {
    const how = 'set DB_SECRET_ID/REDIS_SECRET_ID, or SECRETS_ENV for the naming convention (docs/reference/secret-naming.md)';
    if (!config.secretIds.db) problems.push(`no database secret: ${how}`);
    if (!config.secretIds.redis) problems.push(`no Redis secret: ${how}`);
  }
  if (!['aws', 'openbao', 'vault'].includes(config.secretsProvider)) {
    problems.push(`SECRETS_PROVIDER must be 'aws', 'openbao' or 'vault'`);
  } else if (config.secretsProvider === 'aws') {
    if (!['sdk', 'agent'].includes(config.secretsMode)) problems.push(`SECRETS_MODE must be 'sdk' or 'agent' with SECRETS_PROVIDER=aws`);
  } else {
    if (!['api', 'file'].includes(config.secretsMode)) problems.push(`SECRETS_MODE must be 'api' or 'file' with SECRETS_PROVIDER=${config.secretsProvider}`);
    if (config.secretsMode === 'file') {
      if (!config.secretsDir) problems.push('SECRETS_DIR is required with SECRETS_MODE=file');
    } else if (!config.bao.addr) {
      problems.push('BAO_ADDR is required (the OpenBao or Vault address)');
    } else if (config.bao.auth === 'kubernetes') {
      if (!config.bao.k8sRole) problems.push('BAO_K8S_ROLE is required with BAO_AUTH=kubernetes (the OpenBao role bound to this service account)');
    } else if (config.bao.auth === 'approle') {
      if (!config.bao.roleId) problems.push('BAO_ROLE_ID is required (the AppRole role ID; it is not a secret)');
      if (!config.bao.secretIdFile) problems.push('BAO_SECRET_ID_FILE is required (the AppRole secret ID is read from a file, never from env)');
    } else {
      problems.push(`BAO_AUTH must be 'approle' or 'kubernetes'`);
    }
  }
  if (!['json', 'pretty'].includes(config.logging.format)) problems.push(`LOG_FORMAT must be 'json' or 'pretty'`);

  if (config.nodeEnv === 'production') {
    // Long-term access keys on an EC2 host defeat the purpose of the instance role.
    if (env.AWS_ACCESS_KEY_ID && !env.AWS_SESSION_TOKEN) {
      problems.push('static AWS_ACCESS_KEY_ID found in production; use the EC2 instance role instead');
    }
    if (config.awsEndpoint) problems.push('AWS_MOCK_ENDPOINT must not be set in production');
    if (config.secretsProvider !== 'aws' && config.secretsMode !== 'file' && config.bao.addr && !config.bao.addr.startsWith('https://')) {
      problems.push('BAO_ADDR must be https:// in production: the token and every secret travel on this connection');
    }
    if (config.demo.enabled) problems.push('DEMO_MODE must not be enabled in production');
    if (config.logging.revealSecrets) problems.push('LOG_REVEAL_SECRETS must not be enabled in production: it writes secret values to the log');
    if (config.logging.format !== 'json') problems.push('LOG_FORMAT must be json in production: log stores and alert rules read JSON');
  }

  if (problems.length) {
    const err = new Error(`Refusing to start:\n  - ${problems.join('\n  - ')}`);
    err.code = 'UNSAFE_CONFIG';
    throw err;
  }
}
