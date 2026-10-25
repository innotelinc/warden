import { BrowserWindow, Menu, WebContentsView, clipboard } from 'electron'
import path from 'node:path'
import type { Rect, TabState } from '@shared/types'
import type { PrivacyService } from '../privacy/privacy-service'
import { safeHost } from '../privacy/filter-engine'
import { popupDecision } from './popup-policy'

export { resolveInput } from '@shared/urls'

const PRELOAD = () => path.join(__dirname, '../preload/page.js')

export type ShortcutCommand =
  | 'new-tab'
  | 'close-tab'
  | 'focus-address'
  | 'command-palette'
  | 'find'
  | 'next-tab'
  | 'prev-tab'
  | 'toggle-terminal'
  | 'toggle-dock'
  | 'lock'
  | 'scry'
  | 'settings'
  | 'reload'
  | 'reload-hard'
  | 'back'
  | 'forward'
  | 'devtools'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'restore-tab'

interface Tab {
  id: string
  view: WebContentsView
  burner: boolean
  title: string
  url: string
  favicon: string | null
  loading: boolean
  crashed: boolean
  mediaCount: number
  zoom: number
  attached: boolean
}

export interface TabHooks {
  onState: () => void
  onShortcut: (command: ShortcutCommand, tabId: string | null) => void
  onVisited: (url: string, title: string) => void
  onCookiesCheck: () => void
  /** Send a media element straight to the Splay dock, bypassing the scanner. */
  onMedia: (tabId: string, media: { url: string; title: string; kind: 'video' | 'audio' }) => void
}

export class TabManager {
  private tabs = new Map<string, Tab>()
  private order: string[] = []
  private activeId: string | null = null
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private visible = true
  private findRequests = new Map<number, (result: { matches: number; active: number }) => void>()
  private counter = 0
  private zoomStatus = new Map<string, number>()
  private createdCounter = 0

  constructor(
    private readonly win: BrowserWindow,
    private readonly privacy: PrivacyService,
    private readonly hooks: TabHooks
  ) {}

  get activeTabId(): string | null {
    return this.activeId
  }

  get count(): number {
    return this.order.length
  }

  list(): TabState[] {
    return this.order
      .map((id) => this.tabs.get(id))
      .filter((tab): tab is Tab => Boolean(tab))
      .map((tab) => this.toState(tab))
  }

  getWebContents(id: string) {
    return this.tabs.get(id)?.view.webContents ?? null
  }

  /**
   * Geometry of the tab surface. A page can load, run script and answer IPC
   * while its view is still 0x0 and therefore invisible, so the smoke harness
   * asserts on this rather than trusting that "the page loaded".
   */
  viewState(id = this.activeId ?? ''): { visible: boolean; attached: boolean; bounds: Rect; url: string } | null {
    const tab = this.tabs.get(id)
    if (!tab) return null
    return {
      visible: tab.view.getVisible(),
      attached: tab.attached,
      bounds: tab.view.getBounds(),
      url: tab.view.webContents.getURL()
    }
  }

  getSession(id: string) {
    return this.tabs.get(id)?.view.webContents.session ?? null
  }

  getTabUrl(id: string): string | null {
    return this.tabs.get(id)?.url ?? null
  }

