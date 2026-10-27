import { describe, expect, it } from 'vitest'
import { cosmeticCss, cosmeticSelectorsFor, GENERIC_SELECTORS, SITE_SELECTORS } from '@shared/cosmetic'

/**
 * Cosmetic filtering hides containers rather than cancelling requests, so the
 * two things that matter are that it reaches the ad slots and that it stops
 * short of the page's own structure.
 */
describe('cosmetic selectors', () => {
  it('targets the containers the big networks actually ship', () => {
    const list = GENERIC_SELECTORS.join(' ')
    expect(list).toContain('ins.adsbygoogle')
    expect(list).toContain('[data-ad-slot]')
    expect(list).toContain('[id^="div-gpt-ad"]')
    expect(list).toContain('iframe[src*="doubleclick.net"]')
  })

  it('keeps the generic list away from page structure', () => {
    // A bare `[class*="ad"]` matches header, shadow and download. The generic
    // list has to be specific enough that a site is never quietly ruined by
    // turning ads off.
    for (const selector of GENERIC_SELECTORS) {
      expect(selector).not.toMatch(/\[class\*="?ad"?\]/)
      expect(selector).not.toMatch(/^[a-z]+$/)
    }
  })

  it('adds a site list to the generic one for that host and its subdomains', () => {
    const yahoo = cosmeticSelectorsFor('news.yahoo.com')
    expect(yahoo.length).toBeGreaterThan(GENERIC_SELECTORS.length)
    expect(yahoo).toContain('[data-col="ad"]')
  })

  it('does not treat a lookalike host as the site', () => {
    expect(cosmeticSelectorsFor('notyahoo.com')).toHaveLength(GENERIC_SELECTORS.length)
    expect(cosmeticSelectorsFor('yahoo.com.example')).toHaveLength(GENERIC_SELECTORS.length)
  })

  it('ignores case and a trailing dot', () => {
    expect(cosmeticSelectorsFor('NEWS.YAHOO.COM.')).toContain('[data-col="ad"]')
  })

  it('falls back to the generic list for an empty host', () => {
    expect(cosmeticSelectorsFor('')).toEqual([...GENERIC_SELECTORS])
  })
})

describe('cosmetic css', () => {
  it('hides every selector it was given', () => {
    const css = cosmeticCss('yahoo.com')
    const rules = css.split('\n')
    expect(rules).toHaveLength(cosmeticSelectorsFor('yahoo.com').length)
    for (const rule of rules) {
      expect(rule).toMatch(/^[^}]+ \{?/.test(rule) ? /.+/ : /.+/)
      expect(rule.endsWith('{display:none !important}')).toBe(true)
    }
  })

  it('cannot break out of its own rule', () => {
    // Every selector is emitted into a stylesheet, so a stray brace in the list
    // would let one entry rewrite the page's own rules.
    for (const selector of [...GENERIC_SELECTORS, ...Object.values(SITE_SELECTORS).flat()]) {
      expect(selector).not.toContain('{')
      expect(selector).not.toContain('}')
    }
  })
})
