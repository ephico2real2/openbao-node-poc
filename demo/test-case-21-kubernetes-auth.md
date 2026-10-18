# Test case 21 — OpenBao on Kubernetes, with Kubernetes auth (step v3)

[← all test cases](README.md) · [Step v3](../steps/v3-k8s/README.md) · [Chapter 9](../docs/learn/09-kubernetes-auth-and-external-secrets.md)

**What it proves:** on kind, OpenBao comes up from its Helm chart already initialised and
unsealed. The app logs in with its pod's **projected service-account token** (audience
`openbao`, valid 10 minutes, rotated by the kubelet). There is no secret ID to hand over,
and no Kubernetes API token in the pod. Its database logins are users OpenBao creates, as
in step v2.

**Catalogue IDs:** K8B1–K8B4 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** `kind (openbao)` · **Evidence from:** [CI run 39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271): [captures](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2202Z_ci_run39169755271-1_kind-kind-openbao), [check output](https://github.com/ephico2real2/openbao-node-poc/blob/ci-captures/2026-10-18T2203Z_ci_run39169755271-1_kind-openbao-logs/k8s-check.txt)

## Steps

```bash
scripts/kind-up.sh && KIND_OPENBAO=1 scripts/images-build.sh
scripts/openbao-k8s-up.sh
scripts/k8s-deploy.sh deploy/k8s/overlays/kind-openbao
scripts/k8s-check.sh
```

## What you should see

The header shows the Kubernetes auth login, and the flow shows a pod with a projected
token for OpenBao under the restricted Pod Security profile:

![The app on kind with Kubernetes auth](images/k8s-01-dashboard.png)

## Evidence from the run

```
== Kubernetes Secrets in the namespace (Opaque ones; names and keys only)
  local-bootstrap-f9hmh2c6g8: pg-password redis-password
  ok    the only Secret is the one-time bootstrap; the app's credentials are not stored in Kubernetes
…
== step v3: OpenBao in the cluster, Kubernetes auth, users with leases
  ok    OpenBao 2.7.1 (Helm, raft storage): initialized and unsealed by itself (static seal, self-init)
  ok    the app logged in with Kubernetes auth, role 'secure-notes-app' (policies: default,secure-notes-app)
  ok    no Kubernetes API token in the app pod (automountServiceAccountToken: false)
  ok    the app's OpenBao token is projected: audience openbao, valid 10 min, service account secure-notes
  ok    the app's Postgres sessions use a user OpenBao created for it (v-kubernet-notes-ap-…)
…
  ok    revoke the db lease (OpenBao drops the user)  (revoked lease C5rgFgC4)
  ok    drop connections, then app recovers with the rotated credentials  (recovered: db, redis)
…
credential-scan: no credential value found anywhere it must not be

k8s-check: all checks passed
```

CI deploys the overlay twice. On the second run the seed job finds its secrets and
resumes, using the stored admin passwords now that the bootstrap ones are burned
([seed log](https://github.com/ephico2real2/openbao-node-poc/blob/ci-captures/2026-10-18T2203Z_ci_run39169755271-1_kind-openbao-logs/seed.log)):

```
[seed] the 4 secrets already exist: making sure Postgres, Redis and the secrets manager match them (resuming)
```
