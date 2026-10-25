/**
 * Self updates for WARDEN.
 *
 * Releases live on GitHub (innotelinc/warden). electron-builder bakes the feed
 * into `resources/app-update.yml`, so the app only needs the release channel:
 * the NSIS installer is downloaded in the background, then swapped in on the
 * next quit. Portable builds cannot be replaced in place, so they are told to
 * download the new exe instead of being offered a half-working restart.
 *
 * The updater is deliberately quiet: a failure never interrupts browsing, it
 * only shows up in Policy › About.
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 20 * 1000

interface Options {
  /** Auto checks can be switched off in Policy; manual checks still work. */
  enabled: () => boolean
  onChange: () => void
  /** Portable builds have no installer to swap, so they never self-update. */
  portable?: boolean
}

function tidy(message: unknown): string {
  const text = typeof message === 'string' ? message : ((message as Error)?.message ?? '')
  // Updater errors can carry feed URLs with query strings; keep the useful part.
  return text.replace(/\s+/g, ' ').slice(0, 240)
}

export class UpdateService {
  private readonly options: Options
  private state: UpdateState
  private timer: NodeJS.Timeout | null = null
  private started = false
  private checking = false

  constructor(options: Options) {
    this.options = options
    const portable = options.portable ?? Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
    this.state = {
      phase: app.isPackaged ? (portable ? 'unsupported' : 'idle') : 'dev',
      current: app.getVersion(),
      version: null,
      percent: 0,
      message: portable
        ? 'Portable builds update by downloading the next exe from the release page.'
        : null,
      checkedAt: null,
      automatic: true
    }
  }

  snapshot(): UpdateState {
    return { ...this.state }
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onChange()
  }

  /** Wire the event stream once, then schedule the first background check. */
  start(): void {
    if (this.started) return
    this.started = true
    this.state.automatic = this.options.enabled()
    if (this.state.phase !== 'idle') return

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.disableWebInstaller = true
    autoUpdater.logger = {
      info: () => undefined,
      warn: () => undefined,
      error: (message) => console.error('[update]', tidy(message)),
      debug: () => undefined
    }

    autoUpdater.on('checking-for-update', () => {
      this.set({ phase: 'checking', message: null })
    })
    autoUpdater.on('update-available', (info) => {
      this.set({ phase: 'downloading', version: info.version, percent: 0 })
    })
    autoUpdater.on('update-not-available', (info) => {
      this.set({
        phase: 'current',
        version: info.version,
        percent: 0,
        message: `WARDEN ${app.getVersion()} is the latest release.`,
        checkedAt: Date.now()
      })
    })
    autoUpdater.on('download-progress', (progress) => {
      this.set({ phase: 'downloading', percent: Math.round(progress.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.set({
        phase: 'ready',
        version: info.version,
        percent: 100,
        message: `WARDEN ${info.version} is ready. Restart to install.`,
        checkedAt: Date.now()
      })
    })
    autoUpdater.on('error', (error) => {
      this.set({
        phase: 'error',
        message: tidy(error),
        checkedAt: Date.now()
      })
    })

    if (this.options.enabled()) {
      setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    }
    this.timer = setInterval(() => {
      if (this.options.enabled()) void this.check()
    }, CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Re-read the auto-update switch: enabling it arms the timer, disabling stops it. */
  applyEnabled(enabled: boolean): void {
    this.state.automatic = enabled
    if (!this.started) return
    if (!enabled && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    } else if (enabled && !this.timer && this.state.phase === 'idle') {
      this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
      this.timer.unref?.()
      setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    }
  }

  async check(): Promise<UpdateState> {
    if (this.state.phase === 'dev' || this.state.phase === 'unsupported' || this.checking) {
      return this.snapshot()
    }
    if (this.state.phase === 'ready') return this.snapshot()
    this.checking = true
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      // A missing release, no network or a rate limit all land here. It must
      // not surface as a crash: report it and let the next timer retry.
      this.set({ phase: 'error', message: tidy(error), checkedAt: Date.now() })
    } finally {
      this.checking = false
    }
    return this.snapshot()
  }

  /** Quit, then let the updater install and relaunch. */
  install(): { ok: boolean } {
    if (this.state.phase !== 'ready') return { ok: false }
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch (error) {
        this.set({ phase: 'error', message: tidy(error) })
      }
    }, 120)
    return { ok: true }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
