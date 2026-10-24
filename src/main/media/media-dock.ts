import { BrowserWindow, WebContentsView, session as electronSession, type Session } from 'electron'
import type { MediaItem, MediaSlot, Rect } from '@shared/types'

const SLOT_COUNT = 3

interface SlotState {
  slot: number
  item: MediaItem
  view: WebContentsView | null
  muted: boolean
  paused: boolean
  rate: number
  referer: string
}

/**
 * Splay — the video dock.
 *
 * Each docked video gets its own WebContentsView pointed at the internal
 * viewer page, so playback is completely independent of the article you are
 * reading. Up to three run at once; their rectangles are driven by the
 * renderer so the dock can animate open without the native layer tearing.
 */
export class MediaDock {
  private slots: (SlotState | null)[] = new Array(SLOT_COUNT).fill(null)
  private session: Session
  private rects: Rect[] = []
  private visible = false

  constructor(
    private readonly win: BrowserWindow,
    privacySessionFactory: () => Session
  ) {
    this.session = privacySessionFactory()
    this.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    this.session.setPermissionCheckHandler(() => false)
  }

  static slotCount(): number {
    return SLOT_COUNT
  }

  snapshot(): MediaSlot[] {
    return this.slots
      .filter((slot): slot is SlotState => Boolean(slot))
      .map((slot) => ({
        slot: slot.slot,
        item: slot.item,
        muted: slot.muted,
        paused: slot.paused,
        rate: slot.rate
      }))
  }

  has(item: MediaItem): boolean {
    return this.slots.some((slot) => slot?.item.id === item.id)
  }

  open(item: MediaItem, pageUrl: string): number | null {
    const existing = this.slots.find((slot) => slot?.item.id === item.id)
    if (existing) return existing.slot

    let free = this.slots.findIndex((slot) => slot === null)
    if (free === -1) free = 0
    if (this.slots[free]) this.destroy(this.slots[free]!)

    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        disableDialogs: true,
        autoplayPolicy: 'user-gesture-required'
      }
    })
    view.setBackgroundColor('#05070a')

    const slot: SlotState = {
      slot: free,
      item,
      view,
      muted: true,
      paused: false,
      rate: 1,
      referer: pageUrl
    }
    this.slots[free] = slot

    this.win.contentView.addChildView(view)
    this.applyBounds()
    view.webContents.loadURL(
      `warden://viewer/?src=${encodeURIComponent(item.viewerUrl)}&title=${encodeURIComponent(item.title)}&kind=${item.kind}&t=${Math.floor(item.currentTime || 0)}`
    ).catch(() => undefined)

    view.webContents.on('will-navigate', (event) => event.preventDefault())
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.setAudioMuted(true)
    return free
  }

  close(slotIndex: number): void {
    const slot = this.slots[slotIndex]
    if (!slot) return
    this.destroy(slot)
    this.slots[slotIndex] = null
  }

  clear(): void {
    for (let index = 0; index < this.slots.length; index += 1) {
      const slot = this.slots[index]
      if (slot) this.destroy(slot)
      this.slots[index] = null
    }
  }

  private destroy(slot: SlotState): void {
    if (!slot.view) return
    try {
      this.win.contentView.removeChildView(slot.view)
      slot.view.webContents.close()
    } catch {
      /* view already detached */
    }
    slot.view = null
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    for (const slot of this.slots) {
      if (!slot?.view) continue
      slot.view.setVisible(visible)
    }
    if (visible) this.applyBounds()
  }

  setRects(rects: Rect[]): void {
    this.rects = rects
    this.applyBounds()
  }

  private applyBounds(): void {
    for (const slot of this.slots) {
      if (!slot?.view) continue
      const rect = this.rects[slot.slot]
      if (!rect || rect.width < 8 || rect.height < 8 || !this.visible) {
        slot.view.setVisible(false)
        continue
      }
      slot.view.setVisible(true)
      slot.view.setBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }
  }

  async control(
    slotIndex: number,
    command: 'play' | 'pause' | 'mute' | 'unmute' | 'rate' | 'seek',
    value?: number
  ): Promise<void> {
    const slot = this.slots[slotIndex]
    if (!slot?.view) return
    const wc = slot.view.webContents

    if (command === 'mute' || command === 'unmute') {
      slot.muted = command === 'mute'
      wc.setAudioMuted(slot.muted)
      return
    }
    if (command === 'rate' && typeof value === 'number') slot.rate = value
    if (command === 'play') slot.paused = false
    if (command === 'pause') slot.paused = true

    const script = `(() => {
      const v = window.__wardenPlayer || document.querySelector('video');
      if (!v) return false;
      ${
        command === 'play'
          ? 'v.play().catch(() => {});'
          : command === 'pause'
            ? 'v.pause();'
            : command === 'rate'
              ? `v.playbackRate = ${Math.min(4, Math.max(0.25, value ?? 1))};`
              : `if (Number.isFinite(v.duration)) v.currentTime = ${Math.min(1, Math.max(0, value ?? 0))} * v.duration;`
      }
      return true;
    })()`
    try {
      await wc.executeJavaScript(script, true)
    } catch {
      /* viewer may still be loading */
    }
  }

  /** Pause the docked copy when its source page changes to avoid ghost audio. */
  pauseAll(): void {
    for (const slot of this.slots) {
      if (slot) void this.control(slot.slot, 'pause')
    }
  }

  refererFor(item: MediaItem): string {
    return this.slots.find((slot) => slot?.item.id === item.id)?.referer ?? ''
  }
}

export function createMediaSession(factory: () => Session = () => electronSession.fromPartition('warden-media')) {
  return factory()
}
