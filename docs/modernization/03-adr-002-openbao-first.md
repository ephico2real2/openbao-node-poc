# ADR-002 — OpenBao first, HashiCorp Vault second

**Epic B1.** [← Initiative](README.md) · [Backlog](backlog.md) · Sibling: [ADR-001 (AWS Secrets Manager)](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/modernization/02-adr-001-secrets-manager-selection.md)

| | |
| --- | --- |
| Status | Accepted (2026-10-18) |
| Context | The sibling repo chose AWS Secrets Manager for AWS (ADR-001). This repo shows the same rules hold off AWS |
| Decision | **Build on OpenBao first** (epics B3 to B5). **Then run the same app on HashiCorp Vault** (B6). AWS Secrets Manager stays the default provider |
| Facts checked | 2026-10-18, each against the project's own page (linked in [Sources](#sources)) |

## Context

Secure Notes reads two credentials at runtime: a Postgres one and a Redis one. Its
rules are:
- nothing in env vars, files, images or logs;
- rotation without a restart;
- masked debug logs, and a lab-only flag that reveals values.

ADR-001 picked AWS Secrets Manager, and scored Vault as strong but costly to run. The
question now is which Vault-API server to build the off-AWS steps on. Two exist: the
OpenBao fork, and HashiCorp Vault itself.

## The facts that decide it

| | OpenBao | HashiCorp Vault |
| --- | --- | --- |
| Licence | **MPL-2.0** (open source) [1] | **BSL 1.1** for 1.15.0 and later; the Licensor is now IBM; each version changes to MPL 2.0 four years after it is published [3] |
| Owner | An OpenSSF sandbox project since June 2025 (OpenSSF is part of the Linux Foundation) [2] | HashiCorp, part of IBM since 27 February 2025 [4] |
| Version used here | **2.7.1** (1 October 2026) [5] | **2.2.0** (15 October 2026) [6]. GitHub's releases page still marks 2.0.4 as "Latest", so use the release notes |
| API | Vault's HTTP API, CLI `bao` | `vault` |
| Storage (2.7) | In-memory, Raft, PostgreSQL, PebbleDB (new in 2.7.0, no HA). File storage was deprecated in 2.6.0 and removed in 2.7.0 [7] | not compared |
| Start without manual unseal | `seal "static"` (a key in a file) and declarative self-initialisation, both since 2.4.0. Self-init needs an auto-unseal seal [8] | not compared (B6 records what the lab needs) |
| Audit devices | Declared in the config file (since 2.4.0). Since 2.3.2 the API can't create them unless `unsafe_allow_api_audit_creation` is set [9] | not compared |
| Namespaces | Since 2.3.1 (2.3.0 was never released) [10] | Enterprise only [11] |
| Read scaling | Standby nodes serve reads since 2.5.0 [12] | not compared |
| Control groups | Since 2.7.0, with identity-group factors only [13] | Enterprise [11] |
| Not available | Performance/DR replication, Sentinel, the Transform engine [14] | Each of these needs an Enterprise licence [11] |
| Database plugins | The docs list Cassandra, InfluxDB, MySQL/MariaDB, PostgreSQL and **Valkey** [15]. The 2.7.1 binary also lists `redis-database-plugin` as built in (`bao plugin list database`, run 2026-10-18), but the docs don't cover it, so step v2 uses Valkey | Includes `redis` and `redis-elasticache` [16] |

**On Kubernetes (epic B5):**
- **External Secrets Operator.** The latest is v2.13.0 (16 October 2026), API `external-secrets.io/v1` [17].
  - Its **Vault provider is stable**.
  - A **dedicated OpenBao provider** was added in v2.7.0 and is **alpha** [18].
  - ESO's own OpenBao page still says to use the Vault provider, and is out of date [19].
- **Vault Secrets Operator** is BSL 1.1, and its README names only Vault [20].
- **OpenBao has its own CSI provider**: Helm chart 0.18.0 or later with provider 2.0.0 or later. It needs the Secrets Store CSI Driver [21].

## Decision

1. **OpenBao for the main path** (B3 KV, B4 dynamic credentials, B5 Kubernetes).
   - The licence is open source, and a foundation owns the project. Anyone can copy this lab.
   - The static seal and self-init make a lab with no manual steps. The server starts unsealed, and its policies and AppRole roles come from `dev/openbao/config.hcl`.
   - Audit devices are declared in config, so the audit log can't be turned off from the API. B7 builds its detection on that log.
2. **HashiCorp Vault in B6**, with the same app and `SECRETS_PROVIDER=vault`.
   - Many teams already run Vault. Showing the app unchanged on both servers is the portability point.
   - B6 uses Vault's Redis database plugin. On OpenBao, B4 uses the Valkey plugin.
