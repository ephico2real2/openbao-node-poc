# Test case 9 — Agent mode

[← all test cases](README.md)

**What it proves:** the app can read its secrets through a local agent (the AWS Workload Credentials Provider on EC2) instead of calling Secrets Manager; the agent only answers requests carrying its token, which only the app can read.

**Catalogue IDs:** A1–A4 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** `compose (agent)` · **Evidence from:** [CI run 39093063634](https://github.com/ephico2real2/aws-secrets-manager-node-poc/actions/runs/39093063634), published on [`ci-captures`](https://github.com/ephico2real2/aws-secrets-manager-node-poc/tree/ci-captures)

## Steps

```bash
docker compose down -v
export COMPOSE_FILE=docker-compose.yml:docker-compose.agent.yml   # every compose command now uses both files
docker compose up --build -d
scripts/compose-check.sh          # wait for the app, the agent checks, smoke test, credential scan
unset COMPOSE_FILE
```

## What you should see

`mode: agent`, the `Workload Credentials Provider` badge, **Secret retrieval channel** now `pass`, and one extra posture check: **Agent SSRF token protected**.

![The dashboard in agent mode](images/agent-01-dashboard.png)

## Evidence from the run

```
== secrets mode: agent
  ok    the agent served 4 secret fetch(es) to the app
  ok    the agent token is visible only to the agent and the app
  ok    the agent rejects a request without the SSRF token (403)
```

The app's debug log records where each token came from, masked:

```json
{
  "msg": "agent request: SSRF token from file, masked",
  "component": "agent",
  "secretId": "/rds/dev/notes-db/app",
  "agent": "http://127.0.0.1:2773",
  "tokenFile": "/var/run/awssm/token",
  "ssrfTokenMasked": "******** (43 chars, fp=5d3a5b56)",
  "refreshNow": false
}
```

![The debug log in agent mode](images/agent-06-debug-log.png)

The credential scan runs in this mode too (as part of `compose-check.sh`, with `COMPOSE_FILE` set so it includes the agent container) and finds nothing.

When you're done: `COMPOSE_FILE=docker-compose.yml:docker-compose.agent.yml docker compose down -v`.
