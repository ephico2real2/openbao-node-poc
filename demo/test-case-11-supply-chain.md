# Test case 11 — Scanned, listed and signed images

[← all test cases](README.md)

**What it proves:** the images have no critical vulnerability that already has a fix, every package in them is listed (an SBOM), and the published images are signed so anyone can check they came from this pipeline.

**Catalogue IDs:** K1–K3, K5 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** `build`, `images` (main only) · **Evidence from:** [CI run 39093063634](https://github.com/ephico2real2/aws-secrets-manager-node-poc/actions/runs/39093063634), published on [`ci-captures`](https://github.com/ephico2real2/aws-secrets-manager-node-poc/tree/ci-captures)

## Steps

```bash
docker compose build && scripts/scan-images.sh        # SBOMs and reports in output/supply-chain

cosign verify ghcr.io/ephico2real2/openbao-node-poc/app:latest \
  --certificate-identity https://github.com/ephico2real2/openbao-node-poc/.github/workflows/ci.yaml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-attestation --type cyclonedx ghcr.io/ephico2real2/openbao-node-poc/app:latest \
  --certificate-identity https://github.com/ephico2real2/openbao-node-poc/.github/workflows/ci.yaml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com > /dev/null && echo "SBOM attestation verified"
```

`scan-images.sh` downloads Linux x86-64 builds of syft and grype (checksums verified), so run it on Linux or in CI; `cosign` you install yourself. Both images share the same `node:22` base, which is where most of the findings are, so their counts are similar.

## Evidence from the run

The scan (grype) of each image, from its SBOM (syft, CycloneDX). The build fails if the last column is not 0:

| Image | Packages | Critical | High | Medium | Low | Critical with a fix |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `secure-notes-app:dev` | 596 | 0 | 20 | 22 | 9 | 0 |
| `secure-notes-aws-mock:dev` | 498 | 0 | 20 | 22 | 9 | 0 |

Signing and verification, on `main` (cosign, keyless: the signature is tied to this workflow's GitHub identity, no key to leak):

```
signed + SBOM attested: ghcr.io/ephico2real2/openbao-node-poc/app@sha256:8e630b51e211592fa79d6239b1b37e0b241d698e5f8afc13218e0e1d5b8a8270
signed + SBOM attested: ghcr.io/ephico2real2/openbao-node-poc/aws-mock@sha256:cb1a529041a85182f385efd17075923f1bcc2947e84f5a4e3452890f190ec7a2
verified signature + SBOM attestation: ghcr.io/ephico2real2/openbao-node-poc/app@sha256:8e630b51e211592fa79d6239b1b37e0b241d698e5f8afc13218e0e1d5b8a8270
verified signature + SBOM attestation: ghcr.io/ephico2real2/openbao-node-poc/aws-mock@sha256:cb1a529041a85182f385efd17075923f1bcc2947e84f5a4e3452890f190ec7a2
public: ghcr.io/ephico2real2/openbao-node-poc/app:sha-73d8c2b
public: ghcr.io/ephico2real2/openbao-node-poc/aws-mock:sha-73d8c2b
```
