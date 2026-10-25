import { describe, expect, it } from 'vitest'
import { sanitizeSettings } from '@shared/settings'
import { hostMatches, hostOfUrl } from '@shared/urls'

/**
 * Compatibility mode is a list of bare hosts, so the matching rules are the
 * ones that matter: a subdomain has to inherit the exemption, and a lookalike
 * host must not.
 */
describe('hostMatches', () => {
  it('matches the host itself and its subdomains', () => {
    expect(hostMatches('neowin.net', ['neowin.net'])).toBe(true)
    expect(hostMatches('www.neowin.net', ['neowin.net'])).toBe(true)
    expect(hostMatches('challenge.neowin.net', ['neowin.net'])).toBe(true)
  })

  it('does not match a host that merely ends with the same characters', () => {
    expect(hostMatches('evilneowin.net', ['neowin.net'])).toBe(false)
    expect(hostMatches('neowin.net.example', ['neowin.net'])).toBe(false)
  })

  it('does not match siblings or the empty list', () => {
    expect(hostMatches('neowin.com', ['neowin.net'])).toBe(false)
    expect(hostMatches('neowin.net', [])).toBe(false)
    expect(hostMatches('', ['neowin.net'])).toBe(false)
  })

  it('ignores case and stray whitespace in entries', () => {
    expect(hostMatches('WWW.Neowin.NET', [' NeoWin.net '])).toBe(true)
  })

  it('finds the host of a page url', () => {
    expect(hostOfUrl('https://www.neowin.net/news/item?x=1')).toBe('www.neowin.net')
    expect(hostOfUrl('not a url')).toBe('')
  })
})

describe('compatibility settings', () => {
  it('normalises, dedupes and caps the list', () => {
    const settings = sanitizeSettings({
      compatibility: [' Neowin.NET ', 'neowin.net', '', 42]
    })
    expect(settings.compatibility).toEqual(['neowin.net'])
  })

  it('survives a hostile value', () => {
    expect(sanitizeSettings({ compatibility: 'neowin.net' }).compatibility).toEqual([])
    expect(sanitizeSettings({ compatibility: null }).compatibility).toEqual([])
  })

  it('caps the list so a settings file cannot grow without bound', () => {
    const many = Array.from({ length: 150 }, (_, index) => `site${index}.example`)
    expect(sanitizeSettings({ compatibility: many }).compatibility).toHaveLength(100)
  })

  it('defaults to no exemptions at all', () => {
    expect(sanitizeSettings({}).compatibility).toEqual([])
  })
})
