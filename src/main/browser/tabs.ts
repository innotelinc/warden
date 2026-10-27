import { BrowserWindow, Menu, WebContentsView, clipboard } from 'electron'
import path from 'node:path'
import type { ChallengeHint, Rect, TabState } from '@shared/types'
import type { PrivacyService } from '../privacy/privacy-service'
import { safeHost } from '../privacy/filter-engine'
import { detectChallengeLoop, type NavigationEvent } from './challenge-loop'
import { popupDecision } from './popup-policy'
import { buildPageMenu, isLocalMediaSource, probeMediaScript, type PageMenuCommand } from './page-menu'
import { signInHostsFor } from '@shared/auth-flow'
import { looksBrokenPage, type PageHealth } from '@shared/site-breakage'
import { themeFor } from '@shared/themes'

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
  /** Main-frame loads, newest last: the stream the loop detector reads. */
  navigations: NavigationEvent[]
  /** The preload's answer for the current document, when it found a wall. */
  wall: { host: string; reason: string } | null
  /** How much the current document drew, as the preload measured it. */
  health: PageHealth | null
  /** Host whose challenge hint the operator has dismissed for this tab. */
  dismissedHint: string | null
}

export interface TabHooks {
  onState: () => void
  onShortcut: (command: ShortcutCommand, tabId: string | null) => void
  onVisited: (url: string, title: string) => void
  onCookiesCheck: () => void
  /** Send a media element straight to the Splay dock, bypassing the scanner. */
  onMedia: (tabId: string, media: { url: string; title: string; kind: 'video' | 'audio' }) => void
  /**
   * Allow cookies for the hosts a sign-in flow spans.
   *
   * An OIDC login is the one thing that cannot work under WARDEN's default
   * cookie policy: the application keeps a state cookie and the provider keeps
   * a session, on two different hosts. The operator clicking "Sign in" is the
   * decision; this carries it through to policy.
   */
  onSignInHosts: (hosts: string[]) => void
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
  /**
   * When the last page menu was opened, in ms. A second `context-menu` for the
   * same click must not stack another menu on top of the first, but a guard
   * that waits for the popup to close could wedge right-click for good if the
   * callback never fires, so this is a short window instead of a lock.
   */
  private menuOpenedAt = 0

  constructor(
    private readonly win: BrowserWindow,
    private readonly privacy: PrivacyService,
    private readonly hooks: TabHooks
  ) {}

  get activeTabId(): string | null {
    return this.activeId
  }

