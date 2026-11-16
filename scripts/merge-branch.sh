#!/usr/bin/env bash
# Merge a branch; if only the generated listings conflict, regenerate them.
# Exit 0: merged. Exit 1: stopped (merge left in progress when files conflict).
set -u
branch=${1:?usage: merge-branch.sh <branch>}
root=$(git rev-parse --show-toplevel) || exit 1
cd "$root"

if git merge --no-ff --no-edit "$branch"; then exit 0; fi

conflicts=$(git diff --name-only --diff-filter=U)
if [ -z "$conflicts" ]; then
  echo "merge failed without file conflicts" >&2
  exit 1
fi
other=$(printf '%s\n' "$conflicts" | grep -vxE '\.claude-plugin/marketplace\.json|README\.md' || true)
if [ -n "$other" ]; then
  echo "Conflicts outside the generated listings; resolve these by hand:" >&2
  printf '%s\n' "$other" | sed 's/^/  /' >&2
  exit 1
fi

for f in $conflicts; do git checkout --theirs -- "$f"; done
node scripts/gen-listings.mjs --write || exit 1
git add .claude-plugin/marketplace.json README.md
git commit --no-edit
