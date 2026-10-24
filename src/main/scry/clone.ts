import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CaptureResult } from './capture'
import type { ScryReport } from '@shared/types'

export interface PlannedFile {
  path: string
  content: Buffer | string
}

export interface ClonePlan {
  files: PlannedFile[]
  warnings: string[]
  assetCount: number
  bytes: number
}

export interface CloneOptions {
  includeScripts?: boolean
  label?: string
}

const EXT_BY_MIME: Record<string, string> = {
  'text/css': '.css',
  'text/html': '.html',
  'application/javascript': '.js',
  'text/javascript': '.js',
  'application/json': '.json',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'application/font-woff2': '.woff2'
}

export function slugFor(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')
    const pathPart = parsed.pathname.replace(/\/+$/, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
    return `${host}${pathPart ? `-${pathPart}` : ''}`.slice(0, 80).toLowerCase() || 'capture'
  } catch {
    return 'capture'
  }
}

function extensionFor(url: string, mimeType: string): string {
  const fromMime = EXT_BY_MIME[mimeType.split(';')[0]?.trim().toLowerCase() ?? '']
  if (fromMime) return fromMime
  try {
    const ext = path.extname(new URL(url).pathname)
    if (ext && ext.length <= 6) return ext
  } catch {
    /* fall through */
  }
  return '.bin'
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function stripScripts(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
}

export function stripInlineHandlers(html: string): string {
  return html
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\sintegrity\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
}

export function rewriteReferences(text: string, map: Map<string, string>): string {
  let output = text
  const entries = [...map.entries()].sort((a, b) => b[0].length - a[0].length)
  for (const [absolute, local] of entries) {
    output = output.split(absolute).join(local)
    const escaped = absolute.replace(/&/g, '&amp;')
    if (escaped !== absolute) output = output.split(escaped).join(local)
  }
  return output
}

/** Resolve a possibly-relative reference against the document it came from. */
function resolveLocal(value: string, base: string, map: Map<string, string>): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return null
  const direct = map.get(trimmed) ?? map.get(trimmed.replace(/^\.\//, ''))
  if (direct) return direct
  try {
    const absolute = new URL(trimmed, base).toString()
    return map.get(absolute) ?? map.get(absolute.replace(/#.*$/, '')) ?? null
  } catch {
    return null
  }
}

function rewriteCssUrls(css: string, base: string, map: Map<string, string>): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, url: string) => {
    const local = resolveLocal(url, base, map)
    return local ? `url("./${local}")` : match
  })
}

function rewriteCss(css: string, base: string, map: Map<string, string>): string {
  let output = rewriteCssUrls(css, base, map)
  output = output.replace(/@import\s+(?:url\()?["']?([^"')\s]+)["']?\)?\s*;/gi, (match, url: string) => {
    const local = resolveLocal(url, base, map)
    return local ? `@import url("./${local}");` : match
  })
  return rewriteReferences(output, map)
}

export function rewriteHtml(html: string, base: string, map: Map<string, string>): string {
  let output = html.replace(
    /\b(src|href|poster|data-src|action)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (match, attr: string, _quoted: string, double: string, single: string) => {
      const value = double ?? single ?? ''
      const local = resolveLocal(value, base, map)
      return local ? `${attr}="./${local}"` : match
    }
  )

  output = output.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (_match, _quoted, double: string, single: string) => {
    const raw = double ?? single ?? ''
    const parts = raw
      .split(',')
      .map((part) => {
        const [url, ...descriptors] = part.trim().split(/\s+/)
        const local = url ? resolveLocal(url, base, map) : null
        return [local ? `./${local}` : url, ...descriptors].filter(Boolean).join(' ')
      })
      .filter(Boolean)
    return `srcset="${parts.join(', ')}"`
  })

  output = rewriteCssUrls(output, base, map)
  return rewriteReferences(output, map)
}

export function buildAssetMap(capture: CaptureResult, includeScripts = false): Map<string, string> {
  const map = new Map<string, string>()
  for (const resource of capture.resources) {
    if (!resource.body || resource.kind === 'document') continue
    if (!includeScripts && resource.kind === 'script') continue
    map.set(
      resource.url,
      `assets/${resource.kind}/${shortHash(resource.url)}${extensionFor(resource.url, resource.mimeType)}`
    )
  }
  return map
}

export function buildClonePlan(capture: CaptureResult, options: CloneOptions = {}): ClonePlan {
  const includeScripts = options.includeScripts ?? false
  const warnings: string[] = []
  const files: PlannedFile[] = []
  const map = buildAssetMap(capture, includeScripts)
  let bytes = 0
  let assetCount = 0

  for (const resource of capture.resources) {
    if (!resource.body || resource.kind === 'document') continue
    if (!includeScripts && resource.kind === 'script') continue
    const local = map.get(resource.url)
    if (!local) continue
    const content =
      resource.kind === 'stylesheet'
        ? Buffer.from(rewriteCss(resource.body.toString('utf8'), resource.url, map), 'utf8')
        : resource.body
    files.push({ path: local, content })
    bytes += content.length
    assetCount += 1
  }

  let html = capture.html
  if (!includeScripts) {
    html = stripScripts(html)
    warnings.push('Scripts were removed. JavaScript-driven content will be missing from this static copy.')
  }
  html = stripInlineHandlers(html)
  html = rewriteHtml(html, capture.finalUrl, map)

  if (!/<meta[^>]+charset/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, '<head$1>\n<meta charset="utf-8" />')
  }

  const banner = `<!--\n  Reconstructed by WARDEN Scry\n  Source: ${capture.finalUrl}\n  Captured: ${new Date().toISOString()}\n  This is a static copy for analysis. Behaviour, trademarks and content remain with the original owner.\n-->`
  html = `${banner}\n${html}`

  files.unshift({ path: 'index.html', content: html })
  bytes += Buffer.byteLength(html)

  if (assetCount === 0) {
    warnings.push('No subresources were captured; only the DOM shell was written.')
  }

  return { files, warnings, assetCount, bytes }
}

