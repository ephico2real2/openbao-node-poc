// LOG_FORMAT=pretty: one readable line per record, for a terminal.
//   08:21:04.123 WARN  secrets  secret fetch failed, serving last good value · secretId=/rds/dev/notes-db/app event=secrets.fetch.stale
// Built from the already-redacted record, so it can't show more than JSON does.
// Development only (refused in production): log stores and alert rules read JSON.

const HIDE = new Set(['time', 'level', 'msg', 'app', 'component']);

function show(v) {
  if (typeof v === 'string') return /[\s"=]/.test(v) || v === '' ? JSON.stringify(v) : v;
  return JSON.stringify(v);
}

export function prettyLine(record) {
  const t = typeof record.time === 'string' && record.time.length >= 23 ? record.time.slice(11, 23) : String(record.time ?? '');
  const level = String(record.level ?? '').toUpperCase().padEnd(5);
  const component = record.component ? `${String(record.component).padEnd(8)} ` : '';
  const fields = Object.entries(record)
    .filter(([k, v]) => !HIDE.has(k) && v !== undefined)
    .map(([k, v]) => `${k}=${show(v)}`)
    .join(' ');
  return `${t} ${level} ${component}${record.msg ?? ''}${fields ? ` · ${fields}` : ''}`;
}
