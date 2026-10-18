# The backlog (docs/modernization/backlog.md) as data, for GitHub issues.
# Epics B0–B8: Secure Notes on OpenBao and HashiCorp Vault, with AWS kept.
# (The sibling repo, aws-secrets-manager-node-poc, holds E0–E15; its E15 is this repo.)
B = "https://github.com/ephico2real2/openbao-node-poc/blob/main/"
def d(path, text=None):
    return f"[{text or path}]({B}{path})"

PLAN = d("docs/modernization/README.md", "initiative")
def S(id, title, size, story, criteria, evidence=(), status="open", done=()):
    """criteria: list of text; `done` lists the indexes already met."""
    return dict(id=id, type="story", title=title, size=size, status=status, story=story,
                criteria=[(i in done, c) for i, c in enumerate(criteria)], evidence=list(evidence) or [PLAN])
def F(id, title, children, docs=()):
    return dict(id=id, type="feature", title=title, status="open", docs=list(docs) or [PLAN], children=children)

EPICS = [
 dict(id="B0", track="app", title="Seed the repo from aws-secrets-manager-node-poc",
  outcome="The Secure Notes app runs here unchanged on AWS Secrets Manager (the bundled stand-in), with CI green, before any OpenBao code lands.",
  docs=[PLAN], children=[
   F("F0.1", "The core, copied and trimmed", [
     S("S0.1", "Copy the core app with the AWS path kept", "M",
       "As the owner, I want this repo to start from the working app, so that every OpenBao change is a visible diff against a known-good baseline.",
       ["Copied from the sibling repo at a recorded commit, with fresh history and a provenance note in the README.",
        "Removed: the AWS-only alerting (SNS, CloudTrail, EventBridge, the log pipeline), CloudFormation and the EC2 scripts; the dashboard's Detection lab.",
        "Kept: the app (SECRETS_PROVIDER=aws, sdk and agent modes), the dashboard, logging and redaction, the AWS stand-in (Secrets Manager + STS), kind and OpenShift, the check scripts, the credential scan, the CI pattern."],
       done=(0, 1, 2)),
     S("S0.2", "CI green on the AWS provider", "S",
       "As a reviewer, I want CI to prove the copied app still works, so that later failures are OpenBao's, not the copy's.",
       ["checks, build, compose (sdk, agent), kind, mirror, env-file-demo, v0-leak and docs jobs green.", "Captures published to this repo's ci-captures branch."],
       evidence=["CI run [39155150999](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39155150999): every job green", "[ci-captures](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures)"],
       status="done", done=(0, 1)),
     S("S0.3", "Handover, CLAUDE.md and the backlog generator", "S",
       "As the owner, I want the working rules and the backlog in this repo from day one, so that any session can continue.",
       ["HANDOVER.md and CLAUDE.md (commits as the owner, no AI attribution).", "scripts/backlog generates the issues and docs/modernization/backlog.md."], done=(0, 1)),
   ]),
  ]),
 dict(id="B1", track="tutorial", title="ADR-002: OpenBao first, HashiCorp Vault second",
  outcome="The choice is recorded with accurate licensing and feature facts, checked against the projects' own pages.",
  docs=[PLAN], children=[
   S("S1.1", "Write ADR-002", "S",
     "As an architect, I want the decision and its facts in one page, so that the team doesn't rely on myths about either product.",
     ["MPL-2.0 (OpenBao, OpenSSF sandbox) vs BSL 1.1 (Vault, IBM); each checked on the release page.",
      "What OpenBao added (namespaces, standby reads, control groups) and lacks (replication, Sentinel, Transform).",
      "The two common claims corrected: 'IBM removed Enterprise features' and 'OpenBao has all Enterprise features'."],
     evidence=[d("docs/modernization/03-adr-002-openbao-first.md", "ADR-002"), "Facts checked 2026-10-18 against each project's own pages (21 sources listed in the ADR)"],
     status="done", done=(0, 1, 2)),
  ]),
 dict(id="B2", track="app", title="One switch: SECRETS_PROVIDER=aws|openbao|vault",
  outcome="The app chooses its secrets manager with one setting; everything above the fetcher (cache, rotation recovery, masking, reveal flag) is unchanged.",
  docs=[PLAN], children=[
   S("S2.1", "Providers for reading", "M",
     "As a developer, I want each secrets manager behind the same interface, so that the cache and the clients don't care which one is in use.",
     ["backend/src/secrets/index.js picks the fetcher by SECRETS_PROVIDER; fetchers.js (aws) and bao/kv.js (openbao, vault) return the same shape; for KV v2 the version is the KV version.",
      "bao: plain fetch against the HTTP API, no new dependency; openbao and vault share it.",
      "Unit tests against a fake HTTP server, and against a real OpenBao 2.7.1 started from the lab's own config.",
      "SECRETS_MODE=file reads a mounted directory and watches it (backend/src/secrets/file-fetcher.js), for External Secrets Operator (S5.2)."],
     evidence=[d("backend/src/secrets/index.js"), d("backend/src/secrets/bao/kv.js"), d("backend/src/secrets/file-fetcher.js"), d("backend/test/bao.test.js"), d("backend/test/file-fetcher.test.js")],
     status="done", done=(0, 1, 2, 3)),
   S("S2.2", "Authentication without a credential in the environment", "M",
     "As a security engineer, I want the app to log in to OpenBao without a token in its environment, so that the no-env rule still holds.",
     ["AppRole with the secret ID read from a file (mode 0400, never env), re-read at each login.",
      "Kubernetes auth with a projected, audience-bound service-account token (with B5).",
      "Token renew-self at 2/3 of its TTL; re-login at the max TTL and on 403; the token and secret ID are registered with the redactor and never logged.",
      "config.js refuses BAO_TOKEN, VAULT_TOKEN, BAO_SECRET_ID, VAULT_SECRET_ID and the existing credential variables; production refuses plain-HTTP BAO_ADDR."],
     evidence=[d("backend/src/secrets/bao/client.js"), d("backend/test/bao.test.js"), d("backend/test/config.test.js"),
               "CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271) kind (openbao): the app logged in with Kubernetes auth; its token is projected (audience openbao, valid 10 min); no Kubernetes API token in the pod"],
     status="done", done=(0, 1, 2, 3)),
   S("S2.3", "Stores for writing (seed and the demo rotation)", "M",
     "As a presenter, I want the seed job and the rotation lab to work on every provider, so that the same demos run on OpenBao.",
     ["Stores with one interface (exists, create, read, randomPassword, putPending, promote, discardPending): backend/src/secrets/aws-store.js and bao/kv.js; the seed job and the rotator use them.",
      "The rotator's four steps unchanged; on OpenBao the pending value is at <name>/pending, and promote writes the next KV version with check-and-set."],
     evidence=[d("backend/src/secrets/aws-store.js"), d("backend/src/secrets/bao/kv.js"), d("backend/src/demo/rotator.js"), "backend/test/bao.test.js: pending is not current; promote with cas; a stale promote fails"],
     status="done", done=(0, 1)),
  ]),
 dict(id="B3", track="app", title="OpenBao KV on Docker Compose (steps/v1-openbao-kv)",
  outcome="The full lab runs on OpenBao: seed, rotation without restart, leak test, credential scan, reveal flag.",
  docs=[PLAN], children=[
   S("S3.1", "OpenBao with no manual steps", "M",
     "As a learner, I want OpenBao to start initialised and unsealed, so that I can focus on the app.",
     ["Static seal and self-init (dev/openbao/config.hcl); KV v2, AppRole and policies created at start.", "A file audit device; its log shows HMACs, never values.",
      "Secret zero: the seed job's bootstrap secret ID is generated at first start and is single-use; it mints the app's secret ID into a mode-0400 file."],
     evidence=[d("dev/openbao/config.hcl"), d("dev/openbao/entrypoint.sh"), d("steps/v1-openbao-kv/README.md"), "backend/test/bao.test.js against the real server: the bootstrap works once; the audit log holds no value",
               "CI run [39161016646](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39161016646) compose (openbao): the seed's bootstrap secret ID is spent; the audit log recorded 52 KV entries and holds no value or secret ID"],
     status="done", done=(0, 1, 2)),
   S("S3.2", "The lab on OpenBao", "M",
     "As a presenter, I want every existing demo to work on OpenBao, so that the comparison is fair.",
     ["Rotate from the dashboard: auth-failed → new-version → recovered.", "Leak test 0 of 6; credential scan clean, including the OpenBao container and its audit log.",
      "CI job compose (openbao) with captures.",
      "The reveal flag on OpenBao: the values appear in the app log only; the AppRole secret IDs appear nowhere."],
     evidence=["CI run [39161016646](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39161016646): compose (openbao) green — rotation db and redis to version 3, recovered: db, redis; 6 attempts, 0 leaks; 14 posture checks, none failing",
               "[compose-check.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2001Z_ci_run39161016646-1_compose-openbao-logs/compose-check.txt): 8 values from OpenBao (every version), clean everywhere incl. the audit log and raft storage; both AppRole secret IDs clean",
               "[credential-scan-revealed.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2001Z_ci_run39161016646-1_compose-openbao-logs/credential-scan-revealed.txt): app log FOUND 4 with LOG_REVEAL_SECRETS=true, clean elsewhere",
               d("steps/v1-openbao-kv/README.md")],
     status="done", done=(0, 1, 2, 3)),
  ]),
 dict(id="B4", track="app", title="Dynamic credentials and leases (steps/v2-openbao-dynamic)",
  outcome="The database password is a lease: per-instance users that expire, renewed and re-issued without a failed request.",
  docs=[PLAN], children=[
   S("S4.1", "Postgres dynamic credentials", "M",
     "As a DBA, I want each app instance to get its own short-lived database user, so that a leaked password expires by itself.",
     ["Database secrets engine with a Postgres role; the seed job connects it through an OpenBao-only admin (bao_admin) and has OpenBao rotate that admin's password; Postgres only ever sees SCRAM verifiers.",
      "Leases renewed at 2/3 of their TTL, re-issued before the max TTL; new queries move to a pool for the new user while the old pool drains; the old lease is revoked after the drain.",
      "Revoking a lease (the dashboard demo) drops the user and ends its sessions; the app recovers on its next query. Leases are revoked on shutdown.",
      "The dashboard shows each lease: time left, renewals, the next renewal or re-issue.",
      "CI job compose (openbao-dynamic) with captures; the reveal-flag run searches for the leased passwords everywhere but the app log."],
     evidence=["CI run [39164263518](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39164263518) compose (openbao-dynamic): leased sessions, both leases renewed, both revoked and recovered, 1 leased user left after cleanup, 6 switches",
               "[walk](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2036Z_ci_run39163651929-1_compose-compose-openbao-dynamic): revoke and recover, and the max-TTL re-issue with the pool switch",
               "[credential-scan-revealed.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2046Z_ci_run39164263518-1_compose-openbao-dynamic-logs/credential-scan-revealed.txt): the leased passwords appear in the app log only",
               d("steps/v2-openbao-dynamic/README.md"), d("backend/src/secrets/bao/leases.js"), d("backend/test/leases.test.js")],
     status="done", done=(0, 1, 2, 3, 4)),
   S("S4.2", "Valkey through OpenBao's plugin", "S",
     "As an operator, I want the cache credential managed the same way, so that both credentials rotate without the app.",
     ["Valkey replaces Redis here (OpenBao documents a Valkey plugin; its binary also carries an undocumented Redis one); ioredis works unchanged.",
      "The seed job connects the plugin through bao-admin (ACL commands only), rotates its password, and saves the ACL file.",
      "A re-issued user switches the connection before the old one is revoked; a revoked user reconnects as a new one by itself."],
     evidence=["CI run [39164263518](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39164263518) compose (openbao-dynamic): Valkey 8.1; the Redis lease revoked and the app reconnected as a new user", d("steps/v2-openbao-dynamic/compose.yaml"), d("backend/scripts/seed-local.js")],
     status="done", done=(0, 1, 2)),
  ]),
 dict(id="B5", track="app", title="Kubernetes and OpenShift: OpenBao Helm and External Secrets Operator",
  outcome="On kind and OpenShift, credentials arrive as a mounted Secret (never env), or through Kubernetes auth, and refresh without a restart.",
  docs=[PLAN], children=[
   S("S5.1", "OpenBao on Kubernetes", "M",
     "As a platform engineer, I want OpenBao installed by its Helm chart, so that the cluster lab matches production practice.",
     ["The openbao chart (raft, one replica) on kind in CI, initialised and unsealed by itself (static seal, self-init); chart and app pinned in scripts/versions.env.",
      "Kubernetes auth for SECRETS_MODE=api: a projected service-account token (audience openbao, 10 min), TokenReview through system:auth-delegator, no Kubernetes API token in the app pod.",
      "Database users with leases, as in step v2; the seed job resumes when it runs again (the bootstrap passwords are burned)."],
     evidence=["CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271) kind (openbao): OpenBao 2.7.1 (Helm, raft storage) initialized and unsealed by itself; Kubernetes auth; leased Postgres user; k8s-check: all checks passed ([k8s-check.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2203Z_ci_run39169755271-1_kind-openbao-logs/k8s-check.txt))",
               d("steps/v3-k8s/README.md"), d("demo/test-case-21-kubernetes-auth.md", "demo test case 21")],
     status="done", done=(0, 1, 2)),
   S("S5.2", "External Secrets Operator and a watched volume", "L",
     "As a developer, I want ESO to deliver the credential as files, so that the app needs no OpenBao client in the cluster.",
     ["ClusterSecretStore (Vault provider) and ExternalSecret; the Secret is mounted, no envFrom and no subPath.",
      "SECRETS_MODE=file watches the ..data swap and re-reads on a timer; rotation in OpenBao reaches the app without a restart.",
      "k8s-check and the credential scan extended."],
     evidence=["CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271) kind (openbao-eso): ExternalSecret Ready; mounted as a volume, no env, envFrom or subPath; no OpenBao token in the app pod; a rotation Job outside the app moved the KV version 1 -> 2 and the new version reached the app in 56 s without a restart ([k8s-check.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2204Z_ci_run39169755271-1_kind-openbao-eso-logs/k8s-check.txt))",
               d("deploy/k8s/overlays/kind-openbao-eso/kustomization.yaml", "overlay kind-openbao-eso"), d("demo/test-case-22-external-secrets.md", "demo test case 22")],
     status="done", done=(0, 1, 2)),
   S("S5.3", "OpenBao and External Secrets on a real OpenShift", "M",
     "As an OpenShift user, I want the step v3 lab proven on OpenShift, so that the restricted-v2 SCC and Routes are known to work.",
     ["steps/v3-k8s/openbao-values-openshift.yaml written (the chart's OpenShift mode; UIDs left to restricted-v2); openbao-k8s-up.sh adds it on OpenShift.",
      "Run on OpenShift Local or a dev cluster: OpenBao up, Kubernetes auth, the ESO overlay, k8s-check green; captures from that run.",
      "Images built on the cluster for Apple-silicon Macs (openshift-build.sh) checked with the OpenBao overlays."],
     evidence=[d("steps/v3-k8s/README.md", "step v3: OpenShift (unproven)")],
     done=(0,)),
  ]),
 dict(id="B6", track="app", title="The same app on HashiCorp Vault (steps/v4-vault)",
  outcome="SECRETS_PROVIDER=vault runs the same lab on Vault, including its Redis database plugin.",
  docs=[PLAN], children=[
   S("S6.1", "Vault variant", "M",
     "As a Vault user, I want the same app on Vault, so that both products are covered.",
     ["Vault 2.2.0 server config (no dev mode); Vault has no self-init, so dev/vault/entrypoint.sh initialises (one key share), unseals, configures with the root token in memory only, then revokes it.",
      "The same app image and seed with SECRETS_PROVIDER=vault; AppRole, KV v2, dynamic Postgres users, and Vault's Redis database plugin.",
      "CI job compose (vault) with captures; the checks job runs the entrypoint against the real Vault binary (dev/vault/test-entrypoint.sh)."],
     evidence=["CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271) compose (vault): logged in to Vault as secure-notes-app; bootstrap secret ID spent; both leases revoked and recovered; 6 attempts, 0 leaks; credential scan clean ([compose-check.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2203Z_ci_run39169755271-1_compose-vault-logs/compose-check.txt))",
               d("steps/v4-vault/README.md"), d("demo/test-case-23-vault.md", "demo test case 23")],
     status="done", done=(0, 1, 2)),
  ]),
 dict(id="B7", track="app", title="Audit-based detection: an unexpected read raises an alert",
  outcome="OpenBao's audit log is the source of truth for who read what; a rule on the log store raises the alert, as CloudTrail does on AWS.",
  docs=[PLAN], children=[
   S("S7.1", "From the audit log to an alert", "L",
     "As a security engineer, I want a read by an unexpected entity to page someone, so that a leaked token is noticed.",
     ["File audit device → a tail shipper (backend/scripts/audit-ship.js) → VictoriaLogs → vmalert → a webhook console (backend/scripts/alert-console.js). A small shipper replaces the OpenTelemetry Collector of the plan: one dependency-free script, unit-tested.",
      "An intruder job (docker compose run --rm intruder) reads the app's secret as the over-broad ops-admin AppRole; the rule SecretReadByUnexpectedIdentity names the role and the path; nothing the app does alerts.",
      "CI job compose (openbao-detection); the checks job runs dev/detect/test-detection.sh with the real VictoriaLogs and vmalert binaries."],
     evidence=["CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271) compose (openbao-detection): 107 audit lines shipped; no alert from the app; alert SecretReadByUnexpectedIdentity for ops-admin reading secret/data/rds/dev/notes-db/app ([compose-check.txt](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2203Z_ci_run39169755271-1_compose-openbao-detection-logs/compose-check.txt))",
               d("steps/v5-detection/README.md"), d("dev/detect/rules.yml"), d("demo/test-case-24-detection.md", "demo test case 24")],
     status="done", done=(0, 1, 2)),
  ]),
 dict(id="B8", track="tutorial", title="Tutorial: learning chapters, guide and demos",
  outcome="Learners can follow the move from AWS Secrets Manager to OpenBao and Vault, step by step, with CI evidence.",
  docs=[PLAN], children=[
   S("S8.1", "Chapters", "M",
     "As a junior engineer, I want the new ideas explained, so that I understand why each step exists.",
     ["Secret zero and AppRole; leases and dynamic credentials; ESO and mounted secrets; OpenBao vs Vault; detection on the audit log (chapters 7–11)."],
     evidence=[d("docs/learn/README.md", "learning path"), d("docs/learn/07-secret-zero-and-approle.md", "chapter 7"), d("docs/learn/11-detection-on-the-audit-log.md", "chapter 11")],
     status="done", done=(0,)),
   S("S8.2", "Guide, tutorial and demo pages from this repo's CI", "M",
     "As a presenter, I want demo pages with this repo's screenshots, so that the evidence is the code in front of me.",
     ["Demo pages 19–24 for steps v1–v5, and pages 1–12 and 18 pointed at this repo's CI run, each quoting its real output; a progression story in demo/README.md.",
      "GUIDE and TUTORIAL cover every step on Compose and kind; OpenShift stays labelled unproven (S5.3)."],
     evidence=[d("demo/README.md", "demo pages"), d("docs/GUIDE.md"), d("docs/TUTORIAL.md"), "Screenshots and output from CI run [39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271)"],
     status="done", done=(0, 1)),
  ]),
]

# ---- progress (evidence: commits on main, CI runs) ----
RUN = "[CI run 39155150999](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39155150999)"
_DONE = {
    "S0.1": [d("README.md", "README (provenance)"), d("HANDOVER.md", "HANDOVER section 4")],
    "S0.2": [RUN, "every job green on the first push, captures on the ci-captures branch"],
    "S0.3": [d("HANDOVER.md"), d("CLAUDE.md"), d("scripts/backlog/README.md", "scripts/backlog")],
}
def _items():
    for e in EPICS:
        for f in e["children"]:
            yield f
            yield from f.get("children", [])
for _it in _items():
    if _it["id"] in _DONE:
        _it["status"] = "done"
        _it["criteria"] = [(True, t) for _, t in _it["criteria"]]
        _it["evidence"] = _DONE[_it["id"]]

