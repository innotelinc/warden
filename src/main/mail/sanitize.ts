/**
 * Mail HTML sanitizer.
 *
 * Mail is the classic tracking vector: one remote pixel identifies the reader.
 * WARDEN strips every remote reference, removes script surfaces, and reports
 * how much remote content was withheld. The renderer additionally puts the
 * result inside a sandboxed iframe with a deny-all CSP.
 */

const BLOCKED_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link', 'style', 'svg', 'math']

export interface SanitizeResult {
  html: string
  remoteCount: number
}

function stripBlockedTags(html: string): string {
  let output = html
  for (const tag of BLOCKED_TAGS) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi')
    output = output.replace(paired, '').replace(selfClosing, '')
  }
  return output
}

function stripEventHandlers(html: string): string {
  return html
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, 'blocked:')
    .replace(/vbscript:/gi, 'blocked:')
}

function neutraliseRemote(html: string): { html: string; remoteCount: number } {
  let remoteCount = 0
  const output = html.replace(
    /(<(?:img|source|video|audio|track|input|table|td|body|div)\b[^>]*?)\s(src|background|poster|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, prefix: string, attr: string, _quoted: string, double: string, single: string, bare: string) => {
      const value = double ?? single ?? bare ?? ''
      if (/^\s*data:/i.test(value) || /^\s*cid:/i.test(value)) return match
      if (!/^(https?:)?\/\//i.test(value.trim())) return match
      remoteCount += 1
      return `${prefix} data-warden-blocked="${attr}"`
    }
  )
  return { html: output, remoteCount }
}

function addTargets(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (match, attrs: string) => {
    if (/target=/i.test(attrs)) return match
    return `<a${attrs} target="_blank" rel="noreferrer noopener">`
  })
}

export function sanitizeMailHtml(input: string): SanitizeResult {
  if (!input) return { html: '', remoteCount: 0 }
  let html = stripBlockedTags(input)
  html = stripEventHandlers(html)
  const remote = neutraliseRemote(html)
  html = addTargets(remote.html)
  const csp =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:;\">"
  return { html: `${csp}<div style="all:initial;display:block">${html}</div>`, remoteCount: remote.remoteCount }
}

/** Convert plain text to safe HTML with linkified URLs. */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const linked = escaped.replace(
    /\bhttps?:\/\/[^\s<>"]+/g,
    (url) => `<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`
  )
  return `<div style="white-space:pre-wrap;font:13px/1.6 ui-monospace,monospace">${linked}</div>`
}
