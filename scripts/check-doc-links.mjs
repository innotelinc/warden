#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// check-doc-links.mjs — fail when a relative link in the manual points at
// nothing.
//
//   node scripts/check-doc-links.mjs           # this repository
//   node scripts/check-doc-links.mjs <dir>     # a tree, for the tests
//
// The scope is README.md and every `*.md` under docs/, which is what a reader
// navigates by hand. Other documents in the tree are left alone: the landing
// page and the mobile notes have their own jobs.
//
// Paths come from the working tree rather than the index, because a link is
// followed in a checkout. A file that is in the index but absent from the
// worktree is skipped, so staging a deletion does not turn this red.
//
// Exits 1 with a GitHub annotation per finding, 0 when every link resolves.
// The reasoning, and what is deliberately left unchecked, is in doc-links.mjs.
// ═══════════════════════════════════════════════════════════════════════════
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findLinksIn, unresolvedLinksIn } from './doc-links.mjs'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = process.argv[2] ? resolve(process.argv[2]) : defaultRoot

/** README.md plus every Markdown file under docs/, as repository-relative paths. */
function markdownPaths() {
  if (!existsSync(join(root, 'README.md'))) {
    // Failing closed: a tree with no README would otherwise report "ok" for the
    // document this check exists to protect.
    console.error(`::error::no README.md under ${root}`)
    process.exit(1)
  }

  const paths = ['README.md']
  const docs = join(root, 'docs')

  if (existsSync(docs)) {
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.md')) paths.push(relative(root, full).split('\\').join('/'))
      }
    }
    walk(docs)
  }

  return [...new Set(paths)].sort()
}

const paths = markdownPaths()
const exists = (path) => existsSync(join(root, path))

let links = 0
let files = 0
const findings = []

for (const path of paths) {
  if (!exists(path)) continue
  files += 1
  const text = readFileSync(join(root, path), 'utf8')
  links += findLinksIn(text).length
  findings.push(...unresolvedLinksIn({ path, text, exists }))
}

for (const finding of findings) {
  // An annotation, so the failure points at the line in the diff view.
  console.error(
    `::error file=${finding.path},line=${finding.line}::${finding.target} does not resolve (looked for ${finding.resolved})`
  )
  console.error(`  ${finding.path}:${finding.line}  ${finding.target}`)
}

if (findings.length > 0) {
  console.error(`\ndoc links: ${findings.length} unresolvable link(s) — a reader finds these by clicking`)
  process.exit(1)
}

console.log(`doc links: ok (${links} link(s) in ${files} file(s))`)
