# Test cases — what each one proves

Every claim this project makes about credentials has a test that would fail if
the claim stopped being true. This page lists them all, grouped by feature.
For a hands-on walk through the same features, see [TUTORIAL.md](TUTORIAL.md).

**Where they run.** *unit* = `npm test` in `backend/` (also the CI `checks` job).
*compose* = `scripts/compose-check.sh` (CI `compose (sdk)`, `compose (agent)` and `compose (openbao)`).
*kind* = `scripts/k8s-check.sh` (CI `kind`). *walk* = the browser walk
(`scripts/capture/`), which photographs each page and fails if the page lacks
the text it must show.

**Where the evidence is.** Every CI run publishes its screenshots and logs to the
[`ci-captures`](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures)
branch, one folder per job (`…_compose-sdk-logs/compose-check.txt`,
`…_kind-logs/k8s-check.txt`, `…_build-supply-chain/`, and the PNGs), and the
check output is on the run's summary page.

## 1. Credentials are never exposed in the container or pod

The core claim, tested with the **actual values**: `scripts/credential-scan.sh`
reads every password the Secrets Manager stand-in holds (current and previous
version of every secret) and searches for those exact strings. The values are
never printed; each place is reported as `clean` or `FOUND n`.

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| C1 | No password in any container's configuration | `docker inspect` of every container (env, command, labels) | 0 matches | compose |
| C2 | No password in any pod spec, Deployment or Job | `kubectl get pods,deploy,jobs -o yaml` | 0 matches | kind |
| C3 | No password in a ConfigMap | `kubectl get configmaps -o yaml` | 0 matches | kind |
| C4 | No password in a Kubernetes Secret (decoded) | every Secret's data, base64-decoded | 0 matches (only the burned bootstrap Secret exists) | kind |
| C5 | No password in cluster events | `kubectl get events -o yaml` | 0 matches | kind |
| C6 | No password in the app's process environment, by value | `/proc/1/environ` inside the app container/pod | 0 matches | compose, kind |
| C7 | No password in any file in the app container | a walk over every readable file (`/proc`, `/sys`, `/dev` skipped), values passed on stdin | 0 files | compose, kind |
| C8 | Postgres stores no plaintext password | `grep` of its data directory and config | 0 matches (only SCRAM verifiers) | compose, kind |
| C9 | Redis stores no plaintext password | `grep` of `/data` and the ACL file | 0 matches (only `#sha256` hashes) | compose, kind |
| C10 | No password in any log, of any container | logs of app, seed, Postgres, Redis, stand-in (and previous pod instances) | 0 matches | compose, kind |
| C11 | The scan really finds a leak | the app restarted with `LOG_REVEAL_SECRETS=true`, scan run with `EXPECT_REVEALED=1` | FOUND in the app log, and **still 0 everywhere else** | compose (sdk, openbao) |
| C12 | Only the one-time bootstrap Secret exists | names and keys of Opaque Secrets | nothing but `local-bootstrap-*` | kind |
| C13 | No credential-named variable is set | variable **names** in the app pod / EC2 process | none of `PASSWORD`, `PGPASS`, `DATABASE_URL`, `REDIS_URL` | kind, aws |
| C14 | The bootstrap passwords stopped working | log in to Postgres and Redis with them | both rejected | compose, kind |
| C15 | Postgres only ever received password **hashes** | `ALTER ROLE … PASSWORD` lines in the Postgres statement log | every one starts with `SCRAM-SHA-256` | kind |
| C16 | No AWS keys or credentials file on the server | `/proc/<pid>/environ` names, `.aws` folders | none | aws |

## 2. Debug logging: names and keys in full, values masked

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| D1 | Passwords are fully masked; hosts and ports are shown; other values partly masked | `mask.test.js` "masking rules" | `******** (32 chars, fp=…)`, `host=postgres`, `username=no*****pp` | unit |
| D2 | Each load of a secret is logged with its ID, version, source and every key | "secret consumed" test | key list `username, password, host, port, dbname, engine`; no line contains the password | unit |
| D3 | Each login shows which secret key feeds which client setting | "a client login line" test | `user<-username`, `password<-password`, masked | unit |
| D4 | At `info` level there is no credential detail at all | "info level" test | no "secret consumed" line | unit |
| D5 | Agent mode logs where the SSRF token came from, masked | "agent mode" test | `tokenFile` + `ssrfTokenMasked` `******** (N chars, fp=…)` (43 for a real agent token); the token never appears | unit |
| D6 | The running app writes those lines | the scan's debug section | ≥ 1 "secret consumed" line and masked password descriptions | compose, kind |
| D7 | The dashboard's Application log shows them | walk page `06-debug-log` | the panel shows `secret consumed`, `password=******** (`, `connecting with`; not `values revealed` | walk |

