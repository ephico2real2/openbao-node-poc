// KV version 2 on OpenBao / Vault, behind the same two interfaces the AWS path
// uses, so nothing above them changes:
//
//   fetcher  (what the app's cache calls)   fetch(secretId) -> { name, versionId, versionStages, createdDate, secretString }
//                                           describe(secretId) -> { currentVersionId, ... }  (metadata only)
//   store    (the seed job and the demo rotator)   exists, create, read, randomPassword,
//                                           putPending, promote, discardPending, describe labels
//
// Secret names keep the naming convention: /rds/dev/notes-db/app is the KV path
// rds/dev/notes-db/app under the mount (default "secret").
//
// Rotation without stages: AWS keeps a new value as AWSPENDING until it is
// tested. KV v2 has versions but no labels, and a write is immediately the
// current version. So the pending value is written to a sibling path
// (<name>/pending), and "finish" writes it as the next version of <name> with
// check-and-set (cas = the version the rotation started from), then deletes the
// pending copy. The app only ever reads <name>.

const pathOf = (secretId) => String(secretId).replace(/^\/+/, '');

export function createKvFetcher(client, { mount = 'secret' } = {}) {
  return {
    kind: 'bao',
    async fetch(secretId) {
      const out = await client.request('GET', `${mount}/data/${pathOf(secretId)}`);
      const data = out?.data?.data;
      const meta = out?.data?.metadata ?? {};
      if (!data) throw new Error(`no value at ${mount}/${pathOf(secretId)} (deleted or never written)`);
      return {
        name: secretId,
        arn: undefined,
        versionId: String(meta.version),
        versionStages: ['current'],
        createdDate: meta.created_time ? new Date(meta.created_time) : undefined,
        secretString: JSON.stringify(data),
      };
    },
    // Metadata only: lets the dashboard show "a newer version exists" without
    // pulling the new value into memory.
    async describe(secretId) {
      const out = await client.request('GET', `${mount}/metadata/${pathOf(secretId)}`);
      const d = out?.data ?? {};
      return {
        currentVersionId: d.current_version !== undefined ? String(d.current_version) : undefined,
        rotationEnabled: false,
        lastRotatedDate: d.updated_time ? new Date(d.updated_time) : undefined,
        versions: d.versions ? Object.keys(d.versions).length : undefined,
      };
    },
  };
}

export function createKvStore(client, { mount = 'secret' } = {}) {
  const data = (id) => `${mount}/data/${pathOf(id)}`;
  const meta = (id) => `${mount}/metadata/${pathOf(id)}`;
  const pending = (id) => `${mount}/data/${pathOf(id)}/pending`;
  return {
    kind: 'bao',
    labels: {
      pending: 'a pending copy at <name>/pending (the app never reads it)',
      current: 'the next KV version',
      previous: 'the previous KV version (kept, readable by version number)',
    },
    async exists(id) {
      return (await client.request('GET', meta(id), { allow404: true })) !== null;
    },
    /** Write the first version only (cas=0 refuses to overwrite). */
    async create(id, value) {
      await client.request('POST', data(id), { body: { options: { cas: 0 }, data: value } });
    },
    async read(id) {
      const out = await client.request('GET', data(id));
      return { value: out.data.data, versionId: String(out.data.metadata.version) };
    },
    /** 32 hex characters from the server's random source (128 bits). */
    async randomPassword() {
      const out = await client.request('POST', 'sys/tools/random/16', { body: { format: 'hex' } });
      return out.data.random_bytes;
    },
    async putPending(id, value) {
      const out = await client.request('POST', pending(id), { body: { data: value } });
      return String(out.data.version);
    },
    /** Make `value` the current version, only if nobody wrote since `fromVersion`. */
    async promote(id, value, fromVersion) {
      const out = await client.request('POST', data(id), { body: { options: { cas: Number(fromVersion) }, data: value } });
      await this.discardPending(id);
      return String(out.data.version);
    },
    async discardPending(id) {
      await client.request('DELETE', `${mount}/metadata/${pathOf(id)}/pending`, { allow404: true }).catch(() => {});
    },
  };
}
