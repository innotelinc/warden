/**
 * Bastion filter engine.
 *
 * Parses Adblock-Plus syntax (EasyList / EasyPrivacy compatible subset) and
 * evaluates requests. Pure TypeScript with no Electron imports so the whole
 * decision surface is unit-testable.
 */

export type ResourceType =
  | 'mainFrame'
  | 'subFrame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xhr'
  | 'ping'
  | 'cspReport'
  | 'media'
  | 'webSocket'
  | 'other'

export type RuleAction = 'block' | 'allow'
export type RuleList = 'ads' | 'trackers' | 'custom' | 'remote'

export interface FilterRule {
  raw: string
  action: RuleAction
  list: RuleList
  pattern: RegExp
  keyword: string | null
  includeDomains: string[]
  excludeDomains: string[]
  /** null = no party constraint */
  thirdParty: boolean | null
  types: Set<ResourceType> | null
  denyTypes: Set<ResourceType> | null
  important: boolean
}

export interface RequestInfo {
  url: string
  type: ResourceType
  /** Host of the page that initiated the request (null for top-level). */
  documentHost: string | null
}

export interface FilterDecision {
  block: boolean
  rule: FilterRule | null
  /** True when an @@ exception cancelled a block. */
  excepted: boolean
}

const TYPE_MAP: Record<string, ResourceType> = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xhr',
  xhr: 'xhr',
  subdocument: 'subFrame',
  document: 'mainFrame',
  'doc': 'mainFrame',
  font: 'font',
  media: 'media',
  websocket: 'webSocket',
  ping: 'ping',
  beacon: 'ping',
  csp_report: 'cspReport',
  other: 'other',
  popup: 'mainFrame'
}

/** Options we cannot honour; rules using them are dropped rather than over-blocking. */
const UNSUPPORTED_OPTIONS = new Set(['csp', 'redirect', 'redirect-rule', 'rewrite', 'replace', 'removeparam', 'inline-script'])

const LITERAL_ESCAPE = /[.*+?${}()|[\]\\]/g

function escapeLiteral(value: string): string {
  return value.replace(LITERAL_ESCAPE, '\\$&')
}

/**
 * Convert an Adblock-Plus URL pattern into a regular expression.
 * Only `*`, `^` and `|` are special; every other character is literal.
 */
export function patternToRegExp(source: string): RegExp {
  let body = source
  let prefix = ''
  let suffix = ''

  if (body.startsWith('||')) {
    body = body.slice(2)
    // Scheme + optional credentials + optional subdomain labels before the host.
    prefix = '^[a-z][a-z0-9+.\\-]*://(?:[^/?#@]*@)?(?:[^/?#]*\\.)?'
  } else if (body.startsWith('|')) {
    body = body.slice(1)
    prefix = '^'
  }

  if (body.endsWith('|')) {
    body = body.slice(0, -1)
    suffix = '$'
  }

  let out = ''
  for (const char of body) {
    if (char === '*') out += '.*'
    else if (char === '^') out += '(?:[^a-zA-Z0-9_\\-.%]|$)'
    else out += escapeLiteral(char)
  }

  return new RegExp(prefix + out + suffix, 'i')
}

/** First literal alphanumeric run of >= 4 characters, used as a cheap pre-filter. */
export function extractKeyword(source: string): string | null {
  const stripped = source.replace(/\^|\*/g, ' ')
  for (const chunk of stripped.split(/[^a-zA-Z0-9]+/)) {
    if (chunk.length >= 4) return chunk.toLowerCase()
  }
  return null
}

function splitTopLevelOptions(text: string): { pattern: string; options: string[] } {
  const comma = text.indexOf('$')
  if (comma === -1) return { pattern: text, options: [] }
  return { pattern: text.slice(0, comma), options: text.slice(comma + 1).split(',') }
}

export function parseRule(
  line: string,
  list: RuleList = 'custom'
): FilterRule | null {
  let text = line.trim()
  if (!text || text.startsWith('!') || text.startsWith('[') || text.startsWith('#')) return null

  let action: RuleAction = 'block'
  if (text.startsWith('@@')) {
    action = 'allow'
    text = text.slice(2)
  }

  const { pattern: rawPattern, options } = splitTopLevelOptions(text)
  if (!rawPattern) return null

  const includeDomains: string[] = []
  const excludeDomains: string[] = []
  const types = new Set<ResourceType>()
  const denyTypes = new Set<ResourceType>()
  let thirdParty: boolean | null = null
  let important = false

  for (const rawOption of options) {
    const option = rawOption.trim()
    if (!option) continue
    const negated = option.startsWith('~')
    const name = (negated ? option.slice(1) : option).toLowerCase()

    const optionKey = name.split('=')[0] ?? name
    if (UNSUPPORTED_OPTIONS.has(optionKey)) return null

    if (name.startsWith('domain=')) {
      for (const rawDomain of name.slice(7).split('|')) {
        const domain = rawDomain.trim().replace(/^~/, '')
        if (!domain) continue
        if (rawDomain.startsWith('~')) excludeDomains.push(domain)
        else includeDomains.push(domain)
      }
      continue
    }

    if (name === 'third-party' || name === '3p') {
      thirdParty = !negated
      continue
    }
    if (name === 'first-party' || name === '1p') {
      thirdParty = negated
      continue
    }
    if (name === 'important') {
      important = !negated
      continue
    }
    if (name === 'match-case') continue

    const type = TYPE_MAP[name]
    if (!type) continue
    if (negated) denyTypes.add(type)
    else types.add(type)
  }

  let pattern: RegExp
  try {
    pattern = patternToRegExp(rawPattern)
  } catch {
    return null
  }

  return {
    raw: line.trim(),
    action,
    list,
    pattern,
    keyword: extractKeyword(rawPattern),
    includeDomains,
    excludeDomains,
    thirdParty,
    types: types.size ? types : null,
    denyTypes: denyTypes.size ? denyTypes : null,
    important
  }
}

