// The event catalogue: every event name the app logs on purpose, and which of
// them should raise an alert. A unit test fails if the code logs an event name
// that isn't listed here, or never logs one that is.
// (In aws-secrets-manager-node-poc this list also generates the alert rules and
// the AWS alarms; here the alert path from OpenBao's audit log is epic B7.)
//
// Field names avoid "secret" and "token": the log redactor blanks those keys.

/**
 * @typedef {object} Alert
 * @property {'critical'|'warning'|'info'} severity
 * @property {string} title       one line, used as the email subject (< 100 chars with the prefix)
 * @property {string} source      where it is logged
 * @property {{count: number, window: string}} when  fire when at least `count` lines in `window`
 * @property {string} repeat      locally, Alertmanager re-notifies a still-firing alert at most this often
 *                                (on AWS a CloudWatch alarm notifies once per state change)
 * @property {string} action      what on-call should do first
 */

/**
 * Events that should raise an alert, once a rule on the log store watches them
 * (epic B7). Severity: critical pages; warning goes to chat.
 */
export const ALERTS = Object.freeze({
  'config.unsafe': {
    severity: 'critical',
    title: 'App refused to start: unsafe configuration',
    source: 'server.js (exit 78)',
    when: { count: 1, window: '5m' },
    repeat: '4h',
    action: 'Read the log line: it lists each problem (a credential in the environment, a missing secret name, a lab flag in production). Fix the unit or ConfigMap and restart.',
  },
  'secrets.load.fatal': {
    severity: 'critical',
    title: 'App could not load its credentials and exited',
    source: 'server.js (exit 1)',
    when: { count: 1, window: '5m' },
    repeat: '1h',
    action: 'Check the role can reach Secrets Manager (VPC endpoint, IAM, KMS) and that the secret names resolve. The app is down until it can read them.',
  },
  'secrets.fetch.failed': {
    severity: 'critical',
    title: 'A credential could not be read from Secrets Manager',
    source: 'secrets/provider.js',
    when: { count: 1, window: '5m' },
    repeat: '1h',
    action: 'Check IAM, the VPC endpoint, KMS and the secret name in the log line. If the line says cached=true (a forced refresh failed), the app keeps serving the value it holds until that is SECRET_MAX_STALE_SECONDS old; with cached=false, requests that need this credential are failing now.',
  },
  'secrets.fetch.stale': {
    severity: 'warning',
    title: 'Serving a cached credential: Secrets Manager unreachable',
    source: 'secrets/provider.js',
    when: { count: 3, window: '10m' },
    repeat: '1h',
    action: 'The app keeps working on the last good value for up to SECRET_MAX_STALE_SECONDS. Find out why refreshes fail before that runs out.',
  },
  'agent.forbidden': {
    severity: 'critical',
    title: 'The local credentials agent refused the app',
    source: 'secrets/provider.js (agent mode)',
    when: { count: 1, window: '5m' },
    repeat: '1h',
    action: 'The agent answered 403: the app is not sending its SSRF token, or the token file is unreadable. Check the token file and group membership. Logged at once, even while a cached value is still served.',
  },
  'db.auth.rejected': {
    severity: 'warning',
    title: 'Postgres rejected the cached password',
    source: 'clients/db.js',
    when: { count: 3, window: '5m' },
    repeat: '30m',
    action: 'Usually a rotation the app recovers from by itself (look for db.auth.recovered). Repeated rejections mean the secret and the database disagree.',
  },
  'cache.auth.rejected': {
    severity: 'warning',
    title: 'Redis rejected the cached password',
    source: 'clients/cache.js',
    when: { count: 3, window: '5m' },
    repeat: '30m',
    action: 'Usually a rotation the app recovers from by itself (look for cache.auth.recovered). Repeated rejections mean the secret and the Redis user disagree.',
  },
  'cache.refresh.failed': {
    severity: 'critical',
    title: 'Redis credential refresh failed',
    source: 'clients/cache.js',
    when: { count: 1, window: '5m' },
    repeat: '1h',
    action: 'Redis rejected the password and the app could not read a new one. Check Secrets Manager access and the rotation function.',
  },
  'secrets.reveal.enabled': {
    severity: 'warning',
    title: 'Secret values are being written to the log (lab flag on)',
    source: 'server.js',
    when: { count: 1, window: '5m' },
    repeat: '24h',
    action: 'LOG_REVEAL_SECRETS=true is for labs. Turn it off and treat the values in this log as exposed.',
  },
  'rotation.demo.failed': {
    severity: 'warning',
    title: 'A demo rotation failed',
    source: 'demo/rotator.js',
    when: { count: 1, window: '5m' },
    repeat: '10m',
    action: 'Demo only. The log line names the step that failed.',
  },
  // OpenBao / Vault (steps v1 and v2)
  'secrets.lease.reissue.failed': {
    severity: 'critical',
    title: 'App could not get a new database user before its lease ends',
    source: 'secrets/provider.js (lease keeper asked for a new user)',
    when: { count: 1, window: '5m' },
    repeat: '30m',
    action: 'When the current lease ends, OpenBao drops the user and the app loses the database. Check OpenBao is reachable and the app token can read database/creds/<role>.',
  },
  'bao.lease.renew.failed': {
    severity: 'warning',
    title: 'A database lease could not be renewed',
    source: 'secrets/bao/leases.js',
    when: { count: 3, window: '10m' },
    repeat: '1h',
    action: 'Once is normal after a revocation (the app asks for a new user). Repeated: OpenBao is unreachable or the policy lost sys/leases/renew.',
  },
  'bao.token.renew.failed': {
    severity: 'warning',
    title: 'The app could not renew its OpenBao token',
    source: 'secrets/bao/client.js',
    when: { count: 3, window: '15m' },
    repeat: '1h',
    action: 'The app logs in again with its secret ID. Repeated failures: check OpenBao is reachable and the secret ID file is still valid.',
  },
});