## 3. The reveal flag (`LOG_REVEAL_SECRETS=true`, lab use only)

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| F1 | The real value appears only in the "(values revealed)" lines | "LOG_REVEAL_SECRETS" test | exactly one line holds the password; an ordinary line is still `[REDACTED]` | unit |
| F2 | The dashboard's log API never serves revealed lines | same test, `logger.recent()` | no value in the ring; walk page `09-reveal-log-panel` shows no `values revealed` | unit, walk |
| F3 | Without the flag no unredacted path exists | "without the flag" test | `revealUnsafe` is undefined | unit |
| F4 | The app refuses the flag in production | "refuses … in production" test | `assertSafeEnvironment` throws; the app exits 78 | unit |
| F5 | It is impossible to miss while on | walk pages `07-reveal-banner`, `08-reveal-posture` | red banner, `VALUES REVEALED` badge, posture check fails | walk |
| F6 | It works end to end | C11 | FOUND in the app log only | compose (sdk) |

## 4. Loading and caching secrets

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| S1 | Cached; returns a `SecretValue` | "caches values" | 1 API call for 2 reads | unit |
| S2 | 50 concurrent cold reads make one call | "single-flight" | 1 call | unit |
| S3 | `refresh()` bypasses the cache | "refresh() bypasses" | new version returned | unit |
| S4 | Survives a Secrets Manager outage | "stale-on-error" | last good value served | unit |
| S5 | A forced refresh failure is not hidden | "forced refresh failure" | rejects | unit |
| S6 | Fails fast when it can't start | "cold start failure" | first read rejects | unit |
| S7 | The app reads and writes through Postgres and Redis | smoke "health", "notes" | `status: ok`; 2nd read from Redis | compose, kind |
| S8 | The secrets dashboard has no password | smoke "secrets dashboard" | `/api/secrets` has no `"password"` | compose, kind |

## 5. Rotation without a restart

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| R1 | The four rotation steps run against Postgres and Redis | smoke "rotate db/redis secret"; walk `02`, `03` | `finishSecret` reached | compose, kind, walk |
| R2 | After rotation, the app recovers on its own | smoke "drop connections"; walk `02`, `03` | `recovered` events for db and redis; "Reconnected … with the rotated credential" | compose, kind, walk |
| R3 | The Redis rotation function adds, switches, then retires | `redis-rotation.test.js` (4 tests) | passwords `[old,new]` then `[new]`; stages correct; retries safe; refuses bad input | unit |
| R4 | The template's copy of that function is the tested one | `sync-rotation-lambda.js --check` | identical | checks |
| R5 | RDS and Redis rotation on real AWS | `aws.yaml` | `AWSCURRENT` changes; ElastiCache user back to 1 password; app healthy | aws |

## 6. Redaction and the leak test

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| L1 | `SecretValue` never serializes | unit | `[REDACTED]` for JSON, template, `String`, `inspect`; frozen | unit |
| L2 | `status()` has no secret | unit | no match | unit |
| L3 | The logger redacts a loaded secret wherever it appears | unit | no line contains it | unit |
| L4 | `scheme://user:pass@host` is masked even if unknown | unit | `user:[REDACTED]@` | unit |
| L5 | Library error fields (e.g. `err.command`) are dropped | unit | not in output | unit |
| L6 | Six real leak attempts on the running app | smoke "leak test"; walk `04` | `0 of 6 leaked` | compose, kind, walk |
| L7 | No posture check fails | smoke "security posture" | 0 `fail` (12 checks + reveal-flag) | compose, kind |

## 7. Agent mode (`SECRETS_MODE=agent`)

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| A1 | The app reads through the agent | agent log lines | > 0 fetches | compose (agent) |
| A2 | Only the agent and the app can see the token | `test -e` in the stand-in | absent | compose (agent) |
| A3 | The agent rejects a request without the token | token-less request from the app's localhost | HTTP 403 | compose (agent) |
| A4 | The token file is not world-readable | posture check "Agent SSRF token protected" | pass | compose (agent) |

