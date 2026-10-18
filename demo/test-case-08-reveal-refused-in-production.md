# Test case 8 — Production refuses the reveal flag

[← all test cases](README.md)

**What it proves:** the reveal flag cannot be turned on where it matters: with `NODE_ENV=production` (the image default, and how the EC2 stack and the `aws` overlay for EKS/ROSA run it) the app refuses to start.

**Catalogue IDs:** F4 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** unit test, `compose (sdk)` ("Reveal flag in production" step) · **Evidence from:** [CI run 39093063634](https://github.com/ephico2real2/aws-secrets-manager-node-poc/actions/runs/39093063634), published on [`ci-captures`](https://github.com/ephico2real2/aws-secrets-manager-node-poc/tree/ci-captures)

## Steps

```bash
docker run --rm -e NODE_ENV=production -e LOG_REVEAL_SECRETS=true \
  -e DB_SECRET_ID=x -e REDIS_SECRET_ID=y secure-notes-app:dev
echo "exit code: $?"
```

## What you should see

```
{"time":"2026-10-18T03:24:23.852Z","level":"error","app":"secure-notes","msg":"Refusing to start:\n  - LOG_REVEAL_SECRETS must not be enabled in production: it writes secret values to the log"}
exit code: 78
```

Exit code 78 means "configuration error": on EC2, systemd is told not to restart the app in a loop on it (`RestartPreventExitStatus=78`).

## Why this is enough

- The CloudFormation template and the `aws` overlay never set the flag, and `NODE_ENV=production` is the image default.
- The `kind` and `openshift` overlays in this repo are demo stacks: they bring their own Postgres, Redis and Secrets Manager stand-in and run in `development` mode, so the flag is allowed there, as in Compose. A real OpenShift deployment against AWS uses the `aws` overlay.
- The same startup guard refuses `DEMO_MODE`, a mock endpoint and static AWS keys in production.
- CI runs this exact command on every push and fails unless the app exits 78 with this message; the unit test `the app refuses LOG_REVEAL_SECRETS in production` checks the guard directly.
