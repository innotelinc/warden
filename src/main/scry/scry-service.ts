import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { WebContents } from 'electron'
import type { CloneResult, ScryProgress, ScryReport, ScryTarget, Settings } from '@shared/types'
import { DebuggerSession, connectRemoteTarget, listRemoteTargets, type ProtocolSession } from './cdp'
import { capturePage, type CaptureResult } from './capture'
import { buildReport } from './recon'
import { buildClonePlan, buildScaffold, slugFor, writeJson, writePlan } from './clone'

export interface ScryDeps {
  settings: () => Settings
  outputRoot: () => string
  localTabs: () => { id: string; title: string; url: string }[]
  localWebContents: (tabId: string) => WebContents | null
  onProgress: (progress: ScryProgress) => void
  onReport: (report: ScryReport) => void
  /** Requests Bastion cancelled so far; used to explain the capture's lower bound. */
  blockedCount: () => number
}

type ScryTargetRef = { source: 'remote' | 'local'; id: string }

/**
 * Scry — deconstruct a running site.
 *
 * Two sources feed the same pipeline: a Chrome instance on the debug port, or
 * one of WARDEN's own tabs (via the built-in debugger). Capture → recon report
 * → static clone → React scaffold.
 */
export class ScryService {
  private running = false
  private cancelled = false

  constructor(private readonly deps: ScryDeps) {}

  get busy(): boolean {
    return this.running
  }

  cancel(): void {
    this.cancelled = true
  }

  async listTargets(port?: number): Promise<ScryTarget[]> {
    const settings = this.deps.settings()
    const remote = await listRemoteTargets(port ?? settings.scryPort)
    const local: ScryTarget[] = this.deps.localTabs().map((tab) => ({
      id: tab.id,
      title: tab.title || tab.url,
      url: tab.url,
      type: 'page',
      source: 'local',
      attached: false
    }))
    return [...local, ...remote]
  }

  async capture(target: ScryTargetRef, options: { label?: string } = {}): Promise<ScryReport> {
    return this.run('capture', target, options, async (capture, _progress, blocked) => buildReport(capture, blocked))
  }

