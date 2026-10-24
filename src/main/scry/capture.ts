import type { DesignTokens } from '@shared/types'

import type { ProtocolSession } from './cdp'

export type AssetKind = 'document' | 'stylesheet' | 'script' | 'image' | 'font' | 'media' | 'json' | 'other'

export interface CapturedResource {
  url: string
  kind: AssetKind
  mimeType: string
  status: number
  body: Buffer | null
  size: number
  headers: Record<string, string>
}

export interface CapturedRequest {
  url: string
  host: string
  type: string
  status: number
  thirdParty: boolean
}

export interface CaptureResult {
  url: string
  finalUrl: string
  origin: string
  capturedAt: number
  title: string
  html: string
  resources: CapturedResource[]
  requests: CapturedRequest[]
  cookies: { name: string; domain: string; secure: boolean; httpOnly: boolean }[]
  documentHeaders: Record<string, string>
  tokens: DesignTokens
  blocks: PageBlock[]
  forms: { action: string; method: string; fields: number }[]
  mixedContent: string[]
  screenshot: string | null
  durationMs: number
}

export interface PageBlock {
  tag: string
  id: string
  className: string
  html: string
}

interface ExtractedPage {
  title: string
  html: string
  tokens: DesignTokens
  assetUrls: string[]
  links: string[]
  blocks: PageBlock[]
  forms: { action: string; method: string; fields: number }[]
  mixedContent: string[]
}

const EXTRACT_SCRIPT = `(() => {
  const counts = (map, key) => { if (!key) return; map.set(key, (map.get(key) || 0) + 1); };
  const colors = new Map(), fonts = new Map(), fontSizes = new Map(), radii = new Map(), shadows = new Map(), spacing = new Map(), breakpoints = new Map();
  const nodes = Array.from(document.querySelectorAll('body *')).slice(0, 6000);
  for (const node of nodes) {
    const style = getComputedStyle(node);
    counts(colors, style.color);
    counts(colors, style.backgroundColor);
    counts(colors, style.borderTopColor);
    counts(fonts, style.fontFamily);
    counts(fontSizes, style.fontSize);
    counts(radii, style.borderRadius);
    if (style.boxShadow && style.boxShadow !== 'none') counts(shadows, style.boxShadow);
    for (const prop of ['paddingTop', 'paddingLeft', 'marginTop', 'marginLeft', 'gap', 'rowGap']) {
      const value = style[prop];
      if (value && value !== '0px' && value !== 'normal') counts(spacing, value);
    }
  }
  const seenSheets = new Set();
  const walkRules = (rules) => {
    for (const rule of rules) {
      try {
        if (rule.media) {
          const text = rule.conditionText || rule.media.mediaText || '';
          const match = /(\\d+(?:\\.\\d+)?)px/g;
          let m;
          while ((m = match.exec(text))) counts(breakpoints, m[1] + 'px');
        }
        if (rule.cssRules) walkRules(rule.cssRules);
      } catch (e) {}
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    if (seenSheets.has(sheet)) continue;
    seenSheets.add(sheet);
    try { if (sheet.cssRules) walkRules(sheet.cssRules); } catch (e) {}
  }

  const assets = new Set();
  for (const el of Array.from(document.querySelectorAll('img[src], script[src], link[href], source[src], video[poster], video[src], audio[src], iframe[src]'))) {
    for (const attr of ['src', 'href', 'poster']) {
      const value = el.getAttribute(attr);
      if (value) { try { assets.add(new URL(value, location.href).toString()); } catch (e) {} }
    }
  }
  for (const el of Array.from(document.querySelectorAll('[srcset]'))) {
    for (const part of (el.getAttribute('srcset') || '').split(',')) {
      const url = part.trim().split(/\\s+/)[0];
      if (url) { try { assets.add(new URL(url, location.href).toString()); } catch (e) {} }
    }
  }

  const links = new Set();
  for (const anchor of Array.from(document.querySelectorAll('a[href]')).slice(0, 400)) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    try { links.add(new URL(href, location.href).toString()); } catch (e) {}
  }

  const blocks = Array.from(document.body ? document.body.children : [])
    .filter((el) => !['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT'].includes(el.tagName))
    .slice(0, 24)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className : '',
      html: el.outerHTML
    }));

  const forms = Array.from(document.querySelectorAll('form')).slice(0, 25).map((form) => ({
    action: form.getAttribute('action') || location.href,
    method: (form.getAttribute('method') || 'get').toUpperCase(),
    fields: form.querySelectorAll('input, select, textarea').length
  }));

  const mixedContent = location.protocol === 'https:'
    ? Array.from(document.querySelectorAll('[src^="http://"], [href^="http://"]'))
        .slice(0, 40)
        .map((el) => el.getAttribute('src') || el.getAttribute('href') || '')
        .filter(Boolean)
    : [];

  const sortMap = (map) => Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([value, count]) => ({ value, count }));

  return {
    title: document.title || '',
    html: '<!DOCTYPE html>\\n' + document.documentElement.outerHTML,
    tokens: {
      colors: sortMap(colors),
      fonts: sortMap(fonts),
      fontSizes: sortMap(fontSizes),
      radii: sortMap(radii),
      shadows: sortMap(shadows),
      spacing: sortMap(spacing),
      breakpoints: sortMap(breakpoints)
    },
    assetUrls: Array.from(assets).slice(0, 600),
    links: Array.from(links),
    blocks,
    forms,
    mixedContent
  };
})()`

