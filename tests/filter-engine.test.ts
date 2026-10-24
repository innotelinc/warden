import { describe, expect, it } from 'vitest'
import {
  FilterEngine,
  extractKeyword,
  getRegistrableDomain,
  isThirdParty,
  parseFilterList,
  parseRule,
  patternToRegExp,
  ruleMatches
} from '../src/main/privacy/filter-engine'

const engineOf = (lines: string[]) => new FilterEngine(parseFilterList(lines.join('\n'), 'ads'))

describe('patternToRegExp', () => {
  it('anchors host patterns to the start of the host or a subdomain', () => {
    const pattern = patternToRegExp('||doubleclick.net^')
    expect(pattern.test('https://doubleclick.net/pixel')).toBe(true)
    expect(pattern.test('https://ad.doubleclick.net/pixel')).toBe(true)
    expect(pattern.test('https://notdoubleclick.net/pixel')).toBe(false)
    expect(pattern.test('https://example.com/?ref=doubleclick.net')).toBe(false)
  })

  it('treats * and ^ as wildcards, not regex syntax', () => {
    const pattern = patternToRegExp('*/pagead/*')
    expect(pattern.test('https://x.example/a/pagead/slot')).toBe(true)
    expect(pattern.test('https://x.example/a/banner/slot')).toBe(false)
  })

  it('honours leading and trailing pipes', () => {
    const exact = patternToRegExp('|https://track.example/p.gif|')
    expect(exact.test('https://track.example/p.gif')).toBe(true)
    expect(exact.test('https://track.example/p.gif?x=1')).toBe(false)
  })

  it('escapes regex metacharacters instead of interpreting them', () => {
    const pattern = patternToRegExp('||example.com/a+b?c^')
    expect(pattern.test('https://example.com/a+b?c')).toBe(true)
    expect(pattern.test('https://example.com/aab?c')).toBe(false)
  })
})

describe('parseRule', () => {
  it('ignores comments and cosmetic rules', () => {
    expect(parseRule('! comment')).toBeNull()
    expect(parseRule('[Adblock Plus 2.0]')).toBeNull()
    expect(parseRule('##.ad-slot')).toBeNull()
    expect(parseRule('')).toBeNull()
  })

  it('drops rules whose action semantics we cannot honour', () => {
    expect(parseRule('||example.com^$csp=script-src none')).toBeNull()
    expect(parseRule('||example.com^$redirect=noop.js')).toBeNull()
  })

  it('reads party, type and domain options', () => {
    const rule = parseRule('||cdn.example^$third-party,script,image,domain=news.example|~shop.example')
    expect(rule).not.toBeNull()
    expect(rule!.thirdParty).toBe(true)
    expect([...rule!.types ?? []]).toEqual(['script', 'image'])
    expect(rule!.includeDomains).toEqual(['news.example'])
    expect(rule!.excludeDomains).toEqual(['shop.example'])
  })

  it('marks exceptions and important rules', () => {
    expect(parseRule('@@||example.com^$important')!.action).toBe('allow')
    expect(parseRule('@@||example.com^$important')!.important).toBe(true)
  })

  it('extracts a usable keyword', () => {
    expect(extractKeyword('||doubleclick.net^')).toBe('doubleclick')
    expect(extractKeyword('*ad*')).toBeNull()
    expect(extractKeyword('||a.bc^')).toBeNull()
  })
})

