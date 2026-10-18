# Secure Notes on OpenBao and HashiCorp Vault

[![ci](https://github.com/ephico2real2/openbao-node-poc/actions/workflows/ci.yaml/badge.svg)](https://github.com/ephico2real2/openbao-node-poc/actions/workflows/ci.yaml)

**The story so far.** [`aws-secrets-manager-node-poc`](https://github.com/ephico2real2/aws-secrets-manager-node-poc)
took a small app, Secure Notes (a dashboard, a Node.js backend, Postgres and Redis), from
passwords in a `.env` file to AWS Secrets Manager. Credentials are fetched at runtime, so
they never sit on disk or in environment variables, logs or Kubernetes objects. They
rotate without a restart. Debug logs show which keys were used, with the values masked.

**This repo.** It shows that design isn't tied to AWS. The same app, unchanged above one
interface, runs on **OpenBao** (the open-source fork of Vault, MPL-2.0, an OpenSSF project)
and on **HashiCorp Vault**. AWS Secrets Manager keeps working, behind the same switch:

| `SECRETS_PROVIDER` | Secrets manager | Status |
| --- | --- | --- |
| `aws` (default) | AWS Secrets Manager (a bundled stand-in locally) | ✅ copied from the sibling repo, CI green |
| `openbao` | OpenBao 2.7.1: KV v2 with AppRole ([step v1](steps/v1-openbao-kv/README.md)) | ✅ step v1 on Docker Compose, CI job `compose (openbao)` |
| | Database users OpenBao creates per instance, with leases; Valkey ([step v2](steps/v2-openbao-dynamic/README.md)) | ✅ step v2 on Docker Compose, CI job `compose (openbao-dynamic)` |
| | Kubernetes: OpenBao from its Helm chart, Kubernetes auth with projected tokens; or External Secrets Operator and a mounted, watched Secret ([step v3](steps/v3-k8s/README.md)) | ✅ step v3 on kind, CI jobs `kind (openbao)` and `kind (openbao-eso)`; OpenShift unproven |
| `vault` | HashiCorp Vault 2.2.0: the same app and client, dynamic users, Vault's Redis plugin ([step v4](steps/v4-vault/README.md)) | ✅ step v4 on Docker Compose, CI job `compose (vault)` |
| detection | OpenBao's audit log → VictoriaLogs → vmalert → an alert when anyone but the app reads its secret ([step v5](steps/v5-detection/README.md)) | ✅ step v5 on Docker Compose, CI job `compose (openbao-detection)` |

To see it run, start with the [demo pages](demo/README.md): test cases 19–24 walk the steps
with screenshots from CI. To learn why each step exists, read
[chapters 7–11](docs/learn/README.md) of the learning path.

**Where the work stands:** [initiative and epics](docs/modernization/README.md) ·
[GitHub issues](https://github.com/ephico2real2/openbao-node-poc/issues). Each step gets a
folder in `steps/` and a git tag. The app itself stays one codebase at the root.
Why OpenBao first: [ADR-002](docs/modernization/03-adr-002-openbao-first.md).

## Run it

```bash
docker compose up --build        # the AWS path, as in the sibling repo: http://localhost:3000
docker compose down -v           # stop and wipe

# step v1: the same lab on OpenBao
export COMPOSE_FILE=docker-compose.yml:steps/v1-openbao-kv/compose.yaml
docker compose up --build -d && scripts/compose-check.sh

# step v2: no stored database password; users OpenBao creates, with leases
export COMPOSE_FILE=$COMPOSE_FILE:steps/v2-openbao-dynamic/compose.yaml
docker compose down -v && docker compose up --build -d && scripts/compose-check.sh
```

- **kind:** `scripts/kind-up.sh && scripts/images-build.sh && scripts/k8s-deploy.sh deploy/k8s/overlays/kind`, then <http://localhost:3000>.
- **OpenShift:** `oc new-project secure-notes && scripts/openshift-build.sh`; it prints the Route.
- **On a MacBook:** `scripts/bootstrap/macos.sh`, then `scripts/preflight.sh kind`.

The [guide](docs/GUIDE.md) and the [quick reference](docs/reference/deploy-quickref.md)
have every command. [HANDOVER.md](HANDOVER.md) is for a new contributor or AI agent.

## Read

- [Learning path](docs/learn/README.md): what a secrets manager is, the `.env` problem, how this app uses one. It is inherited from the sibling repo; chapters on OpenBao come with epic B8.
- [Tutorial](docs/TUTORIAL.md) and [demo pages](demo/README.md): every feature, one at a time. Until this repo's own CI captures replace them, the evidence links point at the sibling repo's runs.
- [Test cases](docs/TEST-CASES.md): every automated test, and the CI job that runs it.

## Repository map

| Folder | What it holds |
| --- | --- |
| [`backend/`](backend/README.md) | The app (Node.js): secrets cache, rotation-aware clients, logging |
| [`frontend/`](frontend/README.md) | The dashboard: static files, no build step |
| [`deploy/`](deploy/README.md) | kind cluster config and Kubernetes overlays (kind, OpenShift, AWS) |
| [`dev/`](dev/README.md) | Dev/CI only: the AWS Secrets Manager stand-in, the OpenBao and Vault lab servers' config, and the detection rules |
| [`steps/`](steps/v1-openbao-kv/README.md) | One folder per step: its Compose overlay and README ([v1: OpenBao KV](steps/v1-openbao-kv/README.md), [v2: dynamic users](steps/v2-openbao-dynamic/README.md), [v3: Kubernetes](steps/v3-k8s/README.md), [v4: Vault](steps/v4-vault/README.md), [v5: detection](steps/v5-detection/README.md)) |
| [`scripts/`](scripts/README.md) | Set up, run, prove and generate: the same scripts on a laptop and in CI |
| [`docs/`](docs/README.md) | Learning path, tutorial, guide, test catalogue, reference, the initiative |
| [`demo/`](demo/README.md) | One page per test case, with CI screenshots |
| [`versions/`](versions/README.md) | Earlier versions you can run (v0: the `.env` app) |

## Provenance

Seeded on 2026-10-18 from
[`aws-secrets-manager-node-poc@67ec055`](https://github.com/ephico2real2/aws-secrets-manager-node-poc/tree/67ec055),
with fresh history. Left out on purpose:
- the AWS-only alerting (SNS, CloudTrail, EventBridge and the log pipeline);
- the CloudFormation stack and the EC2 scripts.

The sibling repo remains the reference for deploying on AWS.
