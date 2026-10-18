# Test case 6 — No credential in any container or pod

[← all test cases](README.md)

**What it proves:** the actual passwords, not just their names, appear nowhere outside the app's memory: not in container configuration, the process environment, any file, the databases (only hashes), or any log.

**Catalogue IDs:** C1–C16 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** `compose (sdk)`, `compose (agent)`, `kind (aws)` · **Evidence from:** [CI run 39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271): [compose check output](https://github.com/ephico2real2/openbao-node-poc/blob/ci-captures/2026-10-18T2201Z_ci_run39169755271-1_compose-sdk-logs/compose-check.txt), [kind check output](https://github.com/ephico2real2/openbao-node-poc/blob/ci-captures/2026-10-18T2201Z_ci_run39169755271-1_kind-aws-logs/k8s-check.txt)

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
  ok    app: every readable file (5845 files)                          clean
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
  ok    app: every readable file (5846 files)                          clean
  ok    postgres pod: data directory (plaintext passwords?)            clean
  ok    redis pod: data and ACL files (plaintext passwords?)           clean
-- logs (every container, current and previous)
  ok    aws-mock-5465c4b6f4-vw8ws: logs                                clean
  ok    postgres-76bdffdcf-76x4p: logs                                 clean
  ok    redis-65c6ffd4cc-pbfxb: logs                                   clean
  ok    secure-notes-644c47bfb6-8xzxt: logs                            clean
  ok    seed-mq96c: logs                                               clean
-- debug logging (LOG_LEVEL=debug)
  ok    app log names the secrets and keys it consumed                 6 line(s)
  ok    every password is shown as ******** (length, fingerprint)      yes
        e.g. {"secretId":"/rds/dev/notes-db/app","versionId":"0c1b0cc8-e759-4bc4-b4fd-782a598e254f","source":"sdk","keys":["engine=postgres","host=postgres","port=5432","dbname=n****","username=no*****pp","password=******** (32 chars, fp=676b1a79)"]}
credential-scan: no credential value found anywhere it must not be
```

For the scan to mean anything, it has to find a leak when there is one: [test case 7](test-case-07-reveal-flag.md) turns on a flag that writes the passwords to the log, and the same scan finds them, there and only there.
