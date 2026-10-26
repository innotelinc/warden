/**
 * Reading a document from this machine in a tab.
 *
 * WARDEN's address bar only understands URLs, so a path like
 * `C:\work\LOCAL_MODELS.md` was sent to a search engine and a `file://` URL was
 * refused by the navigation guard. Notes, model lists and readmes live on disk,
 * and the browser that is supposed to be the front door could not show them.
 *
 * This is deliberately narrow: an explicit path the operator typed or dropped,
 * a text-shaped extension, a size ceiling, and a document with no scripts and no
 * network access at all. It is a reader, not a file browser, and it never walks
 * a directory.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pagePalette } from '../internal-pages'

function filePathOf(value: string): string | null {
  try {
    return fileURLToPath(value)
  } catch {
    return null
  }
}

const DOC_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.log',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.conf',
  '.csv'
])

/** No document this long is worth rendering into a <pre>, and none is free. */
const MAX_BYTES = 2 * 1024 * 1024

export function isDocPath(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 4096) return false
  return DOC_EXTENSIONS.has(path.extname(trimmed).toLowerCase())
}

/** `~/notes.md` and `%USERPROFILE%\notes.md` both mean the home directory. */
export function expandHome(input: string): string {
  const trimmed = input.trim()
  const env = process.env
  if (trimmed.startsWith('~')) return path.join(homedir(), trimmed.slice(1))
  const profiles = [env['USERPROFILE'], env['HOME']].filter((value): value is string => Boolean(value))
  for (const profile of profiles) {
    for (const token of ['%USERPROFILE%', '$HOME']) {
      if (trimmed.toLowerCase().startsWith(token.toLowerCase())) {
        return path.join(profile, trimmed.slice(token.length))
      }
    }
  }
  return trimmed
}

/** Absolutise a typed path. A bare filename means the working directory. */
export function resolveDocPath(input: string): string | null {
  // `file:///C:/notes.md` is what a copy-paste from another browser yields; it
  // names the same file as the path, so it takes the same reader.
  const fromUrl = /^file:/i.test(input.trim()) ? filePathOf(input.trim()) : null
  const expanded = fromUrl ?? expandHome(input)
  if (!isDocPath(expanded)) return null
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded)
  try {
    const info = statSync(absolute)
    if (!info.isFile()) return null
    if (info.size > MAX_BYTES) return null
    return absolute
  } catch {
    return null
  }
}

export function docUrl(filePath: string): string {
  return `warden://doc?path=${encodeURIComponent(filePath)}`
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[char] ?? char
  })

/**
 * The reader itself: escaped text in a monospace column, with the path and size
 * so the operator knows they are looking at a file and not a page pretending to
 * be one.
 */
export function docHtml(filePath: string, text: string, theme?: string): string {
  const name = path.basename(filePath)
  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = text.length ? text.split(/\r\n|\r|\n/).length : 0
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<title>${escapeHtml(name)}</title>
<style>
  ${pagePalette(theme)}
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body { background: var(--bg); color: var(--text); font: 14px/1.55 "Segoe UI", system-ui, sans-serif; }
  header { position: sticky; top: 0; padding: 14px 26px; background: color-mix(in srgb, var(--bg) 94%, transparent); border-bottom: 1px solid var(--line); display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 15px; font-weight: 620; letter-spacing: -.01em; }
  .meta { color: var(--muted); font: 11px/1.5 "Cascadia Mono", Consolas, monospace; overflow-wrap: anywhere; }
  .badge { margin-left: auto; color: var(--mint); font: 10px/1 "Cascadia Mono", Consolas, monospace; letter-spacing: .16em; text-transform: uppercase; border: 1px solid rgba(var(--mint-rgb), .3); border-radius: 999px; padding: 4px 9px; }
  pre { margin: 0; padding: 22px 26px 60px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.65 "Cascadia Mono", Consolas, ui-monospace, monospace; color: var(--text); }
</style></head>
<body>
  <header>
    <h1>${escapeHtml(name)}</h1>
    <span class="meta">${escapeHtml(filePath)}</span>
    <span class="meta">${bytes.toLocaleString()} bytes · ${lines.toLocaleString()} lines</span>
    <span class="badge">local file · read only</span>
  </header>
  <pre>${escapeHtml(text)}</pre>
</body></html>`
}

/** Read a document, or null when the path is not one WARDEN will render. */
export function readDoc(filePath: string, theme?: string): { path: string; html: string } | null {
  const resolved = resolveDocPath(filePath)
  if (!resolved) return null
  try {
    return { path: resolved, html: docHtml(resolved, readFileSync(resolved, 'utf8'), theme) }
  } catch {
    return null
  }
}
