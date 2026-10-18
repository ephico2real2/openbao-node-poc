#!/usr/bin/env bash
# Step v3, file mode: External Secrets Operator from its Helm chart, then the
# ClusterSecretStore that points it at OpenBao (scripts/openbao-k8s-up.sh first).
#
#   scripts/eso-k8s-up.sh
#   scripts/k8s-deploy.sh deploy/k8s/overlays/kind-openbao-eso
# Needs helm 3. The chart comes from the external-secrets GitHub release and is
# checked against the checksum in scripts/versions.env (from its .prov file).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. scripts/versions.env
K="${KUBECTL:-kubectl}"
NSE=external-secrets
command -v helm >/dev/null || { echo "helm 3 is required (https://helm.sh/docs/intro/install/)"; exit 1; }

echo "== namespace $NSE"
if "$K" api-resources --api-group=security.openshift.io 2>/dev/null | grep -q securitycontextconstraints; then
  "$K" get ns "$NSE" >/dev/null 2>&1 || "$K" create ns "$NSE"
else
  "$K" apply -f - <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: $NSE
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
YAML
fi

echo "== the chart: external-secrets-$ESO_CHART_VERSION"
mkdir -p .tmp/charts
tgz=".tmp/charts/external-secrets-$ESO_CHART_VERSION.tgz"
[ -s "$tgz" ] || curl -fsSL -o "$tgz" "https://github.com/external-secrets/external-secrets/releases/download/helm-chart-$ESO_CHART_VERSION/external-secrets-$ESO_CHART_VERSION.tgz"
echo "$ESO_CHART_SHA256  $tgz" | sha256sum -c - >/dev/null && echo "  checksum ok"
helm upgrade --install external-secrets "$tgz" -n "$NSE" -f steps/v3-k8s/eso-values.yaml --wait --timeout 6m

echo "== ClusterSecretStore openbao"
"$K" apply -f steps/v3-k8s/eso-clustersecretstore.yaml
for _ in $(seq 1 40); do
  ready=$("$K" get clustersecretstore openbao -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
  [ "$ready" = True ] && break
  sleep 3
done
"$K" get clustersecretstore openbao
[ "${ready:-}" = True ] || { "$K" describe clustersecretstore openbao | tail -20; exit 1; }
