# versions/

[← Project README](../README.md)

The app's history, in versions you can run. One app lives at the repository root. Earlier
versions that need their own code live here as folders; each later step is a folder in
[`steps/`](../README.md#read) with that step's Compose or Helm files, plus a git tag.

| Version | Where | Credentials come from |
| --- | --- | --- |
| **v0** | [`v0-env-file/`](v0-env-file/README.md) | a `.env` file, as environment variables: the "before" picture (`leak.sh` finds them in 8 of 9 places) |
| **v1** | repo root, tag `v1-aws-baseline` (epic B0) | AWS Secrets Manager at runtime, as in the [sibling repo](https://github.com/ephico2real2/aws-secrets-manager-node-poc) |
| **v2** | `steps/v1-openbao-kv`, tag `v2-openbao-kv` (epic B3) | OpenBao KV v2, AppRole login |
| **v3** | `steps/v2-openbao-dynamic`, tag `v3-openbao-dynamic` (epic B4) | OpenBao dynamic database credentials (leases) |
| **v4** | `steps/v3-k8s`, tag `v4-k8s` (epic B5) | OpenBao on Kubernetes, External Secrets Operator, a watched volume |
| **v5** | `steps/v4-vault`, tag `v5-vault` (epic B6) | HashiCorp Vault |

Tags are created by the `milestone` workflow (Actions → milestone → Run workflow) from a
green commit. If a tag isn't there yet, that step isn't done.
