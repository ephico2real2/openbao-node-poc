# backend/

[← Project README](../README.md) · [How the app works](../docs/learn/04-secure-notes-app.md) · [Request flows](../docs/learn/06-request-flows.md)

The Secure Notes app: Node.js 22, no framework, and four runtime dependencies (`pg`,
`ioredis`, and the AWS SDK clients for Secrets Manager and STS). OpenBao and Vault will be
reached with plain `fetch`, adding none (epic B2). It also serves the
dashboard in [`../frontend`](../frontend/README.md).

```bash
npm ci && npm test        # unit tests (node --test)
```

To run the app itself, use Docker Compose at the repository root: it needs Postgres, Redis
and the AWS stand-in.

## Code map

| Path | What it does |
| --- | --- |
| `src/server.js` | Startup: refuse unsafe settings, load both secrets (retrying while the stack comes up), connect, serve. The only place the process exits |
| `src/config.js` | Every setting, from the environment or a config file. Refuses credentials in the environment (`DB_PASSWORD`, `DATABASE_URL`, `REDIS_URL`…); in production it also refuses static AWS keys, demo mode, mock endpoints, `LOG_FORMAT=pretty` and the reveal flag |
| `src/secrets/provider.js` | The secrets cache: TTL with jitter, single-flight, stale-on-error up to a limit, forced refresh after an authentication failure |
| `src/secrets/fetchers.js` | How a secret is read: the AWS SDK (`SECRETS_MODE=sdk`), or the local agent with its SSRF token (`SECRETS_MODE=agent`) |
| `src/secrets/naming.js` | The naming convention `/{service}/{env}/{resource}/{name}` ([reference](../docs/reference/secret-naming.md)) |
| `src/secrets/SecretValue.js`, `redactor.js`, `mask.js` | A value only comes out through `.reveal()`; every log line and API response is scrubbed of registered values; debug lines show `******** (32 chars, fp=…)` |
| `src/clients/db.js`, `cache.js` | Rotation-aware clients: `pg` reads the password for each new connection; on `28P01` or `WRONGPASS` the client refreshes the secret and retries |
| `src/alerts/catalogue.js` | **Every event name the app logs on purpose**, and which ones should raise an alert (the alert path itself is epic B7) |
| `src/log.js`, `logfmt.js`, `logship/` | JSON logs (or `LOG_FORMAT=pretty`), redacted before any copy leaves the process: stdout, a file for the CloudWatch agent (`LOG_FILE`), OpenTelemetry to a collector (`LOG_OTLP_ENDPOINT`) |
| `src/routes.js`, `http.js` | The API. `/api/demo/*` routes exist only with `DEMO_MODE=true`, which production refuses |
| `src/security/checks.js` | The dashboard's **Security posture** checks |
| `src/demo/` | The lab-only rotator and its crypto helpers |
| `scripts/seed-local.js`, `smoke-test.js` | The seed job (local stacks only) and the end-to-end smoke test the check scripts run |
| `test/` | Unit tests: secrets and the cache, masking and redaction, naming, logging |
| `Dockerfile` | Build it from the repository root (`docker compose build app`). Runs as UID 1000; OpenShift replaces that with an arbitrary UID, which works unchanged |

## Settings

The full list is in `src/config.js`. These are the ones you'll touch:

| Setting | Meaning |
| --- | --- |
| `SECRETS_MODE` | `sdk` (default) or `agent`. `SECRETS_PROVIDER` (`aws`, `openbao`, `vault`) arrives with epic B2 |
| `SECRETS_ENV`, `DB_SECRET_RESOURCE`, `REDIS_SECRET_RESOURCE` | Build the secret names from the convention, or set `DB_SECRET_ID` / `REDIS_SECRET_ID` directly |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_SSL`; `REDIS_HOST`, `REDIS_PORT`, `REDIS_TLS` | Where to connect. Never a password |
| `LOG_LEVEL`, `LOG_FORMAT`, `LOG_FILE`, `LOG_OTLP_ENDPOINT` | Logging. `LOG_REVEAL_SECRETS=true` is a lab-only flag that production refuses |
| `DEMO_MODE` | Turns on the dashboard's labs (rotation, leak test, detection). Refused in production |
