# Step v2: database users that expire

**Step v2: database users that expire.** No database password is stored. OpenBao's
database secrets engine creates a Postgres user and a Valkey user for each app instance,
each with a lease. The app renews the leases, takes a new user before the max TTL and
moves new queries to it while the old pool drains. Revoking a lease drops the user, and
the app recovers on its next query. Only OpenBao knows the database admin's password.

## Run it

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v1-openbao-kv/compose.yaml:steps/v2-openbao-dynamic/compose.yaml
docker compose up --build -d && scripts/compose-check.sh
```

## Evidence

Every job green in [CI run 39164263518](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39164263518), a push to main, on commit `bec8229`.

## Read more

- [Step v2](https://github.com/ephico2real2/openbao-node-poc/tree/v3-openbao-dynamic/steps/v2-openbao-dynamic/README.md)
- Demo pages with this repo's CI screenshots: [demo/README.md](https://github.com/ephico2real2/openbao-node-poc/blob/main/demo/README.md) (on main)
