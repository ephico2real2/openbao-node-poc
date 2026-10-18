#!/usr/bin/env bash
# Prepare a Linux machine (an Ubuntu laptop or the CI runner) for the kind lab:
# kind at its pin, checked against the release's published SHA-256, and kubectl
# if it is missing. Then the preflight. The CI kind job runs exactly this.
#
#   scripts/bootstrap/linux.sh            # installs into /usr/local/bin (sudo if needed)
#   BIN_DIR=$HOME/.local/bin scripts/bootstrap/linux.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
. scripts/versions.env
[ "$(uname -s)" = Linux ] || { echo "this is $(uname -s): use scripts/bootstrap/macos.sh on a Mac" >&2; exit 1; }
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
case "$(uname -m)" in x86_64) a=amd64 ;; aarch64|arm64) a=arm64 ;; *) echo "unsupported CPU $(uname -m)" >&2; exit 1 ;; esac
SUDO=""; [ -w "$BIN_DIR" ] || SUDO=sudo
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

if [ "$(kind version 2>/dev/null | awk '{print $2}')" = "$KIND_VERSION" ]; then
  echo "kind $KIND_VERSION already installed"
else
  base="https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}"
  curl -fsSLo "$tmp/kind-linux-$a" "$base/kind-linux-$a"
  curl -fsSLo "$tmp/kind.sha256sum" "$base/kind-linux-$a.sha256sum"
  (cd "$tmp" && sha256sum -c kind.sha256sum)          # refuses a download that doesn't match the release
  $SUDO install -m 0755 "$tmp/kind-linux-$a" "$BIN_DIR/kind"
  echo "installed kind $(kind version | awk '{print $2}') to $BIN_DIR"
fi

if command -v kubectl >/dev/null; then
  echo "kubectl $(kubectl version --client -o json | sed -n 's/.*"gitVersion": *"\(v[0-9.]*\)".*/\1/p' | head -1) already installed"
else
  v=$(echo "$KIND_NODE_IMAGE" | sed -E 's/.*:(v[0-9.]+)@.*/\1/')   # kubectl matching the node image
  curl -fsSLo "$tmp/kubectl" "https://dl.k8s.io/release/$v/bin/linux/$a/kubectl"
  curl -fsSLo "$tmp/kubectl.sha256" "https://dl.k8s.io/release/$v/bin/linux/$a/kubectl.sha256"
  echo "$(cat "$tmp/kubectl.sha256")  $tmp/kubectl" | sha256sum -c -
  $SUDO install -m 0755 "$tmp/kubectl" "$BIN_DIR/kubectl"
  echo "installed kubectl $v to $BIN_DIR"
fi

scripts/preflight.sh kind
