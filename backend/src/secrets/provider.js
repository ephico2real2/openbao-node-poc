// In-memory, rotation-aware secrets cache.
//
// - Values live only in this process's memory: never on disk, never in env vars.
// - TTL with jitter, so a fleet does not refresh in lockstep.
// - Single-flight: 100 concurrent requests for a cold secret make one API call.
// - Stale-on-error: if Secrets Manager is briefly unreachable, keep serving the
//   last good value (bounded by maxStaleSeconds) instead of failing requests.
// - refresh(): consumers call this when the backend rejects the cached
//   credential (rotation happened), then retry once.
// - status(): metadata for dashboards. Never includes values; the fingerprint
//   is an HMAC under a per-process random key, so it only shows "changed or not".

import { createHmac, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { SecretValue } from './SecretValue.js';
import { describeKeys, describeUse, revealKeys } from './mask.js';

export class SecretsProvider extends EventEmitter {
  #fetcher;
  #ttlMs;
  #maxStaleMs;
  #redactor;
  #log;
  #entries = new Map();
  #inflight = new Map();
  #fingerprintKey = randomBytes(32);

  constructor({ fetcher, ttlSeconds = 300, maxStaleSeconds = 3600, redactor, logger }) {
    super();
    this.#fetcher = fetcher;
    this.#ttlMs = ttlSeconds * 1000;
    this.#maxStaleMs = maxStaleSeconds * 1000;
    this.#redactor = redactor;
    this.#log = logger.child({ component: 'secrets' });
  }

  get mode() {
    return this.#fetcher.kind;
  }

  // While the app is starting, a failed fetch is expected (the network or a
  // mock still coming up): the caller retries, and only its final give-up
  // (secrets.load.fatal) is an alert. Without this, a blip on attempt 1 would page.
  #starting = true;

  /** Called once the first load succeeded: from now on a failed fetch is an alert. */
  startupDone() {
    this.#starting = false;
  }

  /** Returns a SecretValue. Call .reveal() only where the credential is used. */
  async get(secretId) {
    const e = this.#entries.get(secretId);
    if (e && Date.now() < e.expiresAt) {
      e.hits++;
      return e.value;
    }
    return this.#load(secretId, { force: false, reason: e ? 'ttl-expired' : 'cold-start' });
  }

  /** Bypass the cache (e.g. after an authentication failure). */
  async refresh(secretId, reason = 'manual') {
    return this.#load(secretId, { force: true, reason });
  }

  #load(secretId, { force, reason }) {
    // Single-flight: join an in-progress fetch instead of starting another.
    const pending = this.#inflight.get(secretId);
    if (pending) return pending;

    const p = this.#doLoad(secretId, { force, reason }).finally(() => this.#inflight.delete(secretId));
    this.#inflight.set(secretId, p);
    return p;
  }

  async #doLoad(secretId, { force, reason }) {
    const prev = this.#entries.get(secretId);
    const started = Date.now();
    try {
      const r = await this.#fetcher.fetch(secretId, { force });
      let parsed;
      try {
        parsed = JSON.parse(r.secretString);
      } catch {
        parsed = { value: r.secretString };
      }
      // Register BEFORE anything else can log it.
      this.#redactor.registerSecretObject(parsed, r.secretString);

      const fingerprint = createHmac('sha256', this.#fingerprintKey).update(r.secretString).digest('hex').slice(0, 12);
      const jitter = 1 + (Math.random() * 0.2 - 0.1); // +/-10%
      const entry = {
        value: new SecretValue(parsed),
        name: r.name,
        arn: r.arn,
        versionId: r.versionId,
        versionStages: r.versionStages,
        createdDate: r.createdDate,
        fingerprint,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + this.#ttlMs * jitter,
        hits: prev?.hits ?? 0,
        fetches: (prev?.fetches ?? 0) + 1,
        lastReason: reason,
        lastError: undefined,
      };
      this.#entries.set(secretId, entry);

      const changed = prev && prev.versionId !== entry.versionId;
      this.#log.info(
        {
          secretId,
          versionId: entry.versionId,
          reason,
          forced: force,
          changed: Boolean(changed),
          ms: Date.now() - started,
        },
        changed ? 'secret refreshed: new version' : 'secret loaded',
      );
      this.#logConsumed(secretId, entry, parsed, { reason, prevFingerprint: changed ? prev.fingerprint : undefined });
      this.emit('loaded', { secretId, reason, changed: Boolean(changed), versionId: entry.versionId });
      return entry.value;
    } catch (err) {
      const age = prev ? Date.now() - prev.fetchedAt : Infinity;
      const servable = !force && prev && age < this.#maxStaleMs;
      if (prev) prev.lastError = `${err.name}: ${err.message}`;
      // A 403 from the agent is a broken deployment (wrong token), not a blip:
      // say so at once, even while a cached value is still being served.
      if (err?.code === 'AGENT_HTTP_403') {
        this.#log.error({ secretId, err, reason, cached: Boolean(servable), event: 'agent.forbidden' }, 'the secrets agent refused the request');
      } else if (servable) {
        this.#log.warn({ secretId, err, ageSeconds: Math.round(age / 1000), event: 'secrets.fetch.stale' }, 'secret fetch failed, serving last good value');
      } else if (this.#starting && !prev) {
        this.#log.debug({ secretId, err, reason }, 'secret fetch failed during startup (the caller retries)');
      } else {
        // cached: the app still holds a value (e.g. a forced refresh failed) and
        // keeps serving it until it is too old; without one, requests fail.
        this.#log.error({ secretId, err, reason, cached: Boolean(prev), event: 'secrets.fetch.failed' }, 'secret fetch failed');
      }
      if (servable) {
        prev.expiresAt = Date.now() + Math.min(30_000, this.#ttlMs); // retry soon
        return prev.value;
      }
      throw err;
    }
  }

  // DEBUG: which secret and which keys this process now holds, values masked.
  #logConsumed(secretId, entry, parsed, { reason, prevFingerprint }) {
    if (!this.#log.isDebug) return;
    const fields = {
      secretId,
      name: entry.name,
      versionId: entry.versionId,
      stages: entry.versionStages,
      source: this.mode, // sdk | agent
      reason,
      fingerprint: prevFingerprint ? `${prevFingerprint} -> ${entry.fingerprint}` : entry.fingerprint,
    };
    this.#log.debug({ ...fields, keys: describeKeys(parsed, this.#fingerprintKey) }, 'secret consumed');
    this.#log.revealUnsafe?.({ ...fields, keys: revealKeys(parsed, this.#fingerprintKey) }, 'secret consumed (values revealed)');
  }

  /**
   * DEBUG, for clients: which keys of the cached secret feed which connection
   * settings, values masked. mapping = { setting: secretKey }.
   */
  logUse(log, secretId, mapping, fields, msg) {
    if (!log.isDebug) return;
    const e = this.#entries.get(secretId);
    if (!e) return;
    const obj = e.value.reveal();
    const base = { secretId, versionId: e.versionId, fingerprint: e.fingerprint, ...fields };
    log.debug({ ...base, using: describeUse(obj, mapping, this.#fingerprintKey) }, msg);
    log.revealUnsafe?.(
      { ...base, using: Object.entries(mapping).map(([s, k]) => `${s}<-${k}=${obj?.[k]}`) },
      `${msg} (values revealed)`,
    );
  }

  /** Dashboard-safe metadata. Contains no secret material. */
  status() {
    const now = Date.now();
    return [...this.#entries.entries()].map(([secretId, e]) => ({
      secretId,
      name: e.name,
      versionId: e.versionId,
      versionStages: e.versionStages,
      fingerprint: e.fingerprint,
      fetchedAt: new Date(e.fetchedAt).toISOString(),
      ageSeconds: Math.round((now - e.fetchedAt) / 1000),
      ttlRemainingSeconds: Math.max(0, Math.round((e.expiresAt - now) / 1000)),
      cacheHits: e.hits,
      fetches: e.fetches,
      lastReason: e.lastReason,
      lastError: e.lastError,
    }));
  }

  /** Remote metadata (no value). Only available in SDK mode. */
  async describe(secretId) {
    if (typeof this.#fetcher.describe !== 'function') return undefined;
    return this.#fetcher.describe(secretId);
  }
}
