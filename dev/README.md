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
| [`redis-entrypoint.sh`](redis-entrypoint.sh) | Starts Redis with an ACL file, so the users the seed job creates survive a restart |

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

The OpenBao and Vault servers (epics B3 and B6) will live in `dev/openbao/` and `dev/vault/`:
real servers with lab configuration, not stand-ins.
