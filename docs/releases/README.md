# Releases: one tag per step

Each file is the release notes for one tag, cut from a commit whose CI run was green.
A tag is cut with the `milestone` workflow (Actions → milestone → Run workflow), with the
tag, commit, title and notes file below.

| Tag | Commit | Title | Notes |
| --- | --- | --- | --- |
| `v1-aws-baseline` | `98018d1` | Baseline: Secure Notes on AWS Secrets Manager | [v1-aws-baseline.md](v1-aws-baseline.md) |
| `v2-openbao-kv` | `27ca652` | Step v1: the lab on OpenBao (KV v2, AppRole) | [v2-openbao-kv.md](v2-openbao-kv.md) |
| `v3-openbao-dynamic` | `bec8229` | Step v2: database users that expire | [v3-openbao-dynamic.md](v3-openbao-dynamic.md) |
| `v4-k8s` | `16b0037` | Step v3: OpenBao on Kubernetes (Kubernetes auth, External Secrets) | [v4-k8s.md](v4-k8s.md) |
| `v5-vault` | `17a6f4e` | Step v4: the same app on HashiCorp Vault | [v5-vault.md](v5-vault.md) |
| `v6-detection` | `f30aed6` | Step v5: detection on the audit log, and the tutorial | [v6-detection.md](v6-detection.md) |