describe('party comparison', () => {
  it('resolves registrable domains across multi-label suffixes', () => {
    expect(getRegistrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk')
    expect(getRegistrableDomain('a.b.example.com')).toBe('example.com')
    expect(getRegistrableDomain('localhost')).toBe('localhost')
  })

  it('detects third parties', () => {
    expect(isThirdParty('example.com', 'cdn.example.com')).toBe(false)
    expect(isThirdParty('example.com', 'tracker.net')).toBe(true)
    expect(isThirdParty(null, 'tracker.net')).toBe(false)
  })
})

describe('FilterEngine', () => {
  it('blocks ad hosts by host pattern', () => {
    const engine = engineOf(['||doubleclick.net^'])
    const decision = engine.check({
      url: 'https://static.doubleclick.net/ad.js',
      type: 'script',
      documentHost: 'news.example'
    })
    expect(decision.block).toBe(true)
  })

  it('does not block the page origin', () => {
    const engine = engineOf(['||doubleclick.net^'])
    const decision = engine.check({
      url: 'https://news.example/article',
      type: 'mainFrame',
      documentHost: 'news.example'
    })
    expect(decision.block).toBe(false)
  })

  it('lets an @@ exception cancel a block', () => {
    const engine = engineOf(['||tracker.example^', '@@||tracker.example/allow^'])
    expect(engine.check({ url: 'https://tracker.example/pixel', type: 'image', documentHost: 'a.com' }).block).toBe(true)
    expect(engine.check({ url: 'https://tracker.example/allow/x', type: 'image', documentHost: 'a.com' }).block).toBe(false)
  })

  it('keeps an $important block even when an exception exists', () => {
    const engine = engineOf(['@@||tracker.example^', '||tracker.example^$important'])
    const decision = engine.check({ url: 'https://tracker.example/x', type: 'image', documentHost: 'a.com' })
    expect(decision.block).toBe(true)
  })

  it('honours first-party and third-party constraints', () => {
    const engine = engineOf(['||cdn.example.com^$third-party'])
    expect(engine.check({ url: 'https://cdn.example.com/x', type: 'script', documentHost: 'other.test' }).block).toBe(true)
    // Same registrable domain (example.com) is first party, so the rule must not fire.
    expect(engine.check({ url: 'https://cdn.example.com/x', type: 'script', documentHost: 'www.example.com' }).block).toBe(false)
  })

  it('honours $domain includes and excludes', () => {
    const engine = engineOf(['||metrics.example^$domain=news.example'])
    expect(engine.check({ url: 'https://metrics.example/x', type: 'xhr', documentHost: 'news.example' }).block).toBe(true)
    expect(engine.check({ url: 'https://metrics.example/x', type: 'xhr', documentHost: 'shop.example' }).block).toBe(false)
  })

  it('honours resource type options', () => {
    const engine = engineOf(['||assets.example^$script'])
    expect(engine.check({ url: 'https://assets.example/app.js', type: 'script', documentHost: 'a.com' }).block).toBe(true)
    expect(engine.check({ url: 'https://assets.example/hero.jpg', type: 'image', documentHost: 'a.com' }).block).toBe(false)
  })

  it('loads the shipped ruleset and blocks known trackers', () => {
    const lines = [
      '||google-analytics.com^',
      '||googletagmanager.com^',
      '*/pagead/*',
      '||doubleclick.net^'
    ]
    const engine = engineOf(lines)
    const requests = [
      { url: 'https://www.google-analytics.com/collect?v=1', type: 'xhr' as const, documentHost: 'shop.example' },
      { url: 'https://www.googletagmanager.com/gtm.js?id=GTM-1', type: 'script' as const, documentHost: 'shop.example' },
      { url: 'https://shop.example/pagead/slot', type: 'image' as const, documentHost: 'shop.example' },
      { url: 'https://shop.example/app.css', type: 'stylesheet' as const, documentHost: 'shop.example' }
    ]
    expect(requests.map((request) => engine.check(request).block)).toEqual([true, true, true, false])
  })

  it('reports which rule matched', () => {
    const engine = engineOf(['||ads.example^'])
    const decision = engine.check({ url: 'https://ads.example/x', type: 'script', documentHost: 'a.com' })
    expect(decision.rule?.raw).toBe('||ads.example^')
  })

  it('matches rules directly for stratified checks', () => {
    const rule = parseRule('||cdn.example^$image')!
    expect(ruleMatches(rule, { url: 'https://cdn.example/a.png', type: 'image', documentHost: 'a.com' })).toBe(true)
    expect(ruleMatches(rule, { url: 'https://cdn.example/a.js', type: 'script', documentHost: 'a.com' })).toBe(false)
  })
})
