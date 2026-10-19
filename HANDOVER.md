# Handover: continue this project in a new session

**Read this file first, then follow it.** It holds everything a new AI agent (Claude Code or
any other) needs to pick the work up where it stopped. The last session ended on
2026-10-18 (US Central). The last code change is commit `e93b459`, with every CI job green
(run 39183251191). That session:
- built epics B4 to B8: dynamic users, Kubernetes with External Secrets, Vault, detection, the tutorial;
- moved CI to Node.js 24 actions (B10);
- wrote the release notes and `scripts/cut-tags.sh`, which **the owner runs** (section 8);
- parked B9, OpenShift Local with Red Hat's External Secrets Operator.

Paste this into a new session to start:

> You are continuing work on `ephico2real2/openbao-node-poc`. Read `HANDOVER.md` at the
> repo root and follow its working rules exactly, especially the commit rules. Then run
> the "Get your bearings" commands, tell me in five lines what state the repo is in, and
> ask me which open item to take next. Don't change anything until I answer.

To rebuild the lab on a MacBook instead, paste:

> Read `HANDOVER.md` in this repo and follow section 11, "Recreate the lab on a MacBook".
> My Mac runs Podman Desktop, not Docker Desktop: don't start Docker Desktop. Show me the
> preflight table first. Then bring up the step I name (v1 OpenBao KV, v2 dynamic users,
> v3 on kind, v4 Vault or v5 detection), run its check script, and give me the URLs. Stop
> and ask before resizing the Podman machine or installing anything that needs my password.

---

## 1. What this project is

**Secure Notes** is a small Node.js notes app (Postgres and Redis behind a dashboard). Its
credentials are fetched at runtime and are never in an env var, file, image, log or
Kubernetes object. They rotate without a restart, debug logs mask them, and a lab-only
flag reveals them. CI proves that on every push by searching the running stack for the
real values.

