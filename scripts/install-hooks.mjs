#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// install-hooks.mjs — point this clone at the repo's committed git hooks.
//
// Runs automatically from `npm install` / `npm ci` via package.json's
// "prepare" script, so a fresh clone gets the attribution guard and the
// secret scan without anyone remembering a setup step. It writes exactly one
// setting, the clone-local `core.hooksPath`, and never touches the hooks
// themselves, the global config, or any other repository.
//
//   npm run hooks      enable them now (strict: exits 1 if that fails)
//   prepare            soft: warns and continues, so an install never dies
//                      because of a hook problem
//   WARDEN_SKIP_HOOKS=1 npm install    opt out for one install
// ═══════════════════════════════════════════════════════════════════════════
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS_DIR = '.githooks'
// guard-lib is sourced by both hooks, so a checkout missing it would install
// hooks that abort every commit.
const REQUIRED = ['commit-msg', 'pre-commit', 'secret-scan.sh', 'guard-lib']
const EXECUTABLE = ['commit-msg', 'pre-commit', 'secret-scan.sh']

const strict = process.argv.includes('--strict')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hooksPath = join(root, HOOKS_DIR)

const say = (message) => console.log(`hooks: ${message}`)
const warn = (message) => console.error(`hooks: ${message}`)

/** Give up without failing the install unless the caller asked for strict. */
function stop(message, code = 0) {
  warn(message)
  process.exit(strict ? 1 : code)
}

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function gitOrNull(args) {
  try {
    return git(args).trim()
  } catch {
    return null
  }
}

if (process.env.WARDEN_SKIP_HOOKS) {
  say('skipped (WARDEN_SKIP_HOOKS is set)')
  process.exit(0)
}

// A tarball, a Docker build context or an installed dependency has no hooks to
// install; that is not a problem worth printing a warning about.
if (gitOrNull(['rev-parse', '--is-inside-work-tree']) !== 'true') {
  say('not a git checkout — no hooks to install')
  process.exit(0)
}

const missing = REQUIRED.filter((name) => !existsSync(join(hooksPath, name)))
if (missing.length > 0) {
  stop(`warning: ${HOOKS_DIR}/ is incomplete (missing ${missing.join(', ')}) — guard not enabled`)
}

/**
 * The mode git has recorded for a path — what a clone checks out — or null when
 * the path is not tracked.
 */
function recordedMode(relative) {
  const staged = gitOrNull(['ls-files', '--stage', '--', relative])
  if (!staged) return null
  return staged.split(/\s+/)[0] ?? null
}

// Git refuses to run a hook that is not executable on POSIX. Windows ignores
// the bit entirely, so there is nothing to do there.
//
// The repair also has to leave `git status` alone. Restoring a bit the
// repository records as 100755 makes the working tree match HEAD, which is
// clean. Restoring one the repository records as 100644 would put a mode
// change in every status report from then on, so that fix is staged instead —
// one deliberate commit, and the file stops reading as modified for good.
const stagedFixes = []
if (process.platform !== 'win32') {
  for (const name of EXECUTABLE) {
    const relative = `${HOOKS_DIR}/${name}`
    const file = join(hooksPath, name)
    try {
      if ((statSync(file).mode & 0o111) !== 0o111) chmodSync(file, 0o755)
    } catch (error) {
      stop(`warning: could not make ${relative} executable — ${error.message}`)
    }
    if (recordedMode(relative) !== '100644') continue
    try {
      git(['update-index', '--chmod=+x', relative])
      stagedFixes.push(relative)
    } catch (error) {
      stop(`warning: could not stage the mode fix for ${relative} — ${error.message}`)
    }
  }
}
if (stagedFixes.length > 0) {
  warn(`the repository records ${stagedFixes.join(', ')} as non-executable; the fix is staged —`)
  warn('  commit it with: git commit -m "Keep the repo hooks executable"')
}

const current = gitOrNull(['config', '--local', '--get', 'core.hooksPath'])
if (current === HOOKS_DIR || current === hooksPath) {
  say('attribution guard and secret scan already enabled for this clone')
  process.exit(0)
}
if (current) {
  // Someone chose a different hook directory on purpose (a shared hook set,
  // for instance). Do not fight them — say what the repo expects and stop.
  stop(
    `core.hooksPath is set to "${current}" here, so the repo hooks are not in use.\n` +
      `hooks: to use them instead: git config --local core.hooksPath ${HOOKS_DIR}`
  )
}

try {
  git(['config', '--local', 'core.hooksPath', HOOKS_DIR])
} catch (error) {
  stop(`warning: could not set core.hooksPath — ${error.message}`)
}

const applied = gitOrNull(['config', '--local', '--get', 'core.hooksPath'])
if (applied !== HOOKS_DIR) {
  stop('warning: core.hooksPath did not stick — run: npm run hooks')
}

say('attribution guard and secret scan enabled for this clone')
