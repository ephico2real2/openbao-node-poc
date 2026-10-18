#!/usr/bin/env bash
# Build the images ONCE with Docker Compose, then (if a kind cluster is up)
# load those exact images into it.
#
#   scripts/images-build.sh            build, and load into kind if the cluster exists
#   SKIP_BUILD=1 scripts/images-build.sh   only load (CI: the images came from the build job)
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. scripts/versions.env

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  echo "== docker compose build (the one place images are built)"
  docker compose build app aws-mock
fi

docker image inspect "$APP_IMAGE" "$MOCK_IMAGE" --format '{{index .RepoTags 0}}  {{.Id}}  {{.Size}} bytes'

if command -v kind >/dev/null && kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
  echo "== loading into kind cluster '$KIND_CLUSTER' (the same image IDs as above)"
  for img in "$POSTGRES_IMAGE" "$REDIS_IMAGE"; do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img"
  done
  kind load docker-image --name "$KIND_CLUSTER" "$APP_IMAGE" "$MOCK_IMAGE" "$POSTGRES_IMAGE" "$REDIS_IMAGE"
else
  echo "== no kind cluster '$KIND_CLUSTER' running; images are ready for Docker Compose"
fi
