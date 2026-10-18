# Step v1: the lab on OpenBao (KV v2, AppRole)

**Step v1: the same lab on OpenBao.** `SECRETS_PROVIDER=openbao` switches the same app
image to OpenBao 2.7.1's KV v2. OpenBao starts initialised and unsealed (static seal,
self-init). The app logs in with AppRole, and its secret ID is in a mode-0400 file, never
in env. The seed job's bootstrap secret ID is single-use. Rotation from the dashboard,
the leak test, masking and the credential scan work as on AWS; the scan also searches
OpenBao's audit log (HMACs only) and its raft storage.

## Run it

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v1-openbao-kv/compose.yaml
docker compose up --build -d && scripts/compose-check.sh
```

## Evidence

Every job green in [CI run 39161676954](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39161676954), a push to main, on commit `27ca652`.

## Read more

- [Step v1](https://github.com/ephico2real2/openbao-node-poc/tree/v2-openbao-kv/steps/v1-openbao-kv/README.md)
- [ADR-002](https://github.com/ephico2real2/openbao-node-poc/tree/v2-openbao-kv/docs/modernization/03-adr-002-openbao-first.md)
- Demo pages with this repo's CI screenshots: [demo/README.md](https://github.com/ephico2real2/openbao-node-poc/blob/main/demo/README.md) (on main)
