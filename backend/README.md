# backend/

[← Project README](../README.md) · [How the app works](../docs/learn/04-secure-notes-app.md) · [Request flows](../docs/learn/06-request-flows.md)

The Secure Notes app: Node.js 22, no framework, and four runtime dependencies (`pg`,
`ioredis`, and the AWS SDK clients for Secrets Manager and STS). OpenBao and Vault are
reached with plain `fetch`, adding none. It also serves the
dashboard in [`../frontend`](../frontend/README.md).

```bash
npm ci && npm test        # unit tests (node --test)
```

To run the app itself, use Docker Compose at the repository root: it needs Postgres, Redis
and a secrets manager (the AWS stand-in, or OpenBao with [step v1](../steps/v1-openbao-kv/README.md)).
The OpenBao test against a real server runs when `BAO_BIN` points at the `bao` binary
(CI downloads the release, checksum-verified): `BAO_BIN=/path/to/bao npm test`.

## Code map

| Path | What it does |
| --- | --- |
| `src/server.js` | Startup: refuse unsafe settings, load both secrets (retrying while the stack comes up), connect, serve. The only place the process exits |
| `src/config.js` | Every setting, from the environment or a config file. Refuses credentials in the environment (`DB_PASSWORD`, `DATABASE_URL`, `REDIS_URL`…); in production it also refuses static AWS keys, demo mode, mock endpoints, `LOG_FORMAT=pretty` and the reveal flag |
| `src/secrets/provider.js` | The secrets cache: TTL with jitter, single-flight, stale-on-error up to a limit, forced refresh after an authentication failure |
| `src/secrets/index.js` | Picks the secrets manager (`SECRETS_PROVIDER`): the fetcher the cache reads through, and the store the seed job and the demo rotator write through |
| `src/secrets/fetchers.js` | AWS: the SDK (`SECRETS_MODE=sdk`), or the local agent with its SSRF token (`SECRETS_MODE=agent`) |
| `src/secrets/aws-store.js` | AWS writes: create, random password, AWSPENDING then AWSCURRENT |
| `src/secrets/bao/client.js` | OpenBao/Vault: HTTP client, AppRole login with the secret ID read from a file, token renewal at 2/3 of the TTL, re-login at the max TTL or on 403 |
| `src/secrets/file-fetcher.js` | `SECRETS_MODE=file`: one JSON file per secret ID; version = the kubelet's directory; a watch re-reads on the `..data` swap |
| `src/secrets/bao/leases.js` | Step v2: dynamic users. Issue, renew at 2/3 of the TTL, re-issue before the max TTL, revoke the replaced lease after the drain and all leases at shutdown |
| `src/secrets/bao/kv.js` | OpenBao/Vault KV v2: the fetcher (version = KV version), and the store (create with `cas: 0`, pending at `<name>/pending`, promote with check-and-set) |
| `src/secrets/naming.js` | The naming convention `/{service}/{env}/{resource}/{name}` ([reference](../docs/reference/secret-naming.md)) |
| `src/secrets/SecretValue.js`, `redactor.js`, `mask.js` | A value only comes out through `.reveal()`; every log line and API response is scrubbed of registered values; debug lines show `******** (32 chars, fp=…)` |
| `src/clients/db.js`, `cache.js` | Rotation-aware clients: `pg` reads the password for each new connection; on `28P01` or `WRONGPASS` the client refreshes the secret and retries |
| `src/alerts/catalogue.js` | **Every event name the app logs on purpose**, and which ones should raise an alert (the alert path itself is epic B7) |
| `src/log.js`, `logfmt.js`, `logship/` | JSON logs (or `LOG_FORMAT=pretty`), redacted before any copy leaves the process: stdout, a file for the CloudWatch agent (`LOG_FILE`), OpenTelemetry to a collector (`LOG_OTLP_ENDPOINT`) |
| `src/routes.js`, `http.js` | The API. `/api/demo/*` routes exist only with `DEMO_MODE=true`, which production refuses |
| `src/security/checks.js` | The dashboard's **Security posture** checks |
| `src/demo/` | The lab-only rotator and its crypto helpers |
| `scripts/seed-local.js`, `smoke-test.js` | The seed job (local stacks only) and the end-to-end smoke test the check scripts run |
| `test/` | Unit tests: secrets and the cache, masking and redaction, naming, logging, config refusals, the OpenBao client (fake server, and a real one with `BAO_BIN`) |
| `Dockerfile` | Build it from the repository root (`docker compose build app`). Runs as UID 1000; OpenShift replaces that with an arbitrary UID, which works unchanged |

## Settings

The full list is in `src/config.js`. These are the ones you'll touch:

| Setting | Meaning |
| --- | --- |
| `SECRETS_PROVIDER` | `aws` (default), `openbao`, or `vault` (the same client; its own lab comes with epic B6) |
| `SECRETS_MODE` | aws: `sdk` (default) or `agent`. openbao/vault: `api` (default), or `file`: read `SECRETS_DIR` (default `/var/run/secrets/secure-notes`), a Secret that External Secrets Operator keeps in sync, watched for the kubelet's swap ([step v3](../steps/v3-k8s/README.md)); the app then needs no OpenBao address or identity |
| `BAO_ADDR`, `BAO_ROLE_ID`, `BAO_SECRET_ID_FILE` | openbao/vault: the server, the AppRole role ID (not a secret), and the **file** holding the secret ID (mode 0400). `BAO_TOKEN`, `VAULT_TOKEN`, `BAO_SECRET_ID` and `VAULT_SECRET_ID` are refused. Production requires `https://` |
| `BAO_AUTH_MOUNT`, `BAO_KV_MOUNT`, `BAO_DB_MOUNT`, `BAO_NAMESPACE` | Optional: `approle`, `secret`, `database`, none. A secret ID under `<BAO_DB_MOUNT>/creds/` (e.g. `DB_SECRET_ID=database/creds/notes-app`) is a dynamic user with a lease ([step v2](../steps/v2-openbao-dynamic/README.md)); set `DB_HOST`/`REDIS_HOST` with it, since the credential carries no host |
| `SECRETS_ENV`, `DB_SECRET_RESOURCE`, `REDIS_SECRET_RESOURCE` | Build the secret names from the convention, or set `DB_SECRET_ID` / `REDIS_SECRET_ID` directly |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_SSL`; `REDIS_HOST`, `REDIS_PORT`, `REDIS_TLS` | Where to connect. Never a password |
| `LOG_LEVEL`, `LOG_FORMAT`, `LOG_FILE`, `LOG_OTLP_ENDPOINT` | Logging. `LOG_REVEAL_SECRETS=true` is a lab-only flag that production refuses |
| `DEMO_MODE` | Turns on the dashboard's labs (rotation, leak test, detection). Refused in production |
