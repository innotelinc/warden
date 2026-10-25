#!/usr/bin/env node
/**
 * End-to-end smoke test for WARDEN.
 *
 * Serves a page that attempts two tracker requests and a cookie, launches the
 * built app with WARDEN_SMOKE=1, and asserts the app's own JSON report.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4321

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>warden smoke target</title></head>
<body>
  <h1>warden smoke target</h1>
  <img src="https://doubleclick.net/pixel.gif" width="1" height="1" alt="">
  <img src="https://www.google-analytics.com/collect?v=1" width="1" height="1" alt="">
  <script>
    fetch('https://www.google-analytics.com/collect?v=2', { mode: 'no-cors' }).catch(function () {});
    var beacon = new Image();
    beacon.src = 'https://stats.g.doubleclick.net/pixel.gif';
    document.cookie = 'probe_js=1; path=/';
  </script>
</body></html>`

const server = createServer((request, response) => {
  if (request.url === '/robots.txt') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('User-agent: *\nDisallow:\n')
    return
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': ['tracker=abc; Path=/; HttpOnly', 'session=def; Path=/']
  })
  response.end(PAGE)
})

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

let electronPath
try {
  const mod = await import('electron')
  electronPath = mod.default
} catch (error) {
  console.error('electron is not installed:', error.message)
  server.close()
  process.exit(1)
}

// WARDEN_SMOKE_BIN points at a packaged executable (release/win-unpacked/WARDEN.exe).
const binary = process.env.WARDEN_SMOKE_BIN
const outFile = path.join(root, '.tmp', 'smoke-result.json')
await fs.mkdir(path.dirname(outFile), { recursive: true })
await fs.rm(outFile, { force: true })

const child = binary
  ? spawn(binary, [], {
      cwd: path.dirname(binary),
      env: {
        ...process.env,
        WARDEN_SMOKE: '1',
        WARDEN_SMOKE_URL: `http://127.0.0.1:${PORT}/`,
        // Only this child gets the bypass; the real verifier still runs in the
        // packaged app and for every non-smoke launch.
        WARDEN_LOCK_TEST_PASSWORD: 'warden-smoke-pass',
        WARDEN_SMOKE_OUT: outFile
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
  : spawn(electronPath, ['.'], {
      cwd: root,
      env: {
        ...process.env,
        WARDEN_SMOKE: '1',
        WARDEN_SMOKE_URL: `http://127.0.0.1:${PORT}/`,
        WARDEN_LOCK_TEST_PASSWORD: 'warden-smoke-pass'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

let stdout = ''
let stderr = ''
let settled = false
let poll = null

const finish = (code, message) => {
  if (settled) return
  settled = true
  if (poll) clearInterval(poll)
  server.close()
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  console.log(message)
  process.exit(code)
}

const timer = setTimeout(() => {
  console.error(stderr.slice(-4000))
  finish(1, 'TIMEOUT: the app did not report within 120s')
}, 120000)

const verify = (report) => {
  clearTimeout(timer)
  const checks = {
    'hardening installed': report.hardened === true,
    'hardwareConcurrency spoofed': report.cores === 4,
    'plugins emptied': report.plugins === 0,
    'document.cookie inert': report.cookieReadback === '',
    'no cookies in store': report.cookieCount === 0 && report.cookieCountAfter === 0,
    'page rendered': typeof report.heading === 'string' && report.heading.includes('smoke'),
    'scry explains blocked lower bound': Array.isArray(report.scry?.notes) &&
      report.scry.notes.some((note) => note.includes('Bastion blocked')),
    'scry captured requests': (report.scry?.requests ?? 0) > 0,
    'scry extracted design tokens': (report.scry?.tokens ?? 0) > 0,
    'ui brand rendered': report.ui?.brand === 'WARDEN',
    'ui rail has seven workspaces': report.ui?.railButtons === 7,
    'ui chrome present': Boolean(report.ui?.hasToolbar && report.ui?.hasStatus && report.ui?.addressBar),
    'ui workspaces render': ['relay', 'concourse', 'scry', 'policy'].every((name) =>
      (report.ui?.workspaceTitles ?? []).map((title) => title.toLowerCase()).includes(name)
    ),
    'ui has no runtime errors': Array.isArray(report.ui?.errors) && report.ui.errors.length === 0,
    'innovate wrote a modern build':
      report.innovate?.modernDir === true &&
      report.innovate?.files?.length === 4 &&
      report.innovate?.themeTokens === true,
    'innovate loads no original scripts':
      Array.isArray(report.innovate?.scriptSources) &&
      report.innovate.scriptSources.every((src) => src.startsWith('./')) &&
      report.innovate?.inlineHandlersLeft === false,
    'address bar selects the whole URL on click': report.ui?.addressSelection?.all === true,
    'find bar opens fully inside its strip':
      report.ui?.findBar?.present === true &&
      report.ui?.findBar?.bottom <= report.ui?.findBar?.stripLimit &&
      parseFloat(report.ui?.findBar?.radius ?? '0') > 0,
    'find button collapses the bar again': report.ui?.findClosed === true,
    'dragging a tab reorders the strip': report.ui?.tabReorder?.moved === true,
    'trench offers shell and ssh modes':
      JSON.stringify(report.ui?.terminalModes ?? []) === JSON.stringify(['SHELL', 'SSH']),
    'ssh bar opens and closes with the toggle':
      report.ui?.sshBar === true && report.ui?.sshBarClosed === true,
    'ssh destination cannot become an option': report.ssh?.rejectedOptionInjection === true,
    'bastion offers compatibility mode for the current site':
      (report.ui?.bastionButtons ?? []).some((label) => /compatibility mode/i.test(label)),
    'send to scry carries the tab into scry':
      report.ui?.sendButton === true &&
      report.ui?.sendToScry?.workspace === 'Scry' &&
      report.ui?.sendToScry?.modesArmed === true &&
      (report.ui?.sendToScry?.target ?? '').length > 0,
    'scry offers recon, clone and innovate':
      JSON.stringify((report.ui?.scryModes ?? []).map((mode) => mode.name)) ===
      JSON.stringify(['Recon', 'Clone', 'Innovate']),
    'theme chooser lists palettes and applies one':
      (report.ui?.themeCards ?? 0) >= 2 && report.ui?.theme?.changed === true,
    // A page can load and run script while its view is 0x0 and invisible.
    'tab surface has real geometry': (report.view?.bounds?.width ?? 0) > 200 &&
      (report.view?.bounds?.height ?? 0) > 200,
    'tab surface attached and visible': report.view?.attached === true && report.view?.visible === true,
    'ui terminal drawer sized': (report.ui?.terminalHeight ?? 0) > 150 && report.ui?.drawerHead === true,
    'terminal started': Boolean(report.terminal?.backend),
    // Compatibility mode is the escape hatch for challenge pages, so it has to
    // be genuinely inert in the same run that proves the default is not.
    'compatibility skips page shims':
      report.compat?.hardened === false && report.compat?.cores !== 4,
    'compatibility lets the site write cookies':
      String(report.compat?.cookie ?? '').includes('compat_probe') && (report.compat?.stored ?? 0) >= 1,
    'compatibility does not filter requests': report.compat?.trackerBlocked === 0,
    'stats counted blocks': (report.stats?.blockedTotal ?? 0) > 0,
    'lock covers the app': report.lock?.locked === true,
    'lock screen renders its password field':
      /locked/i.test(String(report.lock?.title ?? '')) && report.lock?.hasPasswordField === true,
    'lock rejects a wrong password': report.lock?.wrongRejected === true,
    'lock stays up after a wrong password': report.lock?.stillLocked === true,
    'lock clears for the right password': report.lock?.cleared === true,
    'updater reports its state': typeof report.update?.phase === 'string',
    'window controls drawn by the chrome': report.ui?.windowControls?.count === 3,
    'window controls have accessible labels':
      ['Minimise', 'Maximise', 'Close'].every((label) => (report.ui?.windowControls?.labels ?? []).includes(label)),
    'window controls style their hover state': report.ui?.windowControls?.hoverStyled === true,
    'new tabs are private by default': report.privateTab === true,
    'sensors hand the page a derived video track': (report.sensors?.video ?? 0) >= 1,
    'camera treatment reaches the page': report.sensors?.state?.camera === 'pixelate',
    'voice treatment reaches the page': report.sensors?.state?.voice === 'robot'
  }
  console.log('\n--- WARDEN smoke checks ---')
  let failed = 0
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
    if (!pass) failed += 1
  }
  if (report.error) console.log(`error: ${report.error}`)
  console.log(`\nterminal backend: ${report.terminal?.backend} (${report.terminal?.shell})`)
  console.log(`blocked: ${report.stats?.blockedTotal} · rules: ${report.stats?.rulesLoaded}`)
  console.log(`scry requests: ${report.scry?.requests} · trackers: ${report.scry?.trackers?.join(', ')}`)

  finish(failed === 0 && report.ok ? 0 : 1, failed === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failed} check(s))`)
}

const consume = (text) => {
  const trimmed = text.trim()
  const line = trimmed.split(/\r?\n/).find((entry) => entry.startsWith('WARDEN_SMOKE '))
  // The report file holds the object alone; stdout carries the same JSON behind a marker.
  const payload = line ? line.slice('WARDEN_SMOKE '.length) : trimmed.startsWith('{') ? trimmed : null
  if (!payload) return
  try {
    verify(JSON.parse(payload))
  } catch (error) {
    finish(1, `FAIL: could not parse report (${error.message})`)
  }
}

child.stdout.on('data', (chunk) => {
  const text = chunk.toString()
  stdout += text
  process.stdout.write(text)
  consume(stdout)
})

// A packaged Windows GUI binary may have no usable stdout handle, so it also
// writes the same JSON to WARDEN_SMOKE_OUT.
if (binary) {
  poll = setInterval(async () => {
    if (settled) return
    try {
      consume(await fs.readFile(outFile, 'utf8'))
    } catch {
      /* not written yet */
    }
  }, 500)
}

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

child.on('exit', (code) => {
  if (settled) return
  // The portable launcher is a stub: it starts the real app and exits, so the
  // report still has to arrive through WARDEN_SMOKE_OUT.
  if (binary) return
  clearTimeout(timer)
  console.error(stderr.slice(-4000))
  finish(code ?? 1, `app exited before reporting (code ${code})`)
})
