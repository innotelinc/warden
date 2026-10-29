# check-hook-modes.sh — the hook scripts must be committed executable.
#
# Git refuses to run a hook whose file is not executable on POSIX, and it says
# nothing when it skips one: the commit simply lands unguarded. That is not
# hypothetical here — a commit written through the GitHub file API cannot carry
# a mode at all, so `.githooks/commit-msg` and `.githooks/pre-commit` arrived as
# 100644 and a fresh clone of that commit let a foreign credit trailer straight
# through.
#
# This reads the mode from the INDEX, which is what a clone will check out, not
# from the working tree where a local `chmod` would hide the problem.
#
# Run locally:  bash scripts/check-hook-modes.sh
set -uo pipefail

REQUIRED_MODE=100755
# A sourced library is read, never executed, so its bit is irrelevant. Every
# other tracked file under .githooks is invoked directly by git.
EXEMPT=(guard-lib)

root="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$root" ]; then
  echo "check-hook-modes: not a git checkout — nothing to check" >&2
  exit 0
fi
cd "$root" || exit 1

status=0
checked=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  mode="${entry%% *}"
  path="${entry#*$'\t'}"

  skip=0
  for name in "${EXEMPT[@]}"; do
    if [ "$(basename "$path")" = "$name" ]; then skip=1; fi
  done
  [ "$skip" -eq 0 ] || continue

  checked=$((checked + 1))
  if [ "$mode" != "$REQUIRED_MODE" ]; then
    echo "::error::$path is committed as $mode, not $REQUIRED_MODE — git skips the hook in silence."
    echo "  fix: git update-index --chmod=+x $path && git commit"
    status=1
  fi
done < <(git ls-files --stage -- .githooks/)

if [ "$status" -eq 0 ]; then
  echo "hook modes: ok ($checked hook script(s) executable)"
fi
exit "$status"