function emptyTokens(): DesignTokens {
  return { colors: [], fonts: [], fontSizes: [], radii: [], shadows: [], spacing: [], breakpoints: [] }
}

export function classifyResource(mimeType: string, resourceType: string, url: string): AssetKind {
  const mime = (mimeType || '').toLowerCase()
  if (mime.includes('text/html') || resourceType === 'Document') return 'document'
  if (mime.includes('text/css')) return 'stylesheet'
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'script'
  if (mime.startsWith('image/') || resourceType === 'Image') return 'image'
  if (mime.startsWith('font/') || mime.includes('woff') || resourceType === 'Font') return 'font'
  if (mime.startsWith('video/') || mime.startsWith('audio/') || resourceType === 'Media') return 'media'
  if (mime.includes('json')) return 'json'
  if (/\.(woff2?|ttf|otf)(\?|$)/i.test(url)) return 'font'
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i.test(url)) return 'image'
  if (/\.css(\?|$)/i.test(url)) return 'stylesheet'
  if (/\.m?js(\?|$)/i.test(url)) return 'script'
  return 'other'
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export interface CaptureOptions {
  reload?: boolean
  screenshot?: boolean
  timeoutMs?: number
  maxTotalBytes?: number
  onProgress?: (message: string, requests: number, bytes: number) => void
}

interface ResponseMeta {
  url: string
  status: number
  mimeType: string
  headers: Record<string, string>
  type: string
  requestId: string
}

/**
 * Capture a live page: reload it with the network recorder armed, then pull
 * every response body, the rendered DOM and the computed design tokens.
 */
