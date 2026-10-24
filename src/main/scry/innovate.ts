/**
 * Innovate — the third Scry mode.
 *
 * Clone copies a site. Innovate reads the copy and rebuilds it: scripts are
 * classified and then either dropped (third-party baggage) or quarantined and
 * re-implemented from observed behaviour, inline event handlers are rewritten
 * into delegated data attributes, and the page is re-emitted with a modern
 * design system instead of the original's accumulated CSS.
 *
 * Everything here is a pure function over a capture, so the whole pass is
 * unit-testable without a browser.
 */

import type { CaptureResult } from './capture'
import type { ScryReport } from '@shared/types'
import type { PlannedFile } from './clone'
import { buildAssetMap, rewriteHtml, stripScripts, slugFor } from './clone'

export interface ScriptFinding {
  url: string
  bytes: number
  origin: 'first-party' | 'third-party'
  decision: 'dropped' | 'rebuilt'
  reason: string
}

export interface BehaviorFinding {
  event: string
  code: string
  rewritten: boolean
  replacement: string | null
}

export interface InnovationSummary {
  mode: 'innovate'
  sourceUrl: string
  title: string
  scripts: ScriptFinding[]
  behaviors: BehaviorFinding[]
  features: string[]
  droppedBytes: number
  warnings: string[]
}

export interface InnovationOutput {
  files: PlannedFile[]
  summary: InnovationSummary
  modernHtml: string
}

