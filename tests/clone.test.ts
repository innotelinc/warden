import { describe, expect, it } from 'vitest'
import type { CaptureResult } from '../src/main/scry/capture'
import { buildClonePlan, buildScaffold, slugFor } from '../src/main/scry/clone'
import { buildReport } from '../src/main/scry/recon'

const SOURCE = 'https://shop.example/p/1'

function capture(overrides: Partial<CaptureResult> = {}): CaptureResult {
  return {
    url: SOURCE,
    finalUrl: SOURCE,
    origin: 'https://shop.example',
    capturedAt: Date.now(),
    title: 'Shop',
    html: `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="/assets/site.css">
      </head><body>
      <header onclick="steal()">Head</header>
      <main><img src="/hero.png" srcset="/hero.png 2x"><script src="/app.js"></script></main>
      <script>window.__STATE__ = {}</script>
      </body></html>`,
    resources: [
      {
        url: 'https://shop.example/assets/site.css',
        kind: 'stylesheet',
        mimeType: 'text/css',
        status: 200,
        body: Buffer.from('body { background: url("/bg.png") }'),
        size: 36,
        headers: {}
      },
      {
        url: 'https://shop.example/hero.png',
        kind: 'image',
        mimeType: 'image/png',
        status: 200,
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        size: 4,
        headers: {}
      },
      {
        url: 'https://shop.example/bg.png',
        kind: 'image',
        mimeType: 'image/png',
        status: 200,
        body: Buffer.from([0x89, 0x50, 0x4e, 0x48]),
        size: 4,
        headers: {}
      },
      {
        url: 'https://shop.example/app.js',
        kind: 'script',
        mimeType: 'application/javascript',
        status: 200,
        body: Buffer.from('console.log(1)'),
        size: 14,
        headers: {}
      }
    ],
    requests: [
      { url: SOURCE, host: 'shop.example', type: 'Document', status: 200, thirdParty: false },
      { url: 'https://www.google-analytics.com/collect', host: 'www.google-analytics.com', type: 'Script', status: 200, thirdParty: true },
      { url: 'https://shop.example/api/cart', host: 'shop.example', type: 'Fetch', status: 200, thirdParty: false }
    ],
    cookies: [{ name: 'sid', domain: 'shop.example', secure: true, httpOnly: true }],
    documentHeaders: { server: 'nginx', 'content-type': 'text/html' },
    tokens: {
      colors: [{ value: 'rgb(1, 2, 3)', count: 10 }],
      fonts: [{ value: 'Inter', count: 4 }],
      fontSizes: [{ value: '14px', count: 9 }],
      radii: [{ value: '8px', count: 2 }],
      shadows: [],
      spacing: [{ value: '16px', count: 8 }],
      breakpoints: [{ value: '768px', count: 1 }]
    },
    blocks: [{ tag: 'header', id: '', className: 'site-head', html: '<header class="site-head">Head</header>' }],
    forms: [{ action: 'https://shop.example/checkout', method: 'POST', fields: 3 }],
    mixedContent: [],
    screenshot: null,
    durationMs: 1200,
    ...overrides
  }
}

describe('slugFor', () => {
  it('builds a filesystem-safe stem', () => {
    expect(slugFor('https://www.Example.com/a/b/?q=1')).toBe('example.com-a-b')
    expect(slugFor('not a url')).toBe('capture')
  })
})

describe('buildClonePlan', () => {
  const plan = buildClonePlan(capture())
  const fileAt = (path: string) => plan.files.find((file) => file.path === path)

  it('writes index.html plus every captured asset', () => {
    expect(fileAt('index.html')).toBeTruthy()
    expect(plan.files.some((file) => file.path.endsWith('.css'))).toBe(true)
    expect(plan.files.some((file) => file.path.endsWith('.png'))).toBe(true)
    expect(plan.assetCount).toBe(3)
  })

  it('strips scripts by default and records a warning', () => {
    const html = String(fileAt('index.html')?.content)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('__STATE__')
    expect(plan.warnings.join(' ')).toMatch(/scripts were removed/i)
  })

  it('keeps scripts when explicitly asked', () => {
    const withScripts = buildClonePlan(capture(), { includeScripts: true })
    const html = String(withScripts.files.find((file) => file.path === 'index.html')?.content)
    expect(html).toContain('src="./assets/script/')
    expect(withScripts.files.some((file) => file.path.endsWith('.js'))).toBe(true)
  })

  it('removes inline event handlers', () => {
    const html = String(fileAt('index.html')?.content)
    expect(html).not.toContain('onclick')
  })

  it('rewrites absolute references to local relative paths', () => {
    const html = String(fileAt('index.html')?.content)
    expect(html).toContain('./assets/stylesheet/')
    expect(html).toContain('./assets/image/')
    expect(html).not.toContain('https://shop.example/assets/site.css')
  })

  it('rewrites url() references inside captured CSS', () => {
    const css = plan.files.find((file) => file.path.endsWith('.css'))
    expect(String(css?.content)).toContain('url("./assets/image/')
  })

  it('adds a provenance banner', () => {
    const html = String(fileAt('index.html')?.content)
    expect(html).toContain('Reconstructed by WARDEN Scry')
    expect(html).toContain(SOURCE)
  })

  it('warns when nothing could be captured', () => {
    const empty = buildClonePlan(capture({ resources: [] }))
    expect(empty.warnings.join(' ')).toMatch(/no subresources/i)
  })
})

describe('buildScaffold', () => {
  const source = capture()
  const plan = buildClonePlan(source)
  const report = buildReport(source)
  const files = buildScaffold(source, report, plan, 'shop')
  const at = (path: string) => files.find((file) => file.path === path)

  it('emits a runnable Vite project', () => {
    expect(at('package.json')).toBeTruthy()
    expect(at('vite.config.ts')).toBeTruthy()
    expect(at('src/main.tsx')).toBeTruthy()
    expect(at('src/App.tsx')).toBeTruthy()
    const pkg = JSON.parse(String(at('package.json')?.content)) as { name: string; scripts: Record<string, string> }
    expect(pkg.name).toBe('shop')
    expect(pkg.scripts.dev).toBe('vite')
  })

  it('turns captured blocks into components', () => {
    expect(at('src/blocks/Block1.tsx')).toBeTruthy()
    expect(String(at('src/App.tsx')?.content)).toContain('<Block1 />')
  })

  it('copies assets into public and exports tokens', () => {
    expect(files.some((file) => file.path.startsWith('public/assets/'))).toBe(true)
    expect(String(at('src/styles/tokens.css')?.content)).toContain('--color-1: rgb(1, 2, 3)')
  })

  it('documents what the scaffold is not', () => {
    expect(String(at('README.md')?.content)).toMatch(/not\s+a port|not a port/i)
  })
})
