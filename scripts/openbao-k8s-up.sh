#!/usr/bin/env bash
# Step v3: OpenBao on Kubernetes from its Helm chart, ready and initialised.
#
#   scripts/openbao-k8s-up.sh                 # kind (the current kubectl context)
#   KUBECTL=oc scripts/openbao-k8s-up.sh      # OpenShift: adds steps/v3-k8s/openbao-values-openshift.yaml
#
# 1. Namespace "openbao" (Pod Security restricted on Kubernetes).
# 2. LAB ONLY: the static seal key, 32 random bytes in a Secret, made once.
#    In production the key lives in a KMS/HSM, or another OpenBao (transit).
# 3. The chart, pinned and checksum-verified (scripts/versions.env), installed
#    with steps/v3-k8s/openbao-values.yaml: one Raft server that unseals itself
#    and runs self-init (KV v2, the database engine, Kubernetes auth, the
#    policies and roles for the app, its seed job and External Secrets).
# Needs helm 3. Nothing here prints a secret.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. scripts/versions.env
K="${KUBECTL:-kubectl}"
NSB=openbao
command -v helm >/dev/null || { echo "helm 3 is required (https://helm.sh/docs/intro/install/)"; exit 1; }

openshift=no
"$K" api-resources --api-group=security.openshift.io 2>/dev/null | grep -q securitycontextconstraints && openshift=yes

echo "== namespace $NSB"
if [ "$openshift" = yes ]; then
  "$K" get ns "$NSB" >/dev/null 2>&1 || "$K" create ns "$NSB"
else
  "$K" apply -f - <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: $NSB
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
YAML
fi

echo "== the static seal key (lab only)"
if "$K" -n "$NSB" get secret openbao-seal-key >/dev/null 2>&1; then
  echo "  exists: kept (a new key would make the existing data unreadable)"
else
  umask 077
  key=$(mktemp)
  head -c 32 /dev/urandom > "$key"
  "$K" -n "$NSB" create secret generic openbao-seal-key --from-file=unseal.key="$key" >/dev/null
  rm -f "$key"
  echo "  created Secret openbao-seal-key (32 random bytes)"
fi

echo "== the chart: openbao-$OPENBAO_CHART_VERSION"
mkdir -p .tmp/charts
tgz=".tmp/charts/openbao-$OPENBAO_CHART_VERSION.tgz"
[ -s "$tgz" ] || curl -fsSL -o "$tgz" "https://github.com/openbao/openbao-helm/releases/download/openbao-$OPENBAO_CHART_VERSION/openbao-$OPENBAO_CHART_VERSION.tgz"
echo "$OPENBAO_CHART_SHA256  $tgz" | sha256sum -c - >/dev/null && echo "  checksum ok"

values=(-f steps/v3-k8s/openbao-values.yaml)
[ "$openshift" = yes ] && values+=(-f steps/v3-k8s/openbao-values-openshift.yaml)
helm upgrade --install openbao "$tgz" -n "$NSB" "${values[@]}" --wait --timeout 6m

echo "== status"
for _ in $(seq 1 60); do
  out=$("$K" -n "$NSB" exec openbao-0 -- bao status -format=json 2>/dev/null || true)
  if [ -n "$out" ] && [ "$(jq -r '.initialized and (.sealed | not)' <<< "$out" 2>/dev/null)" = true ]; then
    jq -r '"  initialized: \(.initialized), sealed: \(.sealed), version: \(.version), storage: \(.storage_type)"' <<< "$out"
    break
  fi
  sleep 3
done
"$K" -n "$NSB" get pods -o wide
