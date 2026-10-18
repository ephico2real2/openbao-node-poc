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
       ["checks, build, compose (sdk, agent), kind, mirror, env-file-demo, v0-leak and docs jobs green.", "Captures published to this repo's ci-captures branch."]),
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
      "The two common claims corrected: 'IBM removed Enterprise features' and 'OpenBao has all Enterprise features'."]),
  ]),
 dict(id="B2", track="app", title="One switch: SECRETS_PROVIDER=aws|openbao|vault",
  outcome="The app chooses its secrets manager with one setting; everything above the fetcher (cache, rotation recovery, masking, reveal flag) is unchanged.",
  docs=[PLAN], children=[
   S("S2.1", "Providers for reading", "M",
     "As a developer, I want each secrets manager behind the same interface, so that the cache and the clients don't care which one is in use.",
     ["backend/src/secrets/providers/{aws,bao,file}.js return the same shape; for KV v2 the version is the KV version.",
      "bao: plain fetch against the HTTP API, no new dependency; openbao and vault share it.",
      "Unit tests against a fake HTTP server: KV v2 read, errors, timeouts."]),
   S("S2.2", "Authentication without a credential in the environment", "M",
     "As a security engineer, I want the app to log in to OpenBao without a token in its environment, so that the no-env rule still holds.",
     ["AppRole with the secret ID read from a file (mode 0400, tmpfs); Kubernetes auth with a projected, audience-bound service-account token.",
      "Token renew-self at 2/3 of its TTL; re-login on 403; all logged with masked values.",
      "config.js refuses VAULT_TOKEN, BAO_TOKEN and the existing credential variables."]),
   S("S2.3", "Stores for writing (seed and the demo rotation)", "M",
     "As a presenter, I want the seed job and the rotation lab to work on every provider, so that the same demos run on OpenBao.",
     ["backend/src/secrets/stores/{aws,bao}.js: put, promote, randomPassword.", "The rotator's four steps unchanged; on OpenBao, promote writes a new KV version."]),
  ]),
 dict(id="B3", track="app", title="OpenBao KV on Docker Compose (steps/v1-openbao-kv)",
  outcome="The full lab runs on OpenBao: seed, rotation without restart, leak test, credential scan, reveal flag.",
  docs=[PLAN], children=[
   S("S3.1", "OpenBao with no manual steps", "M",
     "As a learner, I want OpenBao to start initialised and unsealed, so that I can focus on the app.",
     ["Static seal and self-init (dev/openbao/config.hcl); KV v2, AppRole and policies created at start.", "A file audit device; its log shows HMACs, never values."]),
   S("S3.2", "The lab on OpenBao", "M",
     "As a presenter, I want every existing demo to work on OpenBao, so that the comparison is fair.",
     ["Rotate from the dashboard: auth-failed → new-version → recovered.", "Leak test 0 of 6; credential scan clean, including the OpenBao container and its audit log.",
      "CI job compose (openbao) with captures."]),
  ]),
 dict(id="B4", track="app", title="Dynamic credentials and leases (steps/v2-openbao-dynamic)",
  outcome="The database password is a lease: per-instance users that expire, renewed and re-issued without a failed request.",
  docs=[PLAN], children=[
   S("S4.1", "Postgres dynamic credentials", "M",
     "As a DBA, I want each app instance to get its own short-lived database user, so that a leaked password expires by itself.",
     ["Database secrets engine with a Postgres role; leases renewed, re-issued before the max TTL; the pool drains old users.", "The dashboard shows the lease countdown."]),
   S("S4.2", "Valkey through OpenBao's plugin", "S",
     "As an operator, I want the cache credential managed the same way, so that both credentials rotate without the app.",
     ["Valkey replaces Redis here (OpenBao has a Valkey plugin and no Redis plugin); ioredis works unchanged."]),
  ]),
 dict(id="B5", track="app", title="Kubernetes and OpenShift: OpenBao Helm and External Secrets Operator",
  outcome="On kind and OpenShift, credentials arrive as a mounted Secret (never env), or through Kubernetes auth, and refresh without a restart.",
  docs=[PLAN], children=[
   S("S5.1", "OpenBao on Kubernetes", "M",
     "As a platform engineer, I want OpenBao installed by its Helm chart, so that the cluster lab matches production practice.",
     ["Helm (raft) on kind in CI and on OpenShift (restricted-v2, Routes).", "Kubernetes auth for SECRETS_MODE=api."]),
   S("S5.2", "External Secrets Operator and a watched volume", "L",
     "As a developer, I want ESO to deliver the credential as files, so that the app needs no OpenBao client in the cluster.",
     ["ClusterSecretStore (Vault provider) and ExternalSecret; the Secret is mounted, no envFrom and no subPath.",
      "SECRETS_MODE=file watches the ..data swap and re-reads on a timer; rotation in OpenBao reaches the app without a restart.",
      "k8s-check and the credential scan extended."]),
  ]),
 dict(id="B6", track="app", title="The same app on HashiCorp Vault (steps/v4-vault)",
  outcome="SECRETS_PROVIDER=vault runs the same lab on Vault, including its Redis database plugin.",
  docs=[PLAN], children=[
   S("S6.1", "Vault variant", "M",
     "As a Vault user, I want the same app on Vault, so that both products are covered.",
     ["Vault 2.x server config (no dev mode); the same app and seed; the Redis database plugin.", "CI job compose (vault)."]),
  ]),
 dict(id="B7", track="app", title="Audit-based detection: an unexpected read raises an alert",
  outcome="OpenBao's audit log is the source of truth for who read what; a rule on the log store raises the alert, as CloudTrail does on AWS.",
  docs=[PLAN], children=[
   S("S7.1", "From the audit log to an alert", "L",
     "As a security engineer, I want a read by an unexpected entity to page someone, so that a leaked token is noticed.",
     ["File audit device → OpenTelemetry Collector → VictoriaLogs → vmalert → a webhook console.", "A detection lab button reads a secret with another AppRole."]),
  ]),
 dict(id="B8", track="tutorial", title="Tutorial: learning chapters, guide and demos",
  outcome="Learners can follow the move from AWS Secrets Manager to OpenBao and Vault, step by step, with CI evidence.",
  docs=[PLAN], children=[
   S("S8.1", "Chapters", "M",
     "As a junior engineer, I want the new ideas explained, so that I understand why each step exists.",
     ["Secret zero and AppRole; leases and dynamic credentials; ESO and mounted secrets; OpenBao vs Vault."]),
   S("S8.2", "Guide, tutorial and demo pages from this repo's CI", "M",
     "As a presenter, I want demo pages with this repo's screenshots, so that the evidence is the code in front of me.",
     ["Demo pages replaced with this repo's captures; GUIDE covers Compose, kind and OpenShift Local on a Mac."]),
  ]),
]
