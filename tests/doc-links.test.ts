import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  findLinksIn,
  headingAnchorsIn,
  isExternal,
  normaliseTarget,
  slugify,
  unresolvedLinksIn
} from '../scripts/doc-links.mjs'

// The check exists because a relative link that points at nothing still renders
// as a link, and a fragment into a renamed heading still lands on the right
// file — at the top of it. The cases below are the shapes that decide whether
// the rule can be trusted: what it resolves, what it leaves alone, and whether
// its slugs are the ones GitHub generates.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every path the fixture tree contains. */
function existsIn(paths: string[]) {
  return (path: string) => paths.includes(path)
}

/** Heading anchors for a fixed set of documents. */
function anchorsIn(documents: Record<string, string>) {
  return (path: string) => (path in documents ? headingAnchorsIn(documents[path] ?? '') : null)
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
    expect(findings[0]?.kind).toBe('path')
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
})

describe('heading anchors', () => {
  it('follows GitHub slugs for punctuation, parentheses and numbering', () => {
    expect(slugify('Packaging (Windows)')).toBe('packaging-windows')
    expect(slugify('Scry: deconstruct a site')).toBe('scry-deconstruct-a-site')
    expect(slugify('2.1 What is recorded')).toBe('21-what-is-recorded')
    expect(slugify('The core.hooksPath setting')).toBe('the-corehookspath-setting')
  })

  it('numbers duplicate headings the way GitHub does', () => {
    const text = ['## Notes', '## Notes', '## Notes'].join('\n')
    expect([...headingAnchorsIn(text)].sort()).toEqual(['notes', 'notes-1', 'notes-2'])
  })

  it('reads the rendered text of a heading, not its Markdown', () => {
    const text = ['## The `core.hooksPath` setting', '## Mail ([Relay](../README.md))'].join('\n')
    const anchors = headingAnchorsIn(text)
    expect(anchors.has('the-corehookspath-setting')).toBe(true)
    expect(anchors.has('mail-relay')).toBe(true)
  })

  it('does not treat a heading inside a fenced block as an anchor', () => {
    const text = ['```md', '## Not a heading', '```', '## Real'].join('\n')
    expect([...headingAnchorsIn(text)]).toEqual(['real'])
  })

  it('resolves a bare fragment against the document it appears in', () => {
    const text = ['## Keyboard', '', 'back to the [keys](#keyboard)'].join('\n')
    expect(unresolvedLinksIn({ path: 'README.md', text, exists: existsIn([]) })).toEqual([])
  })

  it('flags a bare fragment with no heading behind it', () => {
    const text = 'see [the keys](#keyboard)'
    const findings = unresolvedLinksIn({ path: 'README.md', text, exists: existsIn([]) })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('anchor')
    expect(findings[0]?.anchor).toBe('keyboard')
    expect(findings[0]?.resolved).toBe('README.md')
  })

  it('checks a cross-document fragment against that document', () => {
    const documents = { 'docs/a.md': '## Install it\n' }
    const ok = unresolvedLinksIn({
      path: 'README.md',
      text: '[x](docs/a.md#install-it)',
      exists: existsIn(['docs/a.md']),
      anchors: anchorsIn(documents)
    })
    expect(ok).toEqual([])

    const stale = unresolvedLinksIn({
      path: 'README.md',
      text: '[x](docs/a.md#install-it-now)',
      exists: existsIn(['docs/a.md']),
      anchors: anchorsIn(documents)
    })
    expect(stale).toHaveLength(1)
    expect(stale[0]?.kind).toBe('anchor')
    expect(stale[0]?.anchor).toBe('install-it-now')
    expect(stale[0]?.resolved).toBe('docs/a.md')
  })

  it('abstains when the target document cannot be read', () => {
    // A check that guesses is worse than one that says nothing: an unreadable
    // target must not be reported as broken.
    const findings = unresolvedLinksIn({
      path: 'README.md',
      text: '[x](docs/a.md#anything)',
      exists: existsIn(['docs/a.md']),
      anchors: () => null
    })
    expect(findings).toEqual([])
  })

  it('does not read a fragment on a source file as a heading', () => {
    // GitHub renders `file.ts#L42` as a line range, which no heading index has.
    const findings = unresolvedLinksIn({
      path: 'README.md',
      text: '[src](src/main/index.ts#L42)',
      exists: existsIn(['src/main/index.ts']),
      anchors: () => new Set()
    })
    expect(findings).toEqual([])
  })
})

describe('the check in CI', () => {
  it('finds nothing in the README and docs this repository ships', () => {
    const run = spawnSync(process.execPath, ['scripts/check-doc-links.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })
    expect(run.stderr, run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/doc links: ok \(\d+ link\(s\) in \d+ file\(s\)\)/)
  })

  it('fails on a broken link and a stale anchor, naming only those', () => {
    const tree = mkdtempSync(join(tmpdir(), 'doc-links-'))
    try {
      mkdirSync(join(tree, 'docs'))
      writeFileSync(
        join(tree, 'README.md'),
        [
          '# title',
          '',
          'see [gone](docs/gone.md)',
          'and [there](docs/there.md)',
          'and [anchor](docs/there.md#missing-section)',
          'and [fine](docs/there.md#a-heading)'
        ].join('\n')
      )
      writeFileSync(join(tree, 'docs', 'there.md'), '# A heading\n')

      const run = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'check-doc-links.mjs'), tree], {
        encoding: 'utf8'
      })

      expect(run.status).toBe(1)
      expect(run.stderr).toContain('::error file=README.md,line=3::')
      expect(run.stderr).toContain('docs/gone.md does not resolve')
      expect(run.stderr).toContain('::error file=README.md,line=5::')
      expect(run.stderr).toContain('#missing-section is not a heading in docs/there.md')
      expect(run.stderr).toContain('1 unresolvable path(s), 1 stale anchor(s)')
      expect(run.stderr).not.toContain('docs/there.md does not resolve')
      expect(run.stderr).not.toContain('#a-heading')
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
