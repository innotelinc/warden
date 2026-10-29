import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findDoubledEscapes, findDoubledEscapesIn } from '../scripts/workflow-grep-patterns.mjs'

// The rule exists because the mistake it catches ran green: a workflow step
// whose grep pattern was escaped twice still exits 0, just never for the reason
// it was written. Fixtures are built from a backslash constant for the same
// reason the rule is — a test that has to escape the thing it tests can pass by
// having escaped it the same wrong way.
const BACKSLASH = String.fromCharCode(92)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflows = join(repoRoot, '.github', 'workflows')

const DOUBLED = `          grep -q '^${BACKSLASH}${BACKSLASH}.env' .gitignore || exit 1`
const SINGLE = `          grep -q '^${BACKSLASH}.env' .gitignore || exit 1`

/** The same set the `bash -n` job checks: tracked shell scripts and hooks. */
function trackedShell(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', '*.sh', '.githooks/*'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  return [...new Set(listed.split('\0').filter(Boolean))].sort()
}

describe('workflow grep patterns', () => {
  it('flags a dot escaped one time too many', () => {
    const findings = findDoubledEscapes(DOUBLED)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(1)
  })

  it('allows the single escape that a literal dot needs', () => {
    expect(findDoubledEscapes(SINGLE)).toEqual([])
  })

  it('flags a doubled escape in the middle of a pattern, not just after a caret', () => {
    const middles = `          grep -q 'api${BACKSLASH}${BACKSLASH}.github${BACKSLASH}${BACKSLASH}.com' "$f" || exit 1`
    expect(findDoubledEscapes(middles)).toHaveLength(1)
  })

  it('ignores lines that do not run grep', () => {
    // A `node -e '…'` body may hold a JS string whose own escapes are correct.
    const notAGrep = `          node -e 'const r = "^${BACKSLASH}${BACKSLASH}d+$"'`
    expect(findDoubledEscapes(notAGrep)).toEqual([])
  })

  it('does not flag a double-quoted pattern, where the shell removes one backslash', () => {
    const doubleQuoted = `          grep -q "^${BACKSLASH}${BACKSLASH}." .gitignore`
    expect(findDoubledEscapes(doubleQuoted)).toEqual([])
  })

  it('reports the line number, not just the file', () => {
    const text = ['name: ci', 'on: push', DOUBLED, SINGLE].join('\n')
    const findings = findDoubledEscapes(text)
    expect(findings.map((finding) => finding.line)).toEqual([3])
  })

  it('finds nothing in the workflows this repository actually ships', () => {
    const offenders: string[] = []
    for (const name of readdirSync(workflows).sort()) {
      if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue
      const text = readFileSync(join(workflows, name), 'utf8')
      for (const { line, pattern } of findDoubledEscapes(text)) {
        offenders.push(`${name}:${line} ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('reports which file a finding came from', () => {
    // The shell and hook files are scanned through this path, so the finding
    // has to carry the path; a line number alone is useless across a tree.
    const findings = findDoubledEscapesIn([
      { path: 'scripts/example.sh', text: DOUBLED },
      { path: '.githooks/pre-commit', text: SINGLE }
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.path).toBe('scripts/example.sh')
    expect(findings[0]?.line).toBe(1)
  })

  it('finds nothing in the shell scripts and hooks this repository ships', () => {
    // A hook pattern escaped twice never fires, so this is the scan that keeps
    // the attribution guard and the secret scan honest about their own rules.
    const offenders: string[] = []
    const files = trackedShell()
    expect(files.length).toBeGreaterThan(0)
    for (const path of files) {
      const text = readFileSync(join(repoRoot, path), 'utf8')
      for (const { line, pattern } of findDoubledEscapes(text)) {
        offenders.push(`${path}:${line} ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has the CLI scan shell files, not just the workflows', () => {
    // The rule being right is no use if the CLI never hands it a script: the
    // old version walked .github/workflows only and would have reported "ok"
    // for a hook it had not opened.
    const run = spawnSync(process.execPath, ['scripts/check-workflow-patterns.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })
    expect(run.status).toBe(0)
    const report = run.stdout.trim()
    const counts = /ok \((\d+) workflow\(s\), (\d+) shell script\(s\)\)/.exec(report)
    expect(counts, report).not.toBeNull()
    expect(Number(counts?.[1])).toBeGreaterThan(0)
    expect(Number(counts?.[2])).toBeGreaterThan(0)
  })
})
