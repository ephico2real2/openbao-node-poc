# Test case 8 — Production refuses the reveal flag

[← all test cases](README.md)

**What it proves:** the reveal flag cannot be turned on where it matters: with `NODE_ENV=production` (the image default, and how the `aws` overlay for EKS/ROSA runs it) the app refuses to start.

**Catalogue IDs:** F4 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** unit test, `compose (sdk)` ("Reveal flag in production" step) · **Evidence from:** [CI run 39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271), job `compose (sdk)`: the step's output is in that job's step summary, not on `ci-captures` (the step publishes no file)

## Steps

```bash
docker run --rm -e NODE_ENV=production -e LOG_REVEAL_SECRETS=true \
  -e DB_SECRET_ID=x -e REDIS_SECRET_ID=y secure-notes-app:dev
echo "exit code: $?"
```

## What you should see

One `error` line and no server. Its `msg` is:

```
Refusing to start:
  - LOG_REVEAL_SECRETS must not be enabled in production: it writes secret values to the log
```

and `exit code: 78` (the message is built in `backend/src/config.js`; CI greps for the
same words).

Exit code 78 means "configuration error", so a process manager can be told not to restart the app in a loop on it (systemd: `RestartPreventExitStatus=78`; the EC2 unit that does this is in the sibling repo).

## Why this is enough

- The `aws` overlay never sets the flag, and `NODE_ENV=production` is the image default.
- The `kind` and `openshift` overlays in this repo are demo stacks: they bring their own Postgres, Redis and Secrets Manager stand-in and run in `development` mode, so the flag is allowed there, as in Compose. A real OpenShift deployment against AWS uses the `aws` overlay.
- The same startup guard refuses `DEMO_MODE`, a mock endpoint and static AWS keys in production.
- CI runs this exact command on every push (the `compose (sdk)` job, step "Reveal flag in production — the app refuses to start (exit 78)") and fails unless the app exits 78 with this message; in run 39169755271 that job passed. The unit test `the app refuses LOG_REVEAL_SECRETS in production` checks the guard directly.
