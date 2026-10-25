/**
 * Privacy lock (Ctrl + \).
 *
 * Covers the app with an opaque, blurred snapshot of the page behind it and
 * refuses to go away until the Windows account password is verified. Two ways
 * in: the shortcut, and an idle timer so a machine left open at a desk covers
 * itself.
 *
 * The lock window is a frameless child of the main window, pinned to the same
 * bounds and kept on top. The parent is disabled while it is up, so the page
 * underneath cannot be clicked, scrolled or typed into even if the overlay is
 * somehow dismissed.
 */
import { BrowserWindow, powerMonitor } from 'electron'
import os from 'node:os'
import { shouldAutoLock } from '@shared/lock-policy'
import type { LockState } from '@shared/types'
import { verifyWindowsPassword } from './win-auth'

interface Options {
  parent: () => BrowserWindow | null
  preload: string
  /** Active tab's webContents; its pixels become the blurred backdrop. */
  activePage: () => Electron.WebContents | null
  timeoutMinutes: () => number
  /** Hides tab views while locked; the overlay supplies the only pixels. */
  setSuppressed: (suppressed: boolean) => void
  onState: () => void
}

const IDLE_POLL_MS = 15_000

export class LockService {
  private readonly options: Options
  private overlay: BrowserWindow | null = null
  private background: string | null = null
  private attempts = 0
  private busy = false
  private error: string | null = null
  private byTimeout = false
  private closing = false
  private timer: NodeJS.Timeout | null = null
  private readonly startedAt = Date.now()
  /** Set only by the smoke harness, which has no Windows password to offer. */
  private readonly testPassword: string | null = null

  constructor(options: Options) {
    this.options = options
    if (process.env.WARDEN_SMOKE === '1' && process.env.WARDEN_LOCK_TEST_PASSWORD) {
      this.testPassword = process.env.WARDEN_LOCK_TEST_PASSWORD
    }
  }

  snapshot(): LockState {
    return {
      locked: Boolean(this.overlay),
      attempts: this.attempts,
      busy: this.busy,
      error: this.error,
      timeoutMinutes: this.options.timeoutMinutes(),
      idleSeconds: this.safeIdle(),
      byTimeout: this.byTimeout
    }
  }

  private safeIdle(): number {
    try {
      return powerMonitor.getSystemIdleTime()
    } catch {
      return 0
    }
  }

  /** Background image for the lock window; captured at lock time. */
  backdrop(): string | null {
    return this.background
  }

  user(): string {
    try {
      return os.userInfo().username
    } catch {
      return 'this device'
    }
  }

  isLocked(): boolean {
    return Boolean(this.overlay)
  }

  /** The overlay itself; the smoke harness reads its DOM. */
  overlayWebContents(): Electron.WebContents | null {
    if (!this.overlay || this.overlay.isDestroyed()) return null
    return this.overlay.webContents
  }

  private emit(): void {
    const state = this.snapshot()
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.overlay.webContents.send('warden:lock:state', state)
    }
    this.options.onState()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), IDLE_POLL_MS)
    this.timer.unref?.()
    try {
      // A Windows session lock is intent enough: cover the app too, so the
      // screen is protected even if the OS lock is bypassed by a policy.
      powerMonitor.on('lock-screen', () => void this.lock(true))
    } catch {
      /* headless or unsupported platform */
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Called on the poll; exported shape keeps the decision testable. */
  tick(): void {
    if (this.overlay) return
    const idle = this.safeIdle()
    if (
      shouldAutoLock({
        idleSeconds: idle,
        timeoutMinutes: this.options.timeoutMinutes(),
        locked: false
      })
    ) {
      void this.lock(true)
    }
  }

  async lock(byTimeout = false): Promise<void> {
    if (this.overlay || this.closing) return
    const parent = this.options.parent()
    if (!parent || parent.isDestroyed()) return

    this.attempts = 0
    this.error = null
    this.busy = false
    this.byTimeout = byTimeout
    this.closing = false

    const capture = this.options.activePage()
    if (capture && !capture.isDestroyed()) {
      try {
        const image = await capture.capturePage()
        if (!image.isEmpty()) this.background = `data:image/png;base64,${image.toPNG().toString('base64')}`
      } catch {
        this.background = null
      }
    } else {
      this.background = null
    }
    // A slow capture can outlive the decision (a quick unlock request, say).
    if (this.overlay || this.closing) return

    const overlay = new BrowserWindow({
      parent,
      modal: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#05070a',
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false
      }
    })
    this.overlay = overlay
    overlay.setBounds(parent.getBounds())
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setMenu(null)
    overlay.on('close', (event) => {
      if (!this.closing) event.preventDefault()
    })
    overlay.on('closed', () => {
      if (this.overlay === overlay) this.overlay = null
    })

    const align = (): void => {
      if (!this.overlay || this.overlay.isDestroyed()) return
      const bounds = parent.getBounds()
      this.overlay.setBounds(bounds)
    }
    const onMove = (): void => align()
    const onResize = (): void => align()
    const onMinimize = (): void => this.overlay?.hide()
    const onRestore = (): void => {
      align()
      this.overlay?.show()
      this.overlay?.moveTop()
    }
    parent.on('move', onMove)
    parent.on('resize', onResize)
    parent.on('minimize', onMinimize)
    parent.on('restore', onRestore)
    overlay.on('closed', () => {
      parent.removeListener('move', onMove)
      parent.removeListener('resize', onResize)
      parent.removeListener('minimize', onMinimize)
      parent.removeListener('restore', onRestore)
    })

    this.options.setSuppressed(true)
    parent.setEnabled(false)

    try {
      await overlay.loadURL('warden://lock')
    } catch {
      /* the overlay still covers the app; unlock remains available */
    }
    if (overlay.isDestroyed()) return
    overlay.show()
    overlay.focus()
    overlay.webContents.focus()
    this.emit()
    if (byTimeout) this.options.onState()
    void this.startedAt
  }

  async unlock(password: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.overlay) return { ok: false, error: 'Nothing is locked.' }
    if (this.busy) return { ok: false, error: 'Checking…' }
    if (!password) {
      this.error = 'Enter your Windows password.'
      this.emit()
      return { ok: false, error: this.error }
    }

    this.busy = true
    this.error = null
    this.emit()

    let ok = false
    if (this.testPassword !== null) ok = password === this.testPassword
    else ok = await verifyWindowsPassword(password)

    this.busy = false
    if (!ok) {
      this.attempts += 1
      this.error =
        this.attempts >= 3
          ? 'Still not accepted. Use your Windows sign-in password, or restart WARDEN and sign out.'
          : 'That password did not match this Windows account.'
      this.emit()
      return { ok: false, error: this.error }
    }

    this.release()
    return { ok: true }
  }

  /** Tear the overlay down and give the app back. */
  private release(): void {
    const parent = this.options.parent()
    this.closing = true
    this.overlay?.destroy()
    this.overlay = null
    this.attempts = 0
    this.error = null
    this.byTimeout = false
    this.background = null
    this.closing = false
    this.options.setSuppressed(false)
    if (parent && !parent.isDestroyed()) {
      parent.setEnabled(true)
      parent.focus()
    }
    this.options.onState()
  }

  /** Unlock without a password: used only while WARDEN is shutting down. */
  forceRelease(): void {
    if (!this.overlay) return
    this.release()
  }
}
