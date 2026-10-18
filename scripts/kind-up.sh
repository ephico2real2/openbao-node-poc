#!/usr/bin/env bash
# Create the kind cluster from deploy/kind/cluster.yaml (idempotent), after
# checking the machine. The same script on a MacBook, a Linux laptop and CI.
#
#   scripts/kind-up.sh
#   KIND_APP_PORT=3100 scripts/kind-up.sh                          # run beside Docker Compose
#   PREFLIGHT=0 scripts/kind-up.sh                                 # skip the machine check
#
# Then: scripts/images-build.sh && scripts/k8s-deploy.sh deploy/k8s/overlays/kind
# and open http://localhost:3000.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. scripts/versions.env
APP_PORT="${KIND_APP_PORT:-3000}"

if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
  echo "kind cluster '$KIND_CLUSTER' already exists"
  # A cluster made before deploy/kind/cluster.yaml (a bare `kind create cluster`)
  # has no host ports: the app would only be reachable through a port-forward.
  if ! docker inspect "${KIND_CLUSTER}-control-plane" --format '{{json .HostConfig.PortBindings}}' 2>/dev/null | grep -q '30080'; then
    echo "  it has no host port mappings (made before deploy/kind/cluster.yaml)."
    echo "  Recreate it to reach the app without a port-forward: scripts/kind-down.sh && scripts/kind-up.sh"
  fi
else
  if [ "${PREFLIGHT:-1}" = 1 ]; then
    PREFLIGHT_STRICT=1 scripts/preflight.sh kind
  fi
  cfg=deploy/kind/cluster.yaml
  if [ "$APP_PORT" != 3000 ]; then
    # kind configs can't be templated: write a copy with the requested host ports.
    cfg=$(mktemp "${TMPDIR:-/tmp}/kind-cluster.XXXXXX")
    sed -e "s/hostPort: 3000/hostPort: $APP_PORT/" deploy/kind/cluster.yaml > "$cfg"
    echo "host port: app $APP_PORT"
  fi
  kind create cluster --name "$KIND_CLUSTER" --config "$cfg" --wait 180s
fi
kubectl config use-context "kind-$KIND_CLUSTER" >/dev/null
kubectl get nodes -o wide
