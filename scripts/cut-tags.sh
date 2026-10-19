#!/usr/bin/env bash
# Cut the step tags and their GitHub releases, from your own machine, as you.
#
#   scripts/cut-tags.sh            # every tag below that doesn't exist yet
#   scripts/cut-tags.sh --dry-run  # say what it would do, change nothing
#
# Why not the milestone workflow: GitHub refuses to let a workflow's own token
# create a ref on a commit whose .github/workflows files differ from the
# default branch ("refusing to allow a GitHub App to create or update workflow
# ... without `workflows` permission"), and that token can never get that
# permission. Every older step commit differs, so these tags need a person
# (or a stored token with the workflow scope, which this repo doesn't keep).
#
# Needs git with push access to origin and the GitHub CLI (gh auth login).
# Each tag is annotated, on the commit its release notes name, with the notes
# in docs/releases/<tag>.md. Existing tags are left alone.
set -euo pipefail
cd "$(dirname "$0")/.."
dry=no
[ "${1:-}" = --dry-run ] && dry=yes
run() { if [ "$dry" = yes ]; then echo "  would run: $*"; else "$@"; fi; }

command -v gh >/dev/null || { echo "the GitHub CLI (gh) is required: https://cli.github.com"; exit 1; }
git fetch -q origin main --tags

#   tag                 commit (its CI run was green; see docs/releases/<tag>.md)  title
while IFS='|' read -r tag sha title; do
  [ -n "$tag" ] || continue
  notes="docs/releases/$tag.md"
  [ -s "$notes" ] || { echo "$tag: $notes is missing"; exit 1; }
  git cat-file -e "$sha^{commit}" 2>/dev/null || { echo "$tag: commit $sha not found (git fetch origin)"; exit 1; }
  git merge-base --is-ancestor "$sha" origin/main || { echo "$tag: $sha is not on main"; exit 1; }
  if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
    echo "$tag: exists, left alone"
  else
    echo "$tag -> ${sha:0:7}  $title"
    run git tag -a "$tag" "$sha" -m "$title"
    run git push origin "refs/tags/$tag"
  fi
  if gh release view "$tag" >/dev/null 2>&1; then
    echo "  release exists"
  else
    run gh release create "$tag" --title "$title" --notes-file "$notes" --verify-tag
  fi
done <<'TAGS'
v1-aws-baseline|98018d16860881fb09fcad612acdf0b0526e4147|Baseline: Secure Notes on AWS Secrets Manager
v2-openbao-kv|27ca652e0a343737d788eb28bc3510b71a5ff99c|Step v1: the lab on OpenBao (KV v2, AppRole)
v3-openbao-dynamic|bec8229b417d5d50ccc32389c04db71736fefbbe|Step v2: database users that expire
v4-k8s|16b00373d6b68956f71e53f4d3f520b22d5e1a6a|Step v3: OpenBao on Kubernetes (Kubernetes auth, External Secrets)
v5-vault|17a6f4e9ae2c7c41c03f238b9d643e8cfcc9e4aa|Step v4: the same app on HashiCorp Vault
v6-detection|f30aed655ba0574218daf1d444f39724660eb69e|Step v5: detection on the audit log, and the tutorial
TAGS
echo "done: https://github.com/ephico2real2/openbao-node-poc/releases"
