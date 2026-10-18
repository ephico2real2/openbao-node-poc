# Run and deploy: quick reference

[← README](../../README.md) · Step by step: [GUIDE](../GUIDE.md)

The commands for each path, for when you've done it once. The [guide](../GUIDE.md) explains every step.

## One build, one set of images

`docker compose build` is the only place images are built. It produces
`secure-notes-app:dev` and `secure-notes-aws-mock:dev`; Docker Compose runs them,
`scripts/images-build.sh` loads the exact same images into kind, and CI pushes the
images that passed every job to GHCR (`ghcr.io/ephico2real2/openbao-node-poc/app`)
for OpenShift and EKS to pull. Nothing is rebuilt between the test and the publish.

## A. Run locally with Docker Compose

Needs only Docker to run. The check scripts (`scripts/*-check.sh`) also need Node.js 22, `curl` and `jq`.

```bash
docker compose up --build        # then open http://localhost:3000
docker compose down -v           # stop and wipe (new random credentials next time)
```

Five containers start: Postgres 16, Redis 7, the AWS mock (`dev/aws-mock`: Secrets
Manager and STS), a one-shot `seed` job and the app. The seed job generates random passwords, stores them
in Secrets Manager, applies them to Postgres and Redis, then replaces the bootstrap
passwords. After startup, the only copy of every credential is in Secrets Manager.

**Agent mode:** the same stack with the app reading its secrets through a local agent
on its own `localhost:2773`, as `SECRETS_MODE=agent` does on EC2:

```bash
docker compose -f docker-compose.yml -f docker-compose.agent.yml up --build
```

**The original app (v0)**, with its passwords in a `.env` file:
`cd versions/v0-env-file && docker compose up --build -d && ./leak.sh` (port 3001).

> LocalStack's image now requires an account and auth token, so the project ships its
> own zero-dependency mock. Point `AWS_MOCK_ENDPOINT` at LocalStack if you prefer it.

## B. Run on Kubernetes or OpenShift

Kustomize, in `deploy/k8s/`:

| Directory | What it is |
| --- | --- |
| `base/` | The app alone: hardened Deployment (non-root, read-only root, no capabilities, seccomp), Service, ServiceAccount with no token, default-deny NetworkPolicies. Production mode, no credentials. |
| `components/local-backing-services/` | Postgres, Redis, the mock and the seed Job inside the cluster, each reachable only from the app and the seed. |
| `overlays/kind/` | base + backing services, Pod Security `restricted` enforced on the namespace. |
| `overlays/openshift/` | base + backing services + a TLS Route, published images, no fixed UIDs so the restricted-v2 SCC assigns them. |
| `overlays/aws/` | base only, against real RDS, ElastiCache and Secrets Manager; the ServiceAccount carries an IAM role (IRSA) on EKS or ROSA. |

**kind** (needs Docker, kind and kubectl; on a Mac, `scripts/bootstrap/macos.sh` installs them):

```bash
scripts/preflight.sh kind                         # tools, Docker's memory, free ports
scripts/kind-up.sh                                # the cluster, from deploy/kind/cluster.yaml
scripts/images-build.sh                           # docker compose build, then load into kind
scripts/k8s-deploy.sh deploy/k8s/overlays/kind    # apply and wait
# open http://localhost:3000: kind maps it, no port-forward
scripts/k8s-check.sh                              # evidence + smoke test
scripts/kind-down.sh                              # when you're done
```

**OpenShift** (OpenShift Local / CRC or a dev cluster):

```bash
scripts/preflight.sh openshift                   # oc installed and logged in
oc new-project secure-notes
KUBECTL=oc scripts/k8s-deploy.sh deploy/k8s/overlays/openshift   # published images (amd64), from GHCR
scripts/openshift-build.sh                       # or: build on the cluster from HEAD (Apple-silicon CRC, no GHCR)
# both print the app's https:// Route
```

**A cluster that can't reach ghcr.io or Docker Hub:** copy the four images into a
registry it can reach, then deploy the overlay the script generates (it checks that
every image comes from your registry):

```bash
skopeo login registry.example.com             # or podman/oc registry login
scripts/mirror-images.sh registry.example.com/team/secure-notes
KUBECTL=oc scripts/k8s-deploy.sh deploy/k8s/overlays/mirror
```

It uses `skopeo` (or `oc image mirror` with `MIRROR_TOOL=oc`); `BASE_OVERLAY=kind`
mirrors for the kind overlay instead. A private registry also needs a pull secret
linked to the `secure-notes` and `default` service accounts.

**EKS or ROSA, real AWS:** fill in the placeholders in `deploy/k8s/overlays/aws/`,
create the IAM role for IRSA (`infra/irsa-trust-policy.example.json`) and the `rds-ca`
ConfigMap, then `kubectl apply -k deploy/k8s/overlays/aws`. The IRSA role gets the same
read-only, two-secret policy as the EC2 role.

## C. Deploy to AWS on EC2

In the sibling repo: [`aws-secrets-manager-node-poc`, Part C](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/reference/deploy-quickref.md#c-deploy-to-aws-on-ec2).

## Project layout

```
backend/        Node.js app: src/secrets (provider, fetchers, SecretValue, redactor),
                src/clients (Postgres, Redis), src/security (posture checks),
                src/demo (rotation lab), scripts (seed, smoke test), test (unit)
frontend/       dashboard (vanilla JS, strict CSP, textContent only)
dev/            Secrets Manager + STS + agent mock (dev/CI only), Redis entrypoint
deploy/k8s/     Kustomize base, component and overlays (kind, OpenShift, AWS)
docs/           GUIDE.md (deploy), TUTORIAL.md, TEST-CASES.md;
                learn/ (the learning path), modernization/ (initiative, backlog),
                reference/ (controls, CI, secret naming, this page)
deploy/config/  example config.yaml and config.env (secret naming settings)
demo/           one page per test case, with CI screenshots and output
infra/          example IAM and IRSA policies (the EC2 stack is in the sibling repo)
steps/          one folder per step (OpenBao KV, dynamic credentials, Kubernetes, Vault), from epic B3
scripts/        the same scripts on a laptop and in CI; capture/ = the dashboard walk
.github/        ci.yaml and the browser-walk action
```
