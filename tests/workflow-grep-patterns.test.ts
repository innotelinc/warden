import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findDoubledEscapes } from '../scripts/workflow-grep-patterns.mjs'

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
})
