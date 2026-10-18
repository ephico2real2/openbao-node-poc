# Test case 24 — An alert when someone else reads the app's secret (step v5)

[← all test cases](README.md) · [Step v5](../steps/v5-detection/README.md) · [Chapter 11](../docs/learn/11-detection-on-the-audit-log.md)

**What it proves:** OpenBao's audit log (with values HMAC'd) is shipped to VictoriaLogs and
checked by a vmalert rule. Nothing the app does raises an alert: not its reads, not its
rotations, not the credential scan. When the over-broad `ops-admin` role reads the app's
Postgres secret, an alert names the role and the path.

**Catalogue IDs:** T1–T5 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** `compose (openbao-detection)`, and the `checks` job (`dev/detect/test-detection.sh` with the real binaries) · **Evidence from:** [CI run 39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271): [console capture](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2202Z_ci_run39169755271-1_compose-compose-openbao-detection-alerts), [check output](https://github.com/ephico2real2/openbao-node-poc/blob/ci-captures/2026-10-18T2203Z_ci_run39169755271-1_compose-openbao-detection-logs/compose-check.txt)

## Steps

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v1-openbao-kv/compose.yaml:steps/v5-detection/compose.yaml
docker compose down -v && docker compose up --build -d
scripts/compose-check.sh            # ends by running the intruder and waiting for the alert
```

Or run the intruder yourself with `docker compose run --rm intruder`, then open the alert
console at <http://localhost:3100>.

## What you should see

One alert, naming the role that read the secret and the path it read:

![The alert console](images/detection-07-alert-console.png)

## Evidence from the run

```
SERVICE         IMAGE                                             STATE
…
victorialogs    docker.io/victoriametrics/victoria-logs:v1.53.0   running
vmalert         docker.io/victoriametrics/vmalert:v1.154.0        running
…
== step v5: OpenBao audit log -> VictoriaLogs -> vmalert -> alert console
  ok    VictoriaLogs holds 107 audit response line(s) shipped from OpenBao's audit log
  ok    no alert from everything the app did (its role is secure-notes-app)
  ..    docker compose run --rm intruder (role ops-admin reads the app's Postgres secret)
        [intruder] read secret/data/rds/dev/notes-db/app as role ops-admin: version 3 (value not printed)
  ok    alert SecretReadByUnexpectedIdentity: role ops-admin read secret/data/rds/dev/notes-db/app
        "An app credential was read by 'ops-admin', not by the app"
```

The credential scan in the same run also searches the container config and the logs of
the shipper, VictoriaLogs and vmalert, and finds no value there. OpenBao's audit log, the
source of every line shipped, comes back `clean` too: it holds HMACs, not values.
