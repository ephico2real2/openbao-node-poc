#!/usr/bin/env bash
# Deploy an overlay and wait until the app is serving.
#
#   scripts/k8s-deploy.sh deploy/k8s/overlays/kind                  # then http://localhost:3000
#   KUBECTL=oc scripts/k8s-deploy.sh deploy/k8s/overlays/openshift   # prints the https:// Route
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. scripts/versions.env
OVERLAY="${1:?usage: k8s-deploy.sh <kustomize dir>}"
K="${KUBECTL:-kubectl}"
NS="${NAMESPACE}"

echo "== render $OVERLAY"
"$K" kustomize "$OVERLAY" > /tmp/secure-notes-rendered.yaml
grep -E '^kind:' /tmp/secure-notes-rendered.yaml | sort | uniq -c

# A Job's pod template is immutable; the seed is idempotent, so replace it.
"$K" -n "$NS" delete job seed --ignore-not-found --wait=true 2>/dev/null || true

echo "== apply"
"$K" apply -f /tmp/secure-notes-rendered.yaml

if grep -q '^kind: Job' /tmp/secure-notes-rendered.yaml; then
  echo "== waiting for the backing services and the seed job"
  for d in aws-mock postgres redis; do
    grep -q "^  name: $d$" /tmp/secure-notes-rendered.yaml || continue # the openbao overlays have no aws-mock
    "$K" -n "$NS" rollout status "deploy/$d" --timeout=300s
  done
  if ! "$K" -n "$NS" wait --for=condition=complete job/seed --timeout=300s; then
    "$K" -n "$NS" logs job/seed --all-containers --tail=100 || true
    exit 1
  fi
  "$K" -n "$NS" logs job/seed --tail=20
fi

echo "== waiting for the app (it restarts until its secrets exist, then becomes ready)"
"$K" -n "$NS" rollout status deploy/secure-notes --timeout=420s
"$K" -n "$NS" get pods -o wide

# Where to open it: the Route on OpenShift, the mapped host port on kind.
if grep -q '^kind: Route' /tmp/secure-notes-rendered.yaml; then
  for _ in $(seq 1 30); do
    app_host=$("$K" -n "$NS" get route secure-notes -o jsonpath='{.status.ingress[0].host}' 2>/dev/null)
    [ -n "$app_host" ] && break; sleep 2
  done
  echo; echo "app: https://${app_host:-<route not admitted yet: $K -n $NS get route>}"
elif grep -q 'nodePort: 30080' /tmp/secure-notes-rendered.yaml; then
  echo; echo "app: http://localhost:${KIND_APP_PORT:-3000}"
fi