export function parseFilterList(text: string, list: RuleList = 'remote'): FilterRule[] {
  const rules: FilterRule[] = []
  for (const line of text.split(/\r?\n/)) {
    const rule = parseRule(line, list)
    if (rule) rules.push(rule)
  }
  return rules
}

/** Suffixes that behave like a public suffix for party comparison. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'or.jp', 'ne.jp', 'com.au', 'net.au', 'org.au',
  'co.nz', 'com.br', 'com.mx', 'co.in', 'co.za', 'com.sg', 'com.tr', 'com.cn', 'com.hk', 'co.kr',
  'com.tw', 'com.ar', 'com.pl', 'co.il', 'com.ua', 'com.ru', 'co.id', 'com.my', 'com.ph', 'com.vn'
])

export function getRegistrableDomain(host: string): string {
  const clean = host.toLowerCase().replace(/\.$/, '')
  if (!clean || /^[\d.]+$/.test(clean) || clean.includes(':')) return clean

  const parts = clean.split('.')
  if (parts.length <= 2) return clean

  const lastTwo = parts.slice(-2).join('.')
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.')
  return lastTwo
}

export function isThirdParty(documentHost: string | null, requestHost: string): boolean {
  if (!documentHost) return false
  const a = getRegistrableDomain(documentHost)
  const b = getRegistrableDomain(requestHost)
  if (!a || !b) return false
  return a !== b
}

export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase()
  const d = domain.toLowerCase().replace(/^\*?\./, '')
  return h === d || h.endsWith(`.${d}`)
}

function domainAllowed(rule: FilterRule, documentHost: string | null): boolean {
  if (!rule.includeDomains.length && !rule.excludeDomains.length) return true
  if (!documentHost) return rule.includeDomains.length === 0
  if (rule.includeDomains.length && !rule.includeDomains.some((d) => hostMatches(documentHost, d))) {
    return false
  }
  if (rule.excludeDomains.some((d) => hostMatches(documentHost, d))) return false
  return true
}

export function ruleMatches(rule: FilterRule, request: RequestInfo): boolean {
  if (rule.types && !rule.types.has(request.type)) return false
  if (rule.denyTypes && rule.denyTypes.has(request.type)) return false
  if (!domainAllowed(rule, request.documentHost)) return false

  if (rule.thirdParty !== null) {
    const host = safeHost(request.url)
    if (!host) return false
    if (isThirdParty(request.documentHost, host) !== rule.thirdParty) return false
  }

  if (rule.keyword && !request.url.toLowerCase().includes(rule.keyword)) return false
  return rule.pattern.test(request.url)
}

export function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Keyword-indexed matcher. Rules with a usable literal token are only tested
 * against URLs containing that token, which keeps a full EasyList-sized ruleset
 * out of the hot path.
 */
export class FilterEngine {
  private readonly byKeyword = new Map<string, FilterRule[]>()
  private readonly generic: FilterRule[] = []
  private total = 0

  constructor(rules: FilterRule[] = []) {
    for (const rule of rules) this.add(rule)
  }

  get size(): number {
    return this.total
  }

  add(rule: FilterRule): void {
    this.total += 1
    if (rule.keyword) {
      const bucket = this.byKeyword.get(rule.keyword)
      if (bucket) bucket.push(rule)
      else this.byKeyword.set(rule.keyword, [rule])
    } else {
      this.generic.push(rule)
    }
  }

  check(request: RequestInfo): FilterDecision {
    const url = request.url.toLowerCase()
    const candidates: FilterRule[] = [...this.generic]

    for (const [keyword, rules] of this.byKeyword) {
      if (url.includes(keyword)) candidates.push(...rules)
    }

    let blocker: FilterRule | null = null
    let allower: FilterRule | null = null

    for (const rule of candidates) {
      if (!ruleMatches(rule, request)) continue
      if (rule.action === 'allow') {
        allower = rule
      } else if (!blocker || (rule.important && !blocker.important)) {
        blocker = rule
      }
    }

    if (blocker && allower && !blocker.important) {
      return { block: false, rule: allower, excepted: true }
    }
    if (blocker) return { block: true, rule: blocker, excepted: false }
    return { block: false, rule: null, excepted: false }
  }
}
