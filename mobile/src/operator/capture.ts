/**
 * What a page can tell you about itself.
 *
 * Scry on the desktop reads a page through the Chrome debugger, which sees
 * response headers, request statuses and bodies. A phone has no debugger: the
 * capture runs as a script inside the page the operator is on, so it sees the
 * DOM, `document.cookie` and the Resource Timing entries — and it cannot see
 * response headers at all. `headersObserved: false` travels with the capture so
 * the report states that instead of calling every security header missing.
 *
 * The function is written to be serialised: `captureScript()` stringifies it and
 * the native surface evaluates the result in the page. That is why it declares
 * everything it uses inside itself — a reference to a module-scope helper would
 * be a ReferenceError on the other side of the bridge.
 */
export interface MobileCapture {
  finalUrl: string
  origin: string
  title: string
  capturedAt: number
  durationMs: number
  html: string
  /** True when the markup was cut to keep the bridge payload small. */
  htmlTruncated: boolean
  requests: { url: string; host: string; type: string; status: number; thirdParty: boolean }[]
  resources: { url: string; kind: string; size: number }[]
  documentHeaders: Record<string, string>
  cookies: { name: string; domain: string; secure: boolean; httpOnly: boolean }[]
  mixedContent: string[]
  forms: { action: string; method: string; fields: number }[]
  tokens: {
    colors: { value: string; count: number }[]
    fonts: { value: string; count: number }[]
    fontSizes: { value: string; count: number }[]
    radii: { value: string; count: number }[]
    shadows: { value: string; count: number }[]
    spacing: { value: string; count: number }[]
    breakpoints: { value: string; count: number }[]
  }
  headersObserved: boolean
}