  /**
   * The colour behind a page.
   *
   * A view paints this before its document does, so a literal dark value would
   * flash under a light palette on every new tab. Read from the active preset
   * instead, which is the same surface the renderer paints its chrome with.
   */
  private pageBackground(): string {
    return themeFor(this.privacy.getSettings().theme).vars['--bg'] ?? '#0b0e12'
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

  /**
   * Turn the cloak on or off for one tab.
   *
   * A view's session is chosen when it is created, so the flag cannot change
   * under a live page: the URL is reopened in a new view on the other session,
   * the new tab takes the old tab's place in the strip, and the old view closes.
   * History does not carry over — a different session is a different browser —
   * which is why the strip's toggle reloads the page instead of switching it.
   */
  setCloak(id: string, on: boolean): string | null {
    const tab = this.tabs.get(id)
    if (!tab) return null
    if (tab.burner === on) return id

    const index = this.order.indexOf(id)
    const url = tab.url || 'warden://newtab'
    const wasActive = this.activeId === id
    const previousActive = this.activeId

    const nextId = this.create(url, on)
    this.move(nextId, index)
    this.close(id)
    if (wasActive) this.activate(nextId)
    else if (previousActive) this.activate(previousActive)
    return nextId
  }

  /**
   * The challenge the active tab is stuck on, if any.
   *
   * Three shapes qualify: a page it keeps reloading, a single captcha or
   * browser-check interstitial, and a page that arrived empty after WARDEN
   * blocked part of it. Stepping aside for the host is the remedy this prompt
   * offers, so a host that already has it stays silent — there is nothing left
   * for the operator to grant.
   */
  challengeHint(id: string | null = this.activeId): ChallengeHint | null {
    if (!id) return null
    const tab = this.tabs.get(id)
    if (!tab) return null

    const loop = detectChallengeLoop(tab.navigations, Date.now())
    const hint: ChallengeHint | null = loop
      ? { host: loop.host, kind: 'loop', attempts: loop.attempts }
      : tab.wall
        ? { host: tab.wall.host, kind: 'wall' }
        : this.brokenHint(tab)
    if (!hint) return null

    if (this.privacy.isCompatible(hint.host)) return null
    if (tab.dismissedHint === hint.host) return null
    return hint
  }

  /** A settled document that drew nothing, on a tab that had requests blocked. */
  private brokenHint(tab: Tab): ChallengeHint | null {
    const host = safeHost(tab.url)
    if (!host) return null
    const broken = looksBrokenPage({
      health: tab.health,
      blocked: this.privacy.blockedForWebContents(tab.view.webContents.id),
      compatible: this.privacy.isCompatible(host),
      loading: tab.loading
    })
    if (!broken) return null
    return { host, kind: 'broken', blocked: broken.blocked }
  }

  /**
   * The preload's measurement of the document it is showing.
   *
   * Returns whether anything changed: a single-page app re-measures on every
   * substantial mutation, and an identical reading must not push state.
   */
  setPageHealth(id: string, health: PageHealth): boolean {
    const tab = this.tabs.get(id)
    if (!tab) return false
    const previous = tab.health
    const next = { textChars: health.textChars, elements: health.elements }
    if (previous && previous.textChars === next.textChars && previous.elements === next.elements) {
      return false
    }
    tab.health = next
    return true
  }

  /**
   * The content preload's answer for the document it is showing.
   *
   * Returns whether anything changed, so a page that keeps re-probing itself
   * does not push an identical state at the renderer.
   */
  setChallengeWall(id: string, reason: string | null): boolean {
    const tab = this.tabs.get(id)
    if (!tab) return false
    const host = safeHost(tab.url)
    const next = reason && host ? { host, reason } : null
    if (tab.wall?.host === next?.host && tab.wall?.reason === next?.reason) return false
    tab.wall = next
    return true
  }

  /** A dismissed hint stays quiet until the tab leaves the host and comes back. */
  dismissChallenge(id: string, host: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.dismissedHint = host.trim().toLowerCase() || null
  }

  private noteNavigation(tab: Tab, url: string): void {
    tab.navigations.push({ url, at: Date.now() })
    if (tab.navigations.length > 24) tab.navigations.splice(0, tab.navigations.length - 24)
    // A hint covers the page it was shown for, not every later page on the same
    // host: leaving the site clears the dismissal.
    const host = safeHost(url)
    if (tab.dismissedHint && tab.dismissedHint !== host) tab.dismissedHint = null
    // The wall described the document that just went away. The probe answers for
    // the new one, and a compatible page answers nothing at all, so clearing
    // here also keeps a stale wall from coming back when the exemption is
    // revoked. The measurement described that document too.
    tab.wall = null
    tab.health = null
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
    view.setBackgroundColor(this.pageBackground())

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
      attached: false,
      navigations: [],
      wall: null,
      health: null,
      dismissedHint: null
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
      cloaked: tab.burner,
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
      this.noteNavigation(tab, url)
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
      const decision = popupDecision({ url, disposition, pageUrl: tab.url })
      if (decision === 'window') {
        // A sized window on the page's own site (OIDC sign-in, a bank portal)
        // gets a real window on the opener's session: `window.open` returns a
        // handle, the opener is live, and a cloaked tab's popup stays inside
        // that throwaway session instead of landing in the shared one.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 700,
            parent: this.win,
            autoHideMenuBar: true,
            backgroundColor: this.pageBackground(),
            webPreferences: {
              session: wc.session,
              preload: PRELOAD(),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webviewTag: false,
              spellcheck: false,
              backgroundThrottling: false,
              navigateOnDragDrop: false,
              safeDialogs: true,
              disableDialogs: true
            }
          }
        }
      }
      if (decision === 'tab') {
        this.create(url, tab.burner)
      } else {
        this.privacy.noteBlockedPopup(wc.id)
        update()
      }
      return { action: 'deny' }
    })

    wc.on('will-navigate', (event, url) => {
      // `warden://doc` reads a file from this machine, so only WARDEN itself may
      // open it: a page that navigated there would be choosing which local
      // document to display.
      if (/^warden:\/\/(doc|lock)/i.test(url)) {
        event.preventDefault()
        return
      }
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

    // A sign-in popup spans two hosts and WARDEN refuses cookies on both by
    // default, so the flow dies at the callback with no useful error. The click
    // on "Sign in" is the decision: allow exactly the hosts the flow names, as
    // the redirect reveals them.
    wc.on('did-create-window', (child, { url }) => {
      const childWc = child.webContents
      const openerHost = safeHost(tab.url)
      const note = (target: string) => {
        this.privacy.setHostForWebContents(childWc.id, safeHost(target))
        const signIn = signInHostsFor(target)
        if (!signIn) return
        const hosts = [signIn.provider, signIn.application, openerHost].filter(
          (host): host is string => Boolean(host)
        )
        if (hosts.length) this.hooks.onSignInHosts(hosts)
      }
      // `will-redirect` fires before the provider's response arrives, so its
      // session cookie is kept rather than stripped as third-party.
      childWc.on('will-redirect', (_event, target) => note(target))
      childWc.on('will-navigate', (_event, target) => note(target))
      childWc.on('did-navigate', (_event, target) => note(target))
      note(url)
    })

    wc.on('context-menu', (_event, params) => {
      // One menu per click. A second template from a stacked handler would put
      // two menus on screen and let the operator click a label that belongs to
      // the one underneath.
      const now = Date.now()
      if (now - this.menuOpenedAt < 150) return
      this.menuOpenedAt = now

      const commands = buildPageMenu({
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        isEditable: params.isEditable,
        selectionText: params.selectionText ?? '',
        linkURL: params.linkURL ?? '',
        mediaType: params.mediaType,
        srcURL: params.srcURL ?? '',
        hasMedia: tab.mediaCount > 0,
        mediaKind: params.mediaType === 'video' || params.mediaType === 'audio' ? params.mediaType : null
      })

      const template: Electron.MenuItemConstructorOptions[] = commands.map((command) => {
        if (command.kind === 'separator') return { type: 'separator' }
        if (command.kind === 'role') return { role: command.role }
        return {
          label: command.label,
          enabled: command.enabled,
          click: () => this.runPageMenu(tab, command, params)
        }
      })
      if (!template.length) return

      Menu.buildFromTemplate(template).popup({ window: this.win })
    })

    wc.on('destroyed', () => {
      this.tabs.delete(tab.id)
      this.order = this.order.filter((entry) => entry !== tab.id)
      this.hooks.onState()
    })
  }

  private runPageMenu(
    tab: Tab,
    command: Extract<PageMenuCommand, { kind: 'command' }>,
    params: Electron.ContextMenuParams
  ): void {
    const wc = tab.view.webContents
    switch (command.id) {
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
        return
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
        return
      case 'reload':
        wc.reload()
        return
      case 'open-link':
        if (command.arg) this.create(command.arg, tab.burner)
        return
      case 'copy-link':
      case 'copy-image-url':
        if (command.arg) clipboard.writeText(command.arg)
        return
      case 'copy-image':
        wc.copyImageAt(params.x, params.y)
        return
      case 'scry':
        this.hooks.onShortcut('scry', tab.id)
        return
      case 'inspect':
        wc.inspectElement(params.x, params.y)
        return
      case 'send-media':
        this.sendMediaToSplay(tab, params, command.arg)
        return
    }
  }

  /**
   * Hand the media under the cursor to Splay.
   *
   * When the page did not name the element — a custom player draws its own
   * controls over a hidden <video> — the page is asked for whatever sits at the
   * click point. A `blob:` or MediaSource answer is dropped here: it only
   * resolves inside the document that made it, so a separate viewer would show
   * a black rectangle.
   */
  private sendMediaToSplay(tab: Tab, params: Electron.ContextMenuParams, given?: string): void {
    const hand = (src: string, kind: 'video' | 'audio'): void => {
      if (!src || isLocalMediaSource(src)) return
      this.hooks.onMedia(tab.id, { url: src, title: tab.title || params.pageURL || 'Media', kind })
      // The player leaves the page as well as joining the dock. Splay plays the
      // source in its own view, so leaving the original in place means the same
      // audio twice and a page still holding a poster-sized gap. Only ever sent
      // from this path — the dock's automatic hand-off mirrors a playing video
      // and must not touch the document.
      tab.view.webContents.send('warden:media:detach', src)
    }

    if (given) {
      hand(given, params.mediaType === 'audio' ? 'audio' : 'video')
      return
    }

    tab.view.webContents
      .executeJavaScript(probeMediaScript(params.x, params.y))
      .then((found: unknown) => {
        if (!found || typeof found !== 'object') return
        const { src, kind } = found as { src?: unknown; kind?: unknown }
        if (typeof src !== 'string') return
        hand(src, kind === 'audio' ? 'audio' : 'video')
      })
      .catch(() => undefined)
  }
}