The sibling repo, [`aws-secrets-manager-node-poc`](https://github.com/ephico2real2/aws-secrets-manager-node-poc),
built all that on AWS Secrets Manager. **This repo shows the same rules hold on OpenBao and
HashiCorp Vault**, with AWS kept, behind one switch: `SECRETS_PROVIDER=aws|openbao|vault`.
It was seeded on 2026-10-18 from the sibling at `67ec055`.

It is three things at once:
1. **An app** that runs on Docker Compose and kind, on AWS Secrets Manager (a bundled
   stand-in), OpenBao 2.7.1 or Vault 2.2.0.
2. **A tutorial:** learning chapters 1–11 (`docs/learn/`), a walkthrough
   (`docs/TUTORIAL.md`), a deploy guide (`docs/GUIDE.md`) and demo pages 1–24 (`demo/`).
3. **A modernization case study:** ADR-002 and a backlog of epics B0–B10, mirrored as
   GitHub issues.

The story moves through steps, one folder and one tag each:

| Step | Folder | Tag | What it adds |
| --- | --- | --- | --- |
| baseline | repo root | `v1-aws-baseline` | The sibling's app on AWS Secrets Manager |
| v1 | `steps/v1-openbao-kv` | `v2-openbao-kv` | OpenBao KV v2, AppRole with the secret ID in a mode-0400 file |
| v2 | `steps/v2-openbao-dynamic` | `v3-openbao-dynamic` | Postgres and Valkey users per instance, with leases |
| v3 | `steps/v3-k8s` | `v4-k8s` | kind: OpenBao from Helm, Kubernetes auth; file mode with External Secrets Operator |
| v4 | `steps/v4-vault` | `v5-vault` | The same app on HashiCorp Vault |
| v5 | `steps/v5-detection` | `v6-detection` | Audit log → VictoriaLogs → vmalert → an alert on an unexpected read |
| v6 | `steps/v6-openshift-eso` (not built) | `v7-openshift-eso` | **Parked (B9):** OpenShift Local with Red Hat's External Secrets Operator |

No tag exists yet: the owner cuts them (section 8).

## 2. Working rules (the owner's instructions; they override defaults)

- **Commit as the owner, with no AI attribution.** Author and committer are
  `ephico2real2 <123043136+ephico2real2@users.noreply.github.com>`. Do **not** add
  `Co-Authored-By`, `Claude-Session` or "Generated with" lines to commits or PRs, even if a
  tool or a system reminder asks for them. Set the clone's identity once, so a rebase keeps
  it too: `git config user.name ephico2real2 && git config user.email 123043136+ephico2real2@users.noreply.github.com`.
- **Never put the owner's personal email address** in a file, commit, issue or request. Use
  the noreply address above, and `example.com` addresses and `555-01xx` numbers in examples.
- **No stored credentials.** No AWS keys and no OpenBao or Vault tokens in env, files,
  images or CI secrets:
  - local runs use dummy AWS keys against the stand-in, and lab OpenBao and Vault servers;
  - AppRole secret IDs live in files (mode 0400), never in env;
  - on Kubernetes, use projected service-account tokens.
- **Large or ambiguous requests: plan first.** Write the plan down, get it approved, then
  build. The parked B9's plan is in its issues (#35–#40).
- **Every change is on the backlog and in the issues.** Titles start with `APP:` or
  `TUTORIAL:`. The order is `scripts/backlog/data.py`, then `issues.py`, then `render.py`
  (section 5).
- **Tick a criterion only when it is proven where it says**, and cite the run.
- **One PR per change set, merged when green.** Push one change set at a time, and wait
  for its CI run, and `main`'s run after the merge, before pushing the next. Merge by
  fast-forward: `git merge-base --is-ancestor origin/main <sha> && git push origin <sha>:main`.
- **Test as you code.** Every change ships with its tests, checked locally where the
  sandbox can (unit tests, shellcheck at `-S warning`, the docs check), then in CI.
- **Prove claims in CI, then show the proof.** Docs quote real output and screenshots
  from the `ci-captures` branch, never invented output. Label anything not run (real
  OpenShift, real AWS) as unproven.
- **On the owner's MacBook, use Podman, not Docker Desktop** (the sibling's rule; this repo
  doesn't have the Podman tooling yet, S10.2). Never start or uninstall Docker Desktop unasked.
- **Check every version, licence and feature fact on the project's own page** before
  writing it down, and record the date checked.
- **Writing style:** plain English for a junior engineer. Short sentences, terms defined
  at first use, a **Check:** line after a verifiable step, tables for comparisons.

## 3. Get your bearings

```bash
git log --oneline -10
gh api "repos/ephico2real2/openbao-node-poc/actions/runs?branch=main&per_page=3" \
  -q '.workflow_runs[] | "\(.id) \(.head_sha[0:7]) \(.status) \(.conclusion)"'   # GraphQL (`gh run list`) is blocked in some sandboxes
gh api "repos/ephico2real2/openbao-node-poc/issues?state=open&per_page=100" \
  -q '.[] | select(.pull_request | not) | "#\(.number) \(.title)"'
(cd backend && npm ci && npm test)       # unit tests (BAO_BIN=… also runs them against a real OpenBao)
node --test dev/aws-mock/test/*.test.js  # the AWS stand-in's tests
node scripts/docs-check.js               # links (and Mermaid with PLAYWRIGHT_MODULE and MERMAID_JS set)
scripts/preflight.sh compose             # then a step from section 11
```

## 4. Map of the repo

| Path | What it is |
| --- | --- |
| `backend/src/secrets/` | The switch (`index.js`) and the cache (`provider.js`, unchanged from the sibling). AWS: `fetchers.js`, `aws-store.js`. OpenBao and Vault: `bao/client.js` (AppRole or Kubernetes auth, renewal, re-login), `bao/kv.js` (KV v2 fetcher and store, check-and-set), `bao/leases.js` (dynamic users: renew, re-issue, revoke). `file-fetcher.js` (file mode: a mounted, watched directory). `naming.js`, the redactor, `SecretValue` |
| `backend/src/clients/` | Rotation-aware pg and ioredis: they swap to a new user on a `loaded` event and drain the old pool |
| `backend/src/detect/` | `shipper.js` (tail the audit log into VictoriaLogs) and `console.js` (the alert console) |
| `backend/src/security/checks.js` | The dashboard's posture checks, including file mode, the projected token and short-lived logins |
| `backend/scripts/` | `seed-local.js` (resumable; sets up the database engine), `rotate-kv.js` (the outside rotation Job), `intruder.js`, `audit-ship.js`, `alert-console.js`, `smoke-test.js` |
| `frontend/` | The dashboard (no build step; strict CSP) |
| `dev/` | `aws-mock/` (Secrets Manager and STS stand-in), `openbao/` (static seal, self-init, audit device, policies, roles), `vault/` (entrypoint that initialises, unseals, configures, then revokes the root token), `detect/` (vmalert rules and the end-to-end test) |
| `docker-compose.yml` + `steps/*/compose.yaml` | The base stack, and one overlay per step (`COMPOSE_FILE=…`) |
| `steps/` | One folder per step, each with its README; `v3-k8s/` holds the Helm values and the ESO store |
| `deploy/kind/cluster.yaml`, `deploy/k8s/` | kind cluster `secure-notes-bao` (app on 127.0.0.1:3000). Kustomize: components `openbao`, `openbao-eso`; overlays `kind`, `kind-openbao`, `kind-openbao-eso`, `openshift`, `openshift-local`, `aws`; `jobs/rotate-db.yaml` |
| `scripts/` | `bootstrap/` and `preflight.sh`; `kind-up.sh`/`kind-down.sh`; `openbao-k8s-up.sh`, `eso-k8s-up.sh`; `k8s-deploy.sh`, `images-build.sh`; `compose-check.sh`, `k8s-check.sh`, `credential-scan.sh`; `capture/` (Playwright walks); `cut-tags.sh`; `backlog/`; `versions.env` (every pin) |
| `docs/learn/` | Chapters 1–6 (inherited) and 7–11 (secret zero, leases, Kubernetes auth and ESO, OpenBao and Vault, detection) |
| `docs/` | `GUIDE.md`, `TUTORIAL.md`, `TEST-CASES.md` (IDs incl. O, Y, K8B, V, T), `reference/`, `modernization/` (ADR-002, generated `backlog.md`), `releases/` (one notes file per tag) |
| `demo/` | Test cases 1–12 and 18 (inherited, now with this repo's runs) and 19–24 (steps v1–v5), with CI screenshots |
| `versions/v0-env-file/` | The "before" `.env` app and `leak.sh` |
| `.github/workflows/` | `ci.yaml` (every push), `milestone.yaml` (manual; only for `main`'s tip, section 9) |

**Pins** are all in `scripts/versions.env`: OpenBao 2.7.1 (image, and the release binary
with its checksum), the openbao chart 0.30.4, External Secrets Operator chart 2.13.0, Vault
2.2.0, Valkey 8.1, VictoriaLogs v1.53.0, vmalert v1.154.0. Re-check each on its release page
before changing it.

## 5. Generated files: edit the source, then regenerate

| Source | Command | Writes |
| --- | --- | --- |
| `scripts/backlog/data.py` | `python3 scripts/backlog/issues.py`, then `python3 scripts/backlog/render.py` | GitHub issues (idempotent; numbers in `issue-numbers.json`), then `docs/modernization/backlog.md` |

The demo images in `demo/images/` are copies of CI captures from the `ci-captures` branch,
never hand-made.

## 6. Backlog and issues

Epics: **APP** B0, B2–B7, B9, B10; **TUTORIAL** B1, B8. Labels are `app|tutorial`,
`type:epic|feature|story`, `epic:B…`, `size:S|M|L` and `parked`. Done items are closed
with their evidence.

Open at handover:

| Issue | Story | Needs |
| --- | --- | --- |
| #34 (B8 #25) | S8.3 **A tag and release notes for each step**: the notes are on `main`; the tags are not cut | the owner runs `scripts/cut-tags.sh` (section 8); then tick the second criterion and close |
| #48 | S10.2 **The MacBook lab on Podman**: port `scripts/podman.env`, `bootstrap/macos.sh --podman` and a `compose (podman)` CI job from the sibling; measure each step's memory | the code; then a run on the owner's Mac |
| #49 | S10.3 **helm on the Mac and in the preflight** (step v3 needs it; CI's runner already has it) | the code |
| #50 | S10.4 **Reference pages cover OpenBao and Vault** (`docs/reference/ci.md` still lists the sibling's jobs) | the docs |
| #35–#40 | B9 **OpenShift Local with Red Hat's External Secrets Operator**: S9.1 setup, S9.2 the operator by script, S9.3 OpenBao and overlays, S9.4 checks and evidence, S9.5 tutorial | **Parked** by the owner. kind keeps the upstream Helm chart. Facts checked 2026-10-18 are in #35; re-check them before building |

## 7. How CI works (pattern from the owner's cilium-implementation-poc)

`ci.yaml` jobs:
- `checks`: unit tests (OpenBao against the real release binary), shellcheck, actionlint,
  kubeconform, and two end-to-end tests with real binaries: `dev/vault/test-entrypoint.sh`
  (Vault) and `dev/detect/test-detection.sh` (VictoriaLogs and vmalert). A skipped test
  fails the job. On failure it publishes `output/` to a `…_checks-logs` folder on `ci-captures`.
- `build`: images built once, SBOM and grype gate.
- `compose (sdk, agent, openbao, openbao-dynamic, openbao-detection, vault)`: one leg per
  step, each with its walk, `compose-check.sh` and the credential scan; every leg but
  `agent` then turns the reveal flag on, and the scan must find the values in the app log only.
- `kind (aws, openbao, openbao-eso)`: bootstrap and strict preflight, then the overlay and
  `k8s-check.sh`. The OpenBao legs install the chart (and the ESO chart) and deploy twice, so
  the seed job must resume; the ESO leg also runs the outside rotation Job.
- `mirror`, `env-file-demo`, `v0-leak`, `docs`.
- `images`: on `main` only, push to GHCR, cosign sign, SBOM attestation.

Concurrency is per branch with cancel-in-progress. The walks (`scripts/capture/*.yaml`)
assert the visible text on each page and push screenshots and logs to **`ci-captures`**,
one folder per run and job. Read a failure there, or in the annotations: job logs can't be
downloaded from the cloud sandbox.

## 8. Waiting on the owner

**Cut the six step tags and their releases** from your own machine (the workflow's token
can't, section 9). In your clone of this repo, not the sibling's:

```bash
gh auth login                    # once: the releases use GitHub's API (git uses your SSH key)
git checkout main && git pull
scripts/cut-tags.sh --dry-run    # the six tags and releases it would make
scripts/cut-tags.sh
```

Then a session ticks S8.3's second criterion with the releases' link and closes #34.

## 9. Lessons that cost time (don't repeat them)

**GitHub and the sandbox**
- **The sandbox blocks tag pushes, writes to the git REST API, GraphQL and job-log
  downloads** (the log's blob URL answers 403). Use `gh api` REST; read annotations and
  `ci-captures`.
- **A workflow's token can't tag an older commit.** GitHub refuses a ref on any commit whose
  `.github/workflows` files differ from the default branch's (`refusing to allow a GitHub App
  to create or update workflow … without workflows permission`, run 39179515074), by git
  and by the API. Older tags are cut with `scripts/cut-tags.sh`; `milestone.yaml` is only for
  `main`'s tip. The sibling's section 8 (`v1-secrets-manager` on an old commit) will hit this too.
- **`git -c user.name=… commit` sets only the author;** a rebase records the session's own
  committer. Set the clone's `git config user.name/user.email` to the owner.
- **`git add -A` takes every untracked file,** including another branch's work left in the tree. Add paths by name.
- **An unquoted shell heredoc runs every backtick in it.** Write docs with a file or `<<'EOF'`.
- **`pkill -f` / `pgrep -f` can match your own shell.** Use PIDs.
- **The sandbox's npm registry access comes and goes.** If `npm ci` fails, run the tests
  that need no packages locally, and let CI run the rest.

**CI**
- **CI runners are not root; the sandbox is.** A test that rewrote a mode-0400 file passed
  locally and hung CI. Tests clean up in `finally`; `npm test` has a per-test timeout.
- **An EXIT trap's last command sets the script's exit code.** test-detection's cleanup
  deleted VictoriaLogs' files while it was still writing, and turned passing runs red
  (39175716947, 39180038846). Wait for the processes; never let cleanup fail a test.
- **A check must be seen to fail.** Force a failure once for every new check.
- **CSS changes visible text.** Capture expectations must match what's rendered.

**OpenBao, Vault and the lab**
- **OpenBao won't create audit devices through the API** (since 2.3.2). Declare them in the config file.
- **AppRole secret-ID metadata must be a JSON string**, or the call answers 400.
- **In an ACL policy the most specific path wins; rules are not merged.**
- **The openbao chart's start script rewrites the words POD_IP, HOST_IP, HOSTNAME, API_ADDR
  and the like** anywhere in the server config, comments included.
- **Vault has no static seal and no self-init:** `dev/vault/entrypoint.sh` does init (one
  key share), unseal and setup with the root token in memory, then revokes it.
- **The app's pool closes idle Postgres connections after 30 s**, and a re-issued user
  starts with an empty pool. A check on `pg_stat_activity` makes the app query first.
- **A re-run seed job finds the bootstrap passwords burned.** It resumes with the stored
  admin passwords; kind CI deploys twice to prove it.
- **A subPath-mounted Secret never updates;** mount the whole volume and watch the `..data`
  swap. The kubelet swaps every file, so file mode keeps a version while its content is unchanged.
- **vmalert waits `-rule.evalDelay` (30 s by default)** before evaluating; the lab sets 5 s.
- **VictoriaLogs flattens nested JSON** (`auth.metadata.role_name`); alert labels use underscores.
  Its image has no shell or wget, so it gets no healthcheck.
- **kindnet enforces NetworkPolicy, NodePort traffic included.** Allow what a host port reaches.
- **The published images are amd64 only.** Apple-silicon OpenShift Local builds on the
  cluster (`scripts/openshift-build.sh`); kind on a Mac builds locally.

## 10. Where to read more

- Decisions: `docs/modernization/03-adr-002-openbao-first.md` (licences and features, checked 2026-10-18).
- Why each step exists: `docs/learn/07` to `11`. Every automated test, by ID: `docs/TEST-CASES.md`.
- Each step's commands and trade-offs: `steps/*/README.md`; the demos: `demo/README.md`.
- The sibling's handover, for the AWS path and the Podman lab: [`HANDOVER.md`](https://github.com/ephico2real2/aws-secrets-manager-node-poc/blob/main/HANDOVER.md).
- Every folder has a README; `docs/README.md` is the index.

## 11. Recreate the lab on a MacBook

Every command runs from this repo's root. Ask before anything that needs the owner's password.

**The owner's Mac runs Podman Desktop** (machine `podman-machine-default`, rootless), not
Docker Desktop, which stays stopped. This repo doesn't have the sibling's `scripts/podman.env`
yet (S10.2). Until it does, set the same two variables by hand in each terminal. This is
**unproven in this repo**; it works in the sibling:

```bash
export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' | head -1)"
export KIND_EXPERIMENTAL_PROVIDER=podman
```

### 11.1 Get the code and the tools

```bash
git clone git@github.com:ephico2real2/openbao-node-poc.git
cd openbao-node-poc
scripts/bootstrap/macos.sh               # bash, jq, node, kind, kubectl; it also installs Docker Desktop if missing (it has no --podman yet, S10.2)
brew install helm                        # step v3 needs it; the bootstrap doesn't install it yet (S10.3)
scripts/preflight.sh compose
```

Fix every `REQUIRED-FAIL` row first (the sibling's section 11.1 lists the usual ones).
Memory per step is **not measured** on the Mac yet (S10.2). The detection and kind
stacks run more containers than the sibling's 4 GiB labs, so watch `podman machine inspect`.

### 11.2 Docker Compose, one step at a time

```bash
export COMPOSE_FILE=docker-compose.yml:steps/v1-openbao-kv/compose.yaml          # v1
# v2: …:steps/v1-openbao-kv/compose.yaml:steps/v2-openbao-dynamic/compose.yaml
# v4: docker-compose.yml:steps/v4-vault/compose.yaml
# v5: …:steps/v1-openbao-kv/compose.yaml:steps/v5-detection/compose.yaml   (alert console :3100)
docker compose down -v && docker compose up --build -d
scripts/compose-check.sh                 # ends with "credential-scan: no credential value found …"
# http://localhost:3000
docker compose down -v && unset COMPOSE_FILE
```

### 11.3 kind (step v3)

```bash
docker compose down -v                   # kind uses port 3000 too
scripts/kind-up.sh && KIND_OPENBAO=1 scripts/images-build.sh
scripts/openbao-k8s-up.sh
scripts/k8s-deploy.sh deploy/k8s/overlays/kind-openbao        # Kubernetes auth
scripts/k8s-check.sh                     # ends with "k8s-check: all checks passed"
# file mode instead: scripts/eso-k8s-up.sh && scripts/k8s-deploy.sh deploy/k8s/overlays/kind-openbao-eso
scripts/kind-down.sh
```

The cluster and the Compose project are both `secure-notes-bao`, so they don't collide
with the sibling's. Both use port 3000: run one lab at a time.

### 11.4 OpenShift Local

**Parked (B9, #35–#40).** The plan is Red Hat's External Secrets Operator from the Red Hat
catalog on OpenShift Local, with kind keeping the Helm chart. Don't run `crc setup` or
`crc start`, or download a bundle, unless the owner asks.