/**
 * Alerts that come from a log-level pattern, not from an event name.
 * `match` is a LogsQL filter (local) and a CloudWatch Logs filter pattern (AWS).
 */
export const PATTERN_ALERTS = Object.freeze({
  'app.errors.burst': {
    severity: 'warning',
    title: 'Burst of errors in the app log',
    source: 'any error line (the leak test\'s "simulated:" lines excluded)',
    when: { count: 5, window: '5m' },
    repeat: '1h',
    action: 'Look at the error lines in the log store for the same five minutes.',
    logsql: 'level:=error -_msg:~"^simulated:"',
    cloudwatch: '{ ($.level = "error") && ($.msg != "simulated:*") }',
  },
});

/** Events that are logged for the record but never alert. */
export const RECORD_EVENTS = Object.freeze({
  'db.auth.recovered': 'Postgres accepted the refreshed credential',
  'cache.auth.recovered': 'Redis accepted the refreshed credential',
  'db.pool.switched': 'New Postgres connections use a newly issued user; the old pool drains (step v2)',
  'cache.user.switched': 'The Redis connection switched to a newly issued user (step v2)',
  'rotation.demo.revoked': 'Demo: a lease was revoked from the dashboard (step v2)',
  'bao.login': 'The app logged in to OpenBao with its AppRole',
  'bao.token.max_ttl': 'The OpenBao token reached its max TTL; the app logs in again',
  'bao.lease.issued': 'OpenBao issued a database user for this instance (step v2)',
  'bao.lease.renewed': 'A database lease was renewed (step v2)',
  'bao.lease.reissue': 'A lease is near its end; the app asks for a new user (step v2)',
  'bao.lease.revoked': 'A lease was revoked: replaced, at shutdown, or by the demo (step v2)',
  'secrets.file.changed': 'The mounted Secret changed (External Secrets Operator, kubelet swap); re-reading (step v3)',
});

export const ALL_EVENTS = Object.freeze(new Set([
  ...Object.keys(ALERTS),
  ...Object.keys(RECORD_EVENTS),
]));

/** "5m" -> 300 */
export function seconds(window) {
  const m = /^(\d+)([smhd])$/.exec(window);
  if (!m) return undefined;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}
