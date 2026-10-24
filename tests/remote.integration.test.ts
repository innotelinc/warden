/**
 * Integration test for the remote Chrome debugger path.
 *
 * Node-only: it does not boot Electron. Run it with a live Chrome:
 *   npm run verify:remote
 * which starts a local page, launches headless Chrome with a debug port and
 * sets CHROME_CDP_PORT. Without that env var the suite is skipped.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectRemoteTarget, listRemoteTargets } from '../src/main/scry/cdp'
import { capturePage } from '../src/main/scry/capture'
import { buildClonePlan, writePlan } from '../src/main/scry/clone'
import { buildReport } from '../src/main/scry/recon'

const port = Number(process.env.CHROME_CDP_PORT || 0)
const origin = process.env.CHROME_TARGET_ORIGIN || ''
const tempDirs: string[] = []

afterAll(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe.skipIf(!port || !origin)('remote Chrome capture', () => {
  it('lists page targets on the debug port', async () => {
    const targets = await listRemoteTargets(port)
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.every((target) => target.url.startsWith('http') || target.url.startsWith('data:'))).toBe(true)
    expect(targets.some((target) => target.url.startsWith(origin))).toBe(true)
  })

  it('captures the live page over WebSocket CDP', { timeout: 90000 }, async () => {
    const targets = await listRemoteTargets(port)
    const target = targets.find((entry) => entry.url.startsWith(origin))
    expect(target).toBeTruthy()

    const session = await connectRemoteTarget(port, target!.id)
    try {
      const capture = await capturePage(session, { reload: true, timeoutMs: 25000 })

      expect(capture.html).toContain('remote capture target')
      expect(capture.title.toLowerCase()).toContain('remote')
      expect(capture.resources.length).toBeGreaterThan(0)
      expect(capture.requests.length).toBeGreaterThan(0)
      expect(capture.documentHeaders['content-type']).toContain('text/html')
      expect(capture.tokens.colors.length).toBeGreaterThan(0)
      expect(capture.blocks.length).toBeGreaterThan(0)

      const report = buildReport(capture)
      expect(report.thirdParties.length).toBeGreaterThan(0)
      expect(report.technologies.some((tech) => tech.name === 'nginx')).toBe(false)

      const plan = buildClonePlan(capture)
      const indexPath = plan.files.find((file) => file.path === 'index.html')
      expect(indexPath).toBeTruthy()
      expect(String(indexPath!.content)).toContain('Reconstructed by WARDEN Scry')
      expect(plan.files.some((file) => file.path.startsWith('assets/'))).toBe(true)

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'warden-clone-'))
      tempDirs.push(dir)
      await writePlan(dir, plan)
      const written = await fs.readFile(path.join(dir, 'index.html'), 'utf8')
      expect(written).toContain('<!DOCTYPE html>')
      const assetFiles = await fs.readdir(path.join(dir, 'assets'))
      expect(assetFiles.length).toBeGreaterThan(0)
    } finally {
      await session.detach()
    }
  })
})
