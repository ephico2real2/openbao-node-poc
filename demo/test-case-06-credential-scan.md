# Test case 6 — No credential in any container or pod

[← all test cases](README.md)

**What it proves:** the actual passwords, not just their names, appear nowhere outside the app's memory: not in container configuration, the process environment, any file, the databases (only hashes), or any log.

**Catalogue IDs:** C1–C16 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** `compose (sdk)`, `compose (agent)`, `kind` · **Evidence from:** [CI run 39093063634](https://github.com/ephico2real2/aws-secrets-manager-node-poc/actions/runs/39093063634), published on [`ci-captures`](https://github.com/ephico2real2/aws-secrets-manager-node-poc/tree/ci-captures)

## Steps

```bash
scripts/credential-scan.sh compose      # or: scripts/credential-scan.sh k8s
```

## How it works

1. It reads every password from the Secrets Manager stand-in: all secrets, current and previous versions (6 values here: the app and admin passwords for Postgres and Redis, before and after the rotations of test cases 2 and 3; without those you'll see 4).
2. It keeps them in a mode-600 temp file that is deleted on exit, passes them into containers only on stdin (never as arguments), and **never prints them**.
3. It searches each place below for those exact strings and reports `clean` or `FOUND n`.

`scripts/compose-check.sh` and `scripts/k8s-check.sh` run it **after** the end-to-end test, so the logs already hold the rotations and the six leak attempts.

## Evidence from the run (Docker Compose)

```
== credential scan (compose): searching for 6 secret values from Secrets Manager (every version); the values are never printed
-- containers
  ok    app: container config (env, command, labels: docker inspect)   clean
  ok    aws-mock: container config (env, command, labels: docker inspect) clean
  ok    postgres: container config (env, command, labels: docker inspect) clean
  ok    redis: container config (env, command, labels: docker inspect) clean
  ok    seed: container config (env, command, labels: docker inspect)  clean
  ok    app: process environment values (/proc/1/environ)              clean
  ok    app: every readable file (5828 files)                          clean
  ok    postgres: data directory and config (plaintext passwords?)     clean
  ok    redis: data and ACL files (plaintext passwords?)               clean
-- logs
  ok    app: log                                                       clean
  ok    aws-mock: log                                                  clean
  ok    postgres: log                                                  clean
  ok    redis: log                                                     clean
  ok    seed: log                                                      clean
-- debug logging (LOG_LEVEL=debug)
  ok    app log names the secrets and keys it consumed                 6 line(s)
  ok    every password is shown as ******** (length, fingerprint)      yes
credential-scan: no credential value found anywhere it must not be
```

## Evidence from the run (Kubernetes, kind)

```
== credential scan (k8s): searching for 6 secret values from Secrets Manager (every version); the values are never printed
-- Kubernetes objects
  ok    pod specs, Deployments, Jobs (env, args, annotations)          clean
  ok    ConfigMaps                                                     clean
  ok    Secrets (decoded)                                              clean
  ok    events                                                         clean
-- inside the app pod
  ok    app: process environment values (/proc/1/environ)              clean
  ok    app: every readable file (5829 files)                          clean
  ok    postgres pod: data directory (plaintext passwords?)            clean
  ok    redis pod: data and ACL files (plaintext passwords?)           clean
-- logs (every container, current and previous)
  ok    aws-mock-7dc6d4744f-8snlw: logs                                clean
  ok    postgres-7f4f4f4bcc-qzvh5: logs                                clean
  ok    redis-7cf5965cd7-k952r: logs                                   clean
  ok    secure-notes-6648cc8b67-mvp4s: logs                            clean
  ok    seed-nt9z4: logs                                               clean
-- debug logging (LOG_LEVEL=debug)
  ok    app log names the secrets and keys it consumed                 6 line(s)
  ok    every password is shown as ******** (length, fingerprint)      yes
        e.g. {"secretId":"/elasticache/dev/notes-cache/app","versionId":"77830568-80be-41f2-b8d1-17e03bf1ce9d","source":"sdk","keys":["host=redis","port=6379","username=no*****pp","password=******** (32 chars, fp=1a926a75)"]}
credential-scan: no credential value found anywhere it must not be
```

For the scan to mean anything, it has to find a leak when there is one: [test case 7](test-case-07-reveal-flag.md) turns on a flag that writes the passwords to the log, and the same scan finds them, there and only there.
