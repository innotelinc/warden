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

## Landing a file the write path refuses

Most edits to this repository go in through the GitHub contents API, which is fine until the file
is large: a 55 KB `README.md` came back `403`, while a 9 KB commit to the same branch a minute
earlier succeeded. That is a cap on the request body, not a permission problem, and the file still
has to change — the only way to do that without sending its bytes is to let a runner change it.

**`workflow_dispatch` resolves the workflow from the default branch.** A throwaway workflow
committed to a side branch cannot be dispatched at all; the API answers `Workflow '<file>' not
found in repository` no matter how long you wait. The workflow has to land on `main` first.

The recipe, in the order that avoids a half-applied edit:

1. Commit a `workflow_dispatch`-only workflow to `main` that edits the file, commits and pushes.
   It is a few kilobytes, so it goes through the normal write path.
2. Have the job **delete itself in the same commit** as the file change, so the tree ends with only
   the intended edit. History keeps an add/remove pair; the tree does not.
3. Rehearse before dispatching: extract the workflow's own `run:` text and execute it against a
   scratch bare remote seeded from `main`. A block scalar whose content sits at column 0 makes the
   whole YAML invalid, and `yaml.safe_load` plus a dry run catch that in seconds rather than after
   a failed run.

### The blob-hash gate

A workflow that says it ran proves nothing about the bytes it wrote. Pass the hash of the file you
tested and make the job refuse to commit anything else:

```bash
EXPECTED_BLOB=$(git hash-object README.md)                 # the file as verified locally
git show origin/main:README.md | git hash-object --stdin    # what actually landed
```

Inside the job, hash the file after the edit and compare it with the expected value; on a mismatch,
`git checkout -- <file>` and exit non-zero. A reflowed paragraph, a lost em dash or a stray space
then fails closed instead of publishing as a small rendering bug. Check the landed result the same
way afterwards — matching hashes are what make a server-side edit reviewable at all.

Use this only when the direct write is refused. For anything that fits, the normal commit path is
shorter and leaves no scaffolding behind.

## CI is the backstop, not the first line

[`.github/workflows/attribution-guard.yml`](../.github/workflows/attribution-guard.yml) and the
secret-scan job enforce the same policy on every push and pull request, using the same
`.githooks/guard-lib` that the local hooks source. The local hooks exist so a bad commit never
becomes history in the first place.
