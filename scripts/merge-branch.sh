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

# Text of a conflicted file outside what gen-listings regenerates.
strip() { # $1 = file, $2 = stage
  git show ":$2:$1" 2>/dev/null | node -e '
    const f = process.argv[1]; let s = require("fs").readFileSync(0, "utf8");
    if (f === "README.md") s = s.replace(/<!-- mods:start -->[\s\S]*<!-- mods:end -->/, "");
    else { try { const j = JSON.parse(s); delete j.plugins; s = JSON.stringify(j); } catch {} }
    process.stdout.write(s)' "$1"
}
for f in $conflicts; do
  b=$(strip "$f" 1); o=$(strip "$f" 2); t=$(strip "$f" 3)
  if [ "$o" = "$b" ] || [ "$o" = "$t" ]; then side=theirs; else side=ours; fi
  if [ "$o" != "$b" ] && [ "$t" != "$b" ] && [ "$o" != "$t" ]; then
    echo "$f has conflicting non-listing edits on both sides; resolve by hand." >&2
    exit 1
  fi
  git checkout --$side -- "$f"
done
node scripts/gen-listings.mjs --write || exit 1
git add .claude-plugin/marketplace.json README.md
git commit --no-edit
