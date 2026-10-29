/**
 * Scry's report builder, platform-neutral.
 *
 * It is the same judgement on desktop and on a phone: which stack the page is
 * running, which third parties it called, which of those are trackers, what the
 * forms leave exposed. The desktop feeds it a `CaptureResult` from the Chrome
 * debugger; mobile feeds it what a page can see about itself (`performance`
 * entries, the DOM, its own cookies). Keeping one implementation is the point:
 * a host list or a signature that lived twice would be right on one platform and
 * quietly wrong on the other.
 *
 * The one honest asymmetry lives in `headersObserved`. Response headers are not
 * visible to a page, and the mobile engine does not hand them to the shell, so a
 * mobile report says so rather than reporting every security header as missing.
 */
import type { DesignTokens, ScryReport } from './types'
import { BUILTIN_AD_HOSTS, BUILTIN_TRACKER_HOSTS } from './builtin-lists'

export interface ReconRequest {
  url: string
  host: string
  type: string
  status: number
  thirdParty: boolean
}

export interface ReconResource {
  url: string
  kind: string
  size?: number
}

export interface ReconForm {
  action: string
  method: string
  fields: number
}

export interface ReconCookie {
  name: string
  domain: string
  secure: boolean
  httpOnly: boolean
}

/**
 * What a capture has to carry to be reportable. A desktop `CaptureResult`
 * satisfies this structurally; the mobile capture produces exactly this shape.
 */
export interface ReconInput {
  finalUrl: string
  origin: string
  capturedAt: number
  title: string
  html: string
  requests: ReconRequest[]
  resources: ReconResource[]
  documentHeaders: Record<string, string>
  cookies: ReconCookie[]
  mixedContent: string[]
  forms: ReconForm[]
  tokens: DesignTokens
  durationMs: number
  /** False when the platform gives the page no view of response headers. */
  headersObserved?: boolean
}

interface Signature {
  name: string
  match: (context: { html: string; hosts: Set<string>; scripts: string[]; headers: Record<string, string> }) => string | null
}

const TRACKER_SET = new Set(
  [...BUILTIN_TRACKER_HOSTS, ...BUILTIN_AD_HOSTS]
    .filter((entry) => !entry.includes('/'))
    .map((entry) => entry.toLowerCase())
)

const SIGNATURES: Signature[] = [
  {
    name: 'Next.js',
    match: ({ html, scripts }) =>
      html.includes('__NEXT_DATA__') || scripts.some((src) => src.includes('/_next/')) ? '/_next/ bundles' : null
  },
  {
    name: 'React',
    match: ({ html, scripts }) =>
      html.includes('data-reactroot') || scripts.some((src) => /react(-dom)?[.@-]/.test(src))
        ? 'react runtime reference'
        : null
  },
  {
    name: 'Vue',
    match: ({ html, scripts }) => (html.includes('data-v-') || scripts.some((src) => src.includes('/vue')) ? 'vue attributes or bundle' : null)
  },
  {
    name: 'Angular',
    match: ({ html }) => (/ng-version="([^"]+)"/.exec(html)?.[1] ? 'ng-version attribute' : null)
  },
  {
    name: 'Nuxt',
    match: ({ html }) => (html.includes('__NUXT__') || html.includes('_nuxt/') ? '__NUXT__ payload' : null)
  },
  {
    name: 'Astro',
    match: ({ html }) => (html.includes('astro-island') ? 'astro-island hydration' : null)
  },
  {
    name: 'Svelte',
    match: ({ html, scripts }) =>
      scripts.some((src) => src.includes('svelte')) || html.includes('svelte-') ? 'svelte markers' : null
  },
  {
    name: 'Vite',
    match: ({ scripts }) => (scripts.some((src) => /\/assets\/[^/]+-[A-Za-z0-9_]{8}\.js/.test(src)) ? 'hashed asset names' : null)
  },
  {
    name: 'Tailwind CSS',
    match: ({ html }) =>
      /class="[^"]*\b(flex|grid|text-(sm|xs|lg)|bg-(white|black|slate|zinc)-?\d*)\b/.test(html) ? 'utility class usage' : null
  },
  {
    name: 'Bootstrap',
    match: ({ scripts, html }) =>
      scripts.some((src) => src.includes('bootstrap')) || /class="[^"]*\b(container-fluid|col-md-\d+)\b/.test(html)
        ? 'bootstrap classes or bundle'
        : null
  },
  {
    name: 'WordPress',
    match: ({ html, hosts }) =>
      html.includes('/wp-content/') || html.includes('wp-json') || hosts.has('s.w.org') ? 'wp-content paths' : null
  },
  { name: 'Shopify', match: ({ hosts }) => (hosts.has('cdn.shopify.com') ? 'cdn.shopify.com' : null) },
  { name: 'Wix', match: ({ hosts }) => (hosts.has('static.wixstatic.com') ? 'wixstatic assets' : null) },
  { name: 'Squarespace', match: ({ hosts }) => (hosts.has('static1.squarespace.com') ? 'squarespace static' : null) },
  { name: 'Webflow', match: ({ html }) => (html.includes('data-wf-page') ? 'data-wf-page attribute' : null) },
  { name: 'Ghost', match: ({ html }) => (html.includes('ghost-url') || html.includes('content/themes/') ? 'ghost theme paths' : null) },
  { name: 'Cloudflare', match: ({ headers }) => (headers['cf-ray'] || headers['server'] === 'cloudflare' ? 'cf-ray header' : null) },
  { name: 'nginx', match: ({ headers }) => (/nginx/.test(headers.server ?? '') ? `server: ${headers.server}` : null) },
  { name: 'Apache', match: ({ headers }) => (/apache/.test(headers.server ?? '') ? `server: ${headers.server}` : null) },
  { name: 'hCaptcha', match: ({ hosts }) => (hosts.has('hcaptcha.com') ? 'hcaptcha host' : null) },
  { name: 'Google Tag Manager', match: ({ hosts }) => (hosts.has('googletagmanager.com') ? 'googletagmanager host' : null) },
  { name: 'Google Analytics', match: ({ hosts }) => (hosts.has('google-analytics.com') ? 'google-analytics host' : null) }
]

