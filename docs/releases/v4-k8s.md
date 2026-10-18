# Step v3: OpenBao on Kubernetes (Kubernetes auth, External Secrets)

**Step v3: OpenBao on Kubernetes.** OpenBao comes up from its Helm chart on kind,
initialised and unsealed by itself. Two ways for the app to get its credentials:

- **Kubernetes auth:** the app logs in with its pod's projected service-account token
  (audience `openbao`, 10 minutes). There is no secret zero to hand over, and its
  database logins are leased users, as in step v2.
- **File mode:** External Secrets Operator copies the secrets into a Kubernetes Secret,
  mounted as a volume (no env, no subPath). The app has no OpenBao identity at all, and a
  rotation done in OpenBao reaches it as a changed file, with no restart.

OpenShift: the values file exists, but this tag is **not proven on OpenShift** (S5.3).

## Run it

```bash
scripts/kind-up.sh && KIND_OPENBAO=1 scripts/images-build.sh && scripts/openbao-k8s-up.sh
scripts/k8s-deploy.sh deploy/k8s/overlays/kind-openbao && scripts/k8s-check.sh
```

## Evidence

Every job green in [CI run 39169744109](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169744109), a pull request run; its run on main was cancelled by the next push, on commit `16b0037`. (The `images` job runs on pushes to main only.)

## Read more

- [Step v3](https://github.com/ephico2real2/openbao-node-poc/tree/v4-k8s/steps/v3-k8s/README.md)
- Demo pages with this repo's CI screenshots: [demo/README.md](https://github.com/ephico2real2/openbao-node-poc/blob/main/demo/README.md) (on main)
