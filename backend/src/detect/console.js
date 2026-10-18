// Epic B7: the alert console. vmalert sends firing alerts here the way it sends
// them to Alertmanager (POST /api/v2/alerts, a JSON array); this keeps them in
// memory and shows them:
//   GET /             an HTML page (what the CI walk photographs)
//   GET /api/alerts   the same as JSON (what the check scripts read)
// Lab only: no auth, no persistence. In production, point vmalert at
// Alertmanager and route to on-call.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createAlertConsole({ max = 200, now = () => new Date() } = {}) {
  const alerts = new Map(); // fingerprint -> alert

  function receive(list) {
    if (!Array.isArray(list)) throw new Error('expected a JSON array of alerts');
    for (const a of list) {
      const labels = a.labels ?? {};
      const key = JSON.stringify(Object.entries(labels).sort()) + (a.startsAt ?? '');
      const prev = alerts.get(key);
      alerts.set(key, {
        labels,
        annotations: a.annotations ?? {},
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        receivedAt: now().toISOString(),
        times: (prev?.times ?? 0) + 1,
      });
    }
    while (alerts.size > max) alerts.delete(alerts.keys().next().value);
    return list.length;
  }

  const list = () => [...alerts.values()].sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)));

  function html() {
    const rows = list()
      .map(
        (a) => `<article class="alert ${esc(a.labels.severity)}">
  <h2>${esc(a.labels.alertname)} <span class="sev">${esc(a.labels.severity)}</span></h2>
  <p>${esc(a.annotations.summary)}</p>
  <p class="desc">${esc(a.annotations.description)}</p>
  <dl>${Object.entries(a.labels)
    .filter(([k]) => !['alertname', 'severity'].includes(k))
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('')}</dl>
  <p class="when">since ${esc(a.startsAt)} · received ${a.times}×</p>
</article>`,
      )
      .join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alert console</title><meta http-equiv="refresh" content="5">
<style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;background:#f6f5f2;color:#1d1d1b}h1{font-size:22px}
.alert{background:#fff;border:1px solid #ddd;border-left:6px solid #b42318;border-radius:8px;padding:12px 16px;margin:12px 0}
.alert.warning{border-left-color:#b54708}.sev{font-size:12px;text-transform:uppercase;color:#b42318}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;font-family:ui-monospace,monospace;font-size:13px}dt{color:#666}
.when,.desc{color:#555;font-size:13px}.empty{color:#666}</style></head><body>
<h1>Alert console</h1><p>Alerts from vmalert, raised by rules on OpenBao's audit log (lab: newest first).</p>
${rows || '<p class="empty">No alerts. The app reading its own secrets is not an alert.</p>'}
</body></html>`;
  }

  return { receive, list, html, count: () => alerts.size };
}
