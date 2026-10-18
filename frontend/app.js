// Dashboard for the demo. Plain DOM APIs and textContent only (no innerHTML
// with server data), so nothing from the API can inject markup.

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Text with every "[REDACTED]" marker highlighted. */
function redactedText(text) {
  const frag = document.createDocumentFragment();
  String(text).split(/(\[REDACTED\])/).forEach((part) => {
    if (part === '[REDACTED]') frag.append(el('span', { class: 'redacted' }, part));
    else if (part) frag.append(document.createTextNode(part));
  });
  return frag;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

const short = (id) => (id ? String(id).slice(0, 8) : '–');
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ago = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h`);

let cfg = { demoMode: false };
const smBao = () => Boolean(cfg.secretsProvider && cfg.secretsProvider !== 'aws');
const smName = () => ({ openbao: 'OpenBao', vault: 'Vault' })[cfg.secretsProvider] ?? 'Secrets Manager';

// ---------------------------------------------------------------- config ---
async function loadConfig() {
  cfg = await api('GET', '/api/config');
  const bao = cfg.secretsProvider && cfg.secretsProvider !== 'aws';
  const product = { aws: 'AWS Secrets Manager', openbao: 'OpenBao', vault: 'HashiCorp Vault' }[cfg.secretsProvider ?? 'aws'];
  const b = $('badges');
  b.replaceChildren(
    el('span', { class: 'pill pill-accent' }, bao ? (cfg.secretsMode === 'file' ? `${product} · via External Secrets` : `${product} · KV v2 API`) : cfg.secretsMode === 'agent' ? 'Workload Credentials Provider' : 'AWS SDK direct'),
    bao && cfg.secretsMode === 'file' ? el('span', { class: 'pill' }, 'mounted Secret, watched') : bao ? el('span', { class: 'pill' }, `${/^kubernetes/.test(cfg.bao?.authMethod ?? '') ? 'Kubernetes auth' : 'AppRole'} ${cfg.bao?.roleId ?? ''}`.trim()) : el('span', { class: 'pill' }, cfg.region),
    bao ? el('span', { class: 'pill pill-info' }, cfg.environment === 'production' ? 'server' : 'lab server') : cfg.usingLocalMock ? el('span', { class: 'pill pill-info' }, 'local mock') : el('span', { class: 'pill' }, 'AWS'),
    cfg.demoMode ? el('span', { class: 'pill pill-warn' }, 'demo mode') : null,
    cfg.logLevel === 'debug'
      ? cfg.revealSecrets
        ? el('span', { class: 'pill pill-fail' }, 'debug log · VALUES REVEALED')
        : el('span', { class: 'pill pill-info' }, 'debug log · values masked')
      : null,
  );
  $('reveal-banner').hidden = !cfg.revealSecrets;
  const where = {
    compose: ['Docker Compose', bao ? 'container · AppRole secret ID in a file' : 'container · dummy keys, for the mock only'],
    kubernetes: ['Kubernetes', bao ? (cfg.secretsMode === 'file' ? 'pod · no OpenBao identity · restricted PSA' : 'pod · projected token for OpenBao · restricted PSA') : 'pod · no SA token · restricted PSA'],
    openshift: ['OpenShift', 'pod · arbitrary UID · restricted-v2'],
    ec2: ['EC2', 'EC2 instance role · IMDSv2'],
  }[cfg.platform] ?? ['', bao ? 'AppRole, no token in env' : 'IAM role, no keys'];
  $('eyebrow').textContent = `${product} · Node.js${where[0] ? ` on ${where[0]}` : ''}`;
  $('flow-app').textContent = where[1];
  $('flow-cache').textContent = cfg.secretsMode === 'agent' ? 'agent cache + short app cache' : 'TTL + refresh on auth failure';
  $('flow-sm-title').textContent = bao ? product : 'Secrets Manager';
  $('flow-channel').textContent = bao && cfg.secretsMode === 'file'
    ? 'External Secrets → mounted Secret → file watch'
    : bao
    ? `${cfg.bao?.addr ?? ''} · token renewed`
    : cfg.usingLocalMock
      ? 'local mock (HTTP)'
      : cfg.secretsMode === 'agent'
        ? 'via localhost:2773 + SSRF token'
        : 'HTTPS via VPC endpoint · KMS';
  $('secrets-mode').textContent = bao ? `${cfg.secretsProvider} · ${cfg.secretsMode}` : cfg.secretsMode === 'agent' ? 'mode: agent' : 'mode: sdk';
  document.querySelectorAll('.demo-only').forEach((n) => (n.hidden = !cfg.demoMode));
}

// ----------------------------------------------------------------- notes ---
async function loadNotes() {
  const r = await api('GET', '/api/notes');
  const src = $('notes-source');
  src.className = `pill ${r.source === 'redis' ? 'pill-accent' : 'pill-info'}`;
  src.textContent = `${r.source === 'redis' ? 'Redis hit' : 'Postgres'} · ${r.ms} ms`;
  $('notes').replaceChildren(
    ...r.notes.map((n) => el('li', {}, el('span', {}, n.body), el('time', { datetime: n.created_at }, clock(n.created_at)))),
  );
}

$('note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('note-input');
  const body = input.value.trim();
  if (!body) return;
  try {
    await api('POST', '/api/notes', { body });
    input.value = '';
    await loadNotes();
  } catch (err) {
    toast(`Could not save: ${err.message}`);
  }
});

// --------------------------------------------------------------- secrets ---
async function loadSecrets() {
  const r = await api('GET', '/api/secrets');
  $('secrets').replaceChildren(
    ...r.secrets.map((s) => {
      const label = s.alias === 'db' ? 'Postgres credential' : 'Redis credential';
      const btn = el('button', { class: 'btn btn-ghost btn-small' }, 'Refresh now');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('POST', `/api/secrets/${s.alias}/refresh`);
          await refreshLive();
        } catch (err) {
          toast(err.message);
        } finally {
          btn.disabled = false;
        }
      });
      return el(
        'article',
        { class: `secret${s.staleInCache ? ' is-stale' : ''}` },
        el('div', { class: 'secret-head' },
          el('div', {}, el('div', {}, el('strong', {}, label)), el('div', { class: 'secret-name' }, s.secretId)),
          el('span', { class: `pill ${s.staleInCache ? 'pill-warn' : 'pill-pass'}` }, s.staleInCache ? 'cache behind' : 'current'),
        ),
        el('dl', { class: 'kv' },
          el('dt', {}, 'version'), el('dd', {}, `${short(s.versionId)}  ${(s.versionStages || []).join(', ')}`),
          el('dt', {}, 'fingerprint'), el('dd', {}, s.fingerprint ?? '–'),
          el('dt', {}, 'loaded'), el('dd', {}, s.ageSeconds != null ? `${ago(s.ageSeconds)} ago · ${s.lastReason}` : '–'),
          el('dt', {}, 'usage'), el('dd', {}, `${s.cacheHits ?? 0} cache hits · ${s.fetches ?? 0} API fetches`),
          s.remote ? el('dt', {}, smBao() ? `in ${smName()}` : 'in AWS') : null,
          s.remote ? el('dd', {}, smBao()
            ? `current version = ${s.remote.currentVersionId}${s.remote.versions ? ` · ${s.remote.versions} kept` : ''}`
            : `AWSCURRENT = ${short(s.remote.currentVersionId)}${s.remote.rotationEnabled ? ' · rotation on' : ''}`) : null,
          s.lastError ? el('dt', {}, 'last error') : null,
          s.lastError ? el('dd', {}, s.lastError) : null,
          // Step v2: a dynamic user with a lease (this instance's own login).
          s.lease ? el('dt', {}, 'lease') : null,
          s.lease ? el('dd', {}, `${s.lease.lease} · ${s.lease.ttlSeconds}s left · renewed ${s.lease.renewals}×`) : null,
          s.lease ? el('dt', {}, 'next') : null,
          s.lease ? el('dd', {}, s.lease.maxTtlReached || !s.lease.renewable
            ? `max TTL reached: new user in ${s.lease.reissueInSeconds ?? 0}s`
            : `renew in ${s.lease.renewInSeconds ?? 0}s`) : null,
        ),
        el('div', { class: 'ttl', title: s.lease ? 'time left on the lease' : `time until the cache re-checks ${smName()}` }, el('span', { style: null })),
        el('div', { class: 'secret-foot' },
          el('span', { class: s.staleInCache ? 'stale-note' : 'muted small' },
            s.staleInCache
              ? `${smName()} has a newer version. The app picks it up on the next auth failure or TTL expiry.`
              : s.lease
                ? `a user of its own, issued ${ago(s.lease.issuedSecondsAgo ?? 0)} ago`
                : `re-checks in ${ago(s.ttlRemainingSeconds ?? 0)}`),
          btn,
        ),
      );
    }),
  );
  // Width set via CSSOM (allowed by the CSP), not an inline style attribute.
  [...$('secrets').querySelectorAll('.ttl > span')].forEach((bar, i) => {
    const s = r.secrets[i];
    const full = s.lease ? s.lease.ttlSeconds + (s.lease.issuedSecondsAgo ?? 0) : r.ttlSeconds;
    const left = s.lease ? s.lease.ttlSeconds : s.ttlRemainingSeconds;
    bar.style.width = `${left != null && full ? Math.min(100, (left / full) * 100) : 0}%`;
  });
  // Step v2: with dynamic users, the demo revokes a lease instead of rotating a password.
  const dynamic = r.secrets.some((s) => s.lease);
  document.querySelectorAll('[data-rotate]').forEach((b) => {
    const what = b.dataset.rotate === 'db' ? 'Postgres' : 'Redis';
    b.textContent = dynamic ? `Revoke ${what} lease` : `Rotate ${what} secret`;
  });
  if (cfg.secretsMode === 'file') {
    $('rotation-hint').textContent =
      'SECRETS_MODE=file: the app has no OpenBao identity, so it cannot rotate. A rotation happens in OpenBao; External Secrets Operator updates the Secret, the kubelet swaps the mounted files, and the app re-reads them.';
    document.querySelectorAll('#rotation-card button').forEach((b) => (b.disabled = true));
  } else if (dynamic) {
    $('rotation-hint').textContent =
      'Each login is a user OpenBao created for this instance, so there is no password to rotate. Revoke a lease as an operator would after a leak: OpenBao drops the user, and the app finds out on its next login, asks for a new user and retries.';
  }
}

// ---------------------------------------------------------------- events ---
let lastEventId = 0;
async function loadEvents() {
  const { events } = await api('GET', `/api/events?since=${lastEventId}`);
  if (!events.length) return;
  lastEventId = events[events.length - 1].id;
  const list = $('events');
  for (const e of events) {
    const cls = e.source === 'rotation' && e.type !== 'failed' ? 'ev-rotation' : `ev-${e.type}`;
    list.prepend(
      el('li', { class: cls },
        el('time', { datetime: e.at }, clock(e.at)),
        el('div', {}, el('span', { class: 'tag' }, `${e.source} · ${e.type}`), el('br'), e.message),
      ),
    );
  }
  while (list.children.length > 80) list.lastChild.remove();
}

// -------------------------------------------------------------- rotation ---
function setBusy(busy) {
  document.querySelectorAll('#rotation-card button').forEach((b) => (b.disabled = busy));
}

document.querySelectorAll('[data-rotate]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const alias = btn.dataset.rotate;
    setBusy(true);
    $('steps').replaceChildren();
    $('rotation-next').hidden = true;
    try {
      const r = await api('POST', `/api/demo/rotate/${alias}`);
      $('steps').replaceChildren(...r.steps.map((s) => el('li', {}, el('div', {}, el('b', {}, s.name), el('span', {}, s.detail)))));
      $('rotation-next').textContent = r.next;
      $('rotation-next').hidden = false;
    } catch (err) {
      $('steps').replaceChildren(el('li', { class: 'is-fail' }, el('div', {}, el('b', {}, 'failed'), el('span', {}, err.message))));
    } finally {
      setBusy(false);
      refreshLive();
    }
  }),
);

$('drop-btn').addEventListener('click', async () => {
  setBusy(true);
  try {
    const r = await api('POST', '/api/demo/drop-connections');
    toast(`Dropped ${r.postgres} Postgres and ${r.redis} Redis connection(s). Loading notes…`);
    $('rotation-next').hidden = true;
    await api('POST', '/api/notes', { body: `Written right after dropping connections (${new Date().toLocaleTimeString()})` });
    await loadNotes();
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
    refreshLive();
  }
});

// ------------------------------------------------------------------ leaks --
$('leak-btn').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/demo/leak-test');
    const res = $('leak-result');
    res.className = `pill ${r.leaked ? 'pill-fail' : 'pill-pass'}`;
    res.textContent = r.leaked ? `${r.leaked} leaked` : `0 of ${r.attempts.length} leaked`;
    $('leaks').replaceChildren(
      ...r.attempts.map((a) => el('li', {}, el('div', { class: 'attempt' }, a.attempt), el('pre', {}, redactedText(a.output)))),
    );
    refreshLive();
  } catch (err) {
    toast(err.message);
  }
});

// ----------------------------------------------------------------- checks --
const STATUS_CLASS = { pass: 'pill-pass', warn: 'pill-warn', fail: 'pill-fail', info: 'pill-info', skip: 'pill-skip' };
async function loadChecks() {
  const { checks } = await api('GET', '/api/security/checks');
  $('checks').replaceChildren(
    ...checks.map((c) =>
      el('li', {},
        el('span', { class: `pill ${STATUS_CLASS[c.status] ?? ''}` }, c.status),
        el('div', {}, el('strong', {}, c.title), el('span', { class: 'detail' }, c.detail)),
      ),
    ),
  );
}
$('checks-btn').addEventListener('click', () => loadChecks().catch((e) => toast(e.message)));

// ------------------------------------------------------------------- logs --
async function loadLogs() {
  if (!cfg.demoMode) return;
  const only = $('log-cred-only').checked;
  const { lines } = await api('GET', only ? '/api/logs?only=credentials' : '/api/logs');
  const box = $('log');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  box.replaceChildren(
    ...lines.slice(-120).map((line) => {
      const lvl = /"level":"(warn|error)"/.exec(line)?.[1];
      const span = el('span', { class: lvl ? `lvl-${lvl}` : null }, redactedText(line));
      return el('div', {}, span);
    }),
  );
  if (atBottom) box.scrollTop = box.scrollHeight;
}

$('log-cred-only').addEventListener('change', () => {
  $('log').replaceChildren();
  loadLogs().then(() => { $('log').scrollTop = $('log').scrollHeight; }).catch((e) => toast(e.message));
});

// ------------------------------------------------------------------- boot --
async function refreshLive() {
  await Promise.allSettled([loadSecrets(), loadEvents(), loadLogs()]);
}

(async () => {
  try {
    await loadConfig();
    await Promise.allSettled([loadNotes(), loadChecks(), refreshLive()]);
  } catch (err) {
    toast(`Cannot reach the API: ${err.message}`);
  }
  setInterval(refreshLive, 2000);
})();
