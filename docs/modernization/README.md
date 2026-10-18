# Initiative: Secure Notes on any secrets manager

[← Documentation](../README.md) · [ADR-002](03-adr-002-openbao-first.md) · [Backlog](backlog.md) · [GitHub issues](https://github.com/ephico2real2/openbao-node-poc/issues?q=is%3Aissue+label%3Atype%3Aepic)

**Where this comes from.** [`aws-secrets-manager-node-poc`](https://github.com/ephico2real2/aws-secrets-manager-node-poc)
took a Node.js app from passwords in a `.env` file to AWS Secrets Manager:
- credentials fetched at runtime;
- nothing in env vars, files, images or logs;
- rotation without a restart;
- masked debug logs, and a lab-only flag that reveals the values.

Its epic E15 planned the next step and parked it. This repo is that step.

**The goal.** Show the same rules hold on **OpenBao** (most of this repo) and **HashiCorp
Vault**, on Docker Compose, kind and OpenShift, while AWS Secrets Manager keeps working.
One setting chooses the secrets manager:

| `SECRETS_PROVIDER` | Talks to | How the app logs in |
| --- | --- | --- |
| `aws` (default) | AWS Secrets Manager (a stand-in locally) | the IAM role (instance profile, IRSA) |
| `openbao` | OpenBao | AppRole (secret ID from a file) or Kubernetes auth |
| `vault` | HashiCorp Vault | the same; OpenBao keeps Vault's API |

## How the work is organized

The epics are B0 to B8. Each one is a GitHub issue with its features and stories as
sub-issues. Issue titles start with the track: `APP:` (changing the app) or `TUTORIAL:`
(teaching it).

| Epic | Track | Delivers | Folder | Tag |
| --- | --- | --- | --- | --- |
| B0 Seed the repo | APP | The app copied with the AWS path kept, CI green | repo root | `v1-aws-baseline` |
| B1 ADR-002 | TUTORIAL | OpenBao first, Vault second, with accurate facts | `docs/modernization/` | — |
| B2 Provider switch | APP | `SECRETS_PROVIDER`, providers and stores, auth without env | `backend/src/secrets/` | — |
| B3 OpenBao KV | APP | The whole lab on OpenBao (Compose) | `steps/v1-openbao-kv/` | `v2-openbao-kv` |
| B4 Dynamic credentials | APP | Leases, per-instance DB users, Valkey | `steps/v2-openbao-dynamic/` | `v3-openbao-dynamic` |
| B5 Kubernetes | APP | OpenBao Helm, External Secrets Operator, a watched volume, OpenShift | `steps/v3-k8s/` | `v4-k8s` |
| B6 Vault | APP | The same app on HashiCorp Vault | `steps/v4-vault/` | `v5-vault` |
| B7 Detection | APP | OpenBao's audit log → an alert on an unexpected read | `steps/v5-detection/` | — |
| B8 Tutorial | TUTORIAL | Chapters, guide, demo pages from this repo's CI | `docs/` | — |

One app lives at the repository root. Each step folder holds that step's Compose or Helm
files and a README. A git tag marks each step.

**Decisions so far:**
- **A new repo**, rather than a folder in the sibling, so this story can take its own direction.
- **OpenBao first.** It has an open-source licence (MPL-2.0) and is an OpenSSF project. Vault is covered in B6. [ADR-002](03-adr-002-openbao-first.md) records the facts and their sources.
- **The AWS path stays**, so every change is a visible diff against a known-good baseline.
- **AWS-only alerting is not copied.** That means SNS, CloudTrail and EventBridge. The same idea comes back in B7, built on OpenBao's audit log.
