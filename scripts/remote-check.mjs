#!/usr/bin/env node
/**
 * Remote-path verification.
 *
 * 1. serves a small page (and a third-party script from another origin)
 * 2. launches headless Chrome with a debug port and a throwaway profile inside .tmp
 * 3. runs the remote CDP integration test against it
 * 4. asks the REA CLI to list the same targets, proving the optional escalation works
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE_PORT = 4322
const THIRD_PARTY_PORT = 4323
const CDP_PORT = 9333
const ORIGIN = `http://127.0.0.1:${PAGE_PORT}`

const DOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const STYLE = `:root { --brand: rgb(79, 227, 193); }
body { margin: 0; background: url('/dot.png'); color: rgb(12, 18, 24); font-family: "Inter", system-ui, sans-serif; }
.card { padding: 24px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }`

const PAGE = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>remote capture target</title>
<link rel="stylesheet" href="/style.css">
<script src="http://localhost:${THIRD_PARTY_PORT}/lib.js"></script>
</head>
<body>
  <header class="card"><h1>remote capture target</h1></header>
  <main class="card"><p>Scry should see the CSS, the image and the third-party script.</p></main>
  <footer><img src="/dot.png" alt=""></footer>
</body></html>`

const pageServer = createServer((request, response) => {
  if (request.url?.startsWith('/style.css')) {
    response.writeHead(200, { 'content-type': 'text/css' })
    response.end(STYLE)
    return
  }
  if (request.url?.startsWith('/dot.png')) {
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(DOT_PNG)
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', server: 'warden-test' })
  response.end(PAGE)
})

const thirdPartyServer = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/javascript' })
  response.end('window.__thirdParty = true;')
})

await new Promise((resolve) => pageServer.listen(PAGE_PORT, '127.0.0.1', resolve))
await new Promise((resolve) => thirdPartyServer.listen(THIRD_PARTY_PORT, '127.0.0.1', resolve))

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean)

const profileDir = path.join(root, '.tmp', 'chrome-profile')
await fs.mkdir(profileDir, { recursive: true })

let chrome = null
let chromePath = null
for (const candidate of chromeCandidates) {
  try {
    await fs.access(candidate)
    chromePath = candidate
    break
  } catch {
    /* try next */
  }
}

const cleanup = async () => {
  pageServer.close()
  thirdPartyServer.close()
  if (chrome) {
    try {
      chrome.kill()
    } catch {
      /* already gone */
    }
  }
}

if (!chromePath) {
  console.error('No Chrome binary found. Set CHROME_PATH to run the remote verification.')
  await cleanup()
  process.exit(1)
}

console.log(`launching ${chromePath}`)
chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--disable-background-networking',
    '--disable-gpu',
    `${ORIGIN}/`
  ],
  { stdio: 'ignore', windowsHide: true }
)

let ready = false
for (let attempt = 0; attempt < 60; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
    if (response.ok) {
      ready = true
      break
    }
  } catch {
    /* not up yet */
  }
}

if (!ready) {
  console.error('Chrome did not open the debug port')
  await cleanup()
  process.exit(1)
}

console.log(`CDP ready on ${CDP_PORT}`)

/**
 * Run a child **asynchronously**. spawnSync would block this process's event
 * loop, which also serves the test pages, so the reloaded page could never load.
 */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: true, ...options })
    let output = ''
    if (options.capture) {
      child.stdout.on('data', (chunk) => (output += chunk.toString()))
      child.stderr.on('data', (chunk) => (output += chunk.toString()))
    }
    child.on('error', (error) => resolve({ code: 1, output: error.message }))
    child.on('exit', (code) => resolve({ code: code ?? 1, output }))
  })
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const vitest = await run(npx, ['vitest', 'run', 'tests/remote.integration.test.ts'], {
  cwd: root,
  env: { ...process.env, CHROME_CDP_PORT: String(CDP_PORT), CHROME_TARGET_ORIGIN: ORIGIN },
  stdio: 'inherit'
})

console.log('\n--- REA CLI against the same browser ---')
const rea = await run(
  npx,
  ['--yes', 'rea-agents@latest', 'list-browser-targets', `http://127.0.0.1:${CDP_PORT}`, '--format', 'json'],
  { cwd: root, capture: true }
)
const combined = rea.output.trim()
console.log(combined.slice(0, 900) || '(no output)')
console.log(`rea exit: ${rea.code}`)

await cleanup()
process.exit(vitest.code)
