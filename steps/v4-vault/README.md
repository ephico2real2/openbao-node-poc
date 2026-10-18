# Step v4: the same app on HashiCorp Vault

[← Project README](../../README.md) · [Step v2](../v2-openbao-dynamic/README.md) · [ADR-002](../../docs/modernization/03-adr-002-openbao-first.md) · Epic B6

This step runs the same image with `SECRETS_PROVIDER=vault` against **HashiCorp Vault
2.2.0**. OpenBao is a fork of Vault and keeps its HTTP API, so the app's client
([`backend/src/secrets/bao/`](../../backend/src/secrets/bao)) is unchanged. So are the
AppRole login with the secret ID in a file, the KV v2 reads, and the dynamic database
users with their leases. The only provider-specific part of the app is the wording of
its messages.

| | OpenBao (steps v1, v2) | Vault (this step) |
| --- | --- | --- |
| Licence | MPL-2.0 | BSL 1.1 (see ADR-002) |
| Image | `docker.io/openbao/openbao:2.7.1` | `docker.io/hashicorp/vault:2.2.0` |
| Starting with no manual step | `seal "static"` and self-init, both in the config file | No such features. [`dev/vault/entrypoint.sh`](../../dev/vault/entrypoint.sh) runs `operator init` with one key share and unseals. It configures Vault with the root token, kept in the script's memory only, then revokes that token |
| The unseal secret | the static seal key on the data volume (lab only) | the one unseal key on the data volume (lab only) |
| Audit device | declared in the config (the API can't create one) | enabled through the API by the entrypoint |
| Policies | in [`dev/openbao/config.hcl`](../../dev/openbao/config.hcl) | the same text, in [`dev/vault/policies/`](../../dev/vault/policies) |
| Cache plugin | `valkey-database-plugin`, against Valkey 8.1 | `redis-database-plugin`, against Redis 7. Vault documents both root rotation and dynamic roles for it |

## Run it

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v4-vault/compose.yaml
docker compose down -v
docker compose up --build -d          # http://localhost:3000
scripts/compose-check.sh
```

**Check:** the dashboard says **HashiCorp Vault**. The timeline says "Vault issued this
instance its own db user". `docker compose logs vault | grep vault-lab` shows the
entrypoint's three lines:
- initialised with one key share and unsealed;
- configured, with the root token revoked;
- after a restart, unsealed with the key from the data volume.

The checks are the same as step v2's:
- `compose-check.sh` finds the app logged in to Vault with its own role, the seed job's bootstrap secret ID spent, the app's policy refusing other paths, leased Postgres sessions, renewals, revocation, recovery and cleanup;
- the credential scan searches Vault's container, audit log and storage the way it searches OpenBao's.

The CI job `compose (vault)` runs it on every push, with the same dashboard walk as step v2.

## What this shows

- **The app is portable between the two.** One setting, `SECRETS_PROVIDER`, changes only the wording.
- **The difference is in operating the server.** OpenBao's static seal and self-init make a server that is ready from its config file alone. Vault's entrypoint has to script `init`/`unseal` and briefly hold a root token. In production, Vault would use a KMS, an HSM or transit auto-unseal, and its setup would come from Terraform or similar.

## Lab only

- The unseal key sits next to the data.
- One key share instead of the default five with a threshold of three.
- Plain HTTP on the Compose network.
