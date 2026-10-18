#!/usr/bin/env bash
# Delete the kind cluster (and its kubectl context). The images stay in Docker.
#
#   scripts/kind-down.sh
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. scripts/versions.env
if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
  kind delete cluster --name "$KIND_CLUSTER"
else
  echo "no kind cluster '$KIND_CLUSTER'"
fi
