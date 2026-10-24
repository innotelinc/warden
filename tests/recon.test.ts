import { describe, expect, it } from 'vitest'
import { buildReport, isTrackerHost } from '../src/main/scry/recon'
import type { CaptureResult } from '../src/main/scry/capture'
import { sanitizeMailHtml, textToHtml } from '../src/main/mail/sanitize'
import { sanitizeSettings } from '../src/shared/settings'
import { parseUnreadTitle, resolveInput } from '../src/shared/urls'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'

function capture(overrides: Partial<CaptureResult> = {}): CaptureResult {
  return {
    url: 'https://app.example/',
    finalUrl: 'https://app.example/',
    origin: 'https://app.example',
    capturedAt: Date.now(),
    title: 'App',
    html: `<!DOCTYPE html><html><head><script src="/_next/static/chunks/main.js"></script></head>
      <body><div id="__next"></div><img src="http://cdn.example/x.png"><script>var a = 1</script></body></html>`,
    resources: [
      {
        url: 'https://app.example/_next/static/chunks/main.js',
        kind: 'script',
        mimeType: 'application/javascript',
        status: 200,
        body: Buffer.from('x'),
        size: 1,
        headers: {}
      }
    ],
    requests: [
      { url: 'https://app.example/', host: 'app.example', type: 'Document', status: 200, thirdParty: false },
      { url: 'https://www.google-analytics.com/collect', host: 'www.google-analytics.com', type: 'Script', status: 200, thirdParty: true },
      { url: 'https://app.example/api/session', host: 'app.example', type: 'Fetch', status: 200, thirdParty: false },
      { url: 'https://cdn.other.example/lib.js', host: 'cdn.other.example', type: 'Script', status: 200, thirdParty: true }
    ],
    cookies: [{ name: 'sid', domain: 'app.example', secure: true, httpOnly: true }],
    documentHeaders: { 'content-type': 'text/html', server: 'nginx' },
    tokens: {
      colors: [], fonts: [], fontSizes: [], radii: [], shadows: [], spacing: [], breakpoints: []
    },
    blocks: [],
    forms: [{ action: 'https://app.example/login', method: 'POST', fields: 2 }],
    mixedContent: ['http://cdn.example/x.png'],
    screenshot: null,
    durationMs: 900,
    ...overrides
  }
}

describe('buildReport', () => {
  const report = buildReport(capture())

  it('identifies the rendered stack from real evidence', () => {
    const names = report.technologies.map((tech) => tech.name)
    expect(names).toContain('Next.js')
    expect(names).toContain('nginx')
  })

  it('separates trackers from ordinary third parties', () => {
    expect(report.trackers.map((entry) => entry.host)).toContain('www.google-analytics.com')
    expect(report.thirdParties.map((entry) => entry.host)).toContain('cdn.other.example')
    expect(report.trackers.map((entry) => entry.host)).not.toContain('cdn.other.example')
  })

  it('reports missing security headers and insecure subresources', () => {
    expect(report.server.missingSecurityHeaders).toContain('Content-Security-Policy')
    expect(report.mixedContent).toHaveLength(1)
    expect(report.notes.join(' ')).toMatch(/tracking or advertising/i)
  })

  it('lists API endpoints without cookies or credentials', () => {
    expect(report.endpoints).toEqual(['https://app.example/api/session'])
    expect(report.cookies.map((cookie) => cookie.name)).toEqual(['sid'])
  })

  it('notes inline scripts and forms', () => {
    expect(report.notes.join(' ')).toMatch(/inline script/i)
    expect(report.notes.join(' ')).toMatch(/form/i)
  })

  it('matches tracker suffixes', () => {
    expect(isTrackerHost('ssl.google-analytics.com')).toBe(true)
    expect(isTrackerHost('example.com')).toBe(false)
  })
})

describe('mail sanitizer', () => {
  it('removes scripts, iframes and handlers', () => {
    const { html } = sanitizeMailHtml(
      '<div><script>alert(1)</script><iframe src="https://x"></iframe><img src="https://t/p.gif" onload="x()"></div>'
    )
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('onload')
    expect(html).toContain('default-src')
  })

  it('withholds remote images and counts them', () => {
    const result = sanitizeMailHtml('<img src="https://track.example/pixel.gif"><img src="data:image/gif;base64,AA">')
    expect(result.remoteCount).toBe(1)
    expect(result.html).not.toContain('https://track.example/pixel.gif')
    expect(result.html).toContain('data:image/gif')
  })

  it('neutralises javascript: links and opens the rest safely', () => {
    const { html } = sanitizeMailHtml('<a href="javascript:alert(1)">x</a><a href="https://ok.example">y</a>')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('target="_blank"')
  })

  it('escapes plain text and linkifies urls', () => {
    const html = textToHtml('<b>hi</b> https://example.com/x')
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('<a href="https://example.com/x"')
  })
})

describe('sanitizeSettings', () => {
  it('returns defaults for junk', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({ cookieMode: 'allow-all' }).cookieMode).toBe('block')
  })

  it('normalises the allowlist', () => {
    const settings = sanitizeSettings({ allowlist: ['App.Example', 'app.example', '  ', 42] })
    expect(settings.allowlist).toEqual(['app.example'])
  })

  it('clamps numeric controls', () => {
    expect(sanitizeSettings({ terminalFontSize: 999 }).terminalFontSize).toBe(22)
    expect(sanitizeSettings({ terminalFontSize: 1 }).terminalFontSize).toBe(10)
    expect(sanitizeSettings({ scryPort: 5 }).scryPort).toBe(1024)
  })

  it('refuses an empty homepage', () => {
    expect(sanitizeSettings({ homepage: '' }).homepage).toBe(DEFAULT_SETTINGS.homepage)
  })

  it('enforces the cookie policy floor even if the file says otherwise', () => {
    const settings = sanitizeSettings({ cookieMode: 'first-party' })
    expect(settings.cookieMode).toBe('first-party')
    expect(sanitizeSettings({}).cookieMode).toBe('block')
  })
})

describe('resolveInput', () => {
  const search = 'https://search.example/?q=%s'

  it('keeps explicit schemes', () => {
    expect(resolveInput('https://a.example/x', search)).toBe('https://a.example/x')
    expect(resolveInput('warden://newtab', search)).toBe('warden://newtab')
  })

  it('upgrades bare hosts and IPs correctly', () => {
    expect(resolveInput('example.com/path', search)).toBe('https://example.com/path')
    expect(resolveInput('192.168.1.88/admin', search)).toBe('http://192.168.1.88/admin')
    expect(resolveInput('localhost:8080', search)).toBe('http://localhost:8080')
  })

  it('falls back to search for plain words', () => {
    expect(resolveInput('how to block cookies', search)).toBe('https://search.example/?q=how%20to%20block%20cookies')
    expect(resolveInput('   ', search)).toBeNull()
  })
})

describe('parseUnreadTitle', () => {
  it('reads the count conventions chat apps use', () => {
    expect(parseUnreadTitle('(12) Slack')).toBe(12)
    expect(parseUnreadTitle('[3] Discord')).toBe(3)
    expect(parseUnreadTitle('7 • WhatsApp')).toBe(7)
    expect(parseUnreadTitle('Slack')).toBe(0)
  })
})