/** Collected inside the page. Kept free of outer references on purpose. */
export function pageCapture(): MobileCapture | null {
  if (typeof document === 'undefined' || !document.documentElement) return null

  const started = performance.timeOrigin ? Date.now() - performance.now() : Date.now()
  const limit = 120000

  const hostOf = (value: string): string => {
    try {
      return new URL(value, location.href).hostname.toLowerCase()
    } catch {
      return ''
    }
  }

  const kindOf = (url: string, initiator: string): string => {
    // Written for the desktop's typecheck too, which treats an index read as
    // possibly absent; the script has to compile in both projects.
    const path = (url.split('?')[0] ?? '').split('#')[0]?.toLowerCase() ?? ''
    if (/(\.js|\.mjs)$/.test(path) || initiator === 'script') return 'script'
    if (path.endsWith('.css') || initiator === 'link' || initiator === 'css') return 'stylesheet'
    if (/\.(woff2?|ttf|otf|eot)$/.test(path)) return 'font'
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(path)) return 'image'
    if (/\.(mp4|webm|m4a|mp3|ogg|wav|m3u8|ts)$/.test(path)) return 'media'
    if (path.endsWith('.json')) return 'json'
    return 'other'
  }

  const typeOf = (initiator: string): string => {
    switch (initiator) {
      case 'script':
        return 'Script'
      case 'link':
      case 'css':
        return 'Stylesheet'
      case 'img':
      case 'image':
      case 'imageset':
        return 'Image'
      case 'xmlhttprequest':
        return 'XHR'
      case 'fetch':
        return 'Fetch'
      case 'iframe':
      case 'frame':
      case 'navigation':
        return 'Document'
      case 'audio':
      case 'video':
      case 'track':
        return 'Media'
      case 'beacon':
        return 'Ping'
      case 'font':
        return 'Font'
      default:
        return 'Other'
    }
  }

  const requests: MobileCapture['requests'] = [
    { url: location.href, host: hostOf(location.href), type: 'Document', status: 0, thirdParty: false }
  ]
  const resources: MobileCapture['resources'] = []

  let entries: PerformanceEntryList = []
  try {
    entries = performance.getEntriesByType('resource')
  } catch {
    entries = []
  }

  for (let index = 0; index < entries.length && index < 400; index += 1) {
    const entry = entries[index] as PerformanceResourceTiming
    const url = entry.name
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) continue
    const host = hostOf(url)
    const initiator = entry.initiatorType || 'other'
    const size = typeof entry.transferSize === 'number' && entry.transferSize > 0
      ? entry.transferSize
      : typeof entry.encodedBodySize === 'number'
        ? entry.encodedBodySize
        : 0
    requests.push({
      url,
      host,
      type: typeOf(initiator),
      status: 0,
      thirdParty: host !== '' && host !== location.hostname.toLowerCase()
    })
    resources.push({ url, kind: kindOf(url, initiator), size })
  }

  const forms: MobileCapture['forms'] = []
  const formNodes = document.forms
  for (let index = 0; index < formNodes.length && index < 40; index += 1) {
    const form = formNodes[index]
    if (!form) continue
    const action = form.getAttribute('action') || ''
    let resolved = location.href
    try {
      resolved = new URL(action || location.href, location.href).href
    } catch {
      resolved = action
    }
    forms.push({
      action: resolved,
      method: (form.getAttribute('method') || 'GET').toUpperCase(),
      fields: form.elements ? form.elements.length : 0
    })
  }

  const cookies: MobileCapture['cookies'] = []
  const rawCookies = document.cookie ? document.cookie.split(';') : []
  for (const pair of rawCookies) {
    const name = pair.split('=')[0]?.trim() ?? ''
    if (!name) continue
    cookies.push({
      name,
      domain: location.hostname.toLowerCase(),
      secure: location.protocol === 'https:',
      httpOnly: false
    })
  }

  const mixedContent: string[] = []
  if (location.protocol === 'https:') {
    for (const request of requests) {
      if (request.url.startsWith('http://') && mixedContent.length < 40) mixedContent.push(request.url)
    }
  }

  // Design tokens: a sample of what the page actually paints with. Enough to
  // describe the system, small enough to cross the bridge.
  const counts: Record<string, Map<string, number>> = {
    colors: new Map(),
    fonts: new Map(),
    fontSizes: new Map(),
    radii: new Map(),
    shadows: new Map(),
    spacing: new Map()
  }
  const bump = (bucket: string, value: string): void => {
    if (!value || value === 'none' || value === '0px' || value === 'normal') return
    const map = counts[bucket]
    if (!map || map.size > 400) return
    map.set(value, (map.get(value) ?? 0) + 1)
  }
  const top = (bucket: string, limit: number): { value: string; count: number }[] => {
    const map = counts[bucket]
    if (!map) return []
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([value, count]) => ({ value, count }))
  }

  try {
    const all = document.querySelectorAll('*')
    for (let index = 0; index < all.length && index < 250; index += 1) {
      const node = all[index]
      if (!node) continue
      const style = getComputedStyle(node)
      bump('colors', style.backgroundColor)
      bump('colors', style.color)
      bump('fonts', (style.fontFamily || '').split(',')[0]?.replace(/["']/g, '').trim() ?? '')
      bump('fontSizes', style.fontSize)
      bump('radii', style.borderRadius)
      bump('shadows', style.boxShadow)
      bump('spacing', style.padding)
    }
  } catch {
    // A page that refuses computed styles still produces a usable report.
  }

  const html = document.documentElement.outerHTML
  return {
    finalUrl: location.href,
    origin: location.origin,
    title: document.title || location.href,
    capturedAt: Date.now(),
    durationMs: Math.max(0, Date.now() - started),
    html: html.slice(0, limit),
    htmlTruncated: html.length > limit,
    requests,
    resources,
    // Not observable from inside the page. The report says so rather than
    // implying the site has no CSP.
    documentHeaders: {},
    cookies,
    mixedContent,
    forms,
    tokens: {
      colors: top('colors', 10),
      fonts: top('fonts', 8),
      fontSizes: top('fontSizes', 8),
      radii: top('radii', 8),
      shadows: top('shadows', 6),
      spacing: top('spacing', 8),
      breakpoints: []
    },
    headersObserved: false
  }
}

/**
 * The expression the native surface evaluates.
 *
 * Wrapped in a function call so the page gets an expression, not a declaration,
 * and returned as text because that is the one shape both engines hand back
 * identically: Android JSON-quotes a string result, iOS returns it as-is, and the
 * plugin unquotes the first so the shell always parses the same thing.
 */
export function captureScript(): string {
  // `__name` is defined here because a bundler that keeps function names emits
  // `__name(fn, "pageCapture")` around the stringified body; without the shim the
  // page would throw a ReferenceError that reads like a broken capture.
  return (
    '(function(){var __name=function(value){return value};try{' +
    `return JSON.stringify((${pageCapture.toString()})())` +
    '}catch(error){return JSON.stringify({error:String(error)})}})()'
  )
}
