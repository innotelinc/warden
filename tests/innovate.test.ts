import { describe, expect, it } from 'vitest'
import type { CaptureResult } from '../src/main/scry/capture'
import { buildInnovation, classifyScripts, rewriteHandlers } from '../src/main/scry/innovate'
import type { ScryReport } from '../src/shared/types'

const PAGE = 'https://news.example.com/story'

function capture(overrides: Partial<CaptureResult> = {}): CaptureResult {
  return {
    url: PAGE,
    finalUrl: PAGE,
    origin: 'https://news.example.com',
    capturedAt: Date.now(),
    title: 'Story',
    html: [
      '<!doctype html><html><head><title>Story</title>',
      '<script src="/app.js"></script>',
      '<link rel="stylesheet" href="/site.css">',
      '</head><body>',
      '<nav id="menu" class="menu"><a href="/">Home</a></nav>',
      '<button onclick="document.querySelector(\'#menu\').classList.toggle(\'open\')">Menu</button>',
      '<button onclick="window.legacyWidget.mount(4)">Widget</button>',
      '<script>console.log("inline")</script>',
      '</body></html>'
    ].join(''),
    resources: [
      {
        url: 'https://news.example.com/app.js',
        kind: 'script',
        mimeType: 'application/javascript',
        status: 200,
        body: Buffer.from('function boot(){return 1}'),
        size: 23,
        headers: {}
      },
      {
        url: 'https://www.google-analytics.com/analytics.js',
        kind: 'script',
        mimeType: 'application/javascript',
        status: 200,
        body: Buffer.from('/* tag */'),
        size: 9,
        headers: {}
      },
      {
        url: 'https://news.example.com/site.css',
        kind: 'stylesheet',
        mimeType: 'text/css',
        status: 200,
        body: Buffer.from('body{background:url("./assets/image/hero.png")}'),
        size: 48,
        headers: {}
      }
    ],
    requests: [],
    cookies: [],
    documentHeaders: {},
    tokens: { colors: [], fonts: [], fontSizes: [], radii: [], spacing: [], shadows: [], breakpoints: [] },
    blocks: [],
    forms: [],
    mixedContent: [],
    screenshot: null,
    durationMs: 10,
    ...overrides
  }
}

function report(): ScryReport {
  return {
    origin: 'https://news.example.com',
    url: PAGE,
    title: 'Story',
    capturedAt: Date.now(),
    durationMs: 10,
    requests: 3,
    transferredBytes: 80,
    technologies: [],
    server: { headers: {}, missingSecurityHeaders: [] },
    thirdParties: [],
    trackers: [],
    cookies: [],
    mixedContent: [],
    endpoints: [],
    forms: [],
    designTokens: {
      colors: [{ value: '#0b1220', count: 9 }],
      fonts: [{ value: 'Inter, sans-serif', count: 4 }],
      fontSizes: [],
      radii: [{ value: '10px', count: 2 }],
      spacing: [],
      shadows: [],
      breakpoints: []
    },
    notes: []
  }
}

describe('classifyScripts', () => {
  it('drops analytics and rebuilds first-party code', () => {
    const findings = classifyScripts(capture())
    const ga = findings.find((finding) => finding.url.includes('google-analytics'))
    const app = findings.find((finding) => finding.url.endsWith('/app.js'))

    expect(ga?.decision).toBe('dropped')
    expect(app?.decision).toBe('rebuilt')
    expect(app?.origin).toBe('first-party')
  })

  it('drops third-party widgets that are not measurement', () => {
    const base = capture()
    const findings = classifyScripts({
      ...base,
      resources: [
        {
          url: 'https://cdn.widgets.io/embed.js',
          kind: 'script',
          mimeType: 'application/javascript',
          status: 200,
          body: Buffer.from('x'),
          size: 1,
          headers: {}
        }
      ]
    })
    expect(findings[0]?.decision).toBe('dropped')
  })
})

describe('rewriteHandlers', () => {
  it('turns a classList toggle into data attributes', () => {
    const result = rewriteHandlers('<button onclick="document.querySelector(\'#menu\').classList.toggle(\'open\')">x</button>')
    expect(result.html).toContain('data-warden-toggle')
    expect(result.html).toContain('data-warden-target="#menu"')
    expect(result.html).toContain('data-warden-class="open"')
    expect(result.html).not.toContain('onclick')
    expect(result.behaviors[0]?.rewritten).toBe(true)
  })

  it('records handlers it cannot rewrite and removes them anyway', () => {
    const result = rewriteHandlers('<button onclick="window.legacyWidget.mount(4)">x</button>')
    expect(result.html).not.toContain('onclick')
    expect(result.behaviors).toHaveLength(1)
    expect(result.behaviors[0]?.rewritten).toBe(false)
  })

  it('leaves markup without handlers untouched', () => {
    const html = '<main><p>hello</p></main>'
    expect(rewriteHandlers(html).html).toBe(html)
    expect(rewriteHandlers(html).behaviors).toHaveLength(0)
  })
})

describe('buildInnovation', () => {
  const output = buildInnovation(capture(), report())

  it('emits a self-contained modern build', () => {
    const paths = output.files.map((file) => file.path)
    expect(paths).toEqual(
      expect.arrayContaining(['index.html', 'theme.css', 'app.js', 'innovations.json', 'README.md'])
    )
  })

  it('loads no original scripts', () => {
    const html = output.files.find((file) => file.path === 'index.html')!.content as string
    expect(html).not.toContain('google-analytics')
    expect(html).not.toContain('console.log("inline")')
    expect(html).toContain('src="./app.js"')
    expect(html).toContain('./theme.css')
  })

  it('keeps the rewritten handler and the observed element id', () => {
    const html = output.files.find((file) => file.path === 'index.html')!.content as string
    expect(html).toContain('data-warden-target="#menu"')
    expect(html).toContain('id="menu"')
  })

  it('summarises what it dropped and what it could not rewrite', () => {
    expect(output.summary.scripts.filter((script) => script.decision === 'dropped')).toHaveLength(1)
    expect(output.summary.droppedBytes).toBeGreaterThan(0)
    expect(output.summary.behaviors.filter((behavior) => !behavior.rewritten)).toHaveLength(1)
    expect(output.summary.warnings.join(' ')).toMatch(/too specific/)
  })

  it('writes the innovation manifest next to the build', () => {
    const manifest = JSON.parse(output.files.find((file) => file.path === 'innovations.json')!.content as string)
    expect(manifest.mode).toBe('innovate')
    expect(manifest.sourceUrl).toBe(PAGE)
    expect(manifest.features.length).toBeGreaterThan(0)
  })
})
