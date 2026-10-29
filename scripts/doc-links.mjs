// ═══════════════════════════════════════════════════════════════════════════
// doc-links.mjs — the rule behind the documentation link check.
//
// A relative link that points at nothing costs nothing to write and is invisible
// until a reader clicks it: GitHub renders `[x](docs/gone.md)` as a link whether
// or not the file exists, so the manual rots quietly. The same is true of a
// fragment — `[x](other.md#a-section-that-was-renamed)` resolves to the right
// file and then lands the reader at the top of it. This finds both.
//
// What it deliberately does not judge:
//
//   anything with a scheme        http:, https:, mailto:, data:, warden:
//   protocol-relative //host      another site, not this tree
//   reference-style [id]: path    nothing here uses them; a link this cannot
//                                 see is worse than one it skips openly
//
// Fenced blocks and inline code spans are skipped: a path inside a code sample
// is an illustration, not a claim that the file exists.
//
// Anchors are checked only against Markdown targets. `file.ts#L42` is a line
// range in GitHub's viewer, not a heading, and no heading index would ever
// contain it.
//
// Slugs follow GitHub's own rules so the two agree: the rendered heading text
// is lowercased, punctuation is dropped (letters, marks, digits, `_` and `-`
// survive), spaces become hyphens, and a repeated heading gets `-1`, `-2`.
// Only ATX headings (`## Like this`) are indexed; this repository uses no
// setext headings, and a rule that guessed at `---` underlines would mistake a
// horizontal rule for a title.
// ═══════════════════════════════════════════════════════════════════════════

import { posix } from 'node:path'

/** `[text](target)` and `![alt](target)`, with an optional link title. */
const LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const INLINE_CODE = /`+[^`]*`+/g
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/
const CLOSING_HASHES = /\s+#+\s*$/
const NOT_IN_SLUG = /[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu
const HTML_TAG = /<[^>]*>/g
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g
const INLINE_LINK = /\[([^\]]*)\]\([^)]*\)/g
const EMPHASIS = /[*_~]/g

/**
 * Every link target in a Markdown document, with the line it sits on.
 *
 * `target` is the path the link names, without its fragment; `fragment` is the
 * decoded part after `#`, or '' when there is none.
 *
 * @param {string} source
 * @returns {{ line: number, target: string, raw: string, fragment: string }[]} 1-based line numbers
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
      found.push({
        line: index + 1,
        target: normaliseTarget(raw),
        raw,
        fragment: fragmentOf(raw)
      })
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
  let target = unangle(raw.trim())
  target = target.split('#')[0].split('?')[0]
  try {
    return decodeURI(target)
  } catch {
    // A `%` that is not an escape is not this check's problem.
    return target
  }
}

/**
 * The decoded fragment of a link target, or '' when it has none.
 *
 * @param {string} raw
 * @returns {string}
 */
export function fragmentOf(raw) {
  const target = unangle(raw.trim())
  const hash = target.indexOf('#')
  if (hash === -1) return ''
  const fragment = target.slice(hash + 1)
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
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
 * The anchor GitHub gives a heading, before duplicate numbering.
 *
 * @param {string} text Rendered heading text, with its Markdown removed.
 * @returns {string}
 */
export function slugify(text) {
  return text
    .replace(HTML_TAG, '')
    .replace(NOT_IN_SLUG, '')
    .trim()
    .replace(/ /g, '-')
    .toLowerCase()
}

/**
 * Every heading anchor a document offers, following GitHub's duplicate rule:
 * a repeated heading gets `-1`, then `-2`, and the first keeps the bare slug.
 *
 * Headings inside a fenced block are text, not headings, so they are skipped.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function headingAnchorsIn(source) {
  const seen = new Map()
  const anchors = new Set()
  const lines = source.split(/\r?\n/)
  let fence = null

  for (const line of lines) {
    const marker = FENCE.exec(line)
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker[1]
      continue
    }

    const heading = HEADING.exec(line)
    if (!heading) continue
    const slug = slugify(headingText(heading[1] ?? ''))
    if (slug === '') continue

    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    anchors.add(count === 0 ? slug : `${slug}-${count}`)
  }

  return anchors
}

/**
 * The links in one document that name a path which does not exist, or a
 * fragment that is not a heading in the document it points at.
 *
 * `exists` and `anchors` are injected so this stays pure: the tests hand it a
 * set of paths without a tree on disk, the CLI hands it the checkout. `anchors`
 * returning null means "not readable here", which is skipped rather than
 * reported — a check that guesses is worse than one that abstains.
 *
 * @param {{
 *   path: string,
 *   text: string,
 *   exists: (path: string) => boolean,
 *   anchors?: (path: string) => Set<string> | null
 * }} input
 * @returns {{
 *   path: string, line: number, kind: 'path' | 'anchor', target: string,
 *   raw: string, resolved: string, anchor: string
 * }[]}
 */
export function unresolvedLinksIn({ path, text, exists, anchors }) {
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const own = headingAnchorsIn(text)
  const findings = []

  for (const link of findLinksIn(text)) {
    const record = (kind, resolved, anchor) =>
      findings.push({ path, line: link.line, kind, target: link.target, raw: link.raw, resolved, anchor })

    // A bare fragment is a link into this document.
    if (link.target === '') {
      if (link.fragment !== '' && !own.has(link.fragment)) record('anchor', path, link.fragment)
      continue
    }
    if (isExternal(link.target)) continue

    // A leading slash is repository-absolute on GitHub, so it resolves from the
    // root rather than from the directory holding the document.
    const resolved = link.target.startsWith('/')
      ? posix.normalize(link.target.slice(1))
      : posix.normalize(directory ? posix.join(directory, link.target) : link.target)
    if (!exists(resolved)) {
      record('path', resolved, '')
      continue
    }
    if (link.fragment === '') continue
    // A fragment on a source file is a line range, not a heading.
    if (!resolved.toLowerCase().endsWith('.md')) continue

    const index = resolved === path ? own : (anchors ? anchors(resolved) : null)
    if (index === null) continue
    if (!index.has(link.fragment)) record('anchor', resolved, link.fragment)
  }

  return findings
}

/** Strip the `<…>` GitHub allows around a target that would otherwise be split. */
function unangle(target) {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target
}

/** The text a heading renders as, with its Markdown syntax removed. */
function headingText(text) {
  return text
    .replace(CLOSING_HASHES, '')
    .replace(IMAGE, '$1')
    .replace(INLINE_LINK, '$1')
    .replace(HTML_TAG, '')
    .replace(EMPHASIS, '')
    .replace(/`/g, '')
}
