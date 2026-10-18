# Learning path: from `.env` files to a centralized secrets manager

Eleven short chapters, each building on the last. The principles apply to any language and
any secrets manager; **Secure Notes** (Node.js, Postgres, Redis) is the worked example
throughout. Chapters 1–6 use AWS Secrets Manager; chapters 7–11 follow the app onto
OpenBao and HashiCorp Vault, one step folder at a time. About an hour in total.

The sibling repo's chapter on [alerts and audit on AWS](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/learn/07-alerts-and-audit.md)
(CloudTrail, SNS) is the AWS counterpart of chapter 11.

| # | Chapter | You'll learn |
| --- | --- | --- |
| 1 | [Secrets managers and how workloads fetch secrets](01-secrets-managers.md) | The retrieval pattern common to AWS Secrets Manager, HashiCorp Vault, Azure Key Vault and Google Secret Manager |
| 2 | [The `.env` file problem](02-the-env-file-problem.md) | A live Podman demo: anyone with access to a container can read its `.env` credentials |
| 3 | [Why a secrets manager](03-why-a-secrets-manager.md) | Encryption, audit, rotation, automation with Terraform and Ansible, and workload identity with JWTs |
| 4 | [Secure Notes, before and after](04-secure-notes-app.md) | The app's architecture with `.env` and with Secrets Manager, and the code an app must add |
| 5 | [System design review](05-system-design.md) | What the AWS design gets right, what to improve, and the target architecture |
| 6 | [Inside the app: request flows](06-request-flows.md) | Startup retrieval, rotation recovery and log masking, step by step |
| 7 | [Secret zero and AppRole](07-secret-zero-and-approle.md) | The "secret zero" problem, and how step v1 solves it on Compose: a role ID, a secret ID in a mode-0400 file, a one-time bootstrap for the seed job, and a token the app renews |
| 8 | [Leases and dynamic credentials](08-leases-and-dynamic-credentials.md) | Step v2: a Postgres and a Valkey user per app instance, with a lease the app renews, re-issues and revokes; only OpenBao knows the admin |
| 9 | [Kubernetes auth and External Secrets](09-kubernetes-auth-and-external-secrets.md) | Step v3: OpenBao from its Helm chart on kind, projected service-account tokens instead of a secret zero, and file mode with External Secrets Operator and its trade-offs |
| 10 | [OpenBao and HashiCorp Vault](10-openbao-and-vault.md) | Step v4 and ADR-002: the same app on both servers, and what differs: licence, start-up, audit device, cache plugin |
| 11 | [Detection on the audit log](11-detection-on-the-audit-log.md) | Step v5: from an audit log line (values HMAC'd) through a shipper, VictoriaLogs and a vmalert rule to an alert when anyone but the app reads its secret |

## Words you'll meet

| Term | Meaning |
| --- | --- |
| **IAM role** | An AWS identity a workload *assumes*; it has permissions but no long-lived password or key |
| **STS** | AWS Security Token Service: issues the short-lived credentials for a role |
| **SigV4** | How AWS requests are signed with those credentials, so they can't be forged or replayed later |
| **IMDSv2** | The EC2 instance metadata service, session-token version: where the SDK gets the instance role's credentials |
| **KMS** / **envelope encryption** | AWS Key Management Service. Each secret is encrypted with its own data key, and the data key is encrypted with your KMS key |
| **VPC endpoint** | A private address for an AWS service inside your network, so calls don't cross the internet |
| **JWT** | JSON Web Token: a signed statement of who a workload is ([chapter 3](03-why-a-secrets-manager.md#workload-identity-and-jwt)) |
| **IRSA** / **EKS Pod Identity** | IAM Roles for Service Accounts: how a Kubernetes pod on AWS gets an IAM role from its service-account token |
| **EKS** / **ROSA** / **kind** | Amazon's Kubernetes; Red Hat OpenShift Service on AWS; Kubernetes in Docker, for laptops and CI |
| **SSRF** | Server-side request forgery: tricking an app into fetching a URL on the attacker's behalf |
| **Rotation** | Replacing a credential on a schedule; version labels `AWSCURRENT`, `AWSPENDING`, `AWSPREVIOUS` track the old and new |
| **Break-glass role** | An emergency admin role, used rarely and audited |
| **CloudTrail** | AWS's audit log: one record per API call, saying who did what, when and from where |
| **EventBridge** | AWS's event router: a rule matches events (such as CloudTrail records) and sends them to a target |
| **OpenTelemetry** | A CNCF standard for logs, metrics and traces, and the format the app ships its logs in |

**Then:** run it yourself with the [tutorial](../TUTORIAL.md), demo one feature at a time
with the [demo pages](../../demo/README.md), or deploy it with the [guide](../GUIDE.md).
The work behind all of this is organized as an agile initiative in
[`docs/modernization/`](../modernization/README.md).
