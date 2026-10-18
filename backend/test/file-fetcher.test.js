// SECRETS_MODE=file: a directory laid out the way the kubelet writes a Secret
// volume (timestamped directory, ..data symlink, per-key symlinks), and the
// atomic swap it does on an update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileFetcher } from '../src/secrets/file-fetcher.js';
import { SecretsProvider } from '../src/secrets/provider.js';
import { Redactor } from '../src/secrets/redactor.js';
import { createLogger } from '../src/log.js';

function kubeletDir() {
  const dir = mkdtempSync(join(tmpdir(), 'secretvol-'));
  let n = 0;
  const write = (files) => {
    const ts = `..2026_10_18_20_00_0${++n}.000000001`;
    mkdirSync(join(dir, ts));
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, ts, k), JSON.stringify(v));
    symlinkSync(ts, join(dir, '..data_tmp'));
    renameSync(join(dir, '..data_tmp'), join(dir, '..data')); // the atomic swap
    for (const k of Object.keys(files)) {
      try {
        symlinkSync(join('..data', k), join(dir, k));
      } catch {}
    }
    return ts.slice(2);
  };
  return { dir, write };
}

test('file mode: reads the JSON file, version = the kubelet directory; a ..data swap triggers a re-read with the new version', async () => {
  const vol = kubeletDir();
  const v1 = vol.write({ db: { username: 'notes_app', password: 'first-password-0123456789' } });
  const fetcher = createFileFetcher({ dir: vol.dir });
  const provider = new SecretsProvider({ fetcher, ttlSeconds: 300, redactor: new Redactor(), logger: createLogger({ level: 'error', out: { write() {} } }) });

  assert.equal((await provider.get('db')).reveal().password, 'first-password-0123456789');
  assert.equal(provider.status()[0].versionId, v1);
  assert.deepEqual(provider.status()[0].versionStages, ['file']);

  const changed = new Promise((resolve) => provider.on('loaded', (e) => e.changed && resolve(e)));
  const v2 = vol.write({ db: { username: 'notes_app', password: 'second-password-0123456789' } });
  const e = await Promise.race([changed, new Promise((_, rej) => setTimeout(() => rej(new Error('no re-read within 3 s')), 3000))]);
  assert.equal(e.reason, 'file-changed');
  assert.equal(e.versionId, v2);
  assert.equal(provider.peek('db').password, 'second-password-0123456789');
  fetcher.close();
});

test('file mode: a secret ID cannot reach outside the directory', async () => {
  const vol = kubeletDir();
  vol.write({ db: { password: 'x-0123456789' } });
  const fetcher = createFileFetcher({ dir: vol.dir });
  await assert.rejects(fetcher.fetch('../../etc/passwd'), /ENOENT/);
  fetcher.close();
});
