#!/usr/bin/env bash
# CI: push the files in a directory to a folder of the ci-captures branch, so a
# run's logs and evidence are readable from the branch (and linkable from the
# job summary) without downloading artifacts. Several jobs publish at once, so
# a push that lost the race rebuilds on the new tip and retries.
#
#   scripts/ci-publish.sh <source dir> <folder name>
set -uo pipefail
SRC="${1:?source dir}"
DIR="${2:?folder name}"
BR="${CAPTURES_BRANCH:-ci-captures}"

ls -A "$SRC" >/dev/null 2>&1 && [ -n "$(ls -A "$SRC")" ] || { echo "nothing in $SRC to publish"; exit 0; }
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

publish() {
  rm -rf .tmp/pub
  git worktree prune
  if git ls-remote --exit-code --heads origin "$BR" >/dev/null 2>&1; then
    git fetch -q origin "$BR" && git worktree add -q --detach .tmp/pub "origin/$BR" || return 1
  else
    git worktree add -q --detach .tmp/pub && (cd .tmp/pub && git checkout -q --orphan "$BR" && { git rm -rfq . >/dev/null 2>&1 || true; })
  fi
  mkdir -p ".tmp/pub/$DIR" && cp -r "$SRC"/. ".tmp/pub/$DIR/"
  (cd .tmp/pub && git add -A && git commit -qm "ci: $DIR" && git push -q origin "HEAD:$BR")
}

for attempt in 1 2 3 4 5; do
  if publish; then
    echo "published: https://github.com/${GITHUB_REPOSITORY:-?}/tree/$BR/$DIR"
    exit 0
  fi
  echo "publish attempt $attempt lost the race; retrying" >&2
  sleep $((attempt * 3 + RANDOM % 5))
done
echo "::warning::could not publish $SRC after 5 attempts"