  async clone(
    target: ScryTargetRef,
    options: { label?: string; includeScripts?: boolean } = {}
  ): Promise<CloneResult> {
    return this.run('clone', target, options, async (capture, progress, blocked) => {
      const report = buildReport(capture, blocked)
      const stem = `${slugFor(capture.finalUrl)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
      const root = path.join(this.deps.outputRoot(), stem)

      progress('writing', 'building local clone plan', capture.requests.length, 0)
      const plan = buildClonePlan(capture, { includeScripts: options.includeScripts, label: options.label })
      const clonePath = path.join(root, 'clone')
      await writePlan(clonePath, plan)

      progress('writing', 'generating React scaffold', capture.requests.length, plan.bytes)
      const scaffoldPath = path.join(root, 'scaffold')
      const scaffold = buildScaffold(capture, report, plan, options.label ?? stem)
      for (const file of scaffold) {
        const targetPath = path.join(scaffoldPath, file.path)
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await fs.writeFile(targetPath, file.content)
      }

      const reportPath = path.join(root, 'report.json')
      await writeJson(root, 'report.json', report)
      await writeJson(root, 'capture.json', {
        url: capture.finalUrl,
        title: capture.title,
        capturedAt: capture.capturedAt,
        durationMs: capture.durationMs,
        htmlBytes: capture.html.length,
        resources: capture.resources.map((resource) => ({
          url: resource.url,
          kind: resource.kind,
          status: resource.status,
          size: resource.size,
          headers: resource.headers
        })),
        requests: capture.requests,
        cookies: capture.cookies,
        warnings: plan.warnings
      })

      if (capture.screenshot) {
        await fs.writeFile(path.join(root, 'screenshot.png'), Buffer.from(capture.screenshot, 'base64'))
      }

      await fs.writeFile(
        path.join(root, 'README.md'),
        [
          `# Scry capture — ${capture.title || capture.finalUrl}`,
          '',
          `Source: ${capture.finalUrl}`,
          `Captured: ${new Date(capture.capturedAt).toISOString()}`,
          '',
          '## Contents',
          '',
          '- `clone/` — standalone static copy (open `clone/index.html`).',
          '- `scaffold/` — Vite + React project shaped around the captured blocks.',
          '- `report.json` — technologies, security headers, third parties, trackers, endpoints.',
          '- `capture.json` — every request and captured resource, without bodies.',
          '',
          '## Warnings',
          '',
          ...(plan.warnings.length ? plan.warnings.map((warning) => `- ${warning}`) : ['- none']),
          '',
          'Scripts and inline event handlers are removed by default. This is a reconstruction for',
          'analysis, not a working copy of the original application.'
        ].join('\n'),
        'utf8'
      )

      progress('report', 'report written', capture.requests.length, plan.bytes)
      this.deps.onReport(report)
      return {
        outputDir: root,
        capturePath: path.join(root, 'capture.json'),
        clonePath,
        scaffoldPath,
        reportPath,
        pages: 1,
        files: plan.files.length + scaffold.length + 3,
        bytes: plan.bytes
      }
    })
  }

  private async run<T>(
    mode: 'capture' | 'clone',
    target: ScryTargetRef,
    options: { label?: string; includeScripts?: boolean },
    finish: (
      capture: CaptureResult,
      progress: (phase: ScryProgress['phase'], message: string, requests: number, bytes: number) => void,
      blockedDuringCapture: number
    ) => Promise<T>
  ): Promise<T> {
    if (this.running) throw new Error('Scry is already running')
    this.running = true
    this.cancelled = false
    const progress = (phase: ScryProgress['phase'], message: string, requests: number, bytes: number): void => {
      this.deps.onProgress({ phase, message, requests, bytes })
    }

    progress('queued', mode === 'clone' ? 'queued clone' : 'queued capture', 0, 0)

    let session: ProtocolSession | null = null
    try {
      session = await this.openSession(target, progress)
      progress('capturing', 'reloading target with recorder armed', 0, 0)
      const blockedBefore = this.deps.blockedCount()

      const capture = await capturePage(session, {
        reload: true,
        screenshot: mode === 'clone',
        onProgress: (message, requests, bytes) => progress('capturing', message, requests, bytes)
      })

      if (this.cancelled) throw new Error('Scry cancelled')

      const blockedDuringCapture = Math.max(0, this.deps.blockedCount() - blockedBefore)
      const result = await finish(capture, progress, blockedDuringCapture)
      progress('done', 'complete', capture.requests.length, capture.resources.reduce((total, r) => total + r.size, 0))
      return result
    } catch (error) {
      const message = (error as Error).message
      progress('error', message, 0, 0)
      throw error
    } finally {
      if (session) {
        try {
          await session.detach()
        } catch {
          /* ignore */
        }
      }
      this.running = false
    }
  }

  private async openSession(
    target: ScryTargetRef,
    progress: (phase: ScryProgress['phase'], message: string, requests: number, bytes: number) => void
  ): Promise<ProtocolSession> {
    progress('attaching', `attaching to ${target.source} target ${target.id}`, 0, 0)

    if (target.source === 'local') {
      const wc = this.deps.localWebContents(target.id)
      if (!wc) throw new Error('That tab is gone')
      const debuggerApi = wc.debugger
      const attached = debuggerApi.isAttached()
      return new DebuggerSession(debuggerApi, attached)
    }

    const port = this.deps.settings().scryPort
    const targets = await listRemoteTargets(port)
    const remote = targets.find((entry) => entry.id === target.id)
    if (!remote) {
      throw new Error(`Target ${target.id} is not on port ${port}. Start Chrome with --remote-debugging-port=${port}.`)
    }

    return connectRemoteTarget(port, target.id)
  }

  async reaStatus(): Promise<{ installed: boolean; version: string | null; path: string | null }> {
    return new Promise((resolve) => {
      execFile('rea', ['--version'], { shell: true, timeout: 15000 }, (error, stdout) => {
        if (error) {
          resolve({ installed: false, version: null, path: null })
          return
        }
        const version = stdout.trim().split(/\r?\n/)[0] ?? ''
        resolve({ installed: true, version, path: 'rea' })
      })
    })
  }

  /**
   * Hand a remote target to the REA CLI for deeper static JS analysis.
   * WARDEN works without REA; this is an optional escalation.
   */
  async runRea(target: ScryTargetRef): Promise<{ ok: boolean; output: string }> {
    let port = this.deps.settings().scryPort
    let targetId = target.id

    if (target.source === 'local') {
      // REA speaks to a loopback CDP endpoint, so point it at WARDEN's own debug
      // port and map the chosen tab onto the matching debug target. No Chrome.
      const debugPort = this.deps.settings().debugPort
      if (!debugPort) {
        return {
          ok: false,
          output:
            'REA needs a loopback CDP endpoint. Turn on Debug mode in Policy (self debug port), restart WARDEN, then run REA against a WARDEN tab.'
        }
      }
      const tab = this.deps.localTabs().find((entry) => entry.id === target.id)
      const debugTargets = await listRemoteTargets(debugPort)
      const match =
        debugTargets.find((entry) => tab && entry.url === tab.url) ??
        debugTargets.find((entry) => tab && entry.title === (tab.title || tab.url))
      if (!match) {
        return {
          ok: false,
          output: `WARDEN's debug endpoint on ${debugPort} does not list that tab. Reload the tab, then try again.`
        }
      }
      port = debugPort
      targetId = match.id
    }

    const root = path.join(this.deps.outputRoot(), `${slugFor(`rea-${target.id}`)}-${Date.now()}`)
    await fs.mkdir(root, { recursive: true })
    const outFile = path.join(root, 'rea-analyze-web-bundle.json')

    return new Promise((resolve) => {
      execFile(
        'rea',
        ['analyze-web-bundle', `http://127.0.0.1:${port}`, targetId, '--format', 'json'],
        { shell: true, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
        async (error, stdout, stderr) => {
          const output = `${stdout}\n${stderr}`.trim()
          if (error && !stdout) {
            resolve({ ok: false, output: output || error.message })
            return
          }
          try {
            await fs.writeFile(outFile, stdout || output, 'utf8')
          } catch {
            /* output still returned */
          }
          resolve({ ok: !error, output: output.slice(0, 20000) })
        }
      )
    })
  }
}
