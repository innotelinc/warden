import { describe, expect, it } from 'vitest'
import {
  filterResponseHeaders,
  isAllowlisted,
  referrerFor,
  shouldAcceptCookie,
  shouldSendCookies,
  upgradeToHttps
} from '../src/main/privacy/cookie-policy'

const block = { mode: 'block' as const, allowlist: [], siteHost: 'news.example' }
const firstParty = { mode: 'first-party' as const, allowlist: [], siteHost: 'news.example' }

describe('allowlist matching', () => {
  it('matches a host and its subdomains, not sibling domains', () => {
    expect(isAllowlisted('app.internal.example', ['internal.example'])).toBe(true)
    expect(isAllowlisted('internal.example', ['internal.example'])).toBe(true)
    expect(isAllowlisted('notinternal.example', ['internal.example'])).toBe(false)
  })

  it('normalises casing and trailing dots', () => {
    expect(isAllowlisted('APP.Internal.Example.', ['internal.example'])).toBe(true)
  })
})

describe('shouldSendCookies', () => {
  it('refuses every cookie in block mode without an allowance', () => {
    expect(shouldSendCookies(block, 'news.example')).toBe(false)
    expect(shouldSendCookies(block, 'tracker.example')).toBe(false)
  })

  it('permits an allowlisted destination only', () => {
    const ctx = { ...block, allowlist: ['internal.example'] }
    expect(shouldSendCookies(ctx, 'app.internal.example')).toBe(true)
    expect(shouldSendCookies(ctx, 'news.example')).toBe(false)
  })

  it('in first-party mode permits the visited host but not third parties', () => {
    expect(shouldSendCookies(firstParty, 'news.example')).toBe(true)
    expect(shouldSendCookies(firstParty, 'static.news.example')).toBe(true)
    expect(shouldSendCookies(firstParty, 'ads.tracker.example')).toBe(false)
  })
})

describe('shouldAcceptCookie', () => {
  it('rejects third-party Set-Cookie in first-party mode', () => {
    expect(shouldAcceptCookie(firstParty, 'news.example', null)).toBe(true)
    expect(shouldAcceptCookie(firstParty, 'tracker.example', null)).toBe(false)
  })

  it('evaluates the Domain attribute, not just the response host', () => {
    expect(shouldAcceptCookie(firstParty, 'news.example', '.tracker.example')).toBe(false)
    expect(shouldAcceptCookie(firstParty, 'cdn.news.example', '.news.example')).toBe(true)
  })

  it('rejects everything under strict block mode', () => {
    expect(shouldAcceptCookie(block, 'news.example', null)).toBe(false)
  })
})

describe('filterResponseHeaders', () => {
  it('strips Set-Cookie in block mode and counts what it removed', () => {
    const { headers, stripped } = filterResponseHeaders(
      { 'Set-Cookie': ['sid=1; path=/', 'uid=2; path=/'], 'Content-Type': ['text/html'] },
      block,
      'news.example'
    )
    expect(headers['Set-Cookie']).toBeUndefined()
    expect(headers['Content-Type']).toEqual(['text/html'])
    expect(stripped).toBe(2)
  })

  it('keeps allowed cookies and drops the rest in the same response', () => {
    const ctx = { ...firstParty, allowlist: ['allowed.example'] }
    const { headers } = filterResponseHeaders(
      { 'set-cookie': ['a=1; Domain=.news.example', 'b=2; Domain=.tracker.example'] },
      ctx,
      'news.example'
    )
    expect(headers['set-cookie']).toEqual(['a=1; Domain=.news.example'])
  })

  it('removes reporting beacons regardless of cookie policy', () => {
    const { headers } = filterResponseHeaders(
      { 'Report-To': ['{"group":"x"}'], NEL: ['{}'], 'X-Thing': ['ok'] },
      block,
      'news.example'
    )
    expect(headers['Report-To']).toBeUndefined()
    expect(headers['NEL']).toBeUndefined()
    expect(headers['X-Thing']).toEqual(['ok'])
  })

  it('leaves unrelated headers untouched', () => {
    const { headers, stripped } = filterResponseHeaders({ 'Cache-Control': ['no-store'] }, block, 'a.com')
    expect(headers).toEqual({ 'Cache-Control': ['no-store'] })
    expect(stripped).toBe(0)
  })
})

describe('transport hardening helpers', () => {
  it('upgrades plain HTTP but leaves localhost alone', () => {
    expect(upgradeToHttps('http://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(upgradeToHttps('http://localhost:3000/')).toBeNull()
    expect(upgradeToHttps('http://127.0.0.1/')).toBeNull()
    expect(upgradeToHttps('https://example.com/')).toBeNull()
    expect(upgradeToHttps('not a url')).toBeNull()
  })

  it('trims referrers to the origin', () => {
    expect(referrerFor('https://news.example/story/secret?token=1')).toBe('https://news.example/')
    expect(referrerFor('file:///tmp/x.html')).toBeNull()
    expect(referrerFor('about:blank')).toBeNull()
  })
})

/**
 * Authentik sets its CSRF and session cookies on the parent domain
 * (`.innotel.us`) from a host that is allowlisted (`auth.cerulean.innotel.us`).
 * Judging only the cookie's own domain made an accepted site's own login cookies
 * unsavable, which is the bug that broke SSO.
 */
describe('cookies on a parent domain', () => {
  const site = 'auth.cerulean.innotel.us'
  const ctx = { mode: 'block' as const, allowlist: [site], siteHost: site }

  it('accepts the site\'s cookie on its parent domain once the site is allowed', () => {
    expect(shouldAcceptCookie(ctx, site, '.innotel.us')).toBe(true)
    expect(shouldAcceptCookie(ctx, site, 'innotel.us')).toBe(true)
    expect(shouldAcceptCookie(ctx, site, site)).toBe(true)
  })

  it('still refuses a cookie for an unrelated domain', () => {
    expect(shouldAcceptCookie(ctx, site, '.tracker.example')).toBe(false)
    expect(shouldAcceptCookie(ctx, site, 'evil-innotel.us')).toBe(false)
  })

  it('accepts a parent-domain cookie in first-party mode too', () => {
    const firstPartySite = { ...firstParty, siteHost: site }
    expect(shouldAcceptCookie(firstPartySite, site, '.innotel.us')).toBe(true)
    expect(shouldAcceptCookie(firstPartySite, site, '.tracker.example')).toBe(false)
  })

  it('keeps the parent-domain cookie through the header filter', () => {
    const { headers, stripped } = filterResponseHeaders(
      { 'set-cookie': ['authentik_session=abc; Domain=.innotel.us; Path=/; Secure; HttpOnly', 'ad=1; Domain=.tracker.example'] },
      ctx,
      site
    )
    expect(headers['set-cookie']).toEqual(['authentik_session=abc; Domain=.innotel.us; Path=/; Secure; HttpOnly'])
    expect(stripped).toBe(1)
  })
})
