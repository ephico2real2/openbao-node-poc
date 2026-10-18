# Run and Deploy Secure Notes — Step-by-Step Guide

_Last updated October 18, 2026. The [README](../README.md) is the short version; this guide walks through every step._

Secure Notes runs three ways, all from the same two container images: on your laptop with Docker Compose, on Kubernetes or OpenShift, and on AWS on an EC2 server. Its credentials come from a secrets manager you pick with one setting, `SECRETS_PROVIDER=aws|openbao|vault`. Pick the part that matches where you want to run it; you don't need to do them in order.

## Pick your path

| Part | Where it runs | Secrets come from | You need | Time |
| --- | --- | --- | --- | --- |
| **A. Docker Compose** | Your laptop | A Secrets Manager stand-in, in a container | Docker | 5 min |
| **A, steps v1, v2, v5** | Your laptop | OpenBao 2.7.1, in a container: stored secrets with AppRole ([v1](../steps/v1-openbao-kv/README.md)), database users with leases ([v2](../steps/v2-openbao-dynamic/README.md)), an alert on the audit log ([v5](../steps/v5-detection/README.md)) | Docker, Compose 2.24 or later | 5 to 10 min each |
| **A, step v4** | Your laptop | HashiCorp Vault 2.2.0, in a container ([v4](../steps/v4-vault/README.md)) | The same | 5 min |
| **B. Kubernetes or OpenShift** | kind, OpenShift Local or a dev cluster; or EKS / ROSA | The stand-in inside the cluster, or real Secrets Manager on EKS / ROSA | kubectl or oc (plus Docker and kind for B1) | 10 to 20 min |
| **B4, step v3** | kind | OpenBao from its Helm chart, with Kubernetes auth; or a Secret that External Secrets Operator keeps in sync ([v3](../steps/v3-k8s/README.md)) | kubectl, kind and helm 3 | 15 min |
| **C. AWS on EC2** | In the [sibling repo](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/GUIDE.md#part-c--deploy-to-aws-on-ec2) | Real Secrets Manager | An AWS account | About 1 hour |

New to all of this? Do Part A first. It takes five minutes, needs no account, and shows you everything the app does before you deploy it anywhere. The step folders under `steps/` are the source of truth for the OpenBao and Vault commands; this guide gives the short version of each.

**One build, everywhere.** `docker compose build` (which Part A runs for you) is the only place images are built. Part B loads those exact images into kind; on every push to `main`, CI publishes the images that passed its tests to GitHub's container registry for OpenShift and EKS to pull.

**How to read this guide:**

- Every grey command block is copy-paste.
- Text in `<angle brackets>` is something you replace with your own value.
- Run commands in a terminal, from the `openbao-node-poc` folder, unless the step says otherwise.
- Each step ends with a **Check**. Don't move on until it passes.

## Get the code

Every part starts from the project's GitHub repository, [ephico2real2/openbao-node-poc](https://github.com/ephico2real2/openbao-node-poc).

```bash
git clone https://github.com/ephico2real2/openbao-node-poc.git
cd openbao-node-poc
ls
```

**Check:** `ls` lists `backend`, `frontend`, `deploy`, `dev`, `infra`, `scripts`, `docker-compose.yml` and `README.md`.

No git? On the repository page, choose **Code → Download ZIP**, unzip it, and `cd` into the folder.

**On Windows,** run everything inside WSL (Ubuntu). The scripts are bash and won't run in PowerShell.

## Part A — Run locally with Docker Compose

The quickest way to see the app: no AWS account, no Kubernetes, only Docker. Everything AWS would normally provide runs in containers, including a stand-in for Secrets Manager.

**You need:** Docker Desktop, running. Check with `docker compose version`; it should print `v2.` followed by numbers. Node.js 22 is only needed for the optional tests in step 3.

1. Build the images and start everything:

   ```bash
   docker compose up --build
   ```

   The first run takes a few minutes while Docker downloads and builds. Wait until the log shows `secure-notes listening`.
2. Open <http://localhost:3000> and try it: add a note, click **Rotate Postgres secret**, then **Drop connections**, then **Run leak attempts**. Watch the Credential timeline record each step.
3. Optional: in a second terminal, run the unit tests and the end-to-end check:

   ```bash
   (cd backend && npm install && npm test)
   scripts/compose-check.sh
   ```

   **Check:** the tests end with `# fail 0`, and `compose-check.sh` ends with `credential-scan: no credential value found anywhere it must not be`.
4. Stop and reset. Press `Ctrl+C` in the first terminal, then:

   ```bash
   docker compose down -v
   ```

   `-v` deletes the data, so the next start creates new random passwords. It also frees port 3000.

**Optional: agent mode.** On EC2 the app can read its secrets through a local AWS agent instead of calling Secrets Manager itself (`SecretsMode=agent` in the sibling repo's stack). To try that here, start the stack with a second file:

```bash
docker compose -f docker-compose.yml -f docker-compose.agent.yml up --build
```

The dashboard looks the same, and **Secrets in memory** shows `mode: agent`. The agent only answers requests that carry its token, which only it and the app can read.

**What that one command started:**

| Container | Image | What it does |
| --- | --- | --- |
| `app` | `secure-notes-app:dev` (built here) | The Node.js app and dashboard |
| `aws-mock` | `secure-notes-aws-mock:dev` (built here) | Stands in for Secrets Manager and STS; local and CI only |
| `seed` | `secure-notes-app:dev` | Runs once: puts random passwords into Secrets Manager, applies them to Postgres and Redis, then disables the startup passwords |
| `postgres` | `postgres:16` | The database |
| `redis` | `redis:7-alpine` | The cache |

**Why is there a password in docker-compose.yml?** `bootstrap-only-change-me` only lets the seed job log in the first time. The seed job immediately replaces it with a random value stored only in Secrets Manager, and CI checks on every push that the old one no longer works.

### The same lab on OpenBao and Vault (steps v1, v2, v4, v5)

Each step is a second Compose file layered on `docker-compose.yml`. You pick it with `COMPOSE_FILE`; every `docker compose` command then uses both files. The app image, Postgres and the checks don't change. The step READMEs hold the detail; this is the short version. You need Docker Compose 2.24 or later, because the overlays replace the app's environment with `!override`.

Stop the AWS stack first (`docker compose down -v`), and run `unset COMPOSE_FILE` at the end to go back to it.

#### Step v1 — OpenBao, stored secrets (KV v2) and AppRole

A real OpenBao server in place of the stand-in. The app logs in with AppRole and reads its secret ID from a file:

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v1-openbao-kv/compose.yaml
docker compose up --build -d        # http://localhost:3000
scripts/compose-check.sh            # the checks below, the smoke test, the credential scan
docker compose down -v              # stop and wipe (a new seal key and new secret IDs next time)
```

**Check:** the dashboard's header says **OpenBao** and **AppRole secret ID in a file**; `aws-mock` isn't started. `compose-check.sh` prints its OpenBao lines (logged in as `secure-notes-app`, the secret ID file is mode 0400, the seed's bootstrap secret ID is spent, another path gets 403), then ends with the credential scan's `no credential value found anywhere it must not be`. [Step README](../steps/v1-openbao-kv/README.md) · [demo page](../demo/test-case-19-openbao-kv.md) · [chapter 7](learn/07-secret-zero-and-approle.md).

#### Step v2 — database users that expire (dynamic credentials)

No stored database password at all: OpenBao creates a Postgres user and a Valkey user for this instance, each with a lease. Valkey replaces Redis.

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v1-openbao-kv/compose.yaml:steps/v2-openbao-dynamic/compose.yaml
docker compose down -v               # start clean: the seed job sets up the database engine once
docker compose up --build -d         # http://localhost:3000
scripts/compose-check.sh
```

**Check:** **Secrets in memory** shows a `lease` row for each credential, with the time left and the renewal count, and **Security posture** passes **Database logins are short-lived**. The rotation buttons become **Revoke Postgres lease** and **Revoke Redis lease**; click one, then add a note, and the timeline shows `revokeLease`, `auth-failed`, `new-lease`, `switched` and `recovered`. [Step README](../steps/v2-openbao-dynamic/README.md) · [demo page](../demo/test-case-20-dynamic-users.md) · [chapter 8](learn/08-leases-and-dynamic-credentials.md).

#### Step v4 — the same app on HashiCorp Vault

The same image with `SECRETS_PROVIDER=vault` against Vault 2.2.0, with the dynamic users of step v2. Vault has no self-init, so `dev/vault/entrypoint.sh` scripts the init and unseal:

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v4-vault/compose.yaml
docker compose down -v
docker compose up --build -d          # http://localhost:3000
scripts/compose-check.sh
```

**Check:** the dashboard says **HashiCorp Vault**, and the timeline says "Vault issued this instance its own db user". `docker compose logs vault | grep vault-lab` shows the entrypoint's three lines: initialised and unsealed, configured with the root token revoked, and (after a restart) unsealed again from the key on the data volume. [Step README](../steps/v4-vault/README.md) · [demo page](../demo/test-case-23-vault.md) · [chapter 10](learn/10-openbao-and-vault.md).

#### Step v5 — an alert when someone else reads the app's secret

Step v1 plus detection: OpenBao's audit log goes to VictoriaLogs, vmalert runs a rule on it, and an alert console on port 3100 shows what fires.

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v1-openbao-kv/compose.yaml:steps/v5-detection/compose.yaml
docker compose up --build -d          # the app on :3000, the alert console on :3100
docker compose run --rm intruder      # role ops-admin reads the app's Postgres secret
```

**Check:** before the intruder, <http://localhost:3100> says **No alerts**, though the app has been reading its secrets all along. Within about a minute after it, the console shows **SecretReadByUnexpectedIdentity**, naming `ops-admin` and the path it read. `scripts/compose-check.sh` runs the same intruder after the credential scan and waits for the alert. [Step README](../steps/v5-detection/README.md) · [demo page](../demo/test-case-24-detection.md) · [chapter 11](learn/11-detection-on-the-audit-log.md).

## Part B — Run on Kubernetes or OpenShift

The same images run on any Kubernetes cluster. Pick B1 for a local kind cluster, B2 for OpenShift, B3 for EKS or ROSA against real AWS, or B4 for OpenBao on kind (step v3). The manifests live in `deploy/k8s/` as Kustomize overlays:

| Overlay | Use it for | What it adds to the base |
| --- | --- | --- |
| `overlays/kind` | kind, or any local Kubernetes | Postgres, Redis, the AWS stand-in and the seed job, inside the cluster; Pod Security `restricted` enforced on the namespace; the app on a NodePort that kind maps to `localhost:3000` |
| `overlays/kind-openbao` | kind, step v3 | The `openbao` component: no AWS stand-in, Valkey instead of Redis, a token projected for audience `openbao` into the app and seed pods, and NetworkPolicies to OpenBao on 8200 |
| `overlays/kind-openbao-eso` | kind, step v3 in file mode | The `openbao-eso` component: an `ExternalSecret` that External Secrets Operator refreshes every 15 s, mounted into the app as a volume; the app has no OpenBao token |
| `overlays/openshift` | OpenShift Local (CRC) or a dev cluster | The same, plus a TLS Route; images pulled from GHCR; no fixed user IDs, so OpenShift assigns them |
| `overlays/openshift-local` | OpenShift Local on an Apple-silicon Mac, or any cluster that can't pull from GHCR | The OpenShift overlay with images built on the cluster from your checkout (`scripts/openshift-build.sh`) |
| `overlays/aws` | EKS, or ROSA with STS | Only the app, against real RDS, ElastiCache and Secrets Manager, with AWS access through an IAM role on the service account (IRSA) |

The base is hardened in every overlay: non-root, read-only root filesystem, all Linux capabilities dropped, seccomp on, no service-account token, and default-deny NetworkPolicies. The app's credentials never become a Kubernetes Secret: the only Secret in the namespace is the one-time startup secret.

### B1 — kind (Kubernetes on your laptop)

**You need:** Docker, [kind](https://kind.sigs.k8s.io) (CI uses v0.33.0) and kubectl, and about 6 GiB of memory for Docker. On a Mac, `scripts/bootstrap/macos.sh` installs what's missing; on Linux, `scripts/bootstrap/linux.sh`. Then check the machine:

```bash
scripts/preflight.sh kind
```

**Check:** the last line is `preflight: ready for the kind lab.` Port 3000 must be free, so stop Docker Compose first (`docker compose down`), or give kind another port with `KIND_APP_PORT=3100`.

1. Create the cluster. It reads `deploy/kind/cluster.yaml`, which pins the Kubernetes version and maps the app to your machine (on `127.0.0.1` only), so no port-forward is needed:

   ```bash
   scripts/kind-up.sh
   ```
2. Build the images with Docker Compose and load them into kind. These are the same images Part A runs; nothing is built twice.

   ```bash
   scripts/images-build.sh
   ```
3. Deploy and wait:

   ```bash
   scripts/k8s-deploy.sh deploy/k8s/overlays/kind
   ```

   It waits for Postgres, Redis and the stand-in, then the seed job, then the app. The app pod may restart once or twice while the seed job finishes; that's expected.
4. Open <http://localhost:3000>. The header says **Node.js on Kubernetes**.
5. Collect the evidence:

   ```bash
   scripts/k8s-check.sh
   ```

   It shows which user each container runs as and the Secrets in the namespace, proves the startup passwords were disabled and that Postgres only ever received password hashes, then runs the end-to-end test.

   **Check:** the last line is `k8s-check: all checks passed`.

When you're done: `scripts/kind-down.sh`. The images stay in Docker for next time.

A cluster made before `deploy/kind/cluster.yaml` existed has no port mappings; `kind-up.sh` says so. Recreate it, or use `kubectl -n secure-notes port-forward svc/secure-notes 3000:80`.

### B2 — OpenShift

**You need:** `oc`, logged in to a cluster as a user who can create a project. OpenShift Local (CRC) on a laptop works: give it at least 9 GiB and 4 CPUs (`crc config set memory 10240`), then `crc start`, `eval $(crc oc-env)` and `oc login -u developer https://api.crc.testing:6443`. Check with `scripts/preflight.sh openshift`.

1. Create the project and deploy. Pick one:

   ```bash
   oc new-project secure-notes

   # the published images (amd64 clusters that can pull from ghcr.io)
   KUBECTL=oc scripts/k8s-deploy.sh deploy/k8s/overlays/openshift

   # or: build the images on the cluster from your checkout (Apple-silicon Macs,
   # where the published amd64 images can't run, or no access to ghcr.io)
   scripts/openshift-build.sh
   ```

   `openshift-build.sh` creates two BuildConfigs, uploads the committed source (`git archive` of HEAD), builds it on the cluster for the cluster's own CPU, and deploys `deploy/k8s/overlays/openshift-local`.
2. The deploy prints the app's address, HTTPS through the OpenShift router:

   ```
   app: https://secure-notes-secure-notes.apps-crc.testing
   ```

   Open it. The header says **Node.js on OpenShift**, and **Security posture** shows the high user ID OpenShift assigned. OpenShift Local's certificate is self-signed, so the browser asks you to accept it once.
3. Collect the evidence:

   ```bash
   oc -n secure-notes port-forward svc/secure-notes 3000:80 &
   KUBECTL=oc scripts/k8s-check.sh
   ```

   **Check:** the last line is `k8s-check: all checks passed`.

**Cluster can't reach ghcr.io or Docker Hub?** Copy the four images into a registry it can reach. Log in to that registry first (`skopeo login`, `podman login` or `oc registry login`), then:

```bash
scripts/mirror-images.sh <your-registry>/<path>
KUBECTL=oc scripts/k8s-deploy.sh deploy/k8s/overlays/mirror
```

The script copies the app, the stand-in, Postgres and Redis with `skopeo` (or `oc image mirror` if you set `MIRROR_TOOL=oc`), writes the `mirror` overlay, and checks that every image in it comes from your registry. If the registry needs a login to pull, also create a pull secret and link it to the `secure-notes` and `default` service accounts.

Why no fixed user IDs: OpenShift's restricted-v2 policy starts every container as a random high user ID with group 0, and rejects pods that ask for a specific one. CI tests the Kubernetes deployment on kind (B1), which runs the same base and backing services; this overlay only adds the Route and the image names, and leaves the user IDs to OpenShift. The check in step 3 confirms it on your cluster.

CI has no OpenShift cluster. It renders and validates both OpenShift overlays on every push, but the Route and `openshift-build.sh` are proven only when you run them; tell us if a step doesn't behave as written.

### B3 — EKS or ROSA, against real AWS

**You need:** an EKS cluster (or ROSA with STS) with an IAM OIDC provider; Postgres on RDS, Redis on ElastiCache with TLS and an RBAC user, and their two secrets in Secrets Manager (the sibling repo's Part C stack creates all of these); and network access from the pods to them.

1. Create the IAM role the pod will use. Replace `ACCOUNT_ID` and `OIDC_PROVIDER` in `infra/irsa-trust-policy.example.json`, and the ARNs in `infra/iam-policy.example.json`, then:

   ```bash
   aws iam create-role --role-name secure-notes-pod \
     --assume-role-policy-document file://infra/irsa-trust-policy.example.json
   aws iam put-role-policy --role-name secure-notes-pod --policy-name read-own-secrets \
     --policy-document file://infra/iam-policy.example.json
   ```

   The permissions policy only works through a Secrets Manager VPC endpoint (`aws:SourceVpce`). If your cluster's VPC has none, delete that `Condition` block.
2. Fill in every `<PLACEHOLDER>` in `deploy/k8s/overlays/aws/kustomization.yaml`: region, the two secret ARNs, the RDS and ElastiCache endpoints, and the role ARN from step 1.
3. Create the namespace and the RDS certificate bundle the app uses to verify the database:

   ```bash
   kubectl create namespace secure-notes
   curl -fsSLo global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
   kubectl -n secure-notes create configmap rds-ca --from-file=global-bundle.pem
   ```
4. Deploy:

   ```bash
   scripts/k8s-deploy.sh deploy/k8s/overlays/aws
   ```
5. Port-forward and open the app as in B1.

   **Check:** **Security posture** shows **Running as an IAM role: pass**, with an ARN that contains `assumed-role`.

On EKS you can use Pod Identity instead of IRSA: skip the annotation, and create a Pod Identity association for the `secure-notes` service account in the `secure-notes` namespace. On a cluster outside AWS, IAM Roles Anywhere is the keyless option, exchanging an X.509 certificate for temporary credentials.

### B4 — OpenBao on kind (step v3)

The lab of step v2 on Kubernetes: OpenBao from its own Helm chart (`openbao-0.30.4`, OpenBao 2.7.1) in the `openbao` namespace, and the app, Postgres and Valkey in `secure-notes` under Pod Security `restricted`. The pods prove who they are with **Kubernetes auth**: a service-account token projected for audience `openbao`, so there is no secret zero to hand over. The [step README](../steps/v3-k8s/README.md) explains each piece.

**You need:** everything B1 needs, plus `helm` 3. Neither `scripts/bootstrap/macos.sh` nor `scripts/bootstrap/linux.sh` installs helm; `scripts/openbao-k8s-up.sh` stops and says so if it is missing. The script downloads the chart from the openbao-helm GitHub release and checks it against the checksum in `scripts/versions.env`.

1. The cluster, the images (also OpenBao and Valkey, preloaded), OpenBao from its chart, then the app:

   ```bash
   scripts/kind-up.sh
   KIND_OPENBAO=1 scripts/images-build.sh                    # also preloads OpenBao and Valkey
   scripts/openbao-k8s-up.sh                                 # OpenBao from its chart, initialised
   scripts/k8s-deploy.sh deploy/k8s/overlays/kind-openbao    # http://localhost:3000
   scripts/k8s-check.sh
   ```

   **Check:** `kubectl -n openbao exec openbao-0 -- bao status` shows `Initialized true` and `Sealed false`, with nobody having run `operator init`. The dashboard's header says **Kubernetes auth secure-notes-app**. `k8s-check.sh` adds its step v3 lines (the app logged in with Kubernetes auth, no Kubernetes API token in the pod, the projected token is for audience `openbao` and short-lived, the Postgres sessions use a user OpenBao created), then ends with `k8s-check: all checks passed`. [Demo page](../demo/test-case-21-kubernetes-auth.md) · [chapter 9](learn/09-kubernetes-auth-and-external-secrets.md).
2. **File mode, with External Secrets Operator.** For apps that can't call OpenBao: ESO reads OpenBao and writes a Kubernetes Secret, which the app mounts as a volume and watches (`SECRETS_MODE=file`). The app has no OpenBao identity at all.

   ```bash
   scripts/openbao-k8s-up.sh
   scripts/eso-k8s-up.sh                                        # ESO from its chart, then its ClusterSecretStore
   scripts/k8s-deploy.sh deploy/k8s/overlays/kind-openbao-eso
   scripts/k8s-check.sh                                         # also rotates in OpenBao and watches it arrive
   ```

   **Check:** `k8s-check.sh` reports the `ExternalSecret` Ready, the Secret mounted as a volume (no `env`, no `subPath`), no OpenBao token in the app pod, then runs the `rotate-db` Job and waits for the new version to reach the app without a restart. The credentials are in a Kubernetes Secret in this mode; the check says so instead of hiding it. CI runs each overlay on a fresh cluster. [Demo page](../demo/test-case-22-external-secrets.md).

When you're done: `scripts/kind-down.sh`.

**OpenShift.** `KUBECTL=oc scripts/openbao-k8s-up.sh` notices OpenShift and adds `steps/v3-k8s/openbao-values-openshift.yaml`, which turns on the chart's OpenShift mode and leaves the user IDs to the `restricted-v2` SCC. CI does not run OpenShift, so the step README marks this part unproven: treat it as a starting point, and tell us what you find.

## Part C — AWS on EC2

Deploying to AWS on EC2 (CloudFormation, RDS, ElastiCache, the instance role, the alert
topics) is the sibling repo's job and isn't copied here. Follow
[its Part C](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/GUIDE.md#part-c--deploy-to-aws-on-ec2): the app it deploys is the
same `SECRETS_PROVIDER=aws` path this repo keeps.

## CI — what every push proves

Every push to the repository runs Part A (all six Compose stacks: the two AWS modes and steps v1, v2, v4 and v5), Part B1 and B4 (three kind legs) and the mirror on GitHub runners, photographs the dashboard, and only then publishes the images. The workflow is [`.github/workflows/ci.yaml`](https://github.com/ephico2real2/openbao-node-poc/blob/main/.github/workflows/ci.yaml), and it calls the same scripts you run by hand.

```mermaid
flowchart LR
  checks["checks<br/>unit tests, lint, schemas;<br/>the Vault entrypoint and<br/>the detection chain, no Docker"] --> build["build<br/>compose build, once<br/>SBOM + CVE scan"]
  build --> compose["compose (sdk, agent, openbao,<br/>openbao-dynamic, openbao-detection, vault)<br/>Part A: both AWS modes,<br/>and steps v1, v2, v5, v4"]
  build --> kind["kind (aws, openbao, openbao-eso)<br/>B1 and B4 · Pod Security restricted"]
  build --> mirror["mirror<br/>all images to another registry"]
  build --> envfile["env-file-demo<br/>a .env file, read back (Podman)"]
  compose --> images["images<br/>main only: push,<br/>sign, attest SBOM"]
  kind --> images
  mirror --> images
  docs["docs<br/>links and diagrams"]
  v0["v0-leak<br/>the .env app still leaks"]
```

| Job | Same as | What it proves |
| --- | --- | --- |
| `checks` | Part A, step 3 | Unit tests with the real Postgres, Redis and AWS SDK libraries, and the OpenBao tests against a real server (the release binary, checksum-verified; a skipped test fails the job). `dev/vault/test-entrypoint.sh` against the real Vault 2.2.0 binary: initialised, unsealed and configured by the entrypoint, no root token left in any file or output, the bootstrap secret ID works once, and unsealed again after a restart. `dev/detect/test-detection.sh` without Docker: real OpenBao, VictoriaLogs and vmalert binaries, the shipper, the console and the intruder; the app's reads raise no alert, the `ops-admin` read does, and no password is in the log store. The image pins in `scripts/versions.env` match the step Compose files; every script and workflow lints clean; all six Kustomize overlays render and match their schemas |
| `build` | `docker compose build` | Builds the two images once, lists every package in them (an SBOM) and fails if any has a critical vulnerability that already has a fix, then hands them to every later job |
| `compose (sdk)`, `compose (agent)` | Part A | The stack starts, the startup passwords stop working, and the end-to-end test passes. It runs twice: once as normal, and once with the app reading its secrets through a local agent (agent mode), which must refuse any request without its token. |
| `compose (openbao)` | Part A, step v1 | The same on a real OpenBao server: the app logs in with its own AppRole identity, its secret ID is a mode-0400 file, the seed's bootstrap secret ID is spent, its policy refuses other paths, the audit log recorded the KV reads, and no value or secret ID is outside OpenBao (its audit log holds only HMACs) |
| `compose (openbao-dynamic)` | Part A, step v2 | Database users OpenBao creates per instance: the app's sessions use them, both leases are renewed, revoking a lease drops the user and the app recovers, and after the smoke test at most two leased users are left in Postgres (the current one and one draining). With the reveal flag on, the leased passwords show up in the app's log and nowhere else |
| `compose (openbao-detection)` | Part A, step v5 | Step v1's checks, then detection: VictoriaLogs holds the audit lines the shipper sent, nothing the app, the seed or the scan did raised an alert, and the intruder's read as `ops-admin` raises `SecretReadByUnexpectedIdentity` naming the role and the path. Then it photographs the alert console |
| `compose (vault)` | Part A, step v4 | The same checks as step v2 on HashiCorp Vault 2.2.0: logged in with its own role, bootstrap secret ID spent, other paths refused, leased Postgres sessions, renewals, revocation and recovery; the scan searches Vault's container, audit log and storage |
| `kind (aws)` | B1 | The same under Pod Security `restricted`: who each container runs as, that no app credential is a Kubernetes Secret, that Postgres only received password hashes, and the end-to-end test |
| `kind (openbao)` | B4, step v3 | OpenBao from its Helm chart is initialised and unsealed by itself; the app logged in with Kubernetes auth; its pod has no Kubernetes API token, only a projected token for audience `openbao`, short-lived; its Postgres sessions use a user OpenBao created. The seed job is deployed a second time and must resume cleanly. The scan adds OpenBao's pod log (HMACs only), its storage and the `openbao` namespace's Secrets |
| `kind (openbao-eso)` | B4, file mode | The `ExternalSecret` is Ready, its Secret has only the keys `db` and `redis` and reaches the app as a whole-volume mount (no `env`, no `subPath`), and the app pod has no OpenBao token. A rotation from outside the app (the `rotate-db` Job) reaches it as a changed file, with no restart, and it writes to Postgres afterwards. The second deploy of the seed job resumes cleanly here too |
| `mirror` | B2, no internet | The mirror script copies all four images into a throwaway registry, the overlay it generates pulls only from there, and each copy has the same layers as its source |
| `env-file-demo` | [chapter 2](learn/02-the-env-file-problem.md) | `scripts/env-file-demo.sh` under Podman: the passwords in a `.env` file can be read back by anyone who can reach the container, and the same lookups on Secure Notes, which is given secret IDs only, find none |
| `v0-leak` | [`versions/v0-env-file`](../versions/v0-env-file/README.md) | The original `.env` app still leaks its passwords (the "before" picture) |
| `docs` | — | Every relative link resolves and every Mermaid diagram renders |
| `images` | — | On `main` only: pushes the exact images that passed to `ghcr.io/ephico2real2/openbao-node-poc`, signs each one with cosign and attaches its SBOM as a signed attestation, then checks both without logging in |

**The screenshots.** In the compose and kind jobs, a Playwright browser walks the dashboard. Each walk is a file in `scripts/capture/`: `dashboard.yaml` for the AWS modes and steps v1 and v5 (first load, a Postgres rotation and recovery, a Redis rotation, the leak test, and a phone-width view), `dynamic.yaml` for steps v2, v3 and v4 (the leases, both revocations and the recovery, the re-issue at the max TTL, the leak test), `eso.yaml` and `eso-rotated.yaml` for file mode (before and after the rotation arrives as a file), `reveal.yaml` for the reveal flag, and `detection.yaml` for the alert console. Each page lists the text it must show, so a screenshot of a broken page fails the job. The pictures go to the [`ci-captures`](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures) branch, one folder per run and job, and appear on the run's summary page. The same pattern as cilium-implementation-poc.

![The dashboard on kind, captured by CI: a Postgres rotation, Postgres rejecting the stale password, and the app recovering](images/kind-rotation-and-recovery.png)

A real capture from the `kind (aws)` job: the four rotation steps have run, and the timeline shows Postgres rejecting the cached password, the app picking up the new version, and recovering, all within the same second.

**To see them:** open the repository's **Actions** tab, pick a run, and scroll the summary. Each job's logs and evidence (`k8s-check.txt`, pod logs) are in a `…-logs` folder on the same branch.

## What the tests prove

Every claim in this guide has a test that fails if the claim stops being true; the most important one searches the running stack for the **actual passwords**, not just their names, and finds none.

| Claim | Proven by | Where |
| --- | --- | --- |
| No password in any container or pod: configuration, pod specs, ConfigMaps, decoded Secrets, events, process environment, every file, the databases (only hashes), every log | `scripts/credential-scan.sh`, run after the end-to-end test | `compose`, `kind` |
| The scan really finds a leak | the same scan with `LOG_REVEAL_SECRETS=true`: FOUND in the app log, and only there | `compose (sdk)` |
| Rotation needs no restart | rotate from the dashboard, drop connections: `auth-failed → new-version → recovered` | `compose`, `kind` |
| Six common leaks are blocked | the leak test: `0 of 6 leaked` | `compose`, `kind` |
| Debug logs name every key and mask every value | unit tests and the dashboard capture | `checks`, `compose`, `kind` |
| Production refuses the reveal flag | the app exits 78 | `checks`, `compose (sdk)` |

**Debug logging.** With `LOG_LEVEL=debug` (the default in Compose and kind; the `LogLevel` parameter on AWS), the log shows which secret, version and keys the app used: passwords as `******** (32 chars, fp=…)`, usernames partly masked, hosts and ports in full. On the dashboard, tick **Credential lines only** under **Application log**.

To see each one work, follow the [tutorial](TUTORIAL.md); to demo them one at a time, with the CI screenshot and output for each, open the [demo folder](../demo/README.md). [TEST-CASES.md](TEST-CASES.md) lists every automated test.

## Troubleshooting

Find your symptom below. Rows marked A are for Docker Compose, B for Kubernetes and OpenShift. AWS problems are in the [sibling repo's troubleshooting](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/docs/GUIDE.md#troubleshooting).

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| App log: `unable to load secrets` with `AccessDenied` | Requests aren't going through the VPC endpoint | Check that the VPC has DNS hostnames and DNS resolution turned on, and that the endpoint values are right |
| App log: `Refusing to start` (exit code 78) | An unsafe setting, such as a password in the environment | The next lines name the setting; remove it |
| A: port is already allocated | Something else uses port 3000 | Stop it, or change 127.0.0.1:3000:3000 in docker-compose.yml to 127.0.0.1:3001:3000 |
| A: app keeps restarting after an earlier run | Old volumes hold passwords from a previous start | docker compose down -v, then start again |
| A, steps v1 to v5: docker compose refuses the step's compose.yaml | Compose older than 2.24; the overlays use `!override` | Update Docker Desktop, then check with docker compose version |
| A: the stack that starts isn't the one you expect | COMPOSE_FILE is still set from an earlier step | unset COMPOSE_FILE, or export the step's value again |
| B4: openbao-k8s-up.sh stops with "helm 3 is required" | The bootstrap scripts don't install helm | Install helm 3, then run it again |
| B: app pod restarts for the first minute | It waits for the seed job to create its secrets | Normal. If it keeps going: kubectl -n secure-notes logs deploy/secure-notes |
| B1: ErrImageNeverPull or ErrImagePull for secure-notes-app:dev | The images aren't loaded into kind | scripts/images-build.sh (with the kind cluster running) |
| B2: ImagePullBackOff from ghcr.io | The cluster can't reach ghcr.io, or the package is private | Mirror the two images to a registry it can reach (see B2), or make the GHCR package public |
| B2: pods rejected by a security context constraint | The kind overlay was applied; it asks for fixed user IDs | Use deploy/k8s/overlays/openshift |
