#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// check-doc-links.mjs — fail when a relative link in the manual points at
// nothing, or at a heading the target document no longer has.
//
//   node scripts/check-doc-links.mjs           # this repository
//   node scripts/check-doc-links.mjs <dir>     # a tree, for the tests
//
// The scope is README.md and every `*.md` under docs/, which is what a reader
// navigates by hand. Other documents in the tree are left alone: the landing
// page and the mobile notes have their own jobs.
//
// Anchors are indexed from the same documents, once each, because two links
// pointing into one file should not read it twice. A target that is not
// Markdown is not indexed at all: `file.ts#L42` is a line range in the viewer,
// not a heading.
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
import { findLinksIn, headingAnchorsIn, unresolvedLinksIn } from './doc-links.mjs'

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

/** Heading anchors per document, read once and remembered. */
const headingCache = new Map()
const anchorsOf = (path) => {
  if (!path.toLowerCase().endsWith('.md') || !exists(path)) return null
  let anchors = headingCache.get(path)
  if (anchors === undefined) {
    anchors = headingAnchorsIn(readFileSync(join(root, path), 'utf8'))
    headingCache.set(path, anchors)
  }
  return anchors
}

let links = 0
let files = 0
const findings = []

for (const path of paths) {
  if (!exists(path)) continue
  files += 1
  const text = readFileSync(join(root, path), 'utf8')
  links += findLinksIn(text).length
  findings.push(...unresolvedLinksIn({ path, text, exists, anchors: anchorsOf }))
}

for (const finding of findings) {
  const detail =
    finding.kind === 'anchor'
      ? `#${finding.anchor} is not a heading in ${finding.resolved}`
      : `${finding.target} does not resolve (looked for ${finding.resolved})`
  // An annotation, so the failure points at the line in the diff view.
  console.error(`::error file=${finding.path},line=${finding.line}::${detail}`)
  console.error(`  ${finding.path}:${finding.line}  ${finding.raw}`)
}

if (findings.length > 0) {
  const broken = findings.filter((finding) => finding.kind === 'path').length
  const stale = findings.length - broken
  console.error(
    `\ndoc links: ${broken} unresolvable path(s), ${stale} stale anchor(s) — a reader finds these by clicking`
  )
  process.exit(1)
}

console.log(`doc links: ok (${links} link(s) in ${files} file(s))`)
