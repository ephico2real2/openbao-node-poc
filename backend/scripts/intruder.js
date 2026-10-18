#!/usr/bin/env node
// LAB (epic B7): the "unexpected read". Someone with a legitimate but too-broad
// OpenBao role (ops-admin: may read every KV secret) reads the app's database
// secret. Nothing stops it; the point is that it is SEEN: the audit log names
// the role, and the detection rule raises an alert within a minute.
// Prints only the version it read, never the value.
import { createBaoClient } from '../src/secrets/bao/client.js';

const id = process.env.TARGET_SECRET ?? 'rds/dev/notes-db/app';
const c = createBaoClient({
  addr: process.env.BAO_ADDR ?? 'http://openbao:8200',
  roleId: process.env.BAO_ROLE_ID ?? 'ops-admin',
  secretIdFile: process.env.BAO_SECRET_ID_FILE ?? '/bao-bootstrap/ops-secret-id',
  scheduleRenewal: false,
});
try {
  const out = await c.request('GET', `secret/data/${id}`);
  console.log(`[intruder] read secret/data/${id} as role ops-admin: version ${out.data.metadata.version} (value not printed)`);
} catch (err) {
  console.error(`[intruder] failed: ${err.message}`);
  process.exit(1);
}
