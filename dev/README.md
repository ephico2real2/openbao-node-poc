# dev/

[← Project README](../README.md)

**Development and CI only. Never deploy anything from here to production.** These are
stand-ins for the AWS services, so the whole lab runs on a laptop or a CI runner with no
AWS account and no real keys. `config.js` refuses a mock endpoint when
`NODE_ENV=production`.

| Path | What it is |
| --- | --- |
| [`aws-mock/server.js`](aws-mock/server.js) | The AWS stand-in on port 4566. It plays **Secrets Manager** (CreateSecret, GetSecretValue, DescribeSecret, PutSecretValue, UpdateSecretVersionStage, GetRandomPassword: what the seed job, the app and rotation use) and **STS** (GetCallerIdentity answers as the caller), for `SECRETS_PROVIDER=aws`. In agent mode (`docker-compose.agent.yml`) it also plays the local credentials agent |
| [`aws-mock/lib/principals.js`](aws-mock/lib/principals.js) | Maps an access key ID to an identity (below) |
| [`aws-mock/test/`](aws-mock/test) | Unit tests for the identities. Run `node --test dev/aws-mock/test/*.test.js` |
| [`aws-mock/Dockerfile`](aws-mock/Dockerfile) | Build it from the repository root (`docker compose build aws-mock`) |
| [`redis-entrypoint.sh`](redis-entrypoint.sh) | Starts Redis (or Valkey, in step v2) with an ACL file, so the users the seed job creates survive a restart |
| [`openbao/config.hcl`](openbao/config.hcl) | A **real** OpenBao server's lab config ([step v1](../steps/v1-openbao-kv/README.md)): raft storage, `seal "static"`, a file audit device, and self-init (KV v2, AppRole, the `secure-notes-app` and `secure-notes-seed` policies and roles). The backend's unit tests start the release binary with this same file |
| [`vault/`](vault) | Step v4: HashiCorp Vault's lab config, the same policies as OpenBao's, and an entrypoint that does what Vault has no config for: `operator init` with one key share, unseal, setup with the root token in memory only, then revoke it |
| [`openbao/entrypoint.sh`](openbao/entrypoint.sh) | Lab only: on the first start, makes the static seal key and the seed job's one-time secret ID on the server's own volumes, then starts the server |

## Who is calling: the access key decides

Local runs sign their requests with dummy keys. The stand-in ignores the signature and reads
the key ID as the caller's identity:

| Key ID | Identity | Used by |
| --- | --- | --- |
| `local-app` | assumed role `secure-notes-app` | the app |
| `local-seed` | the deployer | the seed job |
| `local-intruder-user` | IAM user `mallory` | (kept for the detection lab of epic B7) |
| `local-intruder-role` | assumed role `ops-admin` | (the same) |
| *(unsigned)* | `local-tooling` | the credential scan and health checks |

OpenBao (`dev/openbao/`, epic B3) and later Vault (`dev/vault/`, epic B6) are real servers
with lab configuration, not stand-ins. Lab-only parts are marked in the files: the seal key
sits next to the data, and the listener is plain HTTP.