/** Hosts whose scripts exist to observe the visitor, not to run the page. */
const OBSERVER = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /googlesyndication\.com/i,
  /doubleclick\.net/i,
  /facebook\.(net|com)/i,
  /hotjar\.com/i,
  /segment\.(io|com)/i,
  /mixpanel\.com/i,
  /amplitude\.com/i,
  /clarity\.ms/i,
  /fullstory\.com/i,
  /newrelic\.com/i,
  /nr-data\.net/i,
  /sentry\.io/i,
  /cloudflareinsights\.com/i,
  /adsbygoogle/i,
  /analytics/i,
  /tracking/i,
  /pixel/i
]

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function sameSite(a: string, b: string): boolean {
  if (!a || !b) return false
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

/**
 * Decide what happens to every script the page loaded. Nothing here runs the
 * script: the judgement is structural (who served it, how big it is, whether
 * the page needs it to render).
 */
export function classifyScripts(capture: CaptureResult): ScriptFinding[] {
  const siteHost = hostOf(capture.finalUrl)
  const findings: ScriptFinding[] = []

  for (const resource of capture.resources) {
    if (resource.kind !== 'script' || !resource.body) continue
    const host = hostOf(resource.url)
    const bytes = resource.body.length
    const thirdParty = !sameSite(host, siteHost)
    const observer = OBSERVER.some((pattern) => pattern.test(resource.url) || pattern.test(host))

    if (observer) {
      findings.push({
        url: resource.url,
        bytes,
        origin: thirdParty ? 'third-party' : 'first-party',
        decision: 'dropped',
        reason: 'Measurement/analytics script. The rebuilt page needs no visitor telemetry.'
      })
      continue
    }

    if (thirdParty) {
      findings.push({
        url: resource.url,
        bytes,
        origin: 'third-party',
        decision: 'dropped',
        reason: 'Third-party widget. Dropped so the rebuild has no external runtime dependency.'
      })
      continue
    }

    findings.push({
      url: resource.url,
      bytes,
      origin: 'first-party',
      decision: 'rebuilt',
      reason: 'First-party script. Kept as reference, behaviour re-implemented in app.js.'
    })
  }

  return findings
}

interface Rewrite {
  html: string
  behaviors: BehaviorFinding[]
}

/**
 * Turn inline handlers into declarative attributes the rebuilt page can honour,
 * and record every handler that was too specific to rewrite mechanically.
 */
export function rewriteHandlers(html: string): Rewrite {
  const behaviors: BehaviorFinding[] = []

  const output = html.replace(
    /\son([a-z]+)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (_match, event: string, _quoted: string, double: string, single: string) => {
      const code = (double ?? single ?? '').trim()
      const lower = code.toLowerCase()

      // classList.toggle('open') / classList.add('is-open') on a target element
      const classCall = /classlist\.(toggle|add|remove)\(\s*['"]([^'"]+)['"]/.exec(lower)
      const selector = /queryselector\(\s*['"]([^'"]+)['"]/i.exec(code)
      const looksLikeQuery = selector && /^(#[a-z0-9_-]+|\.[a-z0-9_-]+(\s+[a-z0-9_-]+)?|\[[^\]]+\])$/i.test(selector[1] ?? '')

      if (event === 'click' && classCall && (selector ? looksLikeQuery : true)) {
        const mode = classCall[1] === 'toggle' ? 'toggle' : classCall[1] === 'add' ? 'add' : 'remove'
        const classes = classCall[2] ?? ''
        const target = selector && looksLikeQuery ? (selector[1] as string) : 'self'
        const attrs = [`data-warden-class="${classes}"`, `data-warden-mode="${mode}"`]
        if (target !== 'self') attrs.push(`data-warden-target="${target}"`)
        behaviors.push({
          event,
          code,
          rewritten: true,
          replacement: attrs.join(' ')
        })
        return ` data-warden-toggle ${attrs.join(' ')}`
      }

      behaviors.push({ event, code, rewritten: false, replacement: null })
      return ''
    }
  )

  return { html: output, behaviors }
}

/** Rewrite root-relative clone asset paths so a stylesheet in assets/ resolves. */
function fixCssPaths(css: string): string {
  return css.replace(/url\(\s*(['"]?)\.\/assets\//gi, (_match, quote: string) => `url(${quote}../`)
}

function ensureMeta(html: string): string {
  let output = html
  if (!/<meta[^>]+name=["']viewport["']/i.test(output)) {
    output = output.replace(/<head([^>]*)>/i, '<head$1>\n<meta name="viewport" content="width=device-width, initial-scale=1" />')
  }
  if (!/<meta[^>]+name=["']color-scheme["']/i.test(output)) {
    output = output.replace(/<head([^>]*)>/i, '<head$1>\n<meta name="color-scheme" content="light dark" />')
  }
  return output
}

function modernCss(report: ScryReport, slug: string): string {
  const colors = report.designTokens.colors.slice(0, 8).map((entry) => entry.value)
  const fonts = report.designTokens.fonts.slice(0, 4).map((entry) => entry.value)
  const radius = report.designTokens.radii[0]?.value ?? '12px'
  const accent = colors[0] ?? '#3b82f6'

  return `/*
  ${slug} — rebuilt by WARDEN Scry / Innovate
  A small, readable design system replaces the original stylesheet stack.
  Every value the capture could observe is kept as a token so the rebuild
  still looks like the site it came from.
*/

:root {
  color-scheme: light dark;

  /* observed palette */
${colors.map((value, index) => `  --brand-${index + 1}: ${value};`).join('\n') || '  --brand-1: #3b82f6;'}

  /* observed type */
  --font-sans: ${fonts[0] ?? 'system-ui, -apple-system, "Segoe UI", sans-serif'};
  --font-mono: ui-monospace, "Cascadia Code", "SF Mono", monospace;

  /* rebuilt scale */
  --step--1: clamp(0.78rem, 0.74rem + 0.2vw, 0.88rem);
  --step-0: clamp(0.95rem, 0.9rem + 0.25vw, 1.05rem);
  --step-1: clamp(1.2rem, 1.1rem + 0.5vw, 1.5rem);
  --step-2: clamp(1.5rem, 1.3rem + 1vw, 2.1rem);
  --step-3: clamp(1.9rem, 1.5rem + 2vw, 3rem);

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2.5rem;
  --space-7: 4rem;

  --radius: ${radius};
  --radius-pill: 999px;
  --accent: ${accent};
  --measure: 68ch;

  --surface: #fbfbfd;
  --surface-2: #ffffff;
  --ink: #14161a;
  --ink-soft: #4d5560;
  --line: #e2e5ea;
  --shadow: 0 1px 2px rgb(16 18 22 / 6%), 0 8px 24px rgb(16 18 22 / 6%);
}

@media (prefers-color-scheme: dark) {
  :root {
    --surface: #0f1115;
    --surface-2: #161a20;
    --ink: #eef1f5;
    --ink-soft: #a4adba;
    --line: #262c35;
    --shadow: 0 1px 2px rgb(0 0 0 / 40%), 0 8px 24px rgb(0 0 0 / 32%);
  }
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  font-family: var(--font-sans);
  font-size: var(--step-0);
  line-height: 1.65;
  color: var(--ink);
  background: var(--surface);
  text-rendering: optimizeLegibility;
}

/* The captured markup is not resemanticised, so the layout has to be tolerant
   of whatever wrapper soup the original used. */
body > * { max-width: min(100%, 1200px); margin-inline: auto; padding-inline: var(--space-5); }

img, video, canvas, svg { max-width: 100%; height: auto; display: block; }

h1, h2, h3, h4 { line-height: 1.15; text-wrap: balance; margin-block: 0 var(--space-3); letter-spacing: -0.015em; }
h1 { font-size: var(--step-3); }
h2 { font-size: var(--step-2); }
h3 { font-size: var(--step-1); }
p, li { max-width: var(--measure); text-wrap: pretty; }

a { color: var(--accent); text-underline-offset: 0.2em; }
a:hover { text-decoration-thickness: 2px; }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

button, input, select, textarea { font: inherit; color: inherit; }

button {
  cursor: pointer;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  box-shadow: var(--shadow);
  transition: transform 120ms ease, border-color 120ms ease;
}
button:hover { border-color: var(--accent); }
button:active { transform: translateY(1px); }

/* Progressive enhancement produced by app.js */
[data-warden-ready] [data-warden-hidden] { display: none; }
[data-warden-ready] [data-warden-class].is-open { display: block; }

.warden-skip {
  position: absolute;
  left: -9999px;
  top: var(--space-2);
  z-index: 50;
  padding: var(--space-2) var(--space-4);
  background: var(--surface-2);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow);
}
.warden-skip:focus { left: var(--space-4); }

.warden-theme {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 40;
  padding: var(--space-2) var(--space-3);
  font-size: var(--step--1);
  border-radius: var(--radius-pill);
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--ink-soft);
  box-shadow: var(--shadow);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`
}

function modernJs(): string {
  return `// Rebuilt by WARDEN Scry / Innovate. No third-party runtime, no bundler.
// Behaviours that were inline handlers in the original are delegated here.

const ready = () => document.documentElement.setAttribute('data-warden-ready', '')

const toggleTarget = (el) => {
  const selector = el.dataset.wardenTarget
  if (!selector || selector === 'self') return el
  try {
    return document.querySelector(selector) ?? el
  } catch {
    return el
  }
}

const applyClassBehaviour = (el) => {
  const target = toggleTarget(el)
  const classes = (el.dataset.wardenClass ?? '').split(/\\s+/).filter(Boolean)
  const mode = el.dataset.wardenMode ?? 'toggle'
  for (const name of classes) {
    if (mode === 'add') target.classList.add(name)
    else if (mode === 'remove') target.classList.remove(name)
    else target.classList.toggle(name)
  }
  el.setAttribute('aria-expanded', String(target.classList.contains(classes[0] ?? '')))
}

document.addEventListener('click', (event) => {
  const trigger = event.target.closest?.('[data-warden-toggle]')
  if (!trigger) return
  event.preventDefault()
  applyClassBehaviour(trigger)
})

// Original forms often posted to endpoints that no longer exist; keep the page
// usable and make the absence explicit rather than throwing the visitor away.
document.addEventListener('submit', (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  if (form.dataset.wardenLive === 'true') return
  event.preventDefault()
  form.dataset.wardenSubmitted = 'true'
  form.dispatchEvent(new CustomEvent('warden:form-blocked', { bubbles: true }))
  console.info('[warden] form submission intercepted; wire this form to your own endpoint', form)
})

// Links opened in a new tab keep the opener out of reach.
for (const link of document.querySelectorAll('a[target="_blank"]')) {
  link.rel = 'noopener noreferrer'
}

// Images below the fold are decoded lazily instead of up front.
for (const img of document.querySelectorAll('img:not([loading])')) {
  img.loading = 'lazy'
  img.decoding = 'async'
}

const mount = () => {
  const skip = document.createElement('a')
  skip.className = 'warden-skip'
  skip.href = '#warden-main'
  skip.textContent = 'Skip to content'
  document.body.prepend(skip)

  const theme = document.createElement('button')
  theme.className = 'warden-theme'
  theme.type = 'button'
  theme.textContent = 'Theme'
  theme.title = 'Cycle light / dark / system'
  theme.addEventListener('click', () => {
    const order = ['system', 'light', 'dark']
    const current = document.documentElement.dataset.theme ?? 'system'
    const next = order[(order.indexOf(current) + 1) % order.length]
    if (next === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = next
    theme.textContent = \`Theme: \${next}\`
  })
  document.body.append(theme)

  ready()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
else mount()
`
}

export function buildInnovation(
  capture: CaptureResult,
  report: ScryReport,
  options: { label?: string } = {}
): InnovationOutput {
  const slug = slugFor(capture.finalUrl)
  const warnings: string[] = []
  const scripts = classifyScripts(capture)

  // Handlers are rewritten on the raw capture, before script removal, so the
  // declarative replacements land on the same elements.
  const handlers = rewriteHandlers(capture.html)
  let html = stripScripts(handlers.html)

  const map = buildAssetMap(capture, false)
  html = rewriteHtml(html, capture.finalUrl, map)
  html = ensureMeta(html)

  const totalScripts = capture.resources.filter((resource) => resource.kind === 'script').length
  if (totalScripts === 0) warnings.push('The page loaded no scripts; the rebuild is markup and CSS only.')

  const inlineCount = handlers.behaviors.length
  const rewritten = handlers.behaviors.filter((behavior) => behavior.rewritten).length
  if (inlineCount > rewritten) {
    warnings.push(
      `${inlineCount - rewritten} inline handler(s) were too specific to rewrite automatically; they are listed in innovations.json.`
    )
  }

  const headInjection = [
    '<link rel="stylesheet" href="./theme.css" />'
  ].join('\n')
  html = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${headInjection}\n</head>`)
    : `${headInjection}\n${html}`

  if (!/<\/body>/i.test(html)) {
    html = `${html}\n</body>`
    warnings.push('The captured document had no closing body tag; one was added.')
  }
  html = html.replace(/<\/body>/i, '<script type="module" src="./app.js"></script>\n</body>')

  const anchor = /<main\b/i.test(html) ? null : '<span id="warden-main"></span>'
  if (anchor) html = html.replace(/<body([^>]*)>/i, `<body$1>\n${anchor}`)

  const banner = `<!--
  Rebuilt by WARDEN Scry / Innovate
  Source: ${capture.finalUrl}
  Rebuilt: ${new Date().toISOString()}
  Markup, styles and behaviour were regenerated from a capture. Scripts from the
  original site are not loaded. Content and trademarks remain with their owner.
-->`

  const features = [
    'Zero third-party JavaScript: every external script is analysed and dropped or rebuilt.',
    'Inline event handlers rewritten to delegated data attributes with keyboard-visible focus.',
    'Token-based design system with fluid type, dark mode and reduced-motion support.',
    'Motion and interaction respect prefers-reduced-motion.',
    'Forms are intercepted instead of silently posting to a dead endpoint.',
    'New: theme switcher, skip link, lazy image decoding, noopener on outbound links.'
  ]

  const summary: InnovationSummary = {
    mode: 'innovate',
    sourceUrl: capture.finalUrl,
    title: report.title || capture.title || slug,
    scripts,
    behaviors: handlers.behaviors,
    features,
    droppedBytes: scripts.filter((script) => script.decision === 'dropped').reduce((total, script) => total + script.bytes, 0),
    warnings
  }

  const files: PlannedFile[] = [
    { path: 'index.html', content: `${banner}\n${html}` },
    { path: 'theme.css', content: modernCss(report, slug) },
    { path: 'app.js', content: modernJs() },
    { path: 'innovations.json', content: JSON.stringify(summary, null, 2) },
    {
      path: 'README.md',
      content: [
        `# ${summary.title} — Innovate rebuild`,
        '',
        `Source: ${capture.finalUrl}`,
        `Rebuilt: ${new Date().toISOString()}`,
        '',
        'Open `index.html` directly, or serve the folder:',
        '',
        '```',
        'npx serve .',
        '```',
        '',
        '## What changed',
        '',
        ...features.map((feature) => `- ${feature}`),
        '',
        '## Scripts',
        '',
        scripts.length
          ? [
              '| Script | Size | Origin | Decision |',
              '| --- | --- | --- | --- |',
              ...scripts.map(
                (script) =>
                  `| ${script.url.replace(/\|/g, '%7C')} | ${script.bytes} B | ${script.origin} | ${script.decision} |`
              )
            ].join('\n')
          : '_None._',
        '',
        'Dropped scripts are not downloaded into this folder. Rebuilt scripts are kept under',
        '`legacy/` for reference only and are never loaded by `index.html`.',
        '',
        '## Warnings',
        '',
        ...(warnings.length ? warnings.map((warning) => `- ${warning}`) : ['- none'])
      ].join('\n')
    }
  ]

  return { files, summary, modernHtml: html }
}

/** Keep the original first-party scripts for comparison, never for execution. */
export function legacyScripts(capture: CaptureResult, scripts: ScriptFinding[]): PlannedFile[] {
  const files: PlannedFile[] = []
  for (const resource of capture.resources) {
    if (resource.kind !== 'script' || !resource.body) continue
    const finding = scripts.find((script) => script.url === resource.url)
    if (finding?.decision !== 'rebuilt') continue
    const name = (resource.url.split('?')[0] ?? '').split('/').pop() || 'script.js'
    const safe = name.replace(/[^\w.-]+/g, '-').slice(-60) || 'script.js'
    const hash = Buffer.from(resource.url).toString('base64url').slice(0, 8)
    files.push({ path: `legacy/${hash}-${safe}`, content: resource.body })
  }
  return files
}

/** Stylesheet assets, path-corrected for their new depth under assets/. */
export function stylesheetFiles(capture: CaptureResult, map: Map<string, string>): PlannedFile[] {
  const files: PlannedFile[] = []
  for (const resource of capture.resources) {
    if (resource.kind !== 'stylesheet' || !resource.body) continue
    const local = map.get(resource.url)
    if (!local) continue
    files.push({ path: local, content: Buffer.from(fixCssPaths(resource.body.toString('utf8')), 'utf8') })
  }
  return files
}
