#!/usr/bin/env node
// LAB (epic B7): follow OpenBao's audit log and ship it to VictoriaLogs.
//   AUDIT_FILE=/audit/audit.log LOGS_URL='http://victorialogs:9428/insert/jsonline?_time_field=time&_msg_field=request.id&_stream_fields=type' node scripts/audit-ship.js
import { createTailShipper } from '../src/detect/shipper.js';

const file = process.env.AUDIT_FILE ?? '/audit/audit.log';
const url = process.env.LOGS_URL ?? 'http://victorialogs:9428/insert/jsonline?_time_field=time&_msg_field=request.id&_stream_fields=type';
const log = { info: (o, m) => console.log(`[audit-ship] ${m}`), warn: (o, m) => console.log(`[audit-ship] ${m}: ${o.err}`) };
const s = createTailShipper({ file, url, logger: log });
console.log(`[audit-ship] following ${file} -> ${new URL(url).origin}`);
s.start(Number(process.env.SHIP_INTERVAL_MS ?? 1000));
setInterval(() => console.log(`[audit-ship] ${s.stats().shipped} audit lines shipped`), 30_000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
