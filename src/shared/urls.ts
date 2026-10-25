/**
 * Turn whatever the operator typed into a navigable URL.
 * Never guesses a search engine for something that looks like a host.
 */
export function resolveInput(input: string, searchUrl: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (/^(https?|warden|about|file):/i.test(trimmed)) return trimmed
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`

  const candidate = trimmed.split('/')[0] ?? ''
  const hostPart = candidate.split(':')[0] ?? ''
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostPart)
  const isDotHost = /^[\w-]+(\.[\w-]+)+$/.test(hostPart)
  const isPortHost = /^(localhost|[\w.-]+):\d+$/.test(candidate)

  if (isIpv4 || isDotHost || isPortHost) {
    const hostOnly = hostPart
    const scheme = isIpv4 || hostOnly.startsWith('localhost') ? 'http' : 'https'
    return `${scheme}://${trimmed}`
  }

  return searchUrl.replace('%s', encodeURIComponent(trimmed))
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * True when `host` is one of `entries` or a subdomain of one.
 *
 * Entries are bare hosts (`example.com`), never origins or wildcards, which is
 * what the allowlist and the compatibility list both store.
 */
export function hostMatches(host: string, entries: string[]): boolean {
  const value = host.trim().toLowerCase()
  if (!value) return false
  return entries.some((entry) => {
    const candidate = entry.trim().toLowerCase()
    return candidate.length > 0 && (value === candidate || value.endsWith(`.${candidate}`))
  })
}

/** Unread counts that chat apps encode into document.title. */
export function parseUnreadTitle(title: string): number {
  const patterns = [/^\((\d+)\)/, /^\[(\d+)\]/, /^(\d+)\s*[•·]/, /\b(\d+)\s+unread\b/i]
  for (const pattern of patterns) {
    const match = pattern.exec(title.trim())
    if (match) {
      const value = Number(match[1])
      if (Number.isFinite(value)) return Math.min(9999, value)
    }
  }
  return 0
}
