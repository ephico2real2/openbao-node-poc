#!/usr/bin/env bash
# SBOM (syft, CycloneDX JSON) and vulnerability scan (grype) for the two images
# this repo builds. Writes the reports to OUT and fails if any CRITICAL
# vulnerability that already has a fix is found.
#
#   docker compose build && scripts/scan-images.sh            # reports in output/supply-chain
#   scripts/scan-images.sh /tmp/reports
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. scripts/versions.env
OUT="${1:-output/supply-chain}"
mkdir -p "$OUT"
BIN="${TOOLS_BIN:-$PWD/.tmp/bin}"
mkdir -p "$BIN"
export PATH="$BIN:$PATH"

# Download a pinned anchore release and check it against the release's checksums file.
install_tool() {
  local name=$1 v=${2#v}
  if [ -x "$BIN/$name" ] && "$BIN/$name" version 2>/dev/null | grep -q "$v"; then return; fi
  local base="https://github.com/anchore/$name/releases/download/v$v" tgz="${name}_${v}_linux_amd64.tar.gz" tmp
  tmp=$(mktemp -d)
  local url
  for url in "$base/$tgz" "$base/${name}_${v}_checksums.txt"; do
    curl -fsSL -o "$tmp/${url##*/}" "$url" || { echo "download failed: $url" >&2; exit 1; }
  done
  mv "$tmp/${name}_${v}_checksums.txt" "$tmp/checksums.txt"
  (cd "$tmp" && grep " $tgz\$" checksums.txt | sha256sum -c --quiet -)
  tar -xzf "$tmp/$tgz" -C "$BIN" "$name"
  rm -rf "$tmp"
  echo "installed $name $v (checksum verified)"
}
install_tool syft "$SYFT_VERSION"
install_tool grype "$GRYPE_VERSION"
grype db update -q >/dev/null 2>&1 || true

fails=0
summary="$OUT/summary.md"
{ echo "| Image | Packages | Critical | High | Medium | Low | Critical with a fix |"; echo "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"; } > "$summary"
for pair in "$APP_IMAGE:app" "$MOCK_IMAGE:aws-mock"; do
  img=${pair%:*} name=${pair##*:}
  sbom="$OUT/sbom-$name.cdx.json"
  echo "== $img"
  syft scan "docker:$img" -q -o "cyclonedx-json=$sbom"
  # The full report, for the record.
  grype "sbom:$sbom" -q -o "table=$OUT/grype-$name.txt" -o "json=$OUT/grype-$name.json"
  count() { jq --arg s "$1" '[.matches[] | select(.vulnerability.severity == $s)] | length' "$OUT/grype-$name.json"; }
  fixable=$(jq '[.matches[] | select(.vulnerability.severity == "Critical" and .vulnerability.fix.state == "fixed")] | length' "$OUT/grype-$name.json")
  echo "| \`$img\` | $(jq '.components | length' "$sbom") | $(count Critical) | $(count High) | $(count Medium) | $(count Low) | $fixable |" >> "$summary"
  # The gate: a critical vulnerability with a fix available fails the build.
  if ! grype "sbom:$sbom" -q --only-fixed --fail-on critical -o table > "$OUT/grype-$name-gate.txt"; then
    echo "  FAIL  $img has CRITICAL vulnerabilities with a fix available:"
    grep -i critical "$OUT/grype-$name-gate.txt" || true
    fails=$((fails + 1))
  else
    echo "  ok    no CRITICAL vulnerability with a fix available"
  fi
done
cat "$summary"
exit $((fails > 0))
