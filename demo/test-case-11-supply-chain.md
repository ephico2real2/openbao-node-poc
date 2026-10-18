# Test case 11 — Scanned, listed and signed images

[← all test cases](README.md)

**What it proves:** the images have no critical vulnerability that already has a fix, every package in them is listed (an SBOM), and the published images are signed so anyone can check they came from this pipeline.

**Catalogue IDs:** K1–K3, K5 ([TEST-CASES.md](../docs/TEST-CASES.md)) · **Proven in CI by:** `build`, `images` (main only) · **Evidence from:** [CI run 39169755271](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39169755271): [scan output](https://github.com/ephico2real2/openbao-node-poc/blob/ci-captures/2026-10-18T2158Z_ci_run39169755271-1_build-supply-chain/scan.log), [SBOMs and reports](https://github.com/ephico2real2/openbao-node-poc/tree/ci-captures/2026-10-18T2158Z_ci_run39169755271-1_build-supply-chain/supply-chain); signing from [CI run 39166465530](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39166465530) on `main`: [signing output](https://github.com/ephico2real2/openbao-node-poc/blob/ci-captures/2026-10-18T2116Z_ci_run39166465530-1_images-logs/signing.txt)

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

The scan (grype 0.119.0) of each image, from its SBOM (syft 1.52.0, CycloneDX). The build fails if the last column is not 0:

```
== secure-notes-app:dev
  ok    no CRITICAL vulnerability with a fix available
== secure-notes-aws-mock:dev
  ok    no CRITICAL vulnerability with a fix available
```

| Image | Packages | Critical | High | Medium | Low | Critical with a fix |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `secure-notes-app:dev` | 596 | 0 | 20 | 22 | 9 | 0 |
| `secure-notes-aws-mock:dev` | 498 | 0 | 20 | 22 | 9 | 0 |

Signing and verification happen only on `main` (the `images` job), so they are not part of run 39169755271, which was a branch push. This is the output of the latest `main` run that signed, [39166465530](https://github.com/ephico2real2/openbao-node-poc/actions/runs/39166465530) (cosign, keyless: the signature is tied to this workflow's GitHub identity, no key to leak):

```
signed + SBOM attested: ghcr.io/ephico2real2/openbao-node-poc/app@sha256:79ee0c90629357402595abec9f4f546e622ab5899feb66903e5e3f32321caeda
signed + SBOM attested: ghcr.io/ephico2real2/openbao-node-poc/aws-mock@sha256:ad0ad4a261472c5e8fce4562a99dec67a67d099bc14011b59f81a4a56b70e843
verified signature + SBOM attestation: ghcr.io/ephico2real2/openbao-node-poc/app@sha256:79ee0c90629357402595abec9f4f546e622ab5899feb66903e5e3f32321caeda
verified signature + SBOM attestation: ghcr.io/ephico2real2/openbao-node-poc/aws-mock@sha256:ad0ad4a261472c5e8fce4562a99dec67a67d099bc14011b59f81a4a56b70e843
public: ghcr.io/ephico2real2/openbao-node-poc/app:sha-472262c
public: ghcr.io/ephico2real2/openbao-node-poc/aws-mock:sha-472262c
```