export async function writePlan(root: string, plan: ClonePlan): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  for (const file of plan.files) {
    const target = path.join(root, file.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, file.content)
  }
}

export async function writeJson(root: string, name: string, value: unknown): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2), 'utf8')
}

function tokenCss(report: ScryReport): string {
  const lines: string[] = [':root {']
  report.designTokens.colors.slice(0, 12).forEach((entry, index) => {
    lines.push(`  --color-${index + 1}: ${entry.value};`)
  })
  if (report.designTokens.fonts[0]) lines.push(`  --font-sans: ${report.designTokens.fonts[0].value};`)
  if (report.designTokens.radii[0]) lines.push(`  --radius: ${report.designTokens.radii[0].value};`)
  report.designTokens.spacing.slice(0, 6).forEach((entry, index) => {
    lines.push(`  --space-${index + 1}: ${entry.value};`)
  })
  lines.push('}')
  return lines.join('\n')
}

/**
 * Emit a runnable Vite + React project whose components mirror the captured
 * top-level blocks. It is a design scaffold, not a behaviour port.
 */
export function buildScaffold(
  capture: CaptureResult,
  report: ScryReport,
  plan: ClonePlan,
  label: string
): PlannedFile[] {
  const name = (label || slugFor(capture.finalUrl)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'reconstruction'
  const blocks = capture.blocks.length
    ? capture.blocks
    : [{ tag: 'div', id: '', className: '', html: capture.html }]

  const files: PlannedFile[] = []
  const assets = plan.files.filter((file) => file.path.startsWith('assets/'))
  for (const asset of assets) files.push({ path: `public/${asset.path}`, content: asset.content })

  files.push({
    path: 'package.json',
    content: JSON.stringify(
      {
        name,
        private: true,
        version: '0.1.0',
        type: 'module',
        scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
        devDependencies: {
          '@types/react': '^19.0.0',
          '@types/react-dom': '^19.0.0',
          '@vitejs/plugin-react': '^4.3.0',
          typescript: '~5.6.0',
          vite: '^6.0.0'
        }
      },
      null,
      2
    )
  })
  files.push({
    path: 'vite.config.ts',
    content: `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({ plugins: [react()], server: { port: 5180 } })\n`
  })
  files.push({
    path: 'tsconfig.json',
    content: JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          skipLibCheck: true,
          noEmit: true
        },
        include: ['src']
      },
      null,
      2
    )
  })
  files.push({
    path: 'index.html',
    content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>${capture.title || name}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`
  })
  files.push({
    path: 'src/main.tsx',
    content: `import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App'\nimport './styles/tokens.css'\nimport './styles/global.css'\n\ncreateRoot(document.getElementById('root')!).render(<App />)\n`
  })
  files.push({
    path: 'src/styles/tokens.css',
    content: `${tokenCss(report)}\n`
  })
  files.push({
    path: 'src/styles/global.css',
    content: `*, *::before, *::after { box-sizing: border-box; }\nhtml, body { margin: 0; padding: 0; }\nbody { font-family: var(--font-sans, system-ui, sans-serif); background: var(--color-1, #fff); color: var(--color-2, #111); }\nimg, video { max-width: 100%; height: auto; }\n.block { display: block; }\n`
  })

  const imports: string[] = []
  const uses: string[] = []
  blocks.forEach((block, index) => {
    const component = `Block${index + 1}`
    imports.push(`import ${component} from './blocks/${component}'`)
    uses.push(`      <${component} />`)
    files.push({
      path: `src/blocks/${component}.tsx`,
      content: `const html = ${JSON.stringify(block.html)}\n\n/** ${block.tag}${block.id ? `#${block.id}` : ''}${block.className ? ` .${block.className.split(/\s+/)[0]}` : ''} */\nexport default function ${component}() {\n  return <div className="block" dangerouslySetInnerHTML={{ __html: html }} />\n}\n`
    })
  })

  files.push({
    path: 'src/App.tsx',
    content: `${imports.join('\n')}\n\nexport default function App() {\n  return (\n    <main>\n${uses.join('\n')}\n    </main>\n  )\n}\n`
  })

  files.push({
    path: 'README.md',
    content: `# ${capture.title || name}\n\nReconstructed with **WARDEN Scry** from <${capture.finalUrl}> on ${new Date(capture.capturedAt).toISOString()}.\n\n## What this is\n\n- A Vite + React scaffold shaped around the captured page's top-level blocks.\n- The original CSS and media that could be captured, copied locally under \`public/assets\`.\n- Design tokens extracted from computed styles and used as CSS variables.\n\n## What this is not\n\nA port of the original application's behaviour, data or authentication. Scripts are removed and inline handlers are stripped by default, so interactive features will not work. Rebuilding those means writing new code against the original's documented APIs.\n\n## Run it\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\n## Scry findings\n\n${report.notes.map((note) => `- ${note}`).join('\n')}\n\n## Detected stack\n\n${report.technologies.map((tech) => `- ${tech.name} — ${tech.evidence}`).join('\n') || '- none detected'}\n`
  })

  return files
}
