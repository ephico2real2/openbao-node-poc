// Runtime security posture checks, shown on the dashboard. Each returns
// pass | warn | fail | info | skip with a plain-language explanation.

import { access, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const SUSPICIOUS_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY|CREDENTIAL)/i;
// Names that look sensitive but only hold identifiers, paths or settings.
// The naming-convention parts (DB_SECRET_RESOURCE, SECRETS_NAME_PATTERN, SECRETS_ENV…) are names too.
const BENIGN_NAME = /(_ID|_ARN|_FILE|_PATH|_SECONDS|_TTL|_MODE|_NAME|_RESOURCE|_SERVICE|_PATTERN|_ENV|_ENVS|_APP|_PROVIDER)$/i;
// A switch is not a credential: LOG_REVEAL_SECRETS=false names a secret but holds none.
const SWITCH_VALUE = /^(true|false|yes|no|on|off|0|1)$/i;

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function probeImds() {
  // An IMDSv1-style request (no session token). With IMDSv2 required, EC2 answers 401.
  try {
    const res = await fetch('http://169.254.169.254/latest/meta-data/', { signal: AbortSignal.timeout(800) });
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
}

export async function runSecurityChecks({ config, redactor, provider, logSinks = {}, baoClient }) {
  const out = [];
  const add = (id, title, status, detail) => out.push({ id, title, status, detail });
  const bao = config.secretsProvider !== 'aws';
  const product = config.secretsProvider === 'vault' ? 'Vault' : 'OpenBao';
  // A lab: the local AWS stand-in, or OpenBao/Vault outside production.
  const mock = Boolean(config.awsEndpoint) || (bao && config.nodeEnv !== 'production');
  const env = process.env;

  // 1. Long-term keys
  if (bao && !env.AWS_ACCESS_KEY_ID) {
    add('static-keys', 'No long-term AWS keys on the host', 'pass', `No AWS keys: secrets come from ${product}.`);
  } else if (env.AWS_ACCESS_KEY_ID) {
    if (mock) add('static-keys', 'No long-term AWS keys on the host', 'info', 'Dummy keys are set for the local mock only. On EC2 nothing is set and the SDK uses the instance role.');
    else if (env.AWS_SESSION_TOKEN) add('static-keys', 'No long-term AWS keys on the host', 'warn', 'Temporary credentials are in environment variables. Prefer letting the SDK fetch them from instance metadata.');
    else add('static-keys', 'No long-term AWS keys on the host', 'fail', 'AWS_ACCESS_KEY_ID is set with no session token: long-term keys. Remove them and attach an instance role.');
  } else {
    add('static-keys', 'No long-term AWS keys on the host', 'pass', 'No keys in the environment. The SDK resolves short-lived role credentials from IMDSv2.');
  }

  // 2. Shared credentials file
  // On OpenShift the process runs as an arbitrary UID with no passwd entry, where os.homedir() can throw.
  let home = env.HOME;
  try {
    home ??= homedir();
  } catch {
    home = '/';
  }
  const credFile = env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, '.aws', 'credentials');
  if (await exists(credFile)) {
    add('creds-file', 'No AWS credentials file', mock ? 'info' : 'fail', `${credFile} exists. On EC2 there should be no credentials file; the role is enough.`);
  } else {
    add('creds-file', 'No AWS credentials file', 'pass', 'No ~/.aws/credentials file for this user.');
  }

  // 3. Secrets in environment variables
  const flagged = Object.entries(env)
    .filter(([k, v]) => v && !k.startsWith('AWS_') && (redactor.contains(v) || (SUSPICIOUS_NAME.test(k) && !BENIGN_NAME.test(k) && !SWITCH_VALUE.test(v))))
    .map(([k]) => k);
  if (flagged.length) {
    add('env-secrets', 'No credentials in environment variables', 'fail', `Suspicious variables: ${flagged.join(', ')}. Env vars leak through /proc/<pid>/environ, child processes and crash reports.`);
  } else {
    add('env-secrets', 'No credentials in environment variables', 'pass', 'No loaded secret value or credential-like variable found in the environment.');
  }

  // 4. IMDSv2
  const imds = await probeImds();
  if (imds === 401) add('imdsv2', 'IMDSv2 required', 'pass', 'Instance metadata rejected a token-less (IMDSv1) request, which blocks the classic SSRF credential theft.');
  else if (imds && imds < 400) add('imdsv2', 'IMDSv2 required', 'fail', 'IMDSv1 answered without a token. Set HttpTokens=required (and hop limit 1) on the instance.');
  else add('imdsv2', 'IMDSv2 required', 'skip', 'No instance metadata service reachable; not running on EC2 (or a container blocked by hop limit 1, which is good).');

  // 5. Identity in use
  if (bao && config.secretsMode === 'file') {
    // The app holds no identity in the secrets manager: External Secrets
    // Operator reads it and writes a Secret that Kubernetes mounts as files.
    add('identity', `No ${product} identity in the app`, 'pass', `SECRETS_MODE=file: the app reads ${config.secretsDir}. External Secrets Operator logs in to ${product} with its own service account and keeps the mounted Secret in sync.`);
    try {
      const names = (await readdir(config.secretsDir)).filter((f) => !f.startsWith('..'));
      const modes = await Promise.all(names.map(async (f) => (await stat(join(config.secretsDir, f))).mode & 0o777));
      const loose = modes.some((m) => (m & 0o007) !== 0);
      add('secret-files', 'Mounted credential files protected', loose ? 'fail' : 'pass',
        `${names.length} file(s) in ${config.secretsDir}, mode ${[...new Set(modes.map((m) => m.toString(8)))].join('/')}${loose ? ': readable by any user in the container' : ': owner and group only'}. Mounted as a volume (not env, not subPath), so updates arrive in place.`);
    } catch {
      add('secret-files', 'Mounted credential files protected', 'fail', `Cannot read ${config.secretsDir}.`);
    }
  } else if (bao) {
    const st = baoClient?.status();
    if (st?.loggedIn) {
      add('identity', `Logged in to ${product} with its own identity`, 'pass', `${config.bao.auth === 'kubernetes' ? 'Kubernetes' : 'AppRole'} role "${st.roleId}", policies ${st.policies.join(', ')}; token valid ${st.tokenTtlSeconds} s, renewed ${st.renewals} time(s), ${st.logins} login(s).`);
    } else {
      add('identity', `Logged in to ${product} with its own identity`, 'fail', `Not logged in${st?.lastError ? `: ${st.lastError}` : ''}.`);
    }
    const leased = provider.status().filter((s) => s.lease);
    if (leased.length) {
      add('short-lived', 'Database logins are short-lived', 'pass',
        `${leased.length} login(s) are users ${product} created for this instance, each with a lease (${leased.map((s) => `${s.lease.ttlSeconds}s left, renewed ${s.lease.renewals}×`).join('; ')}). When a lease ends, ${product} drops the user.`);
    } else {
      add('short-lived', 'Database logins are short-lived', 'info', `Stored passwords from ${product}'s KV store, rotated by the demo. Step v2 replaces them with users that expire.`);
    }
    if (config.bao.auth === 'kubernetes') {
      // The projected token: short-lived and bound to OpenBao's audience. Only
      // its claims are read here (expiry, audience), never logged or shown.
      try {
        const jwt = (await readFile(config.bao.k8sTokenFile, 'utf8')).trim();
        const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
        const life = Math.round((claims.exp - claims.iat) / 60);
        const aud = [].concat(claims.aud ?? []);
        const good = life <= 120 && !aud.some((a) => /kubernetes\.default/.test(a));
        add('sa-token', 'Login token is short-lived and audience-bound', good ? 'pass' : 'warn',
          `Projected service-account token: valid ${life} min, audience ${aud.join(', ') || 'none'}; the kubelet rotates it. No secret was handed to the pod.`);
      } catch {
        add('sa-token', 'Login token is short-lived and audience-bound', 'fail', `Cannot read the projected token at ${config.bao.k8sTokenFile}.`);
      }
    } else {
      try {
        const sid = await stat(config.bao.secretIdFile);
        const loose = (sid.mode & 0o077) !== 0;
        add('secret-id-file', 'AppRole secret ID file protected', loose ? 'fail' : 'pass',
          loose ? `${config.bao.secretIdFile} is readable by others (mode ${(sid.mode & 0o777).toString(8)}).` : `${config.bao.secretIdFile} is mode ${(sid.mode & 0o777).toString(8)}: only its owner can read it. It is not in the environment.`);
      } catch {
        add('secret-id-file', 'AppRole secret ID file protected', 'fail', `Cannot read ${config.bao.secretIdFile}.`);
      }
    }
  } else try {
    const sts = new STSClient({ region: config.region, endpoint: config.awsEndpoint, maxAttempts: 1 });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    if (/:assumed-role\//.test(id.Arn)) add('identity', 'Running as an IAM role', 'pass', `Caller: ${id.Arn}`);
    else add('identity', 'Running as an IAM role', mock ? 'info' : 'warn', `Caller: ${id.Arn}. ${mock ? 'Expected with the local mock.' : 'This is an IAM user (long-term keys).'}`);
  } catch (err) {
    add('identity', 'Running as an IAM role', 'skip', `Could not call STS: ${err.name}`);
  }

  // 6. Not root
  if (typeof process.getuid === 'function') {
    const root = process.getuid() === 0;
    add('non-root', 'Process is not root', root ? 'warn' : 'pass', root ? 'Running as root. Use a dedicated service user (see infra/systemd).' : `Running as uid ${process.getuid()}.`);
  }

  // 7. No debugger
  const debug = process.execArgv.some((a) => a.startsWith('--inspect')) || (env.NODE_OPTIONS ?? '').includes('--inspect');
  add('no-inspector', 'Node inspector disabled', debug ? 'fail' : 'pass', debug ? 'An --inspect flag is active: anyone who can reach that port can read process memory, including secrets.' : 'No --inspect flag. The debugger is a direct path to in-memory secrets.');

  // 8. Core dumps
  try {
    const limits = await readFile('/proc/self/limits', 'utf8');
    const soft = limits.split('\n').find((l) => l.startsWith('Max core file size'))?.split(/\s{2,}/)[1];
    const advice = env.KUBERNETES_SERVICE_HOST
      ? 'Kubernetes has no per-pod setting for this: set it in the container runtime\'s default ulimits on the nodes.'
      : 'Set LimitCORE=0 (systemd) or ulimits core=0 (Docker).';
    add('core-dumps', 'Core dumps disabled', soft === '0' ? 'pass' : 'warn', soft === '0' ? 'Core file size limit is 0.' : `Core file limit is "${soft}". A crash dump would contain decrypted secrets. ${advice}`);
  } catch {
    add('core-dumps', 'Core dumps disabled', 'skip', 'Not on Linux.');
  }

  // 9. Transport to the secrets manager
  if (bao && config.secretsMode === 'file') {
    add('sm-transport', 'Secret retrieval channel', 'info', `A file the kubelet mounts. External Secrets Operator talks to ${product} (${config.bao.addr ?? 'its ClusterSecretStore'}); the app never does.`);
  } else if (bao) {
    const tls = String(config.bao.addr).startsWith('https://');
    add('sm-transport', 'Secret retrieval channel', tls ? 'pass' : 'info',
      tls ? `${product} over HTTPS (${config.bao.addr}).` : `Plain HTTP to ${product} on the lab network (${config.bao.addr}). Production requires https:// (the app refuses anything else).`);
  } else if (provider.mode === 'agent') {
    add('sm-transport', 'Secret retrieval channel', 'pass', 'Workload Credentials Provider on loopback, authenticated with its SSRF token. It reaches Secrets Manager over TLS.');
    try {
      const st = await stat(config.agent.tokenFile);
      const worldReadable = (st.mode & 0o004) !== 0;
      add('agent-token', 'Agent SSRF token protected', worldReadable ? 'fail' : 'pass', worldReadable ? `${config.agent.tokenFile} is world-readable.` : `${config.agent.tokenFile} is readable only by its owner and group.`);
    } catch {
      add('agent-token', 'Agent SSRF token protected', 'fail', `Cannot read ${config.agent.tokenFile}.`);
    }
  } else if (mock) {
    add('sm-transport', 'Secret retrieval channel', 'info', `Local mock over plain HTTP (${config.awsEndpoint}). In AWS this is HTTPS to the regional or VPC endpoint.`);
  } else {
    add('sm-transport', 'Secret retrieval channel', 'pass', 'AWS SDK over HTTPS (through the VPC interface endpoint when private DNS is enabled).');
  }

  // 10/11. Data-plane TLS
  add('db-tls', 'TLS to Postgres', config.db.ssl ? 'pass' : mock ? 'info' : 'warn', config.db.ssl ? 'Encrypted and the server certificate is verified.' : 'Plaintext connection. Enable DB_SSL with the RDS CA bundle in AWS.');
  add('redis-tls', 'TLS to Redis', config.redis.tls ? 'pass' : mock ? 'info' : 'warn', config.redis.tls ? 'ElastiCache in-transit encryption is on.' : 'Plaintext connection. Enable REDIS_TLS with ElastiCache in-transit encryption.');

  // 12. Redaction
  if (config.logging?.revealSecrets) {
    add('reveal-flag', 'Secret values kept out of logs', 'fail', `LOG_REVEAL_SECRETS=true: ${config.logging.level === 'debug' ? 'debug lines print the real credential values' : 'set, but inert until LOG_LEVEL=debug'}. Lab use only; the app refuses this in production.`);
  } else {
    add('reveal-flag', 'Secret values kept out of logs', 'pass', `Debug logs (LOG_LEVEL=${config.logging?.level ?? 'info'}) show key names and masked values only.`);
  }
  add('redaction', 'Log and response redaction active', redactor.size > 0 ? 'pass' : 'warn', `${redactor.size} secret value encodings registered; every log line and API response is scrubbed.`);

  // Log delivery: alarms are raised from shipped logs, so a sink that can't
  // write means alerts that can't fire. Shown only when a sink is configured.
  const { otlp, file } = logSinks;
  if (otlp || file) {
    const problems = [];
    if (file?.errors) problems.push(`${file.errors} write error(s) on ${file.path} (${file.lastError})`);
    if (otlp?.dropped || otlp?.lastError) problems.push(`OTLP: ${otlp.dropped} dropped${otlp.lastError ? `, last error ${otlp.lastError}` : ''}`);
    const where = [file && `file ${file.path}`, otlp && `OTLP ${otlp.endpoint}`].filter(Boolean).join(' and ');
    add('log-delivery', 'Logs reach the alerting pipeline', problems.length ? 'warn' : 'pass', problems.length ? `${problems.join('; ')}. Alerts raised from logs may not fire.` : `Every line goes to ${where}, after redaction.`);
  }

  return out;
}
