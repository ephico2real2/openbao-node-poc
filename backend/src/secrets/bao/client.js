// A small HTTP client for OpenBao and HashiCorp Vault (they share the API), with
// AppRole login and token renewal. Plain fetch: no new dependency.
//
// No credential in the environment. Two ways to log in, both from a FILE that
// is read again at every login:
//   approle     the AppRole secret ID (mode 0400, written by whoever provisions
//               the app: the seed job in the lab). The role ID is not a secret.
//   kubernetes  the pod's projected service-account token (short-lived,
//               audience-bound; the kubelet rotates it in place). OpenBao checks
//               it with the Kubernetes TokenReview API. No secret to hand over.
//
// Token lifecycle:
//   login       POST /v1/auth/approle/login           -> token, TTL
//   renew       POST /v1/auth/token/renew-self at 2/3 of the TTL
//   re-login    when renewal can't extend it (max TTL reached), or on a 403
// The token and the secret ID are registered with the redactor before they can
// appear anywhere, and are never logged.

import { readFile } from 'node:fs/promises';

export class BaoError extends Error {
  constructor(message, { status, path, errors } = {}) {
    super(message);
    this.name = 'BaoError';
    this.status = status;
    this.path = path;
    this.errors = errors;
    this.code = status ? `BAO_HTTP_${status}` : 'BAO_UNREACHABLE';
  }
}

/**
 * @param {object} o
 * @param {string} o.addr            e.g. http://openbao:8200
 * @param {string} o.roleId          AppRole role ID (not secret)
 * @param {string} o.secretIdFile    path to the AppRole secret ID (secret)
 * @param {string} [o.authMount]     default "approle"
 * @param {string} [o.namespace]     OpenBao namespace (X-Vault-Namespace)
 * @param {object} [o.redactor]      registers the token and secret ID
 * @param {object} [o.logger]
 * @param {number} [o.timeoutMs]
 * @param {Function} [o.fetchImpl]   for tests
 * @param {Function} [o.now]         for tests
 */
