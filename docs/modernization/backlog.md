# Backlog — epics, features and stories

[← Initiative](README.md) · [GitHub issues](https://github.com/ephico2real2/openbao-node-poc/issues?q=is%3Aissue+label%3Atype%3Aepic) · [Sibling repo's backlog (E0–E15)](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/modernization/backlog.md)

**How to read it:** an **epic** is an outcome; a **feature** is a capability; a **story** is
one deliverable with acceptance criteria (each one testable). Size: S ≤ 1 day, M ≤ 3
days, L ≤ 1 week. Status: ✅ done, with evidence · 🔜 to do.

Every item is also a GitHub issue (linked as #N), with sub-issues for the hierarchy and
labels `app|tutorial`, `type:epic|feature|story`, `epic:B0…B8` and `size:S|M|L`.

**Two tracks.** Issue titles start with the track:

| Track | Prefix and label | What it is | Epics |
| --- | --- | --- | --- |
| **APP** | `APP:` · [`app`](https://github.com/ephico2real2/openbao-node-poc/issues?q=is%3Aissue+label%3Aapp) | Making the app work on any secrets manager: AWS Secrets Manager, OpenBao, HashiCorp Vault | B0, B2–B7 |
| **TUTORIAL** | `TUTORIAL:` · [`tutorial`](https://github.com/ephico2real2/openbao-node-poc/issues?q=is%3Aissue+label%3Atutorial) | Teaching it: the ADR, chapters, guides and demos | B1, B8 |

Done items are closed with their evidence. This page and the issues are generated from
the same list (`scripts/backlog/data.py`), so they say the same thing.

## Track APP — the app on any secrets manager

### B0 — Seed the repo from aws-secrets-manager-node-poc

[#1](https://github.com/ephico2real2/openbao-node-poc/issues/1) · ✅ · **Outcome:** The Secure Notes app runs here unchanged on AWS Secrets Manager (the bundled stand-in), with CI green, before any OpenBao code lands. Docs: [initiative](README.md)

#### F0.1 · The core, copied and trimmed · ✅ · [#2](https://github.com/ephico2real2/openbao-node-poc/issues/2)

**S0.1 · Copy the core app with the AWS path kept** · M · ✅ · [#3](https://github.com/ephico2real2/openbao-node-poc/issues/3)
*As the owner, I want this repo to start from the working app, so that every OpenBao change is a visible diff against a known-good baseline.*
- [x] Copied from the sibling repo at a recorded commit, with fresh history and a provenance note in the README.
- [x] Removed: the AWS-only alerting (SNS, CloudTrail, EventBridge, the log pipeline), CloudFormation and the EC2 scripts; the dashboard's Detection lab.
- [x] Kept: the app (SECRETS_PROVIDER=aws, sdk and agent modes), the dashboard, logging and redaction, the AWS stand-in (Secrets Manager + STS), kind and OpenShift, the check scripts, the credential scan, the CI pattern.

Evidence: [README (provenance)](../../README.md), [HANDOVER section 4](../../HANDOVER.md)

**S0.2 · CI green on the AWS provider** · S · ✅ · [#4](https://github.com/ephico2real2/openbao-node-poc/issues/4)
*As a reviewer, I want CI to prove the copied app still works, so that later failures are OpenBao's, not the copy's.*
- [x] checks, build, compose (sdk, agent), kind, mirror, env-file-demo, v0-leak and docs jobs green.
- [x] Captures published to this repo's ci-captures branch.

Evidence: [CI run 39155150999](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39155150999), every job green on the first push, captures on the ci-captures branch

**S0.3 · Handover, CLAUDE.md and the backlog generator** · S · ✅ · [#5](https://github.com/ephico2real2/openbao-node-poc/issues/5)
*As the owner, I want the working rules and the backlog in this repo from day one, so that any session can continue.*
- [x] HANDOVER.md and CLAUDE.md (commits as the owner, no AI attribution).
- [x] scripts/backlog generates the issues and docs/modernization/backlog.md.

Evidence: [HANDOVER.md](../../HANDOVER.md), [CLAUDE.md](../../CLAUDE.md), [scripts/backlog](../../scripts/backlog/README.md)

### B2 — One switch: SECRETS_PROVIDER=aws|openbao|vault

[#8](https://github.com/ephico2real2/openbao-node-poc/issues/8) · ✅ · **Outcome:** The app chooses its secrets manager with one setting; everything above the fetcher (cache, rotation recovery, masking, reveal flag) is unchanged. Docs: [initiative](README.md)

**S2.1 · Providers for reading** · M · ✅ · [#9](https://github.com/ephico2real2/openbao-node-poc/issues/9)
*As a developer, I want each secrets manager behind the same interface, so that the cache and the clients don't care which one is in use.*
- [x] backend/src/secrets/index.js picks the fetcher by SECRETS_PROVIDER; fetchers.js (aws) and bao/kv.js (openbao, vault) return the same shape; for KV v2 the version is the KV version.
- [x] bao: plain fetch against the HTTP API, no new dependency; openbao and vault share it.
- [x] Unit tests against a fake HTTP server, and against a real OpenBao 2.7.1 started from the lab's own config.
- [x] SECRETS_MODE=file reads a mounted directory and watches it (backend/src/secrets/file-fetcher.js), for External Secrets Operator (S5.2).

Evidence: [backend/src/secrets/index.js](../../backend/src/secrets/index.js), [backend/src/secrets/bao/kv.js](../../backend/src/secrets/bao/kv.js), [backend/src/secrets/file-fetcher.js](../../backend/src/secrets/file-fetcher.js), [backend/test/bao.test.js](../../backend/test/bao.test.js), [backend/test/file-fetcher.test.js](../../backend/test/file-fetcher.test.js)

**S2.2 · Authentication without a credential in the environment** · M · ✅ · [#10](https://github.com/ephico2real2/openbao-node-poc/issues/10)
*As a security engineer, I want the app to log in to OpenBao without a token in its environment, so that the no-env rule still holds.*
- [x] AppRole with the secret ID read from a file (mode 0400, never env), re-read at each login.
- [x] Kubernetes auth with a projected, audience-bound service-account token (with B5).
- [x] Token renew-self at 2/3 of its TTL; re-login at the max TTL and on 403; the token and secret ID are registered with the redactor and never logged.
- [x] config.js refuses BAO_TOKEN, VAULT_TOKEN, BAO_SECRET_ID, VAULT_SECRET_ID and the existing credential variables; production refuses plain-HTTP BAO_ADDR.

Evidence: [backend/src/secrets/bao/client.js](../../backend/src/secrets/bao/client.js), [backend/test/bao.test.js](../../backend/test/bao.test.js), [backend/test/config.test.js](../../backend/test/config.test.js), CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271) kind (openbao): the app logged in with Kubernetes auth; its token is projected (audience openbao, valid 10 min); no Kubernetes API token in the pod

**S2.3 · Stores for writing (seed and the demo rotation)** · M · ✅ · [#11](https://github.com/ephico2real2/openbao-node-poc/issues/11)
*As a presenter, I want the seed job and the rotation lab to work on every provider, so that the same demos run on OpenBao.*
- [x] Stores with one interface (exists, create, read, randomPassword, putPending, promote, discardPending): backend/src/secrets/aws-store.js and bao/kv.js; the seed job and the rotator use them.
- [x] The rotator's four steps unchanged; on OpenBao the pending value is at <name>/pending, and promote writes the next KV version with check-and-set.

Evidence: [backend/src/secrets/aws-store.js](../../backend/src/secrets/aws-store.js), [backend/src/secrets/bao/kv.js](../../backend/src/secrets/bao/kv.js), [backend/src/demo/rotator.js](../../backend/src/demo/rotator.js), backend/test/bao.test.js: pending is not current; promote with cas; a stale promote fails

### B3 — OpenBao KV on Docker Compose (steps/v1-openbao-kv)

[#12](https://github.com/ephico2real2/openbao-node-poc/issues/12) · ✅ · **Outcome:** The full lab runs on OpenBao: seed, rotation without restart, leak test, credential scan, reveal flag. Docs: [initiative](README.md)

**S3.1 · OpenBao with no manual steps** · M · ✅ · [#13](https://github.com/ephico2real2/openbao-node-poc/issues/13)
*As a learner, I want OpenBao to start initialised and unsealed, so that I can focus on the app.*
- [x] Static seal and self-init (dev/openbao/config.hcl); KV v2, AppRole and policies created at start.
- [x] A file audit device; its log shows HMACs, never values.
- [x] Secret zero: the seed job's bootstrap secret ID is generated at first start and is single-use; it mints the app's secret ID into a mode-0400 file.

Evidence: [dev/openbao/config.hcl](../../dev/openbao/config.hcl), [dev/openbao/entrypoint.sh](../../dev/openbao/entrypoint.sh), [steps/v1-openbao-kv/README.md](../../steps/v1-openbao-kv/README.md), backend/test/bao.test.js against the real server: the bootstrap works once; the audit log holds no value, CI run [39161016646](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39161016646) compose (openbao): the seed's bootstrap secret ID is spent; the audit log recorded 52 KV entries and holds no value or secret ID

**S3.2 · The lab on OpenBao** · M · ✅ · [#14](https://github.com/ephico2real2/openbao-node-poc/issues/14)
*As a presenter, I want every existing demo to work on OpenBao, so that the comparison is fair.*
- [x] Rotate from the dashboard: auth-failed → new-version → recovered.
- [x] Leak test 0 of 6; credential scan clean, including the OpenBao container and its audit log.
- [x] CI job compose (openbao) with captures.
- [x] The reveal flag on OpenBao: the values appear in the app log only; the AppRole secret IDs appear nowhere.

Evidence: CI run [39161016646](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39161016646): compose (openbao) green — rotation db and redis to version 3, recovered: db, redis; 6 attempts, 0 leaks; 14 posture checks, none failing, [compose-check.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2001Z_ci_run39161016646-1_compose-openbao-logs/compose-check.txt): 8 values from OpenBao (every version), clean everywhere incl. the audit log and raft storage; both AppRole secret IDs clean, [credential-scan-revealed.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2001Z_ci_run39161016646-1_compose-openbao-logs/credential-scan-revealed.txt): app log FOUND 4 with LOG_REVEAL_SECRETS=true, clean elsewhere, [steps/v1-openbao-kv/README.md](../../steps/v1-openbao-kv/README.md)

### B4 — Dynamic credentials and leases (steps/v2-openbao-dynamic)

[#15](https://github.com/ephico2real2/openbao-node-poc/issues/15) · ✅ · **Outcome:** The database password is a lease: per-instance users that expire, renewed and re-issued without a failed request. Docs: [initiative](README.md)

**S4.1 · Postgres dynamic credentials** · M · ✅ · [#16](https://github.com/ephico2real2/openbao-node-poc/issues/16)
*As a DBA, I want each app instance to get its own short-lived database user, so that a leaked password expires by itself.*
- [x] Database secrets engine with a Postgres role; the seed job connects it through an OpenBao-only admin (bao_admin) and has OpenBao rotate that admin's password; Postgres only ever sees SCRAM verifiers.
- [x] Leases renewed at 2/3 of their TTL, re-issued before the max TTL; new queries move to a pool for the new user while the old pool drains; the old lease is revoked after the drain.
- [x] Revoking a lease (the dashboard demo) drops the user and ends its sessions; the app recovers on its next query. Leases are revoked on shutdown.
- [x] The dashboard shows each lease: time left, renewals, the next renewal or re-issue.
- [x] CI job compose (openbao-dynamic) with captures; the reveal-flag run searches for the leased passwords everywhere but the app log.

Evidence: CI run [39164263518](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39164263518) compose (openbao-dynamic): leased sessions, both leases renewed, both revoked and recovered, 1 leased user left after cleanup, 6 switches, [walk](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2036Z_ci_run39163651929-1_compose-compose-openbao-dynamic): revoke and recover, and the max-TTL re-issue with the pool switch, [credential-scan-revealed.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2046Z_ci_run39164263518-1_compose-openbao-dynamic-logs/credential-scan-revealed.txt): the leased passwords appear in the app log only, [steps/v2-openbao-dynamic/README.md](../../steps/v2-openbao-dynamic/README.md), [backend/src/secrets/bao/leases.js](../../backend/src/secrets/bao/leases.js), [backend/test/leases.test.js](../../backend/test/leases.test.js)

**S4.2 · Valkey through OpenBao's plugin** · S · ✅ · [#17](https://github.com/ephico2real2/openbao-node-poc/issues/17)
*As an operator, I want the cache credential managed the same way, so that both credentials rotate without the app.*
- [x] Valkey replaces Redis here (OpenBao documents a Valkey plugin; its binary also carries an undocumented Redis one); ioredis works unchanged.
- [x] The seed job connects the plugin through bao-admin (ACL commands only), rotates its password, and saves the ACL file.
- [x] A re-issued user switches the connection before the old one is revoked; a revoked user reconnects as a new one by itself.

Evidence: CI run [39164263518](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39164263518) compose (openbao-dynamic): Valkey 8.1; the Redis lease revoked and the app reconnected as a new user, [steps/v2-openbao-dynamic/compose.yaml](../../steps/v2-openbao-dynamic/compose.yaml), [backend/scripts/seed-local.js](../../backend/scripts/seed-local.js)

### B5 — Kubernetes: OpenBao Helm and External Secrets Operator (kind)

[#18](https://github.com/ephico2real2/openbao-node-poc/issues/18) · ✅ · **Outcome:** On kind, credentials arrive through Kubernetes auth, or as a mounted Secret (never env) from External Secrets Operator's Helm chart, and refresh without a restart. OpenShift moved to B9. Docs: [initiative](README.md)

**S5.1 · OpenBao on Kubernetes** · M · ✅ · [#19](https://github.com/ephico2real2/openbao-node-poc/issues/19)
*As a platform engineer, I want OpenBao installed by its Helm chart, so that the cluster lab matches production practice.*
- [x] The openbao chart (raft, one replica) on kind in CI, initialised and unsealed by itself (static seal, self-init); chart and app pinned in scripts/versions.env.
- [x] Kubernetes auth for SECRETS_MODE=api: a projected service-account token (audience openbao, 10 min), TokenReview through system:auth-delegator, no Kubernetes API token in the app pod.
- [x] Database users with leases, as in step v2; the seed job resumes when it runs again (the bootstrap passwords are burned).

Evidence: CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271) kind (openbao): OpenBao 2.7.1 (Helm, raft storage) initialized and unsealed by itself; Kubernetes auth; leased Postgres user; k8s-check: all checks passed ([k8s-check.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2203Z_ci_run39169755271-1_kind-openbao-logs/k8s-check.txt)), [steps/v3-k8s/README.md](../../steps/v3-k8s/README.md), [demo test case 21](../../demo/test-case-21-kubernetes-auth.md)

**S5.2 · External Secrets Operator and a watched volume** · L · ✅ · [#20](https://github.com/ephico2real2/openbao-node-poc/issues/20)
*As a developer, I want ESO to deliver the credential as files, so that the app needs no OpenBao client in the cluster.*
- [x] ClusterSecretStore (Vault provider) and ExternalSecret; the Secret is mounted, no envFrom and no subPath.
- [x] SECRETS_MODE=file watches the ..data swap and re-reads on a timer; rotation in OpenBao reaches the app without a restart.
- [x] k8s-check and the credential scan extended.

Evidence: CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271) kind (openbao-eso): ExternalSecret Ready; mounted as a volume, no env, envFrom or subPath; no OpenBao token in the app pod; a rotation Job outside the app moved the KV version 1 -> 2 and the new version reached the app in 56 s without a restart ([k8s-check.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2204Z_ci_run39169755271-1_kind-openbao-eso-logs/k8s-check.txt)), [overlay kind-openbao-eso](../../deploy/k8s/overlays/kind-openbao-eso/kustomization.yaml), [demo test case 22](../../demo/test-case-22-external-secrets.md)

### B6 — The same app on HashiCorp Vault (steps/v4-vault)

[#21](https://github.com/ephico2real2/openbao-node-poc/issues/21) · ✅ · **Outcome:** SECRETS_PROVIDER=vault runs the same lab on Vault, including its Redis database plugin. Docs: [initiative](README.md)

**S6.1 · Vault variant** · M · ✅ · [#22](https://github.com/ephico2real2/openbao-node-poc/issues/22)
*As a Vault user, I want the same app on Vault, so that both products are covered.*
- [x] Vault 2.2.0 server config (no dev mode); Vault has no self-init, so dev/vault/entrypoint.sh initialises (one key share), unseals, configures with the root token in memory only, then revokes it.
- [x] The same app image and seed with SECRETS_PROVIDER=vault; AppRole, KV v2, dynamic Postgres users, and Vault's Redis database plugin.
- [x] CI job compose (vault) with captures; the checks job runs the entrypoint against the real Vault binary (dev/vault/test-entrypoint.sh).

Evidence: CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271) compose (vault): logged in to Vault as secure-notes-app; bootstrap secret ID spent; both leases revoked and recovered; 6 attempts, 0 leaks; credential scan clean ([compose-check.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2203Z_ci_run39169755271-1_compose-vault-logs/compose-check.txt)), [steps/v4-vault/README.md](../../steps/v4-vault/README.md), [demo test case 23](../../demo/test-case-23-vault.md)

### B7 — Audit-based detection: an unexpected read raises an alert

[#23](https://github.com/ephico2real2/openbao-node-poc/issues/23) · ✅ · **Outcome:** OpenBao's audit log is the source of truth for who read what; a rule on the log store raises the alert, as CloudTrail does on AWS. Docs: [initiative](README.md)

**S7.1 · From the audit log to an alert** · L · ✅ · [#24](https://github.com/ephico2real2/openbao-node-poc/issues/24)
*As a security engineer, I want a read by an unexpected entity to page someone, so that a leaked token is noticed.*
- [x] File audit device → a tail shipper (backend/scripts/audit-ship.js) → VictoriaLogs → vmalert → a webhook console (backend/scripts/alert-console.js). A small shipper replaces the OpenTelemetry Collector of the plan: one dependency-free script, unit-tested.
- [x] An intruder job (docker compose run --rm intruder) reads the app's secret as the over-broad ops-admin AppRole; the rule SecretReadByUnexpectedIdentity names the role and the path; nothing the app does alerts.
- [x] CI job compose (openbao-detection); the checks job runs dev/detect/test-detection.sh with the real VictoriaLogs and vmalert binaries.

Evidence: CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271) compose (openbao-detection): 107 audit lines shipped; no alert from the app; alert SecretReadByUnexpectedIdentity for ops-admin reading secret/data/rds/dev/notes-db/app ([compose-check.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2203Z_ci_run39169755271-1_compose-openbao-detection-logs/compose-check.txt)), [steps/v5-detection/README.md](../../steps/v5-detection/README.md), [dev/detect/rules.yml](../../dev/detect/rules.yml), [demo test case 24](../../demo/test-case-24-detection.md)

## Track TUTORIAL — building the tutorial

### B1 — ADR-002: OpenBao first, HashiCorp Vault second

[#6](https://github.com/ephico2real2/openbao-node-poc/issues/6) · ✅ · **Outcome:** The choice is recorded with accurate licensing and feature facts, checked against the projects' own pages. Docs: [initiative](README.md)

**S1.1 · Write ADR-002** · S · ✅ · [#7](https://github.com/ephico2real2/openbao-node-poc/issues/7)
*As an architect, I want the decision and its facts in one page, so that the team doesn't rely on myths about either product.*
- [x] MPL-2.0 (OpenBao, OpenSSF sandbox) vs BSL 1.1 (Vault, IBM); each checked on the release page.
- [x] What OpenBao added (namespaces, standby reads, control groups) and lacks (replication, Sentinel, Transform).
- [x] The two common claims corrected: 'IBM removed Enterprise features' and 'OpenBao has all Enterprise features'.

Evidence: [ADR-002](03-adr-002-openbao-first.md), Facts checked 2026-10-18 against each project's own pages (21 sources listed in the ADR)

### B8 — Tutorial: learning chapters, guide and demos

[#25](https://github.com/ephico2real2/openbao-node-poc/issues/25) · 🔜 · **Outcome:** Learners can follow the move from AWS Secrets Manager to OpenBao and Vault, step by step, with CI evidence. Docs: [initiative](README.md)

**S8.1 · Chapters** · M · ✅ · [#26](https://github.com/ephico2real2/openbao-node-poc/issues/26)
*As a junior engineer, I want the new ideas explained, so that I understand why each step exists.*
- [x] Secret zero and AppRole; leases and dynamic credentials; ESO and mounted secrets; OpenBao vs Vault; detection on the audit log (chapters 7–11).

Evidence: [learning path](../learn/README.md), [chapter 7](../learn/07-secret-zero-and-approle.md), [chapter 11](../learn/11-detection-on-the-audit-log.md)

**S8.2 · Guide, tutorial and demo pages from this repo's CI** · M · ✅ · [#27](https://github.com/ephico2real2/openbao-node-poc/issues/27)
*As a presenter, I want demo pages with this repo's screenshots, so that the evidence is the code in front of me.*
- [x] Demo pages 19–24 for steps v1–v5, and pages 1–12 and 18 pointed at this repo's CI run, each quoting its real output; a progression story in demo/README.md.
- [x] GUIDE and TUTORIAL cover every step on Compose and kind; OpenShift stays labelled unproven (parked epic B9).

Evidence: [demo pages](../../demo/README.md), [docs/GUIDE.md](../GUIDE.md), [docs/TUTORIAL.md](../TUTORIAL.md), Screenshots and output from CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271)

**S8.3 · A tag and release notes for each step** · S · 🔜 · [#34](https://github.com/ephico2real2/openbao-node-poc/issues/34)
*As a learner, I want each step tagged with its release notes, so that I can check out exactly the code a chapter describes.*
- [x] docs/releases/<tag>.md for v1-aws-baseline through v6-detection, each naming its commit and green CI run.
- [ ] Tags cut with the milestone workflow on those commits; a GitHub release per tag.

Evidence: [docs/releases](../releases/README.md)

## Parked — planned, not scheduled

### B9 — OpenShift Local lab: OpenBao with Red Hat's External Secrets Operator (steps/v6-openshift-eso)

[#35](https://github.com/ephico2real2/openbao-node-poc/issues/35) · 🔜 · **Outcome:** The step v3 lab runs on Red Hat OpenShift Local (CRC) with the Red Hat build of External Secrets Operator, installed from the Red Hat catalog, and is proven by a real run. kind keeps the upstream Helm chart (B5); the ClusterSecretStore, ExternalSecret and app component are shared, only the install differs. Docs: [initiative](README.md), [External Secrets Operator for Red Hat OpenShift (OpenShift 4.22 docs)](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/security_and_compliance/external-secrets-operator-for-red-hat-openshift), Facts checked 2026-10-18: operator 1.2.1 (2026-09-10) is based on upstream v2.5.0; images for amd64, arm64, ppc64le and s390x; Vault is a tested provider, OpenBao is not mentioned (it is reached through the Vault provider); OpenShift Local 2.64.0 ships OpenShift 4.22.14. Re-check before building.

**S9.1 · OpenShift Local ready for the lab** · S · 🔜 · [#36](https://github.com/ephico2real2/openbao-node-poc/issues/36)
*As the owner, I want OpenShift Local sized and set up for this lab on my Mac, so that the run is repeatable.*
- [ ] OpenShift Local 2.64.0 or newer (OpenShift 4.20+, which the operator needs), with the owner's Red Hat pull secret; oc login as kubeadmin (installing operators needs cluster-admin).
- [ ] Memory and CPU sized from the pods' own requests (OpenBao, the operator and its controllers, Postgres, Valkey, the app), not guessed; written in the step README.
- [ ] Apple silicon builds the app images on the cluster (scripts/openshift-build.sh, the published images are amd64 only); an Intel Mac can pull them from GHCR.
- [ ] scripts/preflight.sh openshift checks the cluster version, the login and the redhat-operators catalog.

Evidence: [initiative](README.md)

**S9.2 · Red Hat's External Secrets Operator, installed by a script** · M · 🔜 · [#37](https://github.com/ephico2real2/openbao-node-poc/issues/37)
*As an OpenShift administrator, I want the supported operator installed the way Red Hat documents it, so that the lab matches what a Red Hat customer runs.*
- [ ] cert-manager Operator for Red Hat OpenShift first, if the docs' prerequisite holds ("Ensure cert-manager Operator is installed and operational before deploying the External Secrets Operator"): confirm whether it is required or only recommended.
- [ ] scripts/openshift-eso-up.sh: Namespace, OperatorGroup and Subscription (package openshift-external-secrets-operator, channel stable-v1, source redhat-operators, namespace external-secrets-operator); wait for the CSV to succeed.
- [ ] ExternalSecretsConfig 'cluster' (operator.openshift.io/v1alpha1); the operand pods in external-secrets are Running and the config is Ready.
- [ ] Egress for the controller only to OpenBao (openbao namespace, port 8200), not the docs' allow-all example; the operator's own eso-sys- policies kept.
- [ ] The controller's service account is read from its Deployment and bound to OpenBao's external-secrets role; the shared ClusterSecretStore (Vault provider) becomes Ready.

Evidence: [initiative](README.md)

**S9.3 · OpenBao and the app on OpenShift** · M · 🔜 · [#38](https://github.com/ephico2real2/openbao-node-poc/issues/38)
*As a platform engineer, I want OpenBao and the app under OpenShift's defaults, so that nothing in the lab needs a special SCC.*
- [x] steps/v3-k8s/openbao-values-openshift.yaml (the chart's OpenShift mode; UIDs left to restricted-v2); openbao-k8s-up.sh adds it on OpenShift.
- [ ] Overlays openshift-openbao (Kubernetes auth, api mode) and openshift-openbao-eso (file mode): a TLS Route, no fixed UIDs, and an on-cluster build variant.
- [ ] Every pod admitted under restricted-v2; the NetworkPolicies hold on OVN-Kubernetes.
- [ ] CI renders both overlays and validates them against their schemas (it cannot run OpenShift).

Evidence: [initiative](README.md)

**S9.4 · Checks and evidence from a real OpenShift Local run** · M · 🔜 · [#39](https://github.com/ephico2real2/openbao-node-poc/issues/39)
*As a reviewer, I want the same checks as kind, run on OpenShift Local, so that 'works on OpenShift' is shown, not claimed.*
- [ ] k8s-check.sh on OpenShift: the operator's CSV and version, the operand images from registry.redhat.io, restricted-v2 on the app's pods, the Route, and a rotation done in OpenBao reaching the app without a restart.
- [ ] scripts/openshift-evidence.sh: the checks, the credential scan and a browser walk through the Route, saved in one folder with no secret value.
- [ ] The owner runs it; the folder is published to ci-captures, labelled as a manual OpenShift Local run with its date and versions.

Evidence: [initiative](README.md)

**S9.5 · Tutorial: the OpenShift Local lab** · S · 🔜 · [#40](https://github.com/ephico2real2/openbao-node-poc/issues/40)
*As a learner, I want the OpenShift lab explained next to the kind one, so that I see what the supported operator changes and what stays the same.*
- [ ] steps/v6-openshift-eso/README.md, demo page 25 and a chapter 9 section, from the real run's evidence.
- [ ] GUIDE (Part B) and TEST-CASES updated; the OpenShift parts of steps/v3-k8s stop saying 'unproven'; tag v7-openshift-eso.

Evidence: [initiative](README.md)
