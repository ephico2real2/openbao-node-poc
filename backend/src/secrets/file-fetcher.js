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
      let version;
      try {
        version = basename(await readlink(join(dir, '..data'))); // the kubelet's timestamped directory
      } catch {
        version = createHash('sha256').update(text).digest('hex').slice(0, 12); // a plain directory (local runs)
      }
      return {
        name: secretId,
        arn: undefined,
        versionId: version.replace(/^\.\./, ''),
        versionStages: ['file'],
        createdDate: undefined,
        secretString: text.trim(),
      };
    },
    describe: async () => undefined,
    close: () => watcher?.close(),
  };
}
