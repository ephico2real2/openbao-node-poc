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

// ---------------------------------------------------------------- config ---
async function loadConfig() {
  cfg = await api('GET', '/api/config');
  const b = $('badges');
  b.replaceChildren(
    el('span', { class: 'pill pill-accent' }, cfg.secretsMode === 'agent' ? 'Workload Credentials Provider' : 'AWS SDK direct'),
    el('span', { class: 'pill' }, cfg.region),
    cfg.usingLocalMock ? el('span', { class: 'pill pill-info' }, 'local mock') : el('span', { class: 'pill' }, 'AWS'),
    cfg.demoMode ? el('span', { class: 'pill pill-warn' }, 'demo mode') : null,
    cfg.logLevel === 'debug'
      ? cfg.revealSecrets
        ? el('span', { class: 'pill pill-fail' }, 'debug log · VALUES REVEALED')
        : el('span', { class: 'pill pill-info' }, 'debug log · values masked')
      : null,
  );
  $('reveal-banner').hidden = !cfg.revealSecrets;
  const where = {
    compose: ['Docker Compose', 'container · dummy keys, for the mock only'],
    kubernetes: ['Kubernetes', 'pod · no SA token · restricted PSA'],
    openshift: ['OpenShift', 'pod · arbitrary UID · restricted-v2'],
    ec2: ['EC2', 'EC2 instance role · IMDSv2'],
  }[cfg.platform] ?? ['', 'IAM role, no keys'];
  $('eyebrow').textContent = `AWS Secrets Manager · Node.js${where[0] ? ` on ${where[0]}` : ''}`;
  $('flow-app').textContent = where[1];
  $('flow-cache').textContent = cfg.secretsMode === 'agent' ? 'agent cache + short app cache' : 'TTL + refresh on auth failure';
  $('flow-channel').textContent = cfg.usingLocalMock
    ? 'local mock (HTTP)'
    : cfg.secretsMode === 'agent'
      ? 'via localhost:2773 + SSRF token'
      : 'HTTPS via VPC endpoint · KMS';
  $('secrets-mode').textContent = cfg.secretsMode === 'agent' ? 'mode: agent' : 'mode: sdk';
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
          s.remote ? el('dt', {}, 'in AWS') : null,
          s.remote ? el('dd', {}, `AWSCURRENT = ${short(s.remote.currentVersionId)}${s.remote.rotationEnabled ? ' · rotation on' : ''}`) : null,
          s.lastError ? el('dt', {}, 'last error') : null,
          s.lastError ? el('dd', {}, s.lastError) : null,
        ),
        el('div', { class: 'ttl', title: 'time until the cache re-checks Secrets Manager' }, el('span', { style: null })),
        el('div', { class: 'secret-foot' },
          el('span', { class: s.staleInCache ? 'stale-note' : 'muted small' },
            s.staleInCache
              ? 'Secrets Manager has a newer version. The app picks it up on the next auth failure or TTL expiry.'
              : `re-checks in ${ago(s.ttlRemainingSeconds ?? 0)}`),
          btn,
        ),
      );
    }),
  );
  // Width set via CSSOM (allowed by the CSP), not an inline style attribute.
  [...$('secrets').querySelectorAll('.ttl > span')].forEach((bar, i) => {
    const s = r.secrets[i];
    bar.style.width = `${s.ttlRemainingSeconds != null && r.ttlSeconds ? Math.min(100, (s.ttlRemainingSeconds / r.ttlSeconds) * 100) : 0}%`;
  });
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
