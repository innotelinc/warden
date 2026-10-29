import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Exercises what the unit tests in hook-mode-plan.test.ts cannot: the real
// `git config`, the real `update-index`, and the hooks themselves running on a
// commit. Every case builds a throwaway repository in the OS temp directory, so
// nothing touches the checkout this suite runs in.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const posix = process.platform !== 'win32'

let dir = ''

interface RunOptions {
  cwd?: string
  input?: string
  env?: Record<string, string>
}

function run(command: string, args: string[], options: RunOptions = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? dir,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, ...options.env },
    timeout: 20000
  })
}

function git(args: string[], options: RunOptions = {}): string {
  const result = run('git', args, options)
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return (result.stdout ?? '').trim()
}

/** A temp repo holding the real hooks and scripts, committed as they are. */
function makeRepo(): string {
  const created = mkdtempSync(join(tmpdir(), 'warden-hooks-'))
  cpSync(join(repoRoot, '.githooks'), join(created, '.githooks'), { recursive: true })
  cpSync(join(repoRoot, 'scripts'), join(created, 'scripts'), { recursive: true })
  const identity = ['-c', 'user.email=t@example.com', '-c', 'user.name=T']
  git(['init', '-q'], { cwd: created })
  git([...identity, 'add', '.'], { cwd: created })
  git([...identity, 'commit', '-q', '-m', 'seed'], { cwd: created })
  return created
}

function install(options: RunOptions = {}) {
  return run(process.execPath, [join(dir, 'scripts', 'install-hooks.mjs')], options)
}

/** Does the scanner exist here? The secret gate fails open without it. */
function hasPython(): boolean {
  return run('python3', ['--version'], { cwd: repoRoot }).status === 0
}

/** Commit through the installed hooks, so a failure means a hook refused. */
function commit(message: string) {
  return run(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '--allow-empty', '-F', '-'],
    { input: message }
  )
}

function hooksPath(where = dir): string | null {
  const result = run('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: where })
  return result.status === 0 ? (result.stdout ?? '').trim() : null
}

/** The mode git has recorded for a path, as a clone would check it out. */
function recordedMode(path: string): string {
  return git(['ls-files', '--stage', '--', path]).split(/\s+/)[0] ?? ''
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  dir = ''
})

