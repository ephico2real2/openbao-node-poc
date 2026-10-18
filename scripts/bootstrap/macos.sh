#!/usr/bin/env bash
# Prepare a MacBook (Apple silicon or Intel) for the labs, then run the
# preflight. Installs what is missing with Homebrew; changes nothing else.
#
#   scripts/bootstrap/macos.sh                 # Docker Compose and kind
#   scripts/bootstrap/macos.sh --openshift     # also the OpenShift CLI (oc)
#
# What it installs (Homebrew formulae): bash (macOS ships 3.2; the scripts
# need 4.4+), jq, node, kind, kubernetes-cli; with --openshift, openshift-cli.
# Docker Desktop is installed as a cask if /Applications/Docker.app is missing.
# What stays yours, on purpose:
#   - Homebrew itself (https://brew.sh): its installer needs your password.
#   - Docker Desktop's first launch and its memory setting (Settings > Resources;
#     6 GiB or more for kind). The preflight prints what the VM has.
#   - OpenShift Local (CRC): download it with your Red Hat account from
#     console.redhat.com/openshift/create/local, then `crc setup && crc start`.
#
# Run it from bash 3.2 or later (it is written so macOS's own bash can run it).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ "$(uname -s)" = Darwin ] || { echo "this is $(uname -s): use scripts/bootstrap/linux.sh" >&2; exit 1; }
OPENSHIFT=0; [ "${1:-}" = "--openshift" ] && OPENSHIFT=1

if ! command -v brew >/dev/null; then
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$p" ] && eval "$("$p" shellenv)" && break; done
fi
command -v brew >/dev/null || {
  echo "Homebrew is required: install it from https://brew.sh (it asks for your password), then run this again." >&2
  exit 1
}

formulae="bash jq node kind kubernetes-cli"
[ "$OPENSHIFT" = 1 ] && formulae="$formulae openshift-cli"
missing=""
for f in $formulae; do brew list --formula "$f" >/dev/null 2>&1 || missing="$missing $f"; done
if [ -n "$missing" ]; then echo "== brew install$missing"; brew install $missing; hash -r
else echo "== Homebrew: $formulae already installed"; fi

if [ ! -d /Applications/Docker.app ]; then
  echo "== brew install --cask docker-desktop"
  brew install --cask docker-desktop
  echo "Open Docker Desktop once (open -a Docker), accept its terms, then run this again."
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "== starting Docker Desktop"; open -a Docker
  for _ in $(seq 1 120); do docker info >/dev/null 2>&1 && break; sleep 2; done
fi

echo "== the bash your scripts will run: $(command -v bash) ($(bash -c 'echo $BASH_VERSION'))"
echo "   (Homebrew's must come first on PATH; a new Terminal picks it up)"
scripts/preflight.sh compose
scripts/preflight.sh kind
[ "$OPENSHIFT" = 1 ] && scripts/preflight.sh openshift
echo
echo "Next: docker compose up --build -d   (or scripts/kind-up.sh; see HANDOVER.md section 11)"
