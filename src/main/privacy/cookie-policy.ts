/**
 * Cookie policy for WARDEN.
 *
 * The product promise is "no cookies unless a site is explicitly allowed".
 * Electron has no Chrome-style cookie policy switch, so the guarantee is
 * enforced at three layers (see session.ts): request header stripping,
 * Set-Cookie response stripping, and a guard on the cookie store itself.
 * The decisions live here as pure functions.
 */

import { hostMatches } from './filter-engine'

export type CookieMode = 'block' | 'first-party'

export interface CookieContext {
  mode: CookieMode
  allowlist: string[]
  /** Host of the page being viewed (the tab's top-level site). */
  siteHost: string | null
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

export function isAllowlisted(host: string, allowlist: string[]): boolean {
  const clean = normalizeHost(host)
  if (!clean) return false
  return allowlist.some((entry) => hostMatches(clean, normalizeHost(entry)))
}

/**
 * May a Cookie header be attached to this request?
 * Only when the destination host is allowlisted (or, in first-party mode,
 * when it is the site the user is actually visiting).
 */
export function shouldSendCookies(ctx: CookieContext, requestHost: string): boolean {
  const host = normalizeHost(requestHost)
  if (!host) return false
  if (isAllowlisted(host, ctx.allowlist)) return true
  if (ctx.mode === 'first-party') {
    if (!ctx.siteHost) return false
    return hostMatches(normalizeHost(ctx.siteHost), host) || hostMatches(host, normalizeHost(ctx.siteHost))
  }
  return false
}

/**
 * May a Set-Cookie header from this response be kept?
 * `cookieDomain` is the Domain attribute if present, otherwise the response host.
 */
export function shouldAcceptCookie(
  ctx: CookieContext,
  responseHost: string,
  cookieDomain?: string | null
): boolean {
  const host = normalizeHost(cookieDomain || responseHost)
  if (!host) return false
  if (isAllowlisted(host, ctx.allowlist)) return true
  if (ctx.mode === 'first-party') {
    if (!ctx.siteHost) return false
    return hostMatches(normalizeHost(ctx.siteHost), host)
  }
  return false
}

/** Strip Set-Cookie / Set-Cookie2 entries that the policy rejects. */
export function filterResponseHeaders(
  headers: Record<string, string | string[]>,
  ctx: CookieContext,
  responseHost: string
): { headers: Record<string, string | string[]>; stripped: number } {
  const out: Record<string, string | string[]> = { ...headers }
  let stripped = 0

  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase()
    // NEL / Report-To are reporting beacons that survive most blockers.
    if (lower === 'report-to' || lower === 'nel') {
      delete out[key]
      continue
    }
    if (lower !== 'set-cookie' && lower !== 'set-cookie2') continue

    const value = out[key]
    if (value === undefined) continue
    const values = Array.isArray(value) ? value : [value]
    const kept: string[] = []
    for (const cookie of values) {
      const domainMatch = /;\s*domain=([^;]+)/i.exec(cookie)
      const domain = domainMatch?.[1]?.trim() ?? null
      if (shouldAcceptCookie(ctx, responseHost, domain)) kept.push(cookie)
      else stripped += 1
    }
    if (kept.length) out[key] = kept
    else {
      delete out[key]
      if (!stripped) stripped += 1
    }
  }

  return { headers: out, stripped }
}

/** True when the request URL can be upgraded to HTTPS. */
export function upgradeToHttps(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:') return null
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname.endsWith('.local')) {
      return null
    }
    parsed.protocol = 'https:'
    return parsed.toString()
  } catch {
    return null
  }
}

/** Hosts WARDEN never sends a Referer to. */
export function referrerFor(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:' || parsed.protocol === 'about:') return null
    return `${parsed.protocol}//${parsed.host}/`
  } catch {
    return null
  }
}
