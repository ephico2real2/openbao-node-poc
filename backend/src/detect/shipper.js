// Epic B7: ship OpenBao's audit log to a log store, line by line.
//
// The audit device writes one JSON object per line, with every secret value
// already replaced by an HMAC, so the shipper never parses or changes a line:
// it follows the file (like `tail -F`) and POSTs new complete lines as NDJSON to
// VictoriaLogs' /insert/jsonline endpoint. A file that shrinks (rotated or
// recreated) is read again from the start.

import { open, stat } from 'node:fs/promises';

export function createTailShipper({ file, url, fetchImpl = fetch, maxBatchBytes = 1 << 20, logger }) {
  let offset = 0;
  let partial = '';
  let shipped = 0;
  let timer;

  async function readNew() {
    let st;
    try {
      st = await stat(file);
    } catch {
      return []; // not there yet: the server creates it on its first request
    }
    if (st.size < offset) {
      logger?.info?.({ file }, 'audit log shrank (rotated or recreated); reading it from the start');
      offset = 0;
      partial = '';
    }
    if (st.size === offset) return [];
    const fh = await open(file, 'r');
    try {
      const len = Math.min(st.size - offset, maxBatchBytes);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      offset += bytesRead;
      const text = partial + buf.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      partial = lines.pop(); // an unfinished last line waits for the next read
      return lines.filter((l) => l.trim());
    } finally {
      await fh.close();
    }
  }

  let pending = []; // read but not yet accepted by the log store: sent again (at least once)
  async function tick() {
    pending.push(...(await readNew()));
    if (!pending.length) return 0;
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/stream+json' }, body: `${pending.join('\n')}\n` });
    if (!res.ok) throw new Error(`log store answered HTTP ${res.status}`);
    const n = pending.length;
    shipped += n;
    pending = [];
    return n;
  }

  return {
    tick,
    stats: () => ({ file, offset, shipped }),
    start(intervalMs = 1000) {
      const loop = async () => {
        try {
          await tick();
        } catch (err) {
          logger?.warn?.({ err: err.message }, 'shipping failed; retrying');
        }
        timer = setTimeout(loop, intervalMs);
      };
      loop();
    },
    stop: () => clearTimeout(timer),
  };
}
