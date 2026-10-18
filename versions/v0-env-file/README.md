# v0: Secure Notes with credentials in a `.env` file

[← Repository](../../README.md) · [Source review](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/modernization/01-source-review.md) · [Chapter 2](../../docs/learn/02-the-env-file-problem.md)

**This is the "before" picture of the story. It works, and it leaks. Never deploy it.**

The original app reads its Postgres and Redis passwords from environment variables,
loaded from a `.env` file. That is how most apps start. The rest of this repository is
the redesign, in which credentials are fetched at runtime from AWS Secrets Manager.

| Version | Where | Credentials come from |
| --- | --- | --- |
| **v0** (this folder) | `versions/v0-env-file/` | `v0.env`: plain values, pasted into each service that needs them |
| **v1** (tag `v1-secrets-manager`, once the milestone is released) | the repository root | AWS Secrets Manager at runtime; nothing in env, files, images or logs |
| **v2** (tag `v2-alerts`, once released) | the repository root | as v1, plus logs-first alerting and the detection lab |

## Run it and find the passwords

```bash
cd versions/v0-env-file
docker compose up --build -d     # http://localhost:3001
./leak.sh                        # where the passwords can be read
docker compose down -v
```

`leak.sh` looks in nine places and passes when it finds the passwords in at least eight. All the values are fake (`Example-Only-…`).
The ninth, `ps` inside the Redis container, usually comes up empty: Redis rewrites its
process title, so the command-line password shows up through `inspect` instead.

| Place | Why it leaks |
| --- | --- |
| `v0.env` | Plaintext on disk, and often copied to laptops, wikis and CI |
| `docker compose config` | The resolved deployment includes every value |
| `exec env`, `/proc/1/environ`, `inspect` | The container's environment is readable through the runtime, without even a shell |
| The app's log | A "helpful" startup line and the error handler print connection strings |
| Redis `inspect` and `ps` | The password is on the command line |
| Postgres `exec env` | The same password is pasted a second time |

The [source review](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/modernization/01-source-review.md) turns these into
findings F1–F7. Run [`scripts/credential-scan.sh`](../../scripts/credential-scan.sh)
against the redesigned stack and the same kinds of places are clean.

CI runs this demo on every push and fails if the leak can **no longer** be found, so the
story can't quietly stop being true.
