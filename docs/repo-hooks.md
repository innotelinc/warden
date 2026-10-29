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
- Never touches global Git config, and never replaces a `core.hooksPath` someone deliberately
  pointed at a different directory; it says so and stops instead.
- Warns rather than failing an install when a hook file is missing. The strict form (`npm run
  hooks`) treats the same condition as an error.
- Skips quietly outside a Git checkout (tarball, Docker build context, installed dependency).

## CI is the backstop, not the first line

[`.github/workflows/attribution-guard.yml`](../.github/workflows/attribution-guard.yml) and the
secret-scan job enforce the same policy on every push and pull request, using the same
`.githooks/guard-lib` that the local hooks source. The local hooks exist so a bad commit never
becomes history in the first place.
