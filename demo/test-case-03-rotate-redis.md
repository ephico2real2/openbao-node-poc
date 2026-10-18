# Test case 3 — Rotate the Redis password from the dashboard

[← all test cases](README.md)

**What it proves:** the cache password rotates the same way; Redis users accept two passwords, so the old one keeps working until the new one is in place, then it is revoked.

**Catalogue IDs:** R1, R2 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** `compose (sdk)`, `compose (agent)`, `kind (aws)` · **Evidence from:** [CI run 39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271): [captures](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2159Z_ci_run39169755271-1_compose-compose-sdk), [walk output](https://github.com/ephico2real2/openbao-node-poc/blob/ci-captures/2026-10-18T2159Z_ci_run39169755271-1_compose-compose-sdk/walk.log)

## Steps

1. Click **Rotate Redis secret**. The steps are the same as Postgres, plus `revokeOld`: for a moment both passwords are valid, then the old one is removed.
2. Click **Drop connections**.

## What you should see

`Reconnected to Redis with the rotated credential` in the timeline, and the Redis card back to green with a new version.

![A Redis rotation and the app recovering](images/03-redis-rotation.png)

## Evidence from the run

```
03-redis-rotation: found "revokeOld", "Reconnected to Redis with the rotated credential" — expectations met
```

On AWS the same thing is done by a rotation function every 30 days; its four tests are `R3` in the catalogue. The EC2 stack that deploys that function, and the workflow that triggers it for real, live in the sibling repo, [aws-secrets-manager-node-poc](https://github.com/ephico2real2/aws-secrets-manager-node-poc), not here.
