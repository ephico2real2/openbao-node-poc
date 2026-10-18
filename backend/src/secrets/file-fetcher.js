// SECRETS_MODE=file (step v3): the credentials are files in a directory that
// Kubernetes mounts from a Secret, which External Secrets Operator keeps in
// sync with OpenBao. The app holds no OpenBao identity at all in this mode.
//
//   <dir>/db       {"username": ..., "password": ...}   (one JSON document per secret ID)
//   <dir>/redis
//
// How an update arrives: ESO rewrites the Secret; the kubelet writes the new
// files into a fresh timestamped directory and atomically swaps the ..data
// symlink to it. So:
//   - the "version" of a value is that directory's name (..2026_10_18_...);
//   - a watch on the directory sees the swap and asks the cache to re-read;
//   - the cache TTL re-reads anyway, in case a watch event is missed.
// Never use subPath for this mount: a subPath file is never updated.

import { readFile, readlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

export function createFileFetcher({ dir, logger, watchImpl = watch }) {
  const log = logger?.child({ component: 'secrets-file' });
  const known = new Set();
  const seen = new Map(); // file -> { hash, version }
  let handler = () => {};
  let watcher;
  let debounce;

  function startWatch() {
    if (watcher) return;
    try {
      watcher = watchImpl(dir, (event, file) => {
        // The kubelet's swap renames ..data; any change in the directory is worth a re-read.
        if (file && !String(file).startsWith('..') && !known.has(String(file))) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          log?.info({ dir, file: String(file ?? ''), event: 'secrets.file.changed' }, 'the mounted secret changed; re-reading');
          for (const id of known) handler(id, 'file-changed');
        }, 250);
        debounce.unref?.();
      });
      watcher.unref?.();
      watcher.on?.('error', (err) => log?.warn({ err }, 'watching the secrets directory failed; the cache TTL still re-reads'));
    } catch (err) {
      log?.warn({ err, dir }, 'cannot watch the secrets directory; the cache TTL still re-reads');
    }
  }

  return {
    kind: 'file',
    onExpiring(fn) {
      handler = fn;
      startWatch();
    },
    async fetch(secretId) {
      const name = basename(String(secretId)); // never a path outside the directory
      const text = await readFile(join(dir, name), 'utf8');
      known.add(name);
      startWatch();
      // The version is when this CONTENT arrived: the time in the name of the
      // kubelet's directory (..2026_10_18_22_03_24.3178266370 -> 22:03:24.317826).
      // The kubelet swaps the whole volume, so an unchanged file keeps its
      // version: only the secret that really changed shows a new one.
      const hash = createHash('sha256').update(text).digest('hex');
      let version = seen.get(name)?.hash === hash ? seen.get(name).version : undefined;
      if (!version) {
        try {
          const d = basename(await readlink(join(dir, '..data')));
          const m = /(\d{2})_(\d{2})_(\d{2})\.(\d{1,6})/.exec(d);
          version = m ? `${m[1]}:${m[2]}:${m[3]}.${m[4]}` : d.replace(/^\.\./, '');
        } catch {
          version = hash.slice(0, 12); // a plain directory (local runs)
        }
        seen.set(name, { hash, version });
      }
      return {
        name: secretId,
        arn: undefined,
        versionId: version,
        versionStages: ['file'],
        createdDate: undefined,
        secretString: text.trim(),
      };
    },
    describe: async () => undefined,
    close: () => watcher?.close(),
  };
}