  create(url = 'warden://newtab', burner = this.privacy.getSettings().privateByDefault): string {
    this.counter += 1
    const id = `tab${this.counter}`
    const ses = burner ? this.privacy.createBurnerSession() : this.privacy.browsingSession
    const settings = this.privacy.getSettings()

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: PRELOAD(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        javascript: this.privacy.getSettings().javascriptEnabled,
        images: true,
        backgroundThrottling: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        disableDialogs: true,
        additionalArguments: [
          `--warden-tab=${id}`,
          `--warden-cookies=${settings.cookieMode}`,
          `--warden-allow=${encodeURIComponent(settings.allowlist.join(','))}`
        ]
      }
    })
    view.setBackgroundColor('#0b0e12')

    const tab: Tab = {
      id,
      view,
      burner,
      title: 'New tab',
      url,
      favicon: null,
      loading: false,
      crashed: false,
      mediaCount: 0,
      zoom: 1,
      attached: false
    }

    this.tabs.set(id, tab)
    this.order.push(id)
    this.attach(tab)
    this.wire(tab)
    this.activate(id)

    view.webContents
      .loadURL(url)
      .catch(() => {
        /* navigation errors surface through did-fail-load */
      })

    this.hooks.onState()
    return id
  }

  private attach(tab: Tab): void {
    if (tab.attached) return
    this.win.contentView.addChildView(tab.view)
    tab.attached = true
  }

  private detach(tab: Tab): void {
    if (!tab.attached) return
    try {
      this.win.contentView.removeChildView(tab.view)
    } catch {
      /* already gone */
    }
    tab.attached = false
  }

  activate(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.activeId = id
    for (const [otherId, other] of this.tabs) {
      if (otherId === id) continue
      other.view.setVisible(false)
    }
    this.attach(tab)
    tab.view.setVisible(this.visible)
    this.applyBounds(tab)
    if (this.visible) tab.view.webContents.focus()
    this.hooks.onState()
  }

  close(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const index = this.order.indexOf(id)
    this.tabs.delete(id)
    this.order = this.order.filter((entry) => entry !== id)
    this.detach(tab)
    try {
      tab.view.webContents.close()
    } catch {
      /* already destroyed */
    }

    if (this.activeId === id) {
      const next = this.order[Math.max(0, index - 1)] ?? this.order[0] ?? null
      this.activeId = null
      if (next) this.activate(next)
    }
    this.hooks.onState()
  }

  closeActive(): void {
    if (this.activeId) this.close(this.activeId)
  }

  closeAll(): void {
    for (const id of [...this.order]) this.close(id)
  }

  cycle(direction: 1 | -1): void {
    if (!this.order.length || !this.activeId) return
    const index = this.order.indexOf(this.activeId)
    const next = this.order[(index + direction + this.order.length) % this.order.length]
    if (next) this.activate(next)
  }

  activateIndex(index: number): void {
    const id = this.order[index]
    if (id) this.activate(id)
  }

  /**
   * Move a tab to a new position in the strip.
   *
   * Index is the destination slot among the current order, clamped rather than
   * rejected: a drag that lands past the last tab should put it last, not do
   * nothing. Active tab and page state are untouched — only the order changes.
   */
  move(id: string, index: number): void {
    const from = this.order.indexOf(id)
    if (from === -1) return
    const target = Math.max(0, Math.min(this.order.length - 1, Math.round(index)))
    if (target === from) return
    const next = [...this.order]
    next.splice(from, 1)
    next.splice(target, 0, id)
    this.order = next
    this.hooks.onState()
  }

  setBounds(bounds: Rect): void {
    this.bounds = bounds
    const tab = this.activeId ? this.tabs.get(this.activeId) : null
    if (tab) this.applyBounds(tab)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    const tab = this.activeId ? this.tabs.get(this.activeId) : null
    if (!tab) return
    if (visible) this.attach(tab)
    tab.view.setVisible(visible)
    if (visible) this.applyBounds(tab)
  }

  private applyBounds(tab: Tab): void {
    const { x, y, width, height } = this.bounds
    if (width <= 0 || height <= 0) return
    tab.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
  }

  navigate(id: string, rawUrl: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.crashed = false
    tab.view.webContents.loadURL(rawUrl).catch(() => undefined)
  }

  back(id: string): void {
    const wc = this.tabs.get(id)?.view.webContents
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  forward(id: string): void {
    const wc = this.tabs.get(id)?.view.webContents
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(id: string, hard = false): void {
    const wc = this.tabs.get(id)?.view.webContents
    if (!wc) return
    if (hard) wc.reloadIgnoringCache()
    else wc.reload()
  }

  stop(id: string): void {
    this.tabs.get(id)?.view.webContents.stop()
  }

  mute(id: string, muted: boolean): void {
    this.tabs.get(id)?.view.webContents.setAudioMuted(muted)
    this.hooks.onState()
  }

  setZoom(id: string, delta: number | 'reset'): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const next = delta === 'reset' ? 1 : Math.min(3, Math.max(0.4, tab.zoom + delta))
    tab.zoom = Number(next.toFixed(2))
    tab.view.webContents.setZoomFactor(tab.zoom)
    this.zoomStatus.set(id, tab.zoom)
    this.hooks.onState()
  }

  find(id: string, text: string, options: { forward?: boolean; findNext?: boolean } = {}) {
    const wc = this.tabs.get(id)?.view.webContents
    if (!wc) return Promise.resolve({ matches: 0, active: 0 })
    return new Promise<{ matches: number; active: number }>((resolve) => {
      const requestId = wc.findInPage(text, {
        forward: options.forward ?? true,
        findNext: options.findNext ?? false
      })
      this.findRequests.set(requestId, resolve)
      setTimeout(() => {
        if (this.findRequests.delete(requestId)) resolve({ matches: 0, active: 0 })
      }, 1500)
    })
  }

  stopFind(id: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void {
    this.tabs.get(id)?.view.webContents.stopFindInPage(action)
  }

  openDevTools(id: string): void {
    this.tabs.get(id)?.view.webContents.openDevTools({ mode: 'detach' })
  }

  setMediaCount(id: string, count: number): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.mediaCount = count
    this.hooks.onState()
  }

  private toState(tab: Tab): TabState {
    const wc = tab.view.webContents
    let secure: TabState['secure'] = 'internal'
    try {
      const parsed = new URL(tab.url)
      if (parsed.protocol === 'https:') secure = 'secure'
      else if (parsed.protocol === 'http:') secure = 'insecure'
    } catch {
      secure = 'internal'
    }
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      loading: tab.loading,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      isBurner: tab.burner,
      muted: wc.isAudioMuted(),
      crashed: tab.crashed,
      secure,
      blocked: this.privacy.blockedForWebContents(wc.id),
      mediaCount: tab.mediaCount
    }
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents

    const update = () => {
      tab.url = wc.getURL() || tab.url
      this.hooks.onState()
    }

    wc.on('did-start-loading', () => {
      tab.loading = true
      tab.crashed = false
      update()
    })

    wc.on('did-stop-loading', () => {
      tab.loading = false
      update()
    })

    wc.on('page-title-updated', (_event, title) => {
      tab.title = title || safeHost(wc.getURL()) || 'Untitled'
      update()
    })

    wc.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons[0] ?? null
      update()
    })

    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      this.privacy.setHostForWebContents(wc.id, safeHost(details.url))
    })

    wc.on('did-navigate', (_event, url) => {
      tab.url = url
      tab.crashed = false
      tab.title = tab.title || safeHost(url)
      this.privacy.setHostForWebContents(wc.id, safeHost(url))
      if (/^https?:/i.test(url)) this.hooks.onVisited(url, tab.title)
      this.hooks.onCookiesCheck()
      update()
    })

    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      tab.url = url
      update()
    })

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      tab.loading = false
      const target = `warden://error?code=${errorCode}&desc=${encodeURIComponent(errorDescription)}&url=${encodeURIComponent(validatedURL)}`
      wc.loadURL(target).catch(() => undefined)
      update()
    })

    wc.on('render-process-gone', () => {
      tab.crashed = true
      tab.loading = false
      update()
    })

    wc.on('found-in-page', (_event, result) => {
      const resolve = this.findRequests.get(result.requestId)
      if (!resolve) return
      this.findRequests.delete(result.requestId)
      resolve({ matches: result.matches, active: result.activeMatchOrdinal })
    })

    wc.setWindowOpenHandler(({ url, disposition }) => {
      // Disposition alone cannot tell a link from a popup: Chromium reports a
      // scripted window.open() that happens during a click as a foreground tab,
      // exactly like a target="_blank" link. That is how yts.gg's "Open Full
      // YTS Homepage" managed to navigate to yts.gg/home *and* open an Opera ad
      // in a second tab.
      //
      // So the decision is about destination, not timing: a page may open a
      // window on its own site; a middle- or ctrl-click (background-tab) is an
      // explicit gesture and is always honoured; anything else that jumps to a
      // third party is a popup. Nothing becomes unreachable — the link context
      // menu opens any link in a new tab directly.
      if (popupDecision({ url, disposition, pageUrl: tab.url }) === 'tab') {
        this.create(url, tab.burner)
      } else {
        this.privacy.noteBlockedPopup(wc.id)
        update()
      }
      return { action: 'deny' }
    })

    wc.on('will-navigate', (event, url) => {
      if (!/^(https?|warden|about):/i.test(url)) {
        event.preventDefault()
      }
    })

    wc.on('will-attach-webview', (event) => {
      event.preventDefault()
    })

    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const ctrl = input.control || input.meta
      const key = input.key.toLowerCase()
      const command = (() => {
        if (ctrl && input.shift && key === 'r') return 'reload-hard' as const
        if (ctrl && input.shift && key === 'i') return 'devtools' as const
        if (ctrl && input.shift && key === 's') return 'scry' as const
        if (ctrl && input.shift && key === 't') return 'restore-tab' as const
        if (ctrl && key === 't') return 'new-tab' as const
        if (ctrl && key === 'w') return 'close-tab' as const
        if (ctrl && key === 'l') return 'focus-address' as const
        if (ctrl && key === 'k') return 'command-palette' as const
        if (ctrl && key === 'f') return 'find' as const
        if (ctrl && key === 'r') return 'reload' as const
        if (ctrl && input.shift && key === 'tab') return 'prev-tab' as const
        if (ctrl && key === 'tab') return 'next-tab' as const
        if (ctrl && key === '`') return 'toggle-terminal' as const
        if (ctrl && key === 'j') return 'toggle-dock' as const
        // Backslash sits next to the right-hand modifiers on a US layout, so
        // it is a one-hand reach while reading something sensitive.
        if (ctrl && key === '\\') return 'lock' as const
        if (ctrl && (key === '=' || key === '+')) return 'zoom-in' as const
        if (ctrl && key === '-') return 'zoom-out' as const
        if (ctrl && key === '0') return 'zoom-reset' as const
        if (ctrl && /^[1-9]$/.test(key)) {
          this.activateIndex(Number(key) - 1)
          return 'handled' as const
        }
        if (ctrl && key === ',') return 'settings' as const
        if (input.alt && key === 'arrowleft') return 'back' as const
        if (input.alt && key === 'arrowright') return 'forward' as const
        if (key === 'f5') return 'reload' as const
        return null
      })()

      if (!command || command === 'handled') {
        if (command === 'handled') event.preventDefault()
        return
      }
      event.preventDefault()
      this.hooks.onShortcut(command, tab.id)
    })

    wc.on('context-menu', (_event, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [
        {
          label: 'Back',
          enabled: wc.navigationHistory.canGoBack(),
          click: () => wc.navigationHistory.goBack()
        },
        {
          label: 'Forward',
          enabled: wc.navigationHistory.canGoForward(),
          click: () => wc.navigationHistory.goForward()
        },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' }
      ]

      // Editing roles act on whatever field has focus in the page. Without them
      // a right click could only copy a selection, so nothing could be pasted
      // into a form.
      if (params.isEditable) {
        template.push(
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' }
        )
      } else if (params.selectionText) {
        template.push({ role: 'copy' }, { role: 'selectAll' }, { type: 'separator' })
      }

      if (params.linkURL) {
        template.push({
          label: 'Open link in new tab',
          click: () => this.create(params.linkURL, tab.burner)
        })
        template.push({
          label: 'Copy link address',
          click: () => clipboard.writeText(params.linkURL)
        })
        template.push({ type: 'separator' })
      }

      if ((params.mediaType === 'video' || params.mediaType === 'audio') && params.srcURL) {
        // Splay kept needing a trip through the picker for a video the operator
        // was already looking at. This sends exactly that element, and the dock
        // fills one of its three slots (replacing the oldest when all are busy).
        template.push({
          label: params.mediaType === 'audio' ? 'Send audio to Splay' : 'Send video to Splay',
          click: () =>
            this.hooks.onMedia(tab.id, {
              url: params.srcURL,
              title: tab.title || params.pageURL || 'Media',
              kind: params.mediaType === 'audio' ? 'audio' : 'video'
            })
        })
        template.push({ type: 'separator' })
      }

      if (params.mediaType === 'image' && params.srcURL) {
        template.push({
          label: 'Copy image',
          click: () => wc.copyImageAt(params.x, params.y)
        })
        template.push({
          label: 'Copy image address',
          click: () => clipboard.writeText(params.srcURL)
        })
        template.push({ type: 'separator' })
      }

      template.push({
        label: 'Scry this page',
        click: () => this.hooks.onShortcut('scry', tab.id)
      })
      template.push({
        label: 'Inspect element',
        click: () => wc.inspectElement(params.x, params.y)
      })

      Menu.buildFromTemplate(template).popup({ window: this.win })
    })

    wc.on('destroyed', () => {
      this.tabs.delete(tab.id)
      this.order = this.order.filter((entry) => entry !== tab.id)
      this.hooks.onState()
    })
  }
}