export function createBaoClient({
  addr, roleId, secretIdFile, auth = 'approle', authMount, k8sRole, k8sTokenFile = '/var/run/secrets/openbao/token',
  namespace, redactor, logger, timeoutMs = 5000, fetchImpl = fetch, now = Date.now, scheduleRenewal = true,
  product = 'OpenBao', // 'Vault' for SECRETS_PROVIDER=vault: only log and error wording differs
}) {
  if (!addr) throw new Error('BAO_ADDR is required');
  if (auth === 'kubernetes') {
    if (!k8sRole) throw new Error('BAO_K8S_ROLE is required with BAO_AUTH=kubernetes');
  } else {
    if (!roleId) throw new Error('BAO_ROLE_ID is required');
    if (!secretIdFile) throw new Error('BAO_SECRET_ID_FILE is required (the secret ID is read from a file, never from env)');
  }
  authMount ??= auth === 'kubernetes' ? 'kubernetes' : 'approle';
  const base = new URL(addr);
  const log = logger?.child({ component: 'bao' });
  const state = { token: undefined, expiresAt: 0, renewable: false, logins: 0, renewals: 0, lastError: undefined, accessor: undefined, policies: [] };
  let timer;
  let loggingIn;

  async function raw(method, path, { body, token, allow404 = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Vault-Token'] = token;
    if (namespace) headers['X-Vault-Namespace'] = namespace;
    let res;
    try {
      res = await fetchImpl(new URL(`/v1/${path}`, base), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw new BaoError(`${product} unreachable at ${base.origin}: ${err.message}`, { path });
    }
    if (res.status === 204) return undefined;
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      // OpenBao's error strings never contain secret values; keep them short.
      const errors = (json?.errors ?? []).map((e) => String(e).replace(/\s+/g, ' ').trim()).filter(Boolean);
      throw new BaoError(`${product} ${method} ${path}: HTTP ${res.status}${errors.length ? ` (${errors.join('; ')})` : ''}`, { status: res.status, path, errors });
    }
    return json;
  }

  function schedule() {
    if (!scheduleRenewal) return;
    clearTimeout(timer);
    const ms = Math.max(1000, (state.expiresAt - now()) * (2 / 3));
    timer = setTimeout(() => {
      renew().catch((err) => log?.warn({ err, event: 'bao.token.renew.failed' }, 'token renewal failed; the next request logs in again'));
    }, ms);
    timer.unref?.();
  }

  function adopt(auth) {
    redactor?.register?.(auth.client_token);
    state.token = auth.client_token;
    state.accessor = auth.accessor;
    state.policies = auth.policies ?? auth.token_policies ?? [];
    state.renewable = Boolean(auth.renewable);
    state.expiresAt = now() + (auth.lease_duration ?? 0) * 1000;
    schedule();
  }

  /** The login request body, from the credential FILE (read at every login: it may have been rotated). */
  async function loginBody() {
    const file = auth === 'kubernetes' ? k8sTokenFile : secretIdFile;
    let value;
    try {
      value = (await readFile(file, 'utf8')).trim();
    } catch (err) {
      const what = auth === 'kubernetes' ? 'service-account token' : 'AppRole secret ID';
      throw new BaoError(`cannot read the ${what} file ${file}: ${err.code ?? err.message}`);
    }
    redactor?.register?.(value);
    return auth === 'kubernetes' ? { role: k8sRole, jwt: value } : { role_id: roleId, secret_id: value };
  }

  async function login(reason = 'startup') {
    if (loggingIn) return loggingIn;
    loggingIn = (async () => {
      const out = await raw('POST', `auth/${authMount}/login`, { body: await loginBody() });
      adopt(out.auth);
      state.logins++;
      state.lastError = undefined;
      log?.info(
        { reason, auth, role: auth === 'kubernetes' ? k8sRole : roleId, authMount, policies: state.policies, ttlSeconds: out.auth.lease_duration, renewable: state.renewable, event: 'bao.login' },
        auth === 'kubernetes' ? `logged in to ${product} with the pod's service-account token` : `logged in to ${product} with AppRole`,
      );
    })().finally(() => {
      loggingIn = undefined;
    });
    return loggingIn;
  }

  async function renew() {
    if (!state.token) return login('no-token');
    const before = state.expiresAt;
    try {
      const out = await raw('POST', 'auth/token/renew-self', { token: state.token, body: {} });
      adopt(out.auth);
      state.renewals++;
      // At the max TTL the server can't extend it: log in again before it expires.
      if (state.expiresAt <= before + 1000) {
        log?.info({ event: 'bao.token.max_ttl' }, 'token reached its max TTL; logging in again');
        return login('max-ttl');
      }
      log?.debug({ ttlSeconds: Math.round((state.expiresAt - now()) / 1000), renewals: state.renewals }, 'token renewed');
    } catch (err) {
      state.lastError = err.message;
      return login('renew-failed');
    }
  }

  /** An authenticated request; a 403 triggers one fresh login and a retry. */
  async function request(method, path, opts = {}) {
    if (!state.token || now() >= state.expiresAt) await login(state.token ? 'expired' : 'startup');
    try {
      return await raw(method, path, { ...opts, token: state.token });
    } catch (err) {
      if (err.status !== 403) throw err;
      await login('forbidden');
      return raw(method, path, { ...opts, token: state.token });
    }
  }

  /**
   * Mint a secret ID for another AppRole role (the seed job does this for the
   * app). The server wants metadata as a JSON-encoded STRING, not an object.
   */
  async function mintSecretId(role, metadata = {}) {
    const out = await request('POST', `auth/${authMount}/role/${role}/secret-id`, { body: { metadata: JSON.stringify(metadata) } });
    redactor?.register?.(out.data.secret_id);
    return { secretId: out.data.secret_id, accessor: out.data.secret_id_accessor };
  }

  return {
    kind: 'bao',
    addr: base.origin,
    request,
    login,
    renew,
    mintSecretId,
    health: () => raw('GET', 'sys/health', {}),
    /** Dashboard-safe: no token, no secret ID. */
    status: () => ({
      addr: base.origin,
      authMethod: `${auth} (${authMount})`,
      roleId: auth === 'kubernetes' ? k8sRole : roleId,
      secretIdFile: auth === 'kubernetes' ? undefined : secretIdFile,
      tokenFile: auth === 'kubernetes' ? k8sTokenFile : undefined,
      loggedIn: Boolean(state.token),
      tokenTtlSeconds: state.token ? Math.max(0, Math.round((state.expiresAt - now()) / 1000)) : 0,
      renewable: state.renewable,
      logins: state.logins,
      renewals: state.renewals,
      policies: state.policies,
      lastError: state.lastError,
    }),
    close: () => clearTimeout(timer),
  };
}
