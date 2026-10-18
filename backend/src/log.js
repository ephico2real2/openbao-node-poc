// Small structured JSON logger with mandatory redaction.
//
// Every record goes through the Redactor twice: once structurally (sensitive
// keys) and once on the final serialized line (registered secret values).
// The last-mile pass is what makes redaction hold even when a secret ends up
// somewhere unexpected, like an error message built by a library.
//
// Sinks (e.g. the OTLP shipper) receive exactly the redacted line that stdout
// gets, never a revealed one. format 'pretty' changes only what stdout shows;
// the ring buffer and the sinks always get JSON.

import { prettyLine } from './logfmt.js';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };

export function createLogger({ redactor, level = 'info', ringSize = 300, base = {}, out = process.stdout, revealSecrets = false, format = 'json', sinks = [] }) {
  const ring = [];
  const min = LEVELS[level] ?? LEVELS.info;

  function emit(levelName, bindings, args) {
    if (LEVELS[levelName] < min) return;
    let fields = {};
    let msg;
    if (typeof args[0] === 'string') {
      msg = args[0];
    } else if (args[0] instanceof Error) {
      fields = { err: args[0] };
      msg = args[1] ?? args[0].message;
    } else {
      fields = args[0] ?? {};
      msg = args[1];
    }
    const record = { time: new Date().toISOString(), level: levelName, ...bindings, ...fields, msg };
    const line = redactor.scrubString(JSON.stringify(redactor.scrub(record)));
    out.write(`${format === 'pretty' ? prettyLine(JSON.parse(line)) : line}\n`);
    for (const sink of sinks) sink.write(line);
    ring.push(line);
    if (ring.length > ringSize) ring.shift();
    return line;
  }

  // LOG_REVEAL_SECRETS=true only (refused in production, see config.js): the ONE
  // path that writes a line without redaction, so a lab can see the real value
  // a client used. Debug level only. Grep for revealUnsafe to find every use.
  function emitUnredacted(bindings, fields, msg) {
    if (LEVELS.debug < min) return;
    const record = {
      time: new Date().toISOString(), level: 'debug', ...bindings, ...fields, msg,
      revealed: true, warning: 'secret values in this line are NOT masked (LOG_REVEAL_SECRETS=true)',
    };
    const line = JSON.stringify(record);
    out.write(`${format === 'pretty' ? prettyLine(record) : line}\n`);
    return line; // not kept in the ring and never given to a sink: /api/logs and the log store never get revealed lines
  }

  function make(bindings) {
    return {
      debug: (...a) => emit('debug', bindings, a),
      info: (...a) => emit('info', bindings, a),
      warn: (...a) => emit('warn', bindings, a),
      error: (...a) => emit('error', bindings, a),
      child: (more) => make({ ...bindings, ...more }),
      /** Present only when LOG_REVEAL_SECRETS=true. */
      revealUnsafe: revealSecrets ? (fields, msg) => emitUnredacted(bindings, fields, msg) : undefined,
      isDebug: LEVELS.debug >= min,
      /** Most recent (already redacted) log lines, newest last. */
      recent: (n = 100) => ring.slice(-n),
      /** Send what the sinks have buffered (before exiting). */
      drain: (ms) => Promise.allSettled(sinks.map((s) => s.drain?.(ms))),
    };
  }

  return make(base);
}
