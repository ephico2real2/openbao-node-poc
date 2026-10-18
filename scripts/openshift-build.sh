#!/usr/bin/env bash
# Build the two images ON the OpenShift cluster from this checkout, then deploy
# deploy/k8s/overlays/openshift-local. No local Docker and no registry login:
# `oc start-build` uploads the source, the cluster builds it for its own CPU
# (arm64 on an Apple-silicon Mac running OpenShift Local), and pushes the
# result to ImageStreams in the project.
#
#   oc new-project secure-notes          # once
#   scripts/openshift-build.sh           # build both images, then deploy
#   BUILD_ONLY=1 scripts/openshift-build.sh
#
# The upload is `git archive` of HEAD (--from-repo): commit a change before
# building it. Needs `oc`, logged in, with the project selected.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. scripts/versions.env
NS="$NAMESPACE"
oc whoami >/dev/null 2>&1 || { echo "log in first: oc login …  (OpenShift Local: eval \$(crc oc-env))" >&2; exit 1; }
oc get project "$NS" >/dev/null 2>&1 || { echo "no project '$NS': oc new-project $NS" >&2; exit 1; }

build() { # <name> <Dockerfile path>
  local name=$1 dockerfile=$2
  if ! oc -n "$NS" get bc "$name" >/dev/null 2>&1; then
    oc -n "$NS" new-build --name "$name" --binary --strategy docker --to "$name:dev" >/dev/null
    oc -n "$NS" patch bc "$name" --type merge -p "{\"spec\":{\"strategy\":{\"dockerStrategy\":{\"dockerfilePath\":\"$dockerfile\"}}}}" >/dev/null
    echo "== created BuildConfig $name ($dockerfile -> ImageStreamTag $name:dev)"
  fi
  # Pods may name the ImageStream by its short name (secure-notes-app:dev).
  oc -n "$NS" set image-lookup "$name" >/dev/null
  echo "== building $name from HEAD ($(git rev-parse --short HEAD))"
  oc -n "$NS" start-build "$name" --from-repo=. --follow --wait
}

[ -z "$(git status --porcelain -- backend dev frontend)" ] \
  || echo "note: uncommitted changes in backend/, dev/ or frontend/ are NOT in the build (it uploads HEAD)"
build secure-notes-app backend/Dockerfile
build secure-notes-aws-mock dev/aws-mock/Dockerfile
oc -n "$NS" get istag secure-notes-app:dev secure-notes-aws-mock:dev

[ "${BUILD_ONLY:-0}" = 1 ] && exit 0
KUBECTL=oc scripts/k8s-deploy.sh deploy/k8s/overlays/openshift-local
# A rebuild under the same tag resolves to a new digest only in new pods.
for d in secure-notes aws-mock; do oc -n "$NS" rollout restart "deploy/$d" >/dev/null; done
for d in aws-mock secure-notes; do oc -n "$NS" rollout status "deploy/$d" --timeout=300s; done