const SECURITY_HEADERS: { key: string; label: string }[] = [
  { key: 'content-security-policy', label: 'Content-Security-Policy' },
  { key: 'strict-transport-security', label: 'Strict-Transport-Security' },
  { key: 'x-frame-options', label: 'X-Frame-Options' },
  { key: 'x-content-type-options', label: 'X-Content-Type-Options' },
  { key: 'referrer-policy', label: 'Referrer-Policy' },
  { key: 'permissions-policy', label: 'Permissions-Policy' },
  { key: 'cross-origin-opener-policy', label: 'Cross-Origin-Opener-Policy' }
]

export function isTrackerHost(host: string): boolean {
  if (TRACKER_SET.has(host)) return true
  for (const tracker of TRACKER_SET) {
    if (host.endsWith(`.${tracker}`)) return true
  }
  return false
}

export function buildReport(capture: ReconInput, blockedDuringCapture = 0): ScryReport {
  const headersObserved = capture.headersObserved !== false
  const hosts = new Set(capture.requests.map((request) => request.host).filter(Boolean))
  const scripts = capture.resources.filter((resource) => resource.kind === 'script').map((resource) => resource.url)

  const technologies: ScryReport['technologies'] = []
  for (const signature of SIGNATURES) {
    const evidence = signature.match({
      html: capture.html,
      hosts,
      scripts,
      headers: capture.documentHeaders
    })
    if (evidence) technologies.push({ name: signature.name, evidence })
  }

  const byHost = new Map<string, { requests: number; kind: string }>()
  for (const request of capture.requests) {
    if (!request.host) continue
    const entry = byHost.get(request.host) ?? { requests: 0, kind: request.type }
    entry.requests += 1
    if (request.type === 'Script') entry.kind = 'script'
    byHost.set(request.host, entry)
  }

  const pageHost = hostOf(capture.finalUrl)
  const thirdParties = [...byHost.entries()]
    .filter(([host]) => host !== pageHost && !host.endsWith(`.${pageHost}`))
    .sort((a, b) => b[1].requests - a[1].requests)
    .slice(0, 60)
    .map(([host, meta]) => ({ host, requests: meta.requests, kind: meta.kind }))

  const trackers = thirdParties
    .filter((entry) => isTrackerHost(entry.host))
    .map((entry) => ({ host: entry.host, requests: entry.requests }))

  const missingSecurityHeaders = headersObserved
    ? SECURITY_HEADERS.filter((header) => !capture.documentHeaders[header.key]).map((header) => header.label)
    : []

  const endpoints = [
    ...new Set(
      capture.requests
        .filter((request) => request.type === 'XHR' || request.type === 'Fetch')
        .map((request) => request.url)
    )
  ].slice(0, 80)

  const notes: string[] = []
  if (blockedDuringCapture > 0) {
    notes.push(
      `Bastion blocked ${blockedDuringCapture} request(s) during this capture, so tracker and third-party counts are a lower bound. Disable the relevant filters to see the full footprint.`
    )
  }
  if (trackers.length) {
    notes.push(`${trackers.length} tracking or advertising hosts were contacted on first load.`)
  }
  if (missingSecurityHeaders.length) {
    notes.push(`Missing security headers: ${missingSecurityHeaders.join(', ')}.`)
  }
  if (!headersObserved) {
    notes.push(
      'Response headers are not visible from inside the page, so the server software and the security headers are not part of this report. Read those with Scry on the desktop build.'
    )
  }
  if (capture.mixedContent.length) {
    notes.push(`${capture.mixedContent.length} insecure subresources were requested by an HTTPS page.`)
  }
  if (capture.forms.length) {
    notes.push(`${capture.forms.length} form(s) found; check actions before reusing any of this markup.`)
  }
  const inlineScripts = (capture.html.match(/<script(?![^>]*\bsrc=)/gi) ?? []).length
  if (inlineScripts) {
    notes.push(`${inlineScripts} inline script block(s) carry the page's private state and build config.`)
  }
  if (capture.resources.length === 0) {
    notes.push('No subresources were recorded; the page may have served everything from cache.')
  }

  return {
    origin: capture.origin,
    url: capture.finalUrl,
    title: capture.title,
    capturedAt: capture.capturedAt,
    durationMs: capture.durationMs,
    requests: capture.requests.length,
    transferredBytes: capture.resources.reduce((total, resource) => total + (resource.size ?? 0), 0),
    technologies,
    server: { headers: capture.documentHeaders, missingSecurityHeaders },
    thirdParties,
    trackers,
    cookies: capture.cookies,
    mixedContent: capture.mixedContent,
    endpoints,
    forms: capture.forms,
    designTokens: capture.tokens,
    notes
  }
}

/** Lower-case hostname, matching how a capture names a request's host. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}
