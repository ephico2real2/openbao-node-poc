# Documentation

[← Project README](../README.md)

Everything written about Secure Notes is in this folder. The demo pages are in
[`../demo`](../demo/README.md), and the handover for a new contributor or AI agent is
[`../HANDOVER.md`](../HANDOVER.md).

## Where to start

| You want to… | Read, in this order |
| --- | --- |
| **Learn** why secrets managers exist and how this app uses one | [Learning path](learn/README.md): chapters 1 to 6 (inherited from the sibling repo), then 7 to 11 on OpenBao and Vault; then the [tutorial](TUTORIAL.md) |
| **Run it** on your laptop, on kind or on OpenShift | [GUIDE.md](GUIDE.md), or the one-page [deploy quick reference](reference/deploy-quickref.md) |
| **Demo it**, one feature at a time, with CI screenshots | [Demo test cases](../demo/README.md) |
| **Check a claim**: which test proves what | [TEST-CASES.md](TEST-CASES.md) and [CI](reference/ci.md) |
| **Review the design** as an architect or a security engineer | [System design](learn/05-system-design.md), [security controls](reference/security-controls.md), [ADR-001 (sibling repo)](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/modernization/02-adr-001-secrets-manager-selection.md) |
| **Plan the work** as a team lead | [Initiative and epics B0–B10](modernization/README.md) |

## What's in this folder

| Path | What it is |
| --- | --- |
| [`learn/`](learn/README.md) | The learning path for a junior engineer: chapters 1–6 (inherited: from "what is a secret" to request flows) and 7–11 (secret zero, leases, Kubernetes auth and External Secrets, OpenBao and Vault, detection) |
| [`TUTORIAL.md`](TUTORIAL.md) | One continuous walkthrough: the AWS path (steps 1–9), then OpenBao and Vault (steps 10–14) |
| [`GUIDE.md`](GUIDE.md) | How to deploy: Part A Docker Compose, Part B kind, OpenShift, EKS/ROSA (step by step, with checks). AWS on EC2 is in the sibling repo |
| [`TEST-CASES.md`](TEST-CASES.md) | Every automated test, by ID (S, R, L, D, C, F, A, P, K…), and the CI job that runs it |
| [`reference/`](reference/README.md) | Look-up pages: secret naming, security controls, deploy commands, CI |
| [`modernization/`](modernization/README.md) | The initiative: epics B0–B10, ADR-002 (epic B1), and the generated backlog |
| [`releases/`](releases/README.md) | Release notes, one per step tag, and how the owner cuts the tags |
| [`images/`](images) | Pictures used by these pages (the demo's screenshots live in `../demo/images`) |

## How these pages are kept honest

- **Output is real.** Output and screenshots come from CI runs, published on the
  [`ci-captures`](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures)
  branch, and each page says which run.
- **Generated parts can't drift.** The alert table, the alarms and the backlog are
  generated from code or data, and CI fails if a copy is stale.
- **Links and diagrams are checked.** The `docs` CI job checks every relative link and
  renders every Mermaid diagram.
- **Unproven steps are labelled.** Anything not yet run on real AWS or on a real OpenShift
  cluster says so where it appears.
