#!/usr/bin/env bash
# Check THIS machine before starting a lab: what is installed, what the container
# VM was given, which ports are free. The same questions on a MacBook (Intel or
# Apple silicon), a Linux laptop and the CI runner, so a problem shows up here
# and not halfway through a bring-up.
#
#   scripts/preflight.sh                 # the Docker Compose lab
#   scripts/preflight.sh kind
#   scripts/preflight.sh openshift       # OpenShift Local (CRC) or a dev cluster, through `oc`
#   PREFLIGHT_STRICT=1 scripts/preflight.sh kind   # exit 1 if a REQUIRED row fails (kind-up.sh runs it so)
#
# Every row says what was measured and the rule it was held to. Written for
# bash 3.2 as well (macOS's /bin/bash), so it can tell you to install a newer one.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# shellcheck disable=SC1091
. scripts/versions.env

TARGET="${1:-compose}"
STRICT="${PREFLIGHT_STRICT:-0}"
failed=0
os=$(uname -s); arch=$(uname -m)

row() { # status what measured rule        status: ok | warn | info | REQUIRED-FAIL
  printf '  %-13s %-22s %-40s %s\n' "$1" "$2" "$3" "$4"
  [ "$1" = REQUIRED-FAIL ] && failed=1
  return 0
}
# ver_ge 1.36.4 1.35.0 -> true (sort -V exists in GNU and in macOS's sort)
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
have() { command -v "$1" >/dev/null 2>&1; }
need() { # need <tool> <why>: REQUIRED for this target
  if have "$1"; then row ok "$1" "$(command -v "$1")" "$2"; else row REQUIRED-FAIL "$1" "not found" "$2 (macOS: scripts/bootstrap/macos.sh)"; fi
}
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

printf '\n== preflight for the %s lab on %s %s\n' "$TARGET" "$os" "$arch"
printf '  %-13s %-22s %-40s %s\n' STATUS WHAT MEASURED RULE
case "$os" in
  Darwin) row info host "macOS $(sw_vers -productVersion) $arch, $(sysctl -n hw.memsize | awk '{printf "%d GiB", $1/1073741824}')" "containers run in Docker's Linux VM, sized below" ;;
  Linux)  row info host "$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-Linux}") $arch" "containers share this kernel" ;;
  *)      row warn host "$os" "tested on macOS and Linux only" ;;
esac

# bash: the lab's scripts use bash 4 features (mapfile in mirror-images.sh); macOS ships 3.2
bv=$(bash -c 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"' 2>/dev/null || echo 0)
if ver_ge "$bv" 4.4; then row ok "bash (env bash)" "$bv at $(command -v bash)" ">= 4.4"
else row REQUIRED-FAIL "bash (env bash)" "$bv at $(command -v bash)" ">= 4.4: brew install bash (Homebrew's comes first on PATH)"; fi

# ------------------------------------------------------------ the container engine
if [ "$TARGET" != openshift ]; then
  if ! have docker; then
    row REQUIRED-FAIL docker "not found" "Docker Desktop (macOS) or Docker Engine (Linux)"
  elif ! docker info >/dev/null 2>&1; then
    row REQUIRED-FAIL docker "installed, not answering" "start Docker Desktop (open -a Docker) or the docker service"
  else
    mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null); mem=$(( ${mem:-0} / 1073741824 ))
    cpu=$(docker info --format '{{.NCPU}}' 2>/dev/null)
    row ok docker "engine $(docker version --format '{{.Server.Version}}' 2>/dev/null), ${cpu:-?} CPUs, ${mem} GiB" "the VM's size is what the lab gets"
    want=4; [ "$TARGET" = kind ] && want=6
    if [ "$mem" -ge "$want" ]; then row ok "memory for the lab" "${mem} GiB" ">= ${want} GiB for this target"
    else row warn "memory for the lab" "${mem} GiB" "below ${want} GiB: raise it (Docker Desktop: Settings > Resources > Memory)"; fi
    if docker compose version >/dev/null 2>&1; then row ok "docker compose" "$(docker compose version --short 2>/dev/null)" "Compose v2 builds the images, on every path"
    else row REQUIRED-FAIL "docker compose" "not found" "Compose v2 (part of Docker Desktop; docker-compose-plugin on Linux)"; fi
  fi