3. **On Kubernetes, the ESO Vault provider against OpenBao** (stable), not the alpha OpenBao provider. B5 revisits this if the OpenBao provider leaves alpha first.
4. **One client for both servers.** `backend/src/secrets/bao/client.js` uses plain `fetch` and adds no dependency. `SECRETS_PROVIDER` decides only what really differs between the servers.

## Consequences

- **Operating burden is ours.** ADR-001 scored Vault 1 out of 3 for this, and that holds for OpenBao: HA, upgrades, backups and unseal keys.
  - The lab's static seal key sits next to the data. That is acceptable for a laptop and never for production.
  - Production needs a KMS or HSM seal, kept away from the data. B5 covers the Helm and Raft setup.
- **Secret zero moves, it doesn't vanish.** AppRole needs a secret ID, which is a credential. Here is how this repo handles it:
  - The secret ID lives in a file (mode 0400) and never in env.
  - The seed job's bootstrap secret ID is single-use.
  - On Kubernetes, B5 replaces AppRole with Kubernetes auth (projected service-account tokens).
- **There are no version stages.** KV v2 has versions, but no AWSPENDING or AWSCURRENT labels.
  - The demo rotation writes the pending value to `<name>/pending`.
  - It then writes the next version with check-and-set (see [`kv.js`](../../backend/src/secrets/bao/kv.js)).
  - B4's dynamic credentials remove the shared password altogether.
- **Unverified, so not claimed:**
  - that IBM removed Vault Enterprise features (no evidence was found; Vault 2.0.0 added some);
  - the end-of-life date of HCP Vault Secrets.

## Sources

Checked on 2026-10-18.

1. OpenBao licence: <https://github.com/openbao/openbao/blob/main/LICENSE>
2. OpenSSF announcement, 17 June 2025: <https://openssf.org/blog/2025/06/17/openbao-joins-the-openssf-to-advance-secure-secrets-management-in-open-source/>
3. Vault licence (BSL 1.1): <https://github.com/hashicorp/vault/blob/main/LICENSE>; 1.15.0 release notes (2023-09-27): <https://developer.hashicorp.com/vault/docs/v1.15.x/release-notes/1.15.0>
4. IBM completes the HashiCorp acquisition: <https://newsroom.ibm.com/2025-02-27-IBM-Completes-Acquisition-of-HashiCorp,-Creates-Comprehensive,-End-to-End-Hybrid-Cloud-Platform>
5. OpenBao 2.7.1: <https://github.com/openbao/openbao/releases/tag/v2.7.1>; 2.7.0 notes: <https://openbao.org/community/release-notes/2-7-0/>
6. Vault release notes: <https://developer.hashicorp.com/vault/docs/updates/release-notes>
7. OpenBao storage: <https://openbao.org/docs/configuration/storage/>; 2.6.0 notes: <https://openbao.org/community/release-notes/2-6-0/>
8. OpenBao 2.4.0 notes: <https://openbao.org/community/release-notes/2-4-0/>; self-init: <https://openbao.org/docs/configuration/self-init/>; static seal: <https://openbao.org/docs/configuration/seal/static/>
9. OpenBao 2.3 notes (audit API change in 2.3.2): <https://openbao.org/community/release-notes/2-3-0/>; configuration: <https://openbao.org/docs/configuration/>
10. The same 2.3 notes
11. Vault Enterprise: <https://developer.hashicorp.com/vault/docs/enterprise>; replication: <https://developer.hashicorp.com/vault/docs/enterprise/replication>; Sentinel: <https://developer.hashicorp.com/vault/docs/enterprise/sentinel>; Transform: <https://developer.hashicorp.com/vault/docs/secrets/transform>
12. OpenBao 2.5.0 notes: <https://openbao.org/community/release-notes/2-5-0/>
13. OpenBao control groups: <https://openbao.org/docs/concepts/control-groups/>
14. OpenBao secrets engines: <https://openbao.org/docs/secrets/>
15. OpenBao database plugins: <https://openbao.org/docs/secrets/databases/>
16. Vault Redis plugins: <https://developer.hashicorp.com/vault/docs/secrets/databases/redis>, <https://developer.hashicorp.com/vault/docs/secrets/databases/rediselasticache>
17. ESO v2.13.0: <https://github.com/external-secrets/external-secrets/releases/tag/v2.13.0>
18. ESO stability table: <https://external-secrets.io/latest/introduction/stability-support/>; v2.7.0: <https://github.com/external-secrets/external-secrets/releases/tag/v2.7.0>
19. ESO OpenBao page: <https://external-secrets.io/latest/provider/openbao/>; Vault provider: <https://external-secrets.io/latest/provider/hashicorp-vault/>
20. Vault Secrets Operator licence: <https://github.com/hashicorp/vault-secrets-operator/blob/main/LICENSE>
21. OpenBao CSI provider: <https://openbao.org/docs/platform/k8s/csi/>
