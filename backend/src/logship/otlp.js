// Ship log records to an OpenTelemetry Collector as OTLP/HTTP JSON.
//
// It receives each line AFTER redaction (log.js calls write() with the same
// string it prints), so it can only ever ship what stdout already shows.
// Lines from revealUnsafe() never reach it. stdout stays the primary log;
// this is a best-effort copy for the log store (VictoriaLogs locally,
// CloudWatch Logs or any OTLP backend elsewhere).
//
// It never logs through the logger (that would loop): problems are counted
// and exposed by stats().

const SEVERITY = { debug: [5, 'DEBUG'], info: [9, 'INFO'], warn: [13, 'WARN'], error: [17, 'ERROR'] };
// time and msg become Timestamp and Body; level and event stay as attributes too,
// so log stores that don't map SeverityText/EventName can still filter on them.
const SKIP = new Set(['time', 'msg', 'fatal']);

function anyValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: JSON.stringify(v) };
}

/** {a: {b: 1}, c: [1]} -> [["a.b", 1], ["c", [1]]] (one level of objects flattened per step). */
function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP.has(k) && !prefix) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (v !== undefined && v !== null) out.push([key, v]);
  }
  return out;
}

/** One redacted JSON log line -> one OTLP LogRecord. Exported for tests. */
export function toLogRecord(line) {
  const rec = JSON.parse(line);
  const ms = Date.parse(rec.time);
  const nanos = `${Number.isFinite(ms) ? ms : Date.now()}000000`;
  const [num, text] = rec.fatal ? [21, 'FATAL'] : SEVERITY[rec.level] ?? [0, String(rec.level ?? '')];
  const record = {
    timeUnixNano: nanos,
    observedTimeUnixNano: `${Date.now()}000000`,
    severityNumber: num,
    severityText: text,
    body: { stringValue: String(rec.msg ?? '') },
    attributes: flatten(rec).map(([key, value]) => ({ key, value: anyValue(value) })),
  };
  if (rec.event) record.eventName = rec.event;
  return record;
}

export function createOtlpShipper({
  endpoint,
  resource = {},
  maxBuffer = 2000,
  batchSize = 200,
  intervalMs = 1000,
  timeoutMs = 3000,
  fetchImpl = globalThis.fetch,
}) {
  const url = `${endpoint.replace(/\/+$/, '')}/v1/logs`;
  const resourceAttrs = Object.entries(resource)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([key, value]) => ({ key, value: anyValue(value) }));
  const buffer = [];
  const stats = { shipped: 0, dropped: 0, failedBatches: 0, lastError: undefined, endpoint: url };
  let inFlight = null;

  function write(line) {
    let record;
    try {
      record = toLogRecord(line);
    } catch {
      stats.dropped++;
      return;
    }
    buffer.push(record);
    if (buffer.length > maxBuffer) {
      buffer.splice(0, buffer.length - maxBuffer); // keep the newest
      stats.dropped++;
    }
  }

  async function send(batch) {
    const body = JSON.stringify({
      resourceLogs: [{ resource: { attributes: resourceAttrs }, scopeLogs: [{ scope: { name: 'secure-notes/log.js' }, logRecords: batch }] }],
    });
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`collector answered HTTP ${res.status}`);
  }

  function flush() {
    if (inFlight) return inFlight;
    if (!buffer.length) return Promise.resolve();
    const batch = buffer.splice(0, batchSize);
    inFlight = send(batch)
      .then(() => {
        stats.shipped += batch.length;
        stats.lastError = undefined;
      })
      .catch((err) => {
        stats.failedBatches++;
        stats.lastError = err.message;
        // put them back in front, within the buffer limit
        buffer.unshift(...batch);
        if (buffer.length > maxBuffer) {
          stats.dropped += buffer.length - maxBuffer;
          buffer.splice(0, buffer.length - maxBuffer);
        }
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  const timer = setInterval(() => void flush(), intervalMs);
  timer.unref?.();

  /** Send everything buffered, for up to `ms` (used before exiting). */
  async function drain(ms = 2000) {
    const deadline = Date.now() + ms;
    while ((buffer.length || inFlight) && Date.now() < deadline) {
      await flush();
      if (stats.lastError) break;
    }
  }

  return {
    write,
    flush,
    drain,
    stats: () => ({ ...stats, buffered: buffer.length }),
    close: () => clearInterval(timer),
  };
}
