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

## The manual's links and anchors are checked

A relative link that points at nothing still renders as a link, so a broken one is invisible until
someone clicks it. A stale fragment is quieter still: `[x](docs/gone.md#renamed-away)` opens a real
file and lands the reader at the top of it, with nothing failing anywhere.
[`scripts/doc-links.mjs`](../scripts/doc-links.mjs) is the rule and
[`scripts/check-doc-links.mjs`](../scripts/check-doc-links.mjs) is the CLI; the `Documentation links`
step in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs it on every push, and locally:

```bash
npm run check:docs      # exits 0, or names every broken link by file and line
```

The scope is `README.md` and every `*.md` under `docs/`, so a new document there is covered without
being registered anywhere. Both kinds of rot are reported, and the two are counted separately:

```text
::error file=README.md,line=62::#land-by-hand is not a heading in README.md
::error file=docs/stack.md,line=8::#blob-hash-gate is not a heading in docs/repo-hooks.md
doc links: 0 unresolvable path(s), 2 stale anchor(s) — a reader finds these by clicking
```

### Why renaming a heading breaks the build

An anchor is not stored in the repository — it is derived from the heading's text when GitHub renders
the page. Renaming `## Land by hand` to `## Landing by hand` rewrites the URL from `#land-by-hand` to
`#landing-by-hand`, and every link that used the old one now lands the reader at the top of the page.
Nothing reports it: not the browser, not the renderer, not the push. This check is the only place the
two names meet, which is why a heading is not free to reword.

Slugs follow GitHub's rules, so the checker and the site agree on what a heading is called:

| Heading in the source                      | The anchor a link must use                  |
| ------------------------------------------ | ------------------------------------------- |
| `## The execute bit is checked in CI`      | `#the-execute-bit-is-checked-in-ci`         |
| `### The blob-hash gate`                   | `#the-blob-hash-gate`                       |
| `## Notes (2026)`                          | `#notes-2026`                               |
| `` ## `core.hooksPath` and clones ``       | `#corehookspath-and-clones`                 |
| `## Mail, and **what** it refuses`         | `#mail-and-what-it-refuses`                 |
| `## Landing a file the write path refuses` | `#landing-a-file-the-write-path-refuses`    |

The rules behind those rows: the *rendered* text is used, so backticks, `**emphasis**`, HTML and a
link's own target are gone before the slug is taken; punctuation is dropped while letters, marks,
digits, `_` and `-` survive; spaces become hyphens; and the result is lowercased. A heading that
repeats gets `-1`, then `-2`, with the first occurrence keeping the bare slug.

Because the anchor is derived from the text, there is no alias to leave behind. Keeping an old link
working means keeping the old wording, or updating every link that points at it. Adding a second
heading with the old wording is not a repair: the first heading with that wording keeps the bare
slug, so a dead link starts passing while landing the reader somewhere you did not mean.

### What the anchor check abstains on

- **A fragment on a non-Markdown target.** `../src/main/index.ts#L42` is a line range in GitHub's
  viewer, not a heading, so no heading index would ever contain it.
- **Setext headings**, the kind underlined with `---`. This repository uses none, and a rule that
  guessed would read a horizontal rule as a title.
- **Reference-style links**, anything with a scheme, and protocol-relative `//host` targets.
- **Fenced blocks and inline code.** A path in a code sample is an illustration, not a claim that the
  file exists.
- **A target it cannot read.** No index is returned and the link is skipped rather than reported: a
  check that guesses is worse than one that abstains.

Matching is exact, case included. `#Known-Limits` fails even though the heading exists, because
browsers match ids case-sensitively too — that link is dead for the reader as well, which is the
whole point of using the same rule GitHub does rather than a looser one.

The repair is always the same: change the link, then run `npm run check:docs`. If you deliberately
renamed the heading, the failure names each document and line that still points at the old name.

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
2. Let the job commit **only the file it was dispatched to change**, then delete the workflow
   separately, from outside the job. A push made with the job's own token cannot add, change or
   delete anything under `.github/workflows`: GitHub answers `refusing to allow a GitHub App to
   create or update workflow ... without workflows permission` and refuses the entire push, so the
   file edit is lost with it. An earlier attempt at this recipe had the job remove itself in the
   same commit for a tidier history and landed nothing. Dispatch, verify the commit, then remove
   the workflow as an ordinary commit through the normal write path. History keeps an
   add/edit/remove triple; the tree ends with only the intended change.
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