export async function capturePage(
  session: ProtocolSession,
  options: CaptureOptions = {}
): Promise<CaptureResult> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? 35000
  const maxTotalBytes = options.maxTotalBytes ?? 90 * 1024 * 1024
  const progress = options.onProgress ?? (() => undefined)

  const debug = process.env.WARDEN_SCRY_DEBUG === '1'
  const trace = (line: string): void => {
    if (debug) console.error(`[scry] ${Date.now() - started}ms ${line}`)
  }

  const responses = new Map<string, ResponseMeta>()
  const sizes = new Map<string, number>()
  let requestCount = 0
  let docHeaders: Record<string, string> = {}
  let finalUrl = ''
  let loaded = false
  let lastActivity = Date.now()

  session.onEvent((method, params) => {
    if (method === 'Network.requestWillBeSent') {
      requestCount += 1
      lastActivity = Date.now()
      return
    }
    if (method === 'Network.responseReceived') {
      const response = params.response as {
        url: string
        status: number
        mimeType: string
        headers: Record<string, string>
      }
      const requestId = params.requestId as string
      const type = (params.type as string) ?? 'Other'
      responses.set(requestId, {
        url: response.url,
        status: response.status,
        mimeType: response.mimeType,
        headers: response.headers ?? {},
        type,
        requestId
      })
      lastActivity = Date.now()
      if (type === 'Document') {
        docHeaders = Object.fromEntries(
          Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])
        )
        finalUrl = response.url
      }
      return
    }
    if (method === 'Network.loadingFinished') {
      sizes.set(params.requestId as string, Number(params.encodedDataLength ?? 0))
      lastActivity = Date.now()
      return
    }
    if (method === 'Page.loadEventFired') {
      loaded = true
      lastActivity = Date.now()
      trace('load event')
    }
  })

  progress('arm network recorder', 0, 0)

  // A target that is still loading ignores Page.reload, which would leave us
  // waiting for a load event that never arrives. Let it settle first.
  const settleDeadline = Date.now() + 8000
  while (Date.now() < settleDeadline) {
    const state = await session
      .send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true
      })
      .catch(() => null)
    if (state?.result?.value === 'complete') break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  await session.send('Network.enable', {
    maxTotalBufferSize: 120 * 1024 * 1024,
    maxResourceBufferSize: 24 * 1024 * 1024
  })
  await session.send('Page.enable')
  await session.send('Network.setCacheDisabled', { cacheDisabled: true })

  const evaluated = session
    .send<{ result: { value: ExtractedPage } }>('Runtime.evaluate', {
      expression: EXTRACT_SCRIPT,
      returnByValue: true,
      awaitPromise: false
    })
    .catch(() => null)

  const reloadSentAt = Date.now()
  if (options.reload !== false) {
    progress('reload with recorder armed', requestCount, 0)
    await session.send('Page.reload', { ignoreCache: true }).catch(() => undefined)
  }

  let fallbackNavigated = false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (loaded && Date.now() - lastActivity > 900) break

    if (!loaded && !fallbackNavigated && Date.now() - reloadSentAt > 6000) {
      fallbackNavigated = true
      trace('reload produced no load event; falling back to navigate')
      const current = await session
        .send<{ result: { value: string } }>('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true
        })
        .catch(() => null)
      const target = current?.result?.value
      if (target && /^https?:/i.test(target)) {
        await session.send('Page.navigate', { url: target }).catch(() => undefined)
      }
    }
  }
  trace(`capture window done loaded=${loaded} requests=${requestCount} responses=${responses.size} quiet=${Date.now() - lastActivity}ms`)

  progress('read rendered DOM', requestCount, 0)
  let extracted: ExtractedPage | null = null
  try {
    const result = await session.send<{ result: { value: ExtractedPage } }>('Runtime.evaluate', {
      expression: EXTRACT_SCRIPT,
      returnByValue: true
    })
    extracted = result.result?.value ?? null
  } catch {
    if (evaluated) {
      const fallback = await evaluated
      extracted = fallback?.result?.value ?? null
    }
  }

  // On a fresh reload the pre-reload evaluation is stale; prefer the new one.
  if (!extracted) {
    throw new Error('Page returned no DOM. The target may have navigated away or blocked debugging.')
  }

  finalUrl = finalUrl || extracted.html.match(/<link[^>]+href="([^"]+)"/)?.[1] || ''
  const targetUrl = (await session
    .send<{ result: { value: string } }>('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true
    })
    .catch(() => null))?.result?.value ?? finalUrl

  if (!finalUrl) finalUrl = targetUrl

  let bytes = 0
  const resources: CapturedResource[] = []
  const entries = [...responses.values()]

  for (const meta of entries) {
    if (bytes >= maxTotalBytes) break
    const kind = classifyResource(meta.mimeType, meta.type, meta.url)
    if (kind === 'other') continue
    let body: Buffer | null = null
    try {
      const payload = await session.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', {
        requestId: meta.requestId
      })
      body = payload.base64Encoded ? Buffer.from(payload.body, 'base64') : Buffer.from(payload.body, 'utf8')
      bytes += body.length
    } catch {
      body = null
    }
    if (body && body.length > 8 * 1024 * 1024) {
      body = body.subarray(0, 8 * 1024 * 1024)
    }
    resources.push({
      url: meta.url,
      kind,
      mimeType: meta.mimeType,
      status: meta.status,
      body,
      size: body?.length ?? sizes.get(meta.requestId) ?? 0,
      headers: meta.headers
    })
    progress(`captured ${resources.length} resources`, requestCount, bytes)
  }

  let screenshot: string | null = null
  if (options.screenshot) {
    try {
      const shot = await session.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
      screenshot = shot.data
    } catch {
      screenshot = null
    }
  }

  let cookies: CaptureResult['cookies'] = []
  try {
    const result = await session.send<{
      cookies: { name: string; domain: string; secure: boolean; httpOnly: boolean }[]
    }>('Network.getCookies', { urls: [finalUrl || targetUrl] })
    cookies = (result.cookies ?? []).map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly)
    }))
  } catch {
    cookies = []
  }

  const origin = (() => {
    try {
      return new URL(finalUrl || targetUrl).origin
    } catch {
      return ''
    }
  })()

  const documentOrigin = (() => {
    try {
      return new URL(finalUrl || targetUrl).hostname
    } catch {
      return ''
    }
  })()

  const requests: CapturedRequest[] = entries.map((meta) => {
    const host = hostOf(meta.url)
    return {
      url: meta.url,
      host,
      type: meta.type,
      status: meta.status,
      thirdParty: Boolean(host && documentOrigin && host !== documentOrigin && !host.endsWith(`.${documentOrigin}`))
    }
  })

  return {
    url: targetUrl,
    finalUrl: finalUrl || targetUrl,
    origin,
    capturedAt: Date.now(),
    title: extracted.title || hostOf(finalUrl),
    html: extracted.html,
    resources,
    requests,
    cookies,
    documentHeaders: docHeaders,
    tokens: extracted.tokens ?? emptyTokens(),
    blocks: extracted.blocks ?? [],
    forms: extracted.forms ?? [],
    mixedContent: extracted.mixedContent ?? [],
    screenshot,
    durationMs: Date.now() - started
  }
}
