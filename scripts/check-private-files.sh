#!/bin/sh
# Print any private working-note file tracked in a commit's tree (default HEAD).
# Used by CI and by scripts/git-hooks/pre-push. Prints nothing when clean.
# Exit status: 0 always for listing; use --fail to exit 1 when something is found.
fail=0
if [ "$1" = "--fail" ]; then fail=1; shift; fi
rev=${1:-HEAD}
hits=$(git ls-tree -r --name-only "$rev" -- HANDOFF.md NICK-TODO.md docs/audits 2>/dev/null \
       | grep -v '^docs/audits/README.md$')
if [ -n "$hits" ]; then
  echo "$hits"
  [ "$fail" = 1 ] && exit 1
fi
exit 0
