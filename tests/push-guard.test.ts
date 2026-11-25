import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const script = path.resolve('scripts/check-push.mjs')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commit(cwd: string, message: string): string {
  writeFileSync(path.join(cwd, 'file.txt'), `${message}\n`)
  git(cwd, 'add', 'file.txt')
  git(cwd, 'commit', '-qm', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** A repository whose `main` is already on a scratch bare remote. */
function fixture(): string {
  const remote = mkdtempSync(path.join(tmpdir(), 'warden-push-remote-'))
  const repo = mkdtempSync(path.join(tmpdir(), 'warden-push-repo-'))
  git(remote, 'init', '--bare', '-q')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'dev')
  git(repo, 'remote', 'add', 'origin', remote)
  commit(repo, 'base')
  git(repo, 'push', '-q', 'origin', 'main')
  return repo
}

function check(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' })
}

describe('check-push', () => {
  it('passes when the remote ref is the local branch tip', () => {
    const repo = fixture()
    git(repo, 'checkout', '-qb', 'topic')
    commit(repo, 'topic work')
    git(repo, 'push', '-q', 'origin', 'topic')

    const result = check(repo, 'topic')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('matches topic')
  })

  it('fails when the remote ref is behind the local branch', () => {
    const repo = fixture()
    git(repo, 'checkout', '-qb', 'topic')
    commit(repo, 'topic work')
    git(repo, 'push', '-q', 'origin', 'topic')
    const local = commit(repo, 'unpushed work')

    const result = check(repo, 'topic')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`expected ${local.slice(0, 7)}`)
  })

  it('fails when HEAD is a different branch, which is how the wrong commit gets pushed', () => {
    const repo = fixture()
    git(repo, 'checkout', '-qb', 'topic')
    commit(repo, 'topic work')
    git(repo, 'push', '-q', 'origin', 'topic')
    git(repo, 'checkout', '-q', 'main')

    const result = check(repo, 'topic')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('a push sends HEAD')
  })

  it('fails when the remote has no ref with that name', () => {
    const repo = fixture()
    git(repo, 'checkout', '-qb', 'topic')
    commit(repo, 'topic work')

    const result = check(repo, 'topic')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('has no refs/heads/topic')
  })
})
