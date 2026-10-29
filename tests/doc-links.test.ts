import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findLinksIn, isExternal, normaliseTarget, unresolvedLinksIn } from '../scripts/doc-links.mjs'

// The check exists because a relative link that points at nothing still renders
// as a link: nothing fails, nothing warns, and the reader discovers it. The
// cases below are the shapes that decide whether the rule can be trusted —
// what it resolves, and what it must leave alone.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every path the fixture tree contains. */
function existsIn(paths: string[]) {
  return (path: string) => paths.includes(path)
}

describe('documentation links', () => {
  it('resolves a link relative to the file that holds it', () => {
    const findings = unresolvedLinksIn({
      path: 'docs/a.md',
      text: 'see [x](../scripts/a.mjs)',
      exists: existsIn(['scripts/a.mjs'])
    })
    expect(findings).toEqual([])
  })

  it('flags a link that points at nothing, with the line and the path it looked for', () => {
    const text = ['# title', '', 'see [gone](docs/missing.md)'].join('\n')
    const findings = unresolvedLinksIn({ path: 'README.md', text, exists: existsIn([]) })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.line).toBe(3)
    expect(findings[0]?.resolved).toBe('docs/missing.md')
  })

  it('resolves a leading slash from the repository root, not the document', () => {
    const findings = unresolvedLinksIn({
      path: 'docs/a.md',
      text: '[x](/docs/b.md)',
      exists: existsIn(['docs/b.md'])
    })
    expect(findings).toEqual([])
  })

  it('skips fenced code blocks, where a path is an example', () => {
    const text = ['```bash', 'see [x](not/a/file.md)', '```', 'and [y](docs/a.md)'].join('\n')
    expect(findLinksIn(text).map((link) => link.target)).toEqual(['docs/a.md'])
  })

  it('closes a fence only on the same character and at least the same length', () => {
    const text = ['~~~', '[x](in/tilde.md)', '```', '[y](still/fenced.md)', '~~~', '[z](docs/a.md)'].join(
      '\n'
    )
    expect(findLinksIn(text).map((link) => link.target)).toEqual(['docs/a.md'])
  })

  it('skips inline code, where a path is also an example', () => {
    expect(findLinksIn('`[x](not/a/file.md)` and [y](docs/a.md)').map((link) => link.target)).toEqual([
      'docs/a.md'
    ])
  })

  it('ignores anything with a scheme, and protocol-relative hosts', () => {
    for (const target of ['https://example.com/a', 'mailto:a@b.c', 'data:text/plain,x', '//cdn/a']) {
      expect(isExternal(target), target).toBe(true)
    }
    expect(isExternal('docs/a.md')).toBe(false)
  })

  it('does not treat a same-page anchor as a file', () => {
    expect(unresolvedLinksIn({ path: 'README.md', text: '[x](#keyboard)', exists: existsIn([]) })).toEqual([])
  })

  it('strips a fragment and a query before resolving, and decodes escapes', () => {
    expect(normaliseTarget('docs/a.md#L10')).toBe('docs/a.md')
    expect(normaliseTarget('docs/a.md?plain=1')).toBe('docs/a.md')
    expect(normaliseTarget('<docs/a b.md>')).toBe('docs/a b.md')
    expect(normaliseTarget('docs/a%20b.md')).toBe('docs/a b.md')
  })

  it('checks an image source as well as a link', () => {
    const findings = unresolvedLinksIn({
      path: 'README.md',
      text: '![shot](docs/missing.png)',
      exists: existsIn([])
    })
    expect(findings).toHaveLength(1)
  })

  it('finds nothing in the README and docs this repository ships', () => {
    const run = spawnSync(process.execPath, ['scripts/check-doc-links.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })
    expect(run.stderr, run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/doc links: ok \(\d+ link\(s\) in \d+ file\(s\)\)/)
  })

  it('fails the CLI on a tree that holds a broken link, naming only that one', () => {
    const tree = mkdtempSync(join(tmpdir(), 'doc-links-'))
    try {
      mkdirSync(join(tree, 'docs'))
      writeFileSync(
        join(tree, 'README.md'),
        ['# title', '', 'see [gone](docs/gone.md)', 'and [there](docs/there.md)'].join('\n')
      )
      writeFileSync(join(tree, 'docs', 'there.md'), '# there\n')

      const run = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'check-doc-links.mjs'), tree], {
        encoding: 'utf8'
      })

      expect(run.status).toBe(1)
      expect(run.stderr).toContain('::error file=README.md,line=3::')
      expect(run.stderr).toContain('docs/gone.md does not resolve')
      expect(run.stderr).not.toContain('docs/there.md does not resolve')
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })

  it('fails closed on a tree with no README', () => {
    const tree = mkdtempSync(join(tmpdir(), 'doc-links-empty-'))
    try {
      const run = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'check-doc-links.mjs'), tree], {
        encoding: 'utf8'
      })
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('no README.md')
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })
})
