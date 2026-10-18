# Security controls

[← README](../../README.md) · [System design review](../learn/05-system-design.md) · [Secret naming](secret-naming.md)

Every control that keeps Secure Notes' credentials out of reach, where it lives in the code
or the stack, and the checklist for running it for real.

## The controls

| Control | Where | Why |
|---|---|---|
| **No keys anywhere** | EC2 instance role; IRSA on EKS/ROSA | The SDK gets short-lived credentials from the platform. Nothing to steal from disk or env. |
| **IMDSv2 required, hop limit 1** | `infra/cloudformation.yaml` | Blocks the SSRF attack that reads role credentials from `169.254.169.254`. |
| **Least-privilege IAM, bound to the VPC endpoint** | `AppRole`, `infra/iam-policy.example.json` | Read-only, two secret ARNs, only via `aws:SourceVpce`; `kms:Decrypt` only through Secrets Manager. |
| **Secrets only in memory** | `backend/src/secrets/provider.js` | Never in files, env vars, CLI args, Kubernetes Secrets or ConfigMaps. |
| **Refuse unsafe config** | `backend/src/config.js` | Startup fails if `DB_PASSWORD`, `PGPASSWORD`, `DATABASE_URL`, `REDIS_URL` etc. are set; in production also on static AWS keys, demo mode, a mock Secrets Manager endpoint, `LOG_FORMAT=pretty` or `LOG_REVEAL_SECRETS`. The image defaults to production. |
| **Cache: TTL, single-flight, stale-on-error** | `provider.js` | Few API calls, no thundering herd, survives a brief Secrets Manager outage. |
| **Rotation-aware clients** | `backend/src/clients/` | `pg.Pool` reads the password per new connection; on `28P01`/`WRONGPASS` the app force-refreshes and retries, so rotation needs no restart. |
| **`SecretValue` wrapper** | `backend/src/secrets/SecretValue.js` | `JSON.stringify`, `console.log` and template strings print `[REDACTED]`; values only through a greppable `.reveal()`. |
| **Two-layer redaction** | `redactor.js`, `log.js` | Key-based plus value-based scrubbing of every log line and API response; library error objects reduced to safe fields. |
| **Passwords sent as hashes** | `backend/src/demo/crypto.js` | SCRAM verifiers for Postgres, `#sha256` for Redis ACLs: never in server logs. |
| **Hardened runtime** | systemd unit; Kubernetes `securityContext` | Non-root, no core dumps (systemd), read-only root, no capabilities, seccomp, no Kubernetes API token (on EKS/ROSA only IRSA's web-identity token is mounted). |
| **Network** | Security groups; NetworkPolicies | No inbound to the server; in Kubernetes, default-deny with the backing services reachable only from the app. |
| **Small supply chain** | `backend/package.json` | Five runtime dependencies (pg, ioredis, three AWS SDK clients); HTTP, logging, log shipping and headers use Node built-ins. |

### Check an image yourself

Before you run an image:

```bash
cosign verify ghcr.io/ephico2real2/openbao-node-poc/app:latest \
  --certificate-identity https://github.com/ephico2real2/openbao-node-poc/.github/workflows/ci.yaml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-attestation --type cyclonedx <same arguments>      # the signed SBOM
```

A cluster can enforce the same rule at admission (OpenShift's sigstore image policies,
or Kyverno / policy-controller on other clusters). The SBOMs and scan reports of every
build are also in the run's `…build-supply-chain` folder on `ci-captures`.

## Debug logging, the reveal flag, and the credential scan

| Setting | Default | What it does |
| --- | --- | --- |
| `LOG_LEVEL=debug` | `debug` in Compose and kind, `info` on AWS (`LogLevel` parameter) | Each secret load and each login is logged with the secret ID, version and every key: passwords as `******** (N chars, fp=…)`, usernames partly masked, hosts and ports in full. In demo mode the dashboard's log panel has a **Credential lines only** filter. |
| `LOG_REVEAL_SECRETS=true` | off | Lab troubleshooting only: those debug lines also print the real values. Red banner on the dashboard, a failing posture check, never served by `/api/logs`, and **refused in production** (the app exits 78). |

`scripts/credential-scan.sh compose|k8s` reads every password from the Secrets Manager
stand-in and searches the running stack for the **values**: container configuration,
pod specs, ConfigMaps, decoded Kubernetes Secrets, events, the app's process environment,
every file in the app container, the Postgres and Redis data, and every container's log.
It never prints a value. `compose-check.sh` and `k8s-check.sh` run it after the end-to-end
test; CI also runs it with the reveal flag on and requires it to find the values in the
app's log and nowhere else.

## SDK mode vs Workload Credentials Provider mode

`SECRETS_MODE=sdk` (default): the app calls `GetSecretValue` with the AWS SDK v3 and
caches in-process. `SECRETS_MODE=agent`: the app calls the AWS Workload Credentials
Provider (formerly the Secrets Manager Agent) on `http://localhost:2773` with the SSRF
token from `/var/run/awssmatoken`, and forces `refreshNow=true` after an auth failure,
because the agent does not invalidate its cache on rotation. AWS notes that anyone on
the host with the token can read the agent's cache, so `sdk` is the default.
CI runs Path A in both modes (`docker-compose.agent.yml`).

## Production checklist

- [ ] `NODE_ENV=production` (the image default): enforces the startup guards; demo routes are not registered.
- [x] Rotation on: RDS managed rotation for the DB secret; the stack's rotation function for the Redis user.
- [ ] A dedicated least-privilege DB role for the app instead of the RDS master user.
- [ ] 🔎 Built, verify on AWS (S12.5): the alarm on `GetSecretValue` from any principal other than the app and rotation roles (S4.2, fixed by S11.4 and S12.1; set `AlertEmail`/`AlertPhone`/`AlertWebhookUrl`, and `CreateTrail=true` if the account has no trail).
- [ ] 🔎 Built, verify on AWS: a resource policy on the Redis secret: only the app, the rotation function and `SecretAdminRoleArn` (S4.1). The RDS-managed secret: to do after testing on AWS (S4.1b).
- [ ] `EnableConfigRules=true` where the account has an AWS Config recorder (S4.3).
- [ ] `Environment` set to the real environment, so secret names follow the [naming convention](secret-naming.md).
- [ ] No `--inspect`, no shell for the service user, Session Manager logging on.
- [ ] The committed `package-lock.json`, installed with `npm ci`.
- [ ] Only signed images admitted: verify the cosign signature at the cluster (see [Check an image yourself](#check-an-image-yourself)).
- [ ] 🔎 Built, verify on AWS (S12.5): the app's log in CloudWatch Logs and the generated alarms (`EnableCloudWatchLogs=true`, the default).
- [ ] SMS: leave the SMS sandbox or verify the on-call numbers; for Slack or Teams, connect the topics in Amazon Q Developer in chat applications.
