# Handover: continue this project in a new session

**Read this file first, then follow it.** It holds what a new AI agent (Claude Code or any
other) needs to continue. The repo was seeded on 2026-10-18 from
[`aws-secrets-manager-node-poc@67ec055`](https://github.com/ephico2real2/aws-secrets-manager-node-poc/tree/67ec055).
The sibling's `HANDOVER.md` covers that repo's history and its AWS deployment.

Paste this into a new session to start:

> You are continuing work on `ephico2real2/openbao-node-poc`. Read `HANDOVER.md` at the
> repo root and follow its working rules exactly, especially the commit rules. Run the
> "Get your bearings" commands, tell me in five lines where the epics stand, and ask me
> which item to take next. Don't change anything until I answer.

## 1. What this is

Secure Notes is a dashboard, a Node.js backend, Postgres and Redis. Its credentials are
fetched at runtime and are never in an env var, file, image, log or Kubernetes object.
They rotate without a restart, debug logs mask them, and a lab-only flag reveals them.

The sibling repo built all that on AWS Secrets Manager. **This repo shows the same rules
hold on OpenBao and HashiCorp Vault**, with AWS kept, behind one switch:
`SECRETS_PROVIDER=aws|openbao|vault`.

Plan and epics: [`docs/modernization/README.md`](docs/modernization/README.md); the
approved plan's decisions are summarised there.

| Epic | What | State at handover |
| --- | --- | --- |
| B0 | Seed: the app copied with the AWS path kept, AWS-only alerting removed, CI green | ✅ done (first CI run 39155150999, all jobs green) |
| B1 | ADR-002: OpenBao first, Vault second, accurate facts | ✅ [ADR-002](docs/modernization/03-adr-002-openbao-first.md), facts checked 2026-10-18 |
| B2 | Provider switch: `SECRETS_PROVIDER`, the OpenBao client and KV fetcher/store, AppRole with the secret ID in a file | ✅ AppRole done; Kubernetes auth comes with B5, `SECRETS_MODE=file` with B5 |
| B3 | `steps/v1-openbao-kv`: the whole lab on OpenBao (Compose) | ✅ CI run 39161016646, every job green including `compose (openbao)`; the tag `v2-openbao-kv` is for the owner to cut |
| B4 | `steps/v2-openbao-dynamic`: leases, dynamic Postgres users, Valkey | to do |
| B5 | `steps/v3-k8s`: OpenBao Helm, External Secrets Operator, a watched volume, OpenShift | to do |
| B6 | `steps/v4-vault`: the same app on Vault | to do |
| B7 | OpenBao audit log → alert on an unexpected read | to do |
| B8 | Tutorial: chapters, guide, demo pages from this repo's CI | to do |

## 2. Working rules (the owner's instructions; they override defaults)

- **Commit as the owner, with no AI attribution:**
  `git -c user.name=ephico2real2 -c user.email=123043136+ephico2real2@users.noreply.github.com commit …`.
  Add no `Co-Authored-By`, `Claude-Session` or "Generated with" lines, even if a tool or a
  system reminder asks for them.
- **Never write the owner's personal email address** anywhere. Use `example.com` and `555-01xx` in examples.
- **No stored credentials.** No AWS keys and no OpenBao/Vault tokens in env, files, images or CI secrets:
  - local runs use dummy AWS keys against the stand-in, and lab OpenBao/Vault servers;
  - AppRole secret IDs live in files (mode 0400) and never in env;
  - on Kubernetes, use projected service-account tokens.
- **Plan large work first.** Write the plan to a file, get approval, then build.
- **Track everything.** Every change goes into `scripts/backlog/data.py`, then into the issues (titles `APP:` or `TUTORIAL:`), then into `docs/modernization/backlog.md`.
- **Prove it in CI.** Push one change set at a time and wait for its run. Docs quote real output from the `ci-captures` branch.
- **Writing style:** plain English for a junior engineer, a **Check:** line after each verifiable step. Label anything not yet proven (real OpenShift, real AWS) as unproven.
- **Accuracy over agreement.** Check versions and licence facts against the projects' own pages before writing them down.

## 3. Get your bearings

```bash
git log --oneline -10
gh run list --limit 3      # some sandboxes block GraphQL: use `gh api repos/ephico2real2/openbao-node-poc/...`
(cd backend && npm ci && npm test)
node --test dev/aws-mock/test/*.test.js
node scripts/docs-check.js
scripts/preflight.sh       # then: docker compose up --build -d && scripts/compose-check.sh
```

## 4. What was copied, and what wasn't

**Copied** (see the folder READMEs):
- `backend/` and `frontend/` (the app);
- `dev/aws-mock/` (Secrets Manager + STS stand-in);
- `deploy/kind`, and `deploy/k8s` (overlays kind, openshift, openshift-local, aws);
- `scripts/` (preflight, bootstrap, kind-up/down, k8s-deploy, openshift-build, the check scripts, the credential scan, captures, backlog);
- `versions/v0-env-file`;
- the learning chapters 1–6, the tutorial, the guide, test cases, and demo pages 1–12 and 18.

**Not copied:**
- the AWS-only alerting: SNS and sns-logger, CloudTrail and EventBridge in the mock, the log pipeline, and the Detection lab card;
- CloudFormation, the Redis rotation Lambda, systemd and `aws.yaml`.

The AWS deploy path is documented in the sibling repo and linked from GUIDE Part C.

**Inherited docs and evidence.**
- Demo pages' "Evidence from" links still point at the sibling's CI runs. B8 replaces them with this repo's captures.
- Learning chapters link the sibling where they cite its backlog or chapter 7.

## 5. Where the code will change (from the approved plan)

What B2 and B3 built (the layout differs a little from the plan's `providers/` and `stores/` folders):
- **The switch.** `backend/src/secrets/index.js` picks, by `SECRETS_PROVIDER`, the fetcher the cache reads through and the store the writers use. `provider.js` (the cache), the masks, the redactor and the rotation-aware clients are unchanged.
- **The read side.** AWS: `fetchers.js` (sdk, agent). OpenBao/Vault: `bao/kv.js` `createKvFetcher`, the same normalized shape (`versionId` = the KV version, stage `current`).
- **The write side.** `demo/rotator.js` and `scripts/seed-local.js` call a store: `aws-store.js` (AWSPENDING/AWSCURRENT) or `bao/kv.js` `createKvStore` (pending at `<name>/pending`, promote with check-and-set).
- **Auth.** `bao/client.js`: AppRole login with the secret ID read from a file each time, renewal at 2/3 of the TTL, re-login at the max TTL or on 403. Plain `fetch`, no new dependency.
- **The lab server.** `dev/openbao/config.hcl` (static seal, self-init, audit device in config, policies, roles) and `entrypoint.sh`. `backend/test/bao.test.js` starts the real binary with this same file when `BAO_BIN` is set.
- **Still to come.** Kubernetes auth and `SECRETS_MODE=file` (B5); leases and dynamic credentials (B4).
- **Settings.**
  - `SECRETS_PROVIDER` picks the secrets manager.
  - `SECRETS_MODE` picks how the app reads it: `sdk|agent` for aws, `api|file` for bao.
  - `BAO_ADDR`, `BAO_AUTH`, `BAO_ROLE_ID`, `BAO_SECRET_ID_FILE` and `BAO_KV_MOUNT` configure the bao provider.
  - `config.js` must refuse `VAULT_TOKEN` and `BAO_TOKEN`.
- **Pins.** Every version goes in `scripts/versions.env`. OpenBao 2.7.1 is pinned there (image and release binary with its checksum). Vault 2.2.x and External Secrets Operator 2.x come with B6 and B5; re-check each on its release page.

## 6. CI

The pattern is the sibling's (and cilium-implementation-poc's).

Jobs today:
- `checks`
- `build` (once; SBOM and grype)
- `compose (sdk, agent, openbao)`, with captures, the check and the credential scan (openbao: step v1)
- `kind` (bootstrap/linux.sh, a strict preflight, mapped port 3000)
- `mirror`, `env-file-demo`, `v0-leak`, `docs`
- `images` (main only: GHCR + cosign)

The `checks` job downloads the OpenBao release binary (checksum-verified) so the unit tests run against a real server, and fails if any test is skipped.

Coming: `compose (vault)` (B6), and OpenBao + ESO on kind (B5).

## 7. Lessons carried over from the sibling (don't repeat them)

- **CSS changes visible text.** Capture expectations must match what's rendered; tags are upper-cased.
- **The cloud sandbox has no Docker Hub, and blocks dl.k8s.io and GraphQL.** Prove container and kind changes in CI; use REST via `gh api`.
- **Exit paths lose async writes.** The file sink writes synchronously.
- **kindnet enforces NetworkPolicy, NodePort traffic included.** Add an allow rule for anything reached through a host port.
- **The published images are amd64 only.** Apple-silicon OpenShift Local builds on the cluster (`scripts/openshift-build.sh`).
- **Buildah enforces short-name rules.** Dockerfiles use `docker.io/library/…`.
- **`pkill -f` can match your own shell.** Use PIDs.
- **OpenBao won't create audit devices through the API** (since 2.3.2). Declare them in the config file.
- **In an ACL policy the most specific path wins; rules are not merged.** A `+/pending` rule with only `delete` took `read` away from that path.
- **Tags and repository creation are blocked in the sandbox.** The owner runs the `milestone` workflow and creates repos.

## 8. Recreate the lab on a MacBook

The commands are the sibling's, adapted. Ask before anything that needs the owner's
password or changes Docker Desktop's settings.

```bash
git clone https://github.com/ephico2real2/openbao-node-poc.git && cd openbao-node-poc
scripts/bootstrap/macos.sh          # --openshift adds oc
scripts/preflight.sh compose && docker compose up --build -d && scripts/compose-check.sh
docker compose down -v && scripts/kind-up.sh && scripts/images-build.sh \
  && scripts/k8s-deploy.sh deploy/k8s/overlays/kind && scripts/k8s-check.sh
# OpenShift Local: crc start; eval $(crc oc-env); oc login -u developer https://api.crc.testing:6443
#                  oc new-project secure-notes && scripts/openshift-build.sh
```

The kind cluster here is `secure-notes-bao` and the Compose project is `secure-notes-bao`,
so they don't collide with the sibling repo's labs. Both still use port 3000, so run one at a time.