## 8. Platform hardening

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| P1 | No pod runs as root | pod `runAsUser` | none is 0 | kind |
| P2 | Pod Security `restricted` enforced | namespace label | `enforce=restricted` (or the SCC on OpenShift) | kind |
| P3 | IMDSv1 refused on EC2 | token-less metadata request | HTTP 401 | aws |
| P4 | The real dashboard on EC2 hides demo panels | walk `aws.yaml` | no Rotation lab, leak test, log panel | aws |

## 9. Supply chain and images

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| K1 | No fixable critical vulnerability | `scan-images.sh` (grype) | 0 critical with a fix | build |
| K2 | An SBOM per image | syft, CycloneDX | file published | build |
| K3 | Published images are signed, with a signed SBOM | cosign sign + attest, then verify without login | both verify | images (main) |
| K4 | Mirrored images are identical | `mirror-images.sh` into a throwaway registry | same layer digests; overlay pulls only from it | mirror |
| K5 | Published images pull without credentials | anonymous `docker pull` | succeeds | images (main) |

## 10. The "before" picture

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| N14 | v0 still leaks (the "before" picture) | `versions/v0-env-file/leak.sh` | ≥ 8 of 9 places | v0-leak |

## 11. OpenBao (`SECRETS_PROVIDER=openbao`, step v1)

The same app on OpenBao 2.7.1 ([step v1](../steps/v1-openbao-kv/README.md)). The C, D, F,
S, R and L tests above also run in `compose (openbao)`. There, the credential scan reads
the values from OpenBao, every KV version, as the app's own AppRole identity. *unit (real
server)* starts the `bao` release binary with the lab's own `dev/openbao/config.hcl`.

| ID | What it proves | How | Pass rule | Runs in |
| --- | --- | --- | --- | --- |
| O1 | The app logs in with a secret ID **read from a file** and holds the token only in memory | fake server: the login body, the redactor, `status()` | the token and secret ID are scrubbed from any string; `status()` has no token | unit |
| O2 | A 403 makes the app log in again once, then retry | fake server returns 403 once | 2 logins, the read succeeds | unit |
| O3 | The token is renewed, and at its max TTL the app logs in again | fake server: `renew-self` stops extending | a second login | unit |
| O4 | A missing secret ID file is a clear error, not a request with an empty secret | no file | `cannot read the AppRole secret ID file` | unit |
| O5 | The lab config starts a server with no manual step, and the seed's bootstrap secret ID works **once** | real server, self-init | the first login works, the second gets `invalid role or secret ID` | unit (real server), compose |
| O6 | Creating a secret never overwrites one | KV v2 `cas: 0` | a second create fails with check-and-set | unit (real server) |
| O7 | The app's policy reads only its own paths | read `secret/data/some/other/app` as the app | HTTP 403 | unit (real server), compose |
| O8 | Rotation without stages: the pending copy isn't current, the promote is check-and-set, and a stale rotation can't overwrite | `putPending`, `promote`, `promote` again from the old version | current is unchanged until the promote; version 2; the stale promote fails | unit (real server) |
| O9 | The audit log holds HMACs, never values or secret IDs | grep the audit log for the passwords and secret IDs | 0 matches | unit (real server), compose |
| O10 | The app's secret ID file is private to the app | `stat` in the app container | mode `400`, owner UID 1000 | compose |
| O11 | No token or secret ID in the app's environment or `/api/config` | `env` in the app; `/api/config` JSON | no `BAO_TOKEN`, `VAULT_TOKEN`, `*_SECRET_ID`; nothing token-shaped | compose |
| O12 | The AppRole secret IDs are in no container config, no log and no environment | `credential-scan.sh` searches for both secret IDs | 0 matches everywhere (the app log too, even with the reveal flag) | compose |
| O13 | OpenBao's storage and config hold no plaintext password | grep `/openbao` (raft, seal key, audit log), `/etc/openbao`, `/tmp` | 0 matches | compose |
| O14 | Config refuses a token or secret ID in env, and plain HTTP to OpenBao in production | `config.js` checks | refused at startup | unit |

