# Step v5: detection on the audit log, and the tutorial

**Step v5: an alert when anyone but the app reads its secret.** OpenBao's audit log (values
HMAC'd) is shipped to VictoriaLogs and checked by a vmalert rule. Nothing the app does
raises an alert. When the over-broad `ops-admin` AppRole reads the app's Postgres secret,
an alert names the role and the path.

This tag also carries the tutorial (epic B8): learning chapters 7–11, demo pages 19–24
with screenshots from CI, and a guide and tutorial that cover every step.

## Run it

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v1-openbao-kv/compose.yaml:steps/v5-detection/compose.yaml
docker compose up --build -d && scripts/compose-check.sh
```

## Evidence

Every job green in [CI run 39174595142](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39174595142), a push to main, on commit `f30aed6`.

## Read more

- [Step v5](https://github.com/ephico2real2/openbao-node-poc/tree/v6-detection/steps/v5-detection/README.md)
- [Demo pages 19–24](https://github.com/ephico2real2/openbao-node-poc/tree/v6-detection/demo/README.md)
- [Learning path](https://github.com/ephico2real2/openbao-node-poc/tree/v6-detection/docs/learn/README.md)
- Demo pages with this repo's CI screenshots: [demo/README.md](https://github.com/ephico2real2/openbao-node-poc/blob/main/demo/README.md) (on main)
