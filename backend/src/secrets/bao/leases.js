// Dynamic credentials (step v2): OpenBao's database secrets engine creates a
// database user for this app instance, with a LEASE. The lease keeper:
//
//   issue    GET database/creds/<role>        -> username, password, lease (TTL)
//   renew    PUT sys/leases/renew at 2/3 of the remaining TTL
//   re-issue when a renewal comes back shorter than asked (the role's max TTL
//            caps it), shortly before the lease ends: onExpiring() makes the
//            cache fetch a NEW user, the clients switch to it, and the old
//            lease is revoked after a short grace period (its open connections
//            drain first). OpenBao's revocation drops the old database user.
//   revoke   on shutdown, and for the dashboard's "Revoke lease" demo
//
// A renewal that fails (the lease was revoked, OpenBao restarted) also asks for
// a new user at once. The lease ID is not a credential, but it is only shown
// shortened on the dashboard.

const short = (leaseId) => String(leaseId).split('/').pop().slice(0, 8);

export function createLeaseKeeper(client, { logger, now = Date.now, graceMs = 15_000, minMarginMs = 5_000, timers = { setTimeout, clearTimeout } } = {}) {
  const log = logger?.child({ component: 'leases' });
  const leases = new Map(); // secretId -> current lease state
  let expiringHandler = () => {};

  function arm(st, ms, fn) {
    timers.clearTimeout(st.timer);
    st.timer = timers.setTimeout(fn, Math.max(0, ms));
    st.timer?.unref?.();
  }

  function plan(st) {
    const remaining = st.expiresAt - now();
    if (st.final || !st.renewable) {
      // Can't be extended any more: get a new user before this one ends.
      const margin = Math.max(minMarginMs, Math.min(30_000, remaining / 3));
      st.reissueAt = st.expiresAt - margin;
      st.renewAt = undefined;
      arm(st, st.reissueAt - now(), () => expiring(st, 'lease-max-ttl'));
    } else {
      st.renewAt = now() + (remaining * 2) / 3;
      st.reissueAt = undefined;
      arm(st, st.renewAt - now(), () => renew(st).catch(() => {}));
    }
  }

  function expiring(st, reason) {
    if (leases.get(st.secretId) !== st) return;
    log?.info({ secretId: st.secretId, lease: short(st.id), reason, event: 'bao.lease.reissue' }, 'asking OpenBao for a new database user before the lease ends');
    expiringHandler(st.secretId, reason);
  }

  async function renew(st) {
    if (leases.get(st.secretId) !== st) return;
    try {
      const out = await client.request('PUT', 'sys/leases/renew', { body: { lease_id: st.id, increment: st.ttlSeconds } });
      st.renewals++;
      st.expiresAt = now() + out.lease_duration * 1000;
      // OpenBao caps a renewal at the role's max TTL: a shorter answer means
      // this is the last extension.
      if (out.lease_duration < st.ttlSeconds) st.final = true;
      log?.info(
        { secretId: st.secretId, lease: short(st.id), ttlSeconds: out.lease_duration, renewals: st.renewals, final: st.final, event: 'bao.lease.renewed' },
        st.final ? 'lease renewed for the last time (max TTL reached)' : 'lease renewed',
      );
      plan(st);
    } catch (err) {
      st.lastError = err.message;
      log?.warn({ secretId: st.secretId, lease: short(st.id), err, event: 'bao.lease.renew.failed' }, 'lease renewal failed; asking for a new database user');
      expiring(st, 'lease-renew-failed');
    }
  }

  async function revokeLease(leaseId, why) {
    await client.request('PUT', 'sys/leases/revoke', { body: { lease_id: leaseId } });
    log?.info({ lease: short(leaseId), why, event: 'bao.lease.revoked' }, 'lease revoked: OpenBao drops that database user');
  }

  function retire(st) {
    timers.clearTimeout(st.timer);
    // Let the clients switch and their open connections drain, then revoke.
    const t = timers.setTimeout(() => revokeLease(st.id, 'replaced').catch((err) => log?.debug({ err }, 'revoking the replaced lease failed (it expires on its own)')), graceMs);
    t?.unref?.();
  }

  return {
    onExpiring(fn) {
      expiringHandler = fn;
    },

    /** A new database user for secretId (path e.g. database/creds/notes-app). */
    async issue(secretId, path) {
      const out = await client.request('GET', path);
      if (!out?.lease_id || !out?.data) throw new Error(`no credentials from ${path}`);
      const st = {
        secretId,
        id: out.lease_id,
        issuedAt: now(),
        expiresAt: now() + out.lease_duration * 1000,
        ttlSeconds: out.lease_duration,
        renewable: Boolean(out.renewable),
        renewals: 0,
        final: false,
      };
      const prev = leases.get(secretId);
      leases.set(secretId, st);
      if (prev) retire(prev);
      plan(st);
      log?.info({ secretId, lease: short(st.id), ttlSeconds: st.ttlSeconds, renewable: st.renewable, event: 'bao.lease.issued' }, 'OpenBao issued a database user for this instance');
      return { data: out.data, leaseId: st.id, issuedAt: st.issuedAt };
    },

    expiresAt: (secretId) => leases.get(secretId)?.expiresAt,

    /** Dashboard-safe: no credential (the lease ID is shortened). */
    status(secretId) {
      const st = leases.get(secretId);
      if (!st) return undefined;
      const s = (t) => (t === undefined ? undefined : Math.max(0, Math.round((t - now()) / 1000)));
      return {
        lease: short(st.id),
        ttlSeconds: s(st.expiresAt),
        renewInSeconds: s(st.renewAt),
        reissueInSeconds: s(st.reissueAt),
        renewals: st.renewals,
        renewable: st.renewable,
        maxTtlReached: st.final,
        issuedSecondsAgo: Math.round((now() - st.issuedAt) / 1000),
        lastError: st.lastError,
      };
    },

    /** Demo: revoke the current lease now, as an operator would after a leak. */
    async revoke(secretId) {
      const st = leases.get(secretId);
      if (!st) throw new Error(`no lease held for ${secretId}`);
      timers.clearTimeout(st.timer);
      await revokeLease(st.id, 'demo');
      return short(st.id);
    },

    /** Shutdown: revoke every lease this instance holds, so its users disappear now. */
    async revokeAll() {
      const all = [...leases.values()];
      leases.clear();
      await Promise.allSettled(all.map((st) => (timers.clearTimeout(st.timer), revokeLease(st.id, 'shutdown'))));
    },
  };
}
