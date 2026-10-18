#!/usr/bin/env node
// LAB ONLY (step v3, SECRETS_MODE=file): rotate the app's Postgres password the
// way an outside rotation job does, while the app itself has no OpenBao
// identity. k8s-check.sh runs it as a Kubernetes Job with the seed job's
// service account (Kubernetes auth, role secure-notes-seed).
//
//   1. read the current app secret and the admin secret from OpenBao (KV v2)
//   2. set a new random password on the Postgres role (sent as a SCRAM verifier)
//   3. write it as the next KV version, with check-and-set
// Then External Secrets Operator copies the new version into the Secret, the
// kubelet swaps the mounted files, and the app re-reads them: no restart.
//
// Between steps 2 and the kubelet's swap, NEW connections with the old
// password fail (open ones keep working). That window is why mounted-file
// rotation is usually done with two alternating users, or replaced by the
// dynamic users of step v2, which the app reads over the API.

import pg from 'pg';
import { createBaoClient } from '../src/secrets/bao/client.js';
import { createKvStore } from '../src/secrets/bao/kv.js';
import { scramSha256Verifier } from '../src/demo/crypto.js';
import { resolveSecretIds } from '../src/secrets/naming.js';

const env = process.env;
const must = (k) => {
  if (!env[k]) throw new Error(`${k} is required`);
  return env[k];
};

async function main() {
  const ids = resolveSecretIds({ ...env, DB_SECRET_ID: undefined, REDIS_SECRET_ID: undefined }).ids;
  const bao = createBaoClient({
    addr: must('BAO_ADDR'),
    auth: 'kubernetes',
    k8sRole: env.BAO_K8S_ROLE ?? 'secure-notes-seed',
    k8sTokenFile: env.BAO_K8S_TOKEN_FILE,
    scheduleRenewal: false,
  });
  const store = createKvStore(bao, { mount: env.BAO_KV_MOUNT ?? 'secret' });

  const app = await store.read(ids.db);
  const admin = (await store.read(ids.dbAdmin)).value;
  const password = await store.randomPassword();

  const c = new pg.Client({
    host: env.SEED_PG_HOST ?? admin.host,
    port: Number(admin.port ?? 5432),
    database: admin.dbname ?? 'notes',
    user: admin.username,
    password: admin.password,
  });
  await c.connect();
  await c.query(`ALTER ROLE ${c.escapeIdentifier(app.value.username)} WITH PASSWORD ${c.escapeLiteral(scramSha256Verifier(password))}`);
  await c.end();
  console.log(`[rotate] postgres: new password set on role ${app.value.username} (SCRAM verifier)`);

  const next = await store.promote(ids.db, { ...app.value, password }, app.versionId);
  console.log(`[rotate] OpenBao: ${ids.db} version ${app.versionId} -> ${next} (check-and-set). External Secrets Operator copies it on its next refresh.`);
}

main().catch((err) => {
  console.error(`[rotate] failed: ${err.message}`);
  process.exit(1);
});
