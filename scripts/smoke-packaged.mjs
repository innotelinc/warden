#!/usr/bin/env node
/**
 * Runs the full smoke suite against the packaged app (not the dev tree).
 *
 * Build first:  npm run dist:dir     (or npm run dist)
 * Then:         npm run smoke:dist
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const candidates = [
  'release/win-unpacked/WARDEN.exe',
  'release/mac/WARDEN.app/Contents/MacOS/WARDEN',
  'release/linux-unpacked/warden'
]

const binary = candidates.map((entry) => path.join(root, entry)).find((entry) => existsSync(entry))
if (!binary) {
  console.error('No packaged build found. Run `npm run dist:dir` first.')
  process.exit(1)
}

console.log(`smoke testing ${path.relative(root, binary)}`)
const child = spawn(process.execPath, [path.join(root, 'scripts/smoke.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, WARDEN_SMOKE_BIN: binary }
})
child.on('exit', (code) => process.exit(code ?? 1))
