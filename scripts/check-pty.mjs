#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// check-pty.mjs — prove the terminal actually works on this machine.
//
// `npm ci` pulls node-pty, whose native binding is produced by its own install
// script. npm runs lifecycle scripts only for dependencies named in the
// project's `allowScripts` policy, and a skipped script breaks nothing visible:
// no unit test opens a shell, so a runner can report green with a terminal that
// cannot start. Asking for one and reading what it printed is the only check
// that tells the two apart.
//
//   npm run check:pty
//
// Exit 0 when a shell ran and its output arrived, 1 with the reason otherwise.
// ═══════════════════════════════════════════════════════════════════════════
const EXPECTED = 'PTY_OK'
const TIMEOUT_MS = 20_000

// ConPTY on Windows, a real PTY elsewhere: the two paths that a missing or
// unbuilt binding breaks first, and the reason this runs on both runners.
const windows = process.platform === 'win32'
const shell = windows ? 'powershell.exe' : 'bash'
const args = windows ? ['-NoProfile', '-Command', `Write-Output ${EXPECTED}`] : ['-lc', `echo ${EXPECTED}`]

function fail(reason) {
  console.error(`pty: FAIL — ${reason}`)
  process.exit(1)
}

// Loaded as a dynamic import so a missing native binding arrives here as one
// line rather than an unhandled throw from module evaluation: that binding is
// the thing this check exists to notice.
let pty
try {
  const loaded = await import('node-pty')
  pty = loaded.default ?? loaded
} catch (error) {
  fail(`node-pty could not load — ${error.message}`)
}

let terminal
try {
  terminal = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env
  })
} catch (error) {
  // The interesting failure: node-pty resolved but its binding did not, which
  // is exactly what a skipped install script leaves behind.
  fail(`could not spawn ${shell} through node-pty — ${error.message}`)
}

let output = ''
const verdict = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, reason: `no output after ${TIMEOUT_MS}ms` }), TIMEOUT_MS)

  terminal.onData((chunk) => {
    output += chunk
    if (output.includes(EXPECTED)) {
      clearTimeout(timer)
      resolve({ ok: true })
    }
  })

  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer)
    if (output.includes(EXPECTED)) resolve({ ok: true })
    else resolve({ ok: false, reason: `${shell} exited ${exitCode} without printing ${EXPECTED}` })
  })
})

if (!verdict.ok) {
  const seen = JSON.stringify(output.slice(-200))
  try {
    terminal.kill()
  } catch {
    // Already gone; the verdict is what matters.
  }
  fail(`${verdict.reason} (saw ${seen})`)
}

console.log(`pty: ok (${shell} on ${process.platform} printed ${EXPECTED})`)
process.exit(0)
