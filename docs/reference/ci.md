# CI: what every push proves

[← README](../../README.md) · [Test cases](../TEST-CASES.md) · [Demo pages](../../demo/README.md)

[`.github/workflows/ci.yaml`](../../.github/workflows/ci.yaml):

```
checks ─► build ─┬─► compose (sdk, agent) ─┐
         (scan,  ├─► kind ─────────────────┼─► images (main only: push, sign, attest)
          SBOM)  ├─► mirror ───────────────┘
                 └─► env-file-demo
docs (links, Mermaid)
```

| Job | What it proves |
| --- | --- |
| `checks` | Unit tests with the real `pg`, `ioredis` and AWS SDK; the AWS stand-in's tests; every JS file parses; shellcheck; every Kustomize overlay renders and matches its schemas (the OpenShift Route is skipped: it has no public schema); actionlint on every workflow. |
| `build` | `docker compose build`, once; a CycloneDX SBOM per image (syft) and a vulnerability scan (grype) that fails on any CRITICAL vulnerability with a fix; the images are saved and handed to every later job. |
| `compose (sdk)`, `compose (agent)` | Path A on the runner, once per secrets mode: the dashboard walk, the bootstrap passwords burned, the end-to-end smoke test, the credential scan, and (sdk leg) the reveal-flag checks. In agent mode also: the agent served the app's fetches, its SSRF token is visible only to the agent and the app, and it rejects a request without the token. |
| `kind` | Path B under Pod Security `restricted`: who each container runs as, that Kubernetes holds no copy of the app's credentials, the bootstrap burned, SCRAM-only password changes in the Postgres log, and the smoke test. |
| `mirror` | `scripts/mirror-images.sh` copies all four images into a throwaway registry; the generated overlay pulls only from it and the copies match the originals. |
| `images` | On `main`, pushes the exact images that passed to GHCR, signs each digest with cosign (keyless, this workflow's GitHub identity) and attaches its SBOM as a signed attestation, then verifies both without logging in. |
| `env-file-demo` | Runs `scripts/env-file-demo.sh` with Podman: a `.env` password is readable through `exec`, `/proc` and `inspect`, while the Secure Notes container holds secret IDs only ([chapter 2](../learn/02-the-env-file-problem.md)). |
| `docs` | Every relative link in the Markdown resolves and every Mermaid diagram renders. |
| `v0-leak` | `versions/v0-env-file` (the original `.env` app) still leaks: `leak.sh` finds its passwords in at least 8 of 9 places. |

The dashboard walk (`scripts/capture/`, adapted from
[cilium-implementation-poc](https://github.com/ephico2real2/cilium-implementation-poc))
drives Chromium through `scripts/capture/dashboard.yaml`: first load, a Postgres
rotation and recovery, a Redis rotation, the leak test and a phone-width view. Each
page states the text it must show, so a screenshot of a broken page fails the job.
The PNGs go to the `ci-captures` branch, one folder per run and job, and appear on the
run's summary page.
