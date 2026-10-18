# Step v4: the same app on HashiCorp Vault

**Step v4: the same app on HashiCorp Vault.** `SECRETS_PROVIDER=vault` runs the same image
and client against Vault 2.2.0: AppRole, KV v2 and leased database users, with Vault's
Redis plugin for the cache. Only the server setup differs. Vault has no self-init, so a
lab entrypoint initialises it with one key share, unseals it, configures it with the root
token in memory only, then revokes that token. CI also runs that entrypoint against the
real Vault binary.

## Run it

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v4-vault/compose.yaml
docker compose up --build -d && scripts/compose-check.sh
```

## Evidence

Every job green in [CI run 39169753464](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169753464), a pull request run; its run on main was cancelled by the next push, on commit `17a6f4e`. (The `images` job runs on pushes to main only.)

## Read more

- [Step v4](https://github.com/ephico2real2/openbao-node-poc/tree/v5-vault/steps/v4-vault/README.md)
- Demo pages with this repo's CI screenshots: [demo/README.md](https://github.com/ephico2real2/openbao-node-poc/blob/main/demo/README.md) (on main)
