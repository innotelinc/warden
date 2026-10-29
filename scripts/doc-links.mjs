// ═══════════════════════════════════════════════════════════════════════════
// doc-links.mjs — the rule behind the documentation link check.
//
// A relative link that points at nothing costs nothing to write and is invisible
// until a reader clicks it: GitHub renders `[x](docs/gone.md)` as a link whether
// or not the file exists, so the manual rots quietly. This finds those targets.
//
// What it deliberately does not judge:
//
//   anything with a scheme        http:, https:, mailto:, data:, warden:
//   protocol-relative //host      another site, not this tree
//   a bare fragment #section      an anchor is not a file, and GitHub's slug
//                                 rules are not worth reimplementing to approve
//                                 or reject them
//   reference-style [id]: path    nothing here uses them; a link this cannot
//                                 see is worse than one it skips openly
//
// Fenced blocks and inline code spans are skipped: a path inside a code sample
// is an illustration, not a claim that the file exists.
//
// Targets are read as paths, so a fragment or query is stripped before resolving
// and percent-escapes are decoded — `docs/a%20b.md` names the file with a space.
// ═══════════════════════════════════════════════════════════════════════════

import { posix } from 'node:path'

/** `[text](target)` and `![alt](target)`, with an optional link title. */
const LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const INLINE_CODE = /`+[^`]*`+/g
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * Every link target in a Markdown document, with the line it sits on.
 *
 * @param {string} source
 * @returns {{ line: number, target: string, raw: string }[]} 1-based line numbers
 */
export function findLinksIn(source) {
  const found = []
  const lines = source.split(/\r?\n/)
  let fence = null

  lines.forEach((line, index) => {
    const marker = FENCE.exec(line)
    if (fence !== null) {
      // Only a fence at least as long, of the same character, closes one.
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      return
    }
    if (marker) {
      fence = marker[1]
      return
    }

    LINK.lastIndex = 0
    const prose = line.replace(INLINE_CODE, '')
    for (const match of prose.matchAll(LINK)) {
      const raw = match[1] ?? ''
      found.push({ line: index + 1, target: normaliseTarget(raw), raw })
    }
  })

  return found
}

/**
 * Reduce a link target to the path it names.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normaliseTarget(raw) {
  let target = raw.trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  target = target.split('#')[0].split('?')[0]
  try {
    return decodeURI(target)
  } catch {
    // A `%` that is not an escape is not this check's problem.
    return target
  }
}

/**
 * Whether a target points outside this tree, and so cannot be resolved here.
 *
 * @param {string} target
 * @returns {boolean}
 */
export function isExternal(target) {
  return target === '' || target.startsWith('//') || SCHEME.test(target)
}

/**
 * The links in one document that name a path which does not exist.
 *
 * `exists` is injected so this stays pure: the tests hand it a set of paths
 * without a tree on disk, the CLI hands it the checkout.
 *
 * @param {{ path: string, text: string, exists: (path: string) => boolean }} input
 * @returns {{ path: string, line: number, target: string, raw: string, resolved: string }[]}
 */
export function unresolvedLinksIn({ path, text, exists }) {
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const findings = []

  for (const link of findLinksIn(text)) {
    if (isExternal(link.target)) continue
    // A leading slash is repository-absolute on GitHub, so it resolves from the
    // root rather than from the directory holding the document.
    const resolved = link.target.startsWith('/')
      ? posix.normalize(link.target.slice(1))
      : posix.normalize(directory ? posix.join(directory, link.target) : link.target)
    if (exists(resolved)) continue
    findings.push({ path, line: link.line, target: link.target, raw: link.raw, resolved })
  }

  return findings
}
