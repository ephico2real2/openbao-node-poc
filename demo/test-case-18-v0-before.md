# Test case 18 — Before: the original `.env` app leaks everywhere

[← all test cases](README.md)

**What it proves:** the starting point is real. `versions/v0-env-file` is the app before the redesign: passwords in a `.env` file, passed in as environment variables, and Redis given its password on the command line. Running the same kinds of checks against it finds the passwords almost everywhere, which is the "before" picture for test case 6.

**Catalogue IDs:** N14 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** `v0-leak` · **Evidence from:** [CI run 39142364657](https://github.com/ephico2real2/aws-secrets-manager-node-poc/actions/runs/39142364657), published on [`ci-captures`](https://github.com/ephico2real2/aws-secrets-manager-node-poc/tree/ci-captures)

## Steps

```bash
cd versions/v0-env-file
docker compose --env-file v0.env up --build -d     # http://localhost:3001
./leak.sh
docker compose down -v
```

The values in `v0.env` are fake. The folder is never published as an image.

## Evidence from the run

```
== v0: where the passwords can be read (anyone with access to the host or the runtime)
  LEAK  the .env file itself                                       3 occurrence(s)
  LEAK  docker compose config (the whole resolved deployment)      8 occurrence(s)
  LEAK  app: exec env                                              3 occurrence(s)
  LEAK  app: /proc/1/environ (the process environment)             3 occurrence(s)
  LEAK  app: inspect (no shell needed)                             3 occurrence(s)
  LEAK  app: its own log (connection strings)                      2 occurrence(s)
  LEAK  redis: inspect (password on the command line)              3 occurrence(s)
  -     redis: ps inside the container                             none
  LEAK  postgres: exec env                                         3 occurrence(s)

8 of 9 places expose a password. In the redesign the same checks find none:
see scripts/credential-scan.sh and docs/learn/02-the-env-file-problem.md.
```

Compare with [test case 6](test-case-06-credential-scan.md), where the scan finds no password anywhere, and with [chapter 2 of the learning path](../docs/learn/02-the-env-file-problem.md), which explains each of these places.
