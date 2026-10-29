// ═══════════════════════════════════════════════════════════════════════════
// workflow-grep-patterns.mjs — the rule behind the workflow lint check.
//
// A grep pattern whose dot is escaped one time too many still runs, and still
// exits 0: the two backslashes leave one literal backslash for grep, so the
// pattern matches a backslash followed by any character instead of the text it
// meant. The step then passes for the wrong reason. Exactly that reached this
// repository's landing checks, written through an API that needed the backslash
// escaped twice and kept both copies.
//
// The rule is one shape rather than "every double backslash": a doubled
// backslash is correct when the pattern really does need a literal one, as a
// Windows path does. A doubled backslash immediately before a dot never is — a
// literal dot needs one backslash, not two.
//
// Only single-quoted patterns are inspected. In shell, a double-quoted double
// backslash is not a bug: the double quotes consume one of them, so grep sees
// the pattern the author meant. Treating both quote styles alike would flag
// correct code.
//
// The two-character sequence this file looks for is assembled from a named
// constant rather than written out, so the checker never depends on getting the
// very escaping it exists to catch right.
// ═══════════════════════════════════════════════════════════════════════════

const BACKSLASH = String.fromCharCode(92)
const DOUBLED_ESCAPE = `${BACKSLASH}${BACKSLASH}.`
const SINGLE_QUOTED = /'([^'\n]*)'/g
const GREP = /\bgrep\b/

/**
 * Find a doubled backslash before a dot inside the single-quoted pattern of
 * every grep line in `text`.
 *
 * Only lines that invoke grep are inspected, so a shell-wrapped `node -e '…'`
 * carrying a JS string is left alone.
 *
 * @param {string} text
 * @returns {{ line: number, pattern: string }[]} 1-based line numbers
 */
export function findDoubledEscapes(text) {
  const findings = []
  const lines = text.split(/\r?\n/)

  lines.forEach((line, index) => {
    if (!GREP.test(line)) return
    for (const match of line.matchAll(SINGLE_QUOTED)) {
      const pattern = match[1] ?? ''
      if (!pattern.includes(DOUBLED_ESCAPE)) continue
      findings.push({ line: index + 1, pattern })
    }
  })

  return findings
}