describe('install-hooks against a throwaway repository', () => {
  it('enables the hooks and keeps the tree clean when the record is correct', () => {
    dir = makeRepo()
    // The archive case: git records 100755, the checkout lost the bit.
    if (posix) chmodSync(join(dir, '.githooks', 'commit-msg'), 0o644)

    const result = install()
    expect(result.status).toBe(0)
    expect(hooksPath()).toBe('.githooks')

    if (posix) {
      expect(statSync(join(dir, '.githooks', 'commit-msg')).mode & 0o111).toBe(0o111)
      expect(git(['status', '--porcelain'])).toBe('')
    }
  })

  it('stages the repair when the repository records the hook as a plain file', () => {
    if (!posix) return // windows has no execute bit to record
    dir = makeRepo()
    const identity = ['-c', 'user.email=t@example.com', '-c', 'user.name=T']
    git(['update-index', '--chmod=-x', '.githooks/commit-msg'])
    git([...identity, 'commit', '-q', '-m', 'record it plain'])
    chmodSync(join(dir, '.githooks', 'commit-msg'), 0o644)
    expect(recordedMode('.githooks/commit-msg')).toBe('100644')

    const result = install()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('the fix is staged')
    expect(recordedMode('.githooks/commit-msg')).toBe('100755')

    // Staged, not dangling: the change sits in the index and the working tree
    // has nothing extra for `git status` to report.
    const lines = git(['status', '--porcelain']).split('\n')
    const line = lines.find((entry) => entry.includes('.githooks/commit-msg'))
    expect(line?.slice(0, 2)).toBe('M ')
  })

  it('leaves a different core.hooksPath alone', () => {
    dir = makeRepo()
    git(['config', '--local', 'core.hooksPath', '.husky'])

    const result = install()
    expect(result.status).toBe(0)
    expect(hooksPath()).toBe('.husky')
    expect(result.stderr).toContain('core.hooksPath is set to ".husky"')
  })

  it('honours WARDEN_SKIP_HOOKS', () => {
    dir = makeRepo()
    const result = install({ env: { WARDEN_SKIP_HOOKS: '1' } })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('skipped')
    expect(hooksPath()).toBeNull()
  })

  it('skips a directory that is not a git checkout', () => {
    const plain = mkdtempSync(join(tmpdir(), 'warden-nogit-'))
    try {
      cpSync(join(repoRoot, 'scripts'), join(plain, 'scripts'), { recursive: true })
      const result = run(process.execPath, [join(plain, 'scripts', 'install-hooks.mjs')], { cwd: plain })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('not a git checkout')
    } finally {
      rmSync(plain, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('installs hooks that actually block a foreign credit trailer', () => {
    if (!posix) return // the hooks are bash; git for windows is a different surface
    dir = makeRepo()
    expect(install().status).toBe(0)

    const blocked = commit('probe\n\nCo-Authored-By: Nope <n@example.com>\n')
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('guard:')

    const allowed = commit('probe: a clean subject\n')
    expect(allowed.status).toBe(0)
  })

  it('installs a secret gate that blocks a credential-shaped line', () => {
    if (!posix) return // the hooks are bash; git for windows is a different surface
    if (!hasPython()) return // the gate warns and skips when the scanner is absent
    dir = makeRepo()
    expect(install().status).toBe(0)

    // Deliberately not under tests/: the scanner relaxes the literal rule there,
    // and this has to exercise the same path a real commit takes.
    const config = join(dir, 'operator.conf')
    const seed = git(['rev-parse', 'HEAD'])

    // Assembled at run time rather than written out in full: the scanner does
    // not exempt tests from its shape rules, so the literal here would block
    // this very commit. That is the gate working -- the fix belongs in the
    // fixture, not in a weaker rule.
    const providerKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')

    writeFileSync(config, `AWS_ACCESS_KEY=${providerKey}\n`)
    git(['add', 'operator.conf'])

    const shaped = commit('probe: stage a provider key\n')
    expect(shaped.status).not.toBe(0)
    expect(shaped.stderr).toContain('secret-scan')
    expect(shaped.stderr).toContain('aws-access-key')
    // The finding is reported as a rule and a masked value, never the secret.
    expect(shaped.stderr).not.toContain(providerKey)
    // And nothing landed: the gate runs before the commit is written.
    expect(git(['rev-parse', 'HEAD'])).toBe(seed)

    // The other half of the scanner, through the same plumbing: a literal
    // assigned to a sensitive name, which no shape rule would catch.
    writeFileSync(config, 'ADMIN_PASS = "hunter2hunter2"\n')
    git(['add', 'operator.conf'])

    const assigned = commit('probe: stage a literal secret\n')
    expect(assigned.status).not.toBe(0)
    expect(assigned.stderr).toContain('literal-secret')
    expect(assigned.stderr).toContain('ADMIN_PASS')
    expect(git(['rev-parse', 'HEAD'])).toBe(seed)

    // Remove the credential and the same commit goes through, so the gate is
    // blocking the finding rather than committing in general.
    rmSync(config)
    git(['add', '-A'])

    const clean = commit('probe: config without credentials\n')
    expect(clean.status).toBe(0)
    expect(git(['rev-parse', 'HEAD'])).not.toBe(seed)
  })

  it('blocks attribution added to a staged file, not just the message', () => {
    if (!posix) return // the hooks are bash; git for windows is a different surface
    dir = makeRepo()
    expect(install().status).toBe(0)

    // The message stays clean throughout, so any refusal can only come from the
    // staged diff -- the half commit-msg cannot see. That is what pre-commit is
    // for: a credit line reaching a README or a source comment.
    const notes = join(dir, 'notes.md')
    const seed = git(['rev-parse', 'HEAD'])
    // Composed for the same reason as the provider key above: the guard scans
    // added lines, so the literal here would block this very commit.
    const trailer = ['Co-Authored-By', 'Someone Else <else@example.com>'].join(': ')

    writeFileSync(notes, `# Notes\n\nSee the operator runbook.\n${trailer}\n`)
    git(['add', 'notes.md'])

    const blocked = commit('probe: document the runbook\n')
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('commit blocked')
    // The trailer rule names what it found: a credit line in the diff.
    expect(blocked.stderr).toContain('bad trailer')
    // Nothing landed: the guard runs before the commit object is written.
    expect(git(['rev-parse', 'HEAD'])).toBe(seed)

    // Same file, same message, no attribution line -- the commit goes through.
    writeFileSync(notes, '# Notes\n\nSee the operator runbook.\n')
    git(['add', 'notes.md'])

    const clean = commit('probe: document the runbook\n')
    expect(clean.status).toBe(0)
    expect(git(['rev-parse', 'HEAD'])).not.toBe(seed)
  })
})