fi

# ------------------------------------------------------------ the target's tools
case "$TARGET" in
  kind)
    if have kind; then
      kv=$(kind version 2>/dev/null | awk '{print $2}')
      if [ "$kv" = "$KIND_VERSION" ]; then row ok kind "$kv" "= $KIND_VERSION (scripts/versions.env)"
      else row warn kind "$kv" "the node image is pinned for $KIND_VERSION; other versions usually work"; fi
    else row REQUIRED-FAIL kind "not found" "$KIND_VERSION (brew install kind, or scripts/bootstrap/linux.sh)"; fi
    grep -q "image: ${KIND_NODE_IMAGE}" deploy/kind/cluster.yaml \
      && row ok "node image" "${KIND_NODE_IMAGE%%@*}" "deploy/kind/cluster.yaml = scripts/versions.env" \
      || row REQUIRED-FAIL "node image" "files disagree" "deploy/kind/cluster.yaml and KIND_NODE_IMAGE must name the same image"
    if have kubectl; then
      kc=$(kubectl version --client -o json 2>/dev/null | sed -n 's/.*"gitVersion": *"\(v[0-9.]*\)".*/\1/p' | head -1)
      if ver_ge "${kc#v}" "${KUBECTL_MIN_VERSION#v}"; then row ok kubectl "$kc" ">= $KUBECTL_MIN_VERSION (the cluster's skew)"
      else row warn kubectl "${kc:-?}" "older than $KUBECTL_MIN_VERSION: outside the supported skew"; fi
    else row REQUIRED-FAIL kubectl "not found" "brew install kubernetes-cli"; fi
    ;;
  openshift)
    need oc "the OpenShift CLI (brew install openshift-cli, or eval \$(crc oc-env))"
    if have oc; then
      if who=$(oc whoami 2>/dev/null); then row ok "oc login" "$who on $(oc whoami --show-server 2>/dev/null)" "logged in to the cluster"
      else row REQUIRED-FAIL "oc login" "not logged in" "CRC: eval \$(crc oc-env) && oc login -u developer https://api.crc.testing:6443"; fi
    fi
    if have crc; then row info crc "$(crc version 2>/dev/null | head -1), $(crc status -o json 2>/dev/null | sed -n 's/.*"crcStatus": *"\([^"]*\)".*/\1/p')" "OpenShift Local: 9 GiB and 4 CPUs at least (crc config set memory)"; fi
    ;;
esac

# ------------------------------------------------------------ the check scripts
for t in curl jq; do
  if have "$t"; then row ok "$t" "$(command -v "$t")" "the check scripts"; else row warn "$t" "not found" "the check scripts need it"; fi
done
if have node; then
  nv=$(node -p 'process.versions.node' 2>/dev/null)
  if [ "${nv%%.*}" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then row ok node "$nv" ">= $NODE_MIN_MAJOR for the check scripts and the unit tests"
  else row warn node "$nv" "the check scripts need Node.js $NODE_MIN_MAJOR or later"; fi
else row warn node "not found" "Node.js $NODE_MIN_MAJOR+ for the check scripts and the unit tests"; fi

# ------------------------------------------------------------ host ports
ports="3000"
[ "$TARGET" = openshift ] && ports=""   # OpenShift serves through Routes, not host ports
cluster_up=0
[ "$TARGET" = kind ] && have kind && kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER" && cluster_up=1
for p in $ports; do
  if port_free "$p"; then row ok "port $p" "free" "127.0.0.1:$p is where this lab listens"
  elif [ "$cluster_up" = 1 ]; then row info "port $p" "in use (the kind cluster, probably)" "kind cluster '$KIND_CLUSTER' already exists"
  else row REQUIRED-FAIL "port $p" "in use" "stop what holds it (another lab: docker compose down / scripts/kind-down.sh), or pick other ports"; fi
done

echo
if [ "$failed" = 1 ]; then
  echo "preflight: at least one REQUIRED row failed (above)."
  [ "$STRICT" = 1 ] && exit 1
else
  echo "preflight: ready for the $TARGET lab."
fi
exit 0
