# Repo hooks

The attribution guard and the secret scan live in [`.githooks/`](../.githooks) but Git only runs
them when the clone points at that directory. Nothing did that automatically, so a fresh clone
committed unguarded and CI caught the problem only after the push.

## What enables them

`npm install` and `npm ci` run [`scripts/install-hooks.mjs`](../scripts/install-hooks.mjs) through
the `prepare` script in `package.json`. It sets one clone-local value:

```bash
git config --local core.hooksPath .githooks
```

After that, `.githooks/pre-commit` (secret scan first, then the staged-lines attribution scan) and
`.githooks/commit-msg` (trailers and attribution prose) run before a commit exists.

## Manual use

```bash
npm run hooks                     # enable or repair them now (strict, exits 1 on failure)
WARDEN_SKIP_HOOKS=1 npm install   # one install without them
```

## How the installer behaves

- Restores the execute bits on `commit-msg`, `pre-commit` and `secret-scan.sh` when a checkout or
  archive dropped them — Git refuses to run a hook that is not executable on POSIX.
- Leaves `git status` alone while it does. When the repository records a hook as `100755`, the
  restored bit matches what is committed and nothing shows as modified. When it records `100644`,
  the fix is staged with `git update-index --chmod=+x` and printed, so it becomes one deliberate
  commit instead of a mode change that trails every status report from then on.
- Never touches global Git config, and never replaces a `core.hooksPath` someone deliberately
  pointed at a different directory; it says so and stops instead.
- Warns rather than failing an install when a hook file is missing. The strict form (`npm run
  hooks`) treats the same condition as an error.
- Skips quietly outside a Git checkout (tarball, Docker build context, installed dependency).

## The execute bit is checked in CI

Git skips a hook that is not executable and reports nothing, so a mode lost on the way into the
repository quietly disables the guard everywhere. [`scripts/check-hook-modes.sh`](../scripts/check-hook-modes.sh)
runs in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) and fails when a tracked file under
`.githooks` is not `100755` in the index — the index, because that is what a clone checks out, while
a local `chmod` in the working tree would hide the problem. It needs no runtime beyond git:

```bash
bash scripts/check-hook-modes.sh
```

The repair it prints is `git update-index --chmod=+x <file>`, which records the mode in the tree
without touching the file's content.

## CI is the backstop, not the first line

[`.github/workflows/attribution-guard.yml`](../.github/workflows/attribution-guard.yml) and the
secret-scan job enforce the same policy on every push and pull request, using the same
`.githooks/guard-lib` that the local hooks source. The local hooks exist so a bad commit never
becomes history in the first place.
