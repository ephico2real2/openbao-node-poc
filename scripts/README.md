# scripts/

[← Project README](../README.md) · [Quick reference](../docs/reference/deploy-quickref.md)

The same scripts run on a laptop and in CI. CI calls them rather than repeating their
steps, so a green run means the commands in the docs work. Every tool and image version
they use is pinned in [`versions.env`](versions.env). The scripts need bash 4.4 or later;
macOS ships 3.2, and `bootstrap/macos.sh` installs a newer one.

## Set up a machine

| Script | What it does |
| --- | --- |
| [`bootstrap/macos.sh`](bootstrap/macos.sh) | MacBook: installs what's missing with Homebrew (bash, jq, node, kind, kubectl; `--openshift` adds `oc`) and Docker Desktop, then runs the preflight |
| [`bootstrap/linux.sh`](bootstrap/linux.sh) | Linux laptop or CI runner: kind at its pin, checked against the release's SHA-256, and kubectl if missing; then the preflight |
| [`preflight.sh`](preflight.sh) `compose\|kind\|openshift` | One table: tools and versions, Docker's memory, free ports, `oc` login. `PREFLIGHT_STRICT=1` exits 1 if a required row fails |

## Run a lab

| Script | What it does |
| --- | --- |
| [`kind-up.sh`](kind-up.sh), [`kind-down.sh`](kind-down.sh) | Create the kind cluster from `deploy/kind/cluster.yaml` (after the preflight) or delete it. `KIND_APP_PORT` lets it run beside Docker Compose |
| [`images-build.sh`](images-build.sh) | `docker compose build` (the only place images are built), then load them into kind if the cluster exists |
| [`k8s-deploy.sh`](k8s-deploy.sh) `<overlay>` | Render and apply an overlay, wait for the seed job and the app, and print the app's address (the Route on OpenShift) |
| [`openshift-build.sh`](openshift-build.sh) | OpenShift: build both images on the cluster from HEAD (BuildConfigs), then deploy `overlays/openshift-local` |
| [`mirror-images.sh`](mirror-images.sh) `<registry/path>` | Copy all four images to your registry and write `overlays/mirror`, for clusters that can't pull from GHCR or Docker Hub |

## Prove it (each ends with ok/FAIL lines and a non-zero exit on failure)

| Script | What it proves |
| --- | --- |
| [`compose-check.sh`](compose-check.sh) | Docker Compose: the startup passwords were burned, the end-to-end smoke test, then the credential scan |
| [`k8s-check.sh`](k8s-check.sh) `[base-url]` | Kubernetes or OpenShift: who each container runs as, no app credential in any Kubernetes object, Postgres got only password hashes, the smoke test |
| [`credential-scan.sh`](credential-scan.sh) `compose\|k8s` | Searches the running stack for the **actual password values** (every version): container config, process environments, every file, every log, the databases |
| [`env-file-demo.sh`](env-file-demo.sh) | Who can read credentials passed in a `.env` file, next to the same lookups on Secure Notes |
| [`scan-images.sh`](scan-images.sh) | An SBOM per image (syft) and a vulnerability scan (grype) that fails on a fixable critical |

## Generate (edit the source, then run the script)

| Script | Source | Writes |
| --- | --- | --- |
| [`backlog/`](backlog/README.md) | `backlog/data.py` | GitHub issues, then `docs/modernization/backlog.md` |

## CI helpers

| Path | What it does |
| --- | --- |
| [`capture/`](capture) | Playwright walks (`*.yaml`, run by `walk.js`): open each page, click, and assert the visible text, then save a screenshot. A broken page fails the job |
| [`ci-publish.sh`](ci-publish.sh) | Push a run's evidence to a folder on the `ci-captures` branch |
| [`cut-tags.sh`](cut-tags.sh) `[--dry-run]` | The owner, on their own machine: an annotated tag and a GitHub release per step, from `docs/releases/`. Existing tags are left alone |
| [`docs-check.js`](docs-check.js) | Every relative link and `#anchor` in the docs resolves; every Mermaid diagram renders |
