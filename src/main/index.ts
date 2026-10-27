import {
  BrowserWindow,
  Menu,
  app,
  ipcMain,
  nativeTheme,
  protocol,
  session,
  shell
} from 'electron'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, APP_NAME } from '@shared/defaults'
import { DOH_PROVIDERS, dohSwitches } from '@shared/dns'
import type { ProxyState } from '@shared/network'
import { sanitizeSettings } from '@shared/settings'
import { resolveThemeId, themeFor } from '@shared/themes'
import { ensureWardenProtocol, setWardenHandler } from './warden-protocol'
import type {
  AppState,
  HistoryEntry,
  Bookmark,
  LayoutRequest,
  ScryProgress,
  ScryReport,
  Settings,
  CloneResult,
  MediaItem,
  WorkspaceId
} from '@shared/types'
import { JsonStore } from './store/json-store'
import { PrivacyService } from './privacy/privacy-service'
import { TabManager, type ShortcutCommand } from './browser/tabs'
import { readDoc } from './browser/local-doc'
import { MediaDock } from './media/media-dock'
import { TerminalService } from './terminal/terminal-service'
import { MailService, type MailStore } from './mail/mail-service'
import { MessagingHub } from './messaging/hub'
import { ScryService } from './scry/scry-service'
import { GenieService } from './genie/genie-service'
import { DownloadManager } from './browser/downloads'
import { SecretVault } from './security/vault'
import { errorHtml, lockPageHtml, newTabHtml, viewerHtml } from './internal-pages'
import { LockService } from './security/lock-service'
import { UpdateService } from './update/update-service'
import { registerIpc, type WardenContext } from './ipc'
import { runSmoke } from './smoke'
import { buildChromeMenu } from './chrome-menu'

const isDev = !app.isPackaged

// ---------------------------------------------------------------- privacy switches
// Page scrollbars are drawn by Chromium, not by our CSS: ask for the overlay
// kind so a site's content keeps its width and the bar fades out instead of
// sitting there as a bright strip against a dark page.
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar,DnsOverHttps')

app.commandLine.appendSwitch('no-pings')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-domain-reliability')
app.commandLine.appendSwitch('disable-breakpad')
app.commandLine.appendSwitch('disable-client-side-phishing-detection')
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')
app.commandLine.appendSwitch('disable-features', [
  'Translate',
  'OptimizationHints',
  'MediaRouter',
  'DialMediaRouteProvider',
  'CalculateNativeWinOcclusion',
  'InterestFeedContentSuggestions',
  'PrivacySandboxSettings4',
  'AutofillServerCommunication',
  'CertificateTransparencyComponentUpdater',
  'AcceptCHFrame',
  'AttributionReportingCrossAppWeb'
].join(','))

/**
 * Self debug mode: expose WARDEN's own CDP endpoint on loopback so external
 * tooling (REA, Chrome DevTools, `curl /json`) can inspect the tabs WARDEN is
 * already running. Scry never needs this for WARDEN tabs, which it drives
 * through webContents.debugger; this is for leaving WARDEN open to other tools.
 *
 * The switch only takes effect before the app is ready, so the setting is read
 * from disk here rather than from the store built after startup. Loopback only:
 * a remote-debugging port bound to all interfaces would let anything on the
 * network drive the browser.
 */
/**
 * Encrypted DNS is a process-wide resolver decision taken from the settings
 * file before the app is ready. `secure` makes Chromium fail closed instead of
 * falling back to the system resolver: a site that cannot be resolved is a
 * visible failure, not a quiet leak to the ISP's nameserver.
 */
function splashFacts(settings: Settings, egress: ProxyState, health: 'unknown' | 'up' | 'down' = 'unknown'): string[] {
  const facts: string[] = []
  if (settings.dnsOverHttps) {
    const provider = DOH_PROVIDERS.find((entry) => entry.id === settings.dnsProvider)
    facts.push(`DNS over HTTPS · ${provider?.name ?? 'encrypted'}`)
  } else {
    facts.push('System resolver')
  }
  facts.push(
    egress.kind === 'proxy'
      ? health === 'down'
        ? 'Tunnel down · traffic blocked'
        : `Tunnel · ${egress.rule.replace('://', ' ')}`
      : settings.vpnEnabled
        ? 'No tunnel endpoint'
        : 'Direct egress'
  )
  facts.push(settings.privateByDefault ? 'Private tab by default' : 'Shared session')
  facts.push('Memory-only profile')
  return facts
}

function applyDnsPolicy(): void {
  let enabled = true
  let provider = ''
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')
    ) as { dnsOverHttps?: unknown; dnsProvider?: unknown }
    enabled = parsed.dnsOverHttps !== false
    provider = typeof parsed.dnsProvider === 'string' ? parsed.dnsProvider : ''
  } catch {
    /* first run: the defaults below apply */
  }
  const dns = dohSwitches(enabled, provider || 'quad9')
  if (dns.mode !== 'secure') return
  app.commandLine.appendSwitch('dns-over-https-mode', 'secure')
  app.commandLine.appendSwitch('dns-over-https-templates', dns.templates.join(' '))
}

function applySelfDebugPort(): void {
  if (process.env.WARDEN_DEBUG_PORT && Number(process.env.WARDEN_DEBUG_PORT) > 0) {
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
    app.commandLine.appendSwitch('remote-debugging-port', String(Number(process.env.WARDEN_DEBUG_PORT)))
    return
  }
  try {
    const file = path.join(app.getPath('userData'), 'settings.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { debugPort?: unknown }
    const port = Number(parsed.debugPort)
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
      app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
      app.commandLine.appendSwitch('remote-debugging-port', String(port))
    }
  } catch {
    /* first run, or no debug port configured */
  }
}

// The smoke harness exercises camera/microphone treatment without a real
// device; the switches are scoped to WARDEN_SMOKE so a normal launch never
// gets a synthetic capture device.
if (process.env.WARDEN_SMOKE === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}

applyDnsPolicy()
applySelfDebugPort()

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'warden',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

app.userAgentFallback = app.userAgentFallback
  .replace(/Electron\/[\d.]+\s*/i, '')
  .replace(new RegExp(`\\b${APP_NAME}\\/[\\d.]+\\s*`, 'i'), '')
  .replace(/\s{2,}/g, ' ')

let win: BrowserWindow | null = null
let quitting = false
let protocolRegistered = false

interface Stores {
  settings: JsonStore<Settings>
  history: JsonStore<HistoryEntry[]>
  bookmarks: JsonStore<Bookmark[]>
}

function buildStores(): Stores {
  const root = app.getPath('userData')
  return {
    settings: new JsonStore<Settings>(path.join(root, 'settings.json'), DEFAULT_SETTINGS, sanitizeSettings),
    history: new JsonStore<HistoryEntry[]>(path.join(root, 'history.json'), [], (value) =>
      Array.isArray(value) ? (value as HistoryEntry[]).slice(0, 4000) : []
    ),
    bookmarks: new JsonStore<Bookmark[]>(path.join(root, 'bookmarks.json'), [], (value) =>
      Array.isArray(value) ? (value as Bookmark[]) : []
    )
  }
}

async function createWindow(stores: Stores): Promise<void> {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    // Start on the palette's own background, so a light theme does not show a
    // dark frame for the frame or two before the renderer paints.
    backgroundColor: themeFor(stores.settings.get().theme).vars['--bg'] ?? '#080a0d',
    title: 'WARDEN',
    // No native caption overlay: its glyphs are drawn by Windows and on some
    // builds they vanish against a dark frame with no hover feedback at all.
    // The chrome draws its own buttons (see WindowControls) so the affordance
    // is ours to style and to test.
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  // A menu bar is chrome a browser does not want, but the edit roles are what
  // register Ctrl+C/V/X/A/Z at the application level: with the menu taken away
  // the accelerators were gone too, so nothing could be copied or pasted in the
  // address bar, a dialog or a page field on Windows. Install the roles, then
  // keep the bar out of sight.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ])
  )

  // Chromium only raises `context-menu` on the web contents it happens in, so
  // the chrome needs its own handler: without this, right clicking the address
  // bar showed nothing at all and a URL could not be pasted with the mouse.
  win.webContents.on('context-menu', (_event, params) => {
    const template = buildChromeMenu(params)
    if (!template.length) return
    Menu.buildFromTemplate(template).popup({ window: win ?? undefined })
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && rendererUrl) {
    await win.loadURL(rendererUrl)
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win?.show())

  const settingsStore = stores.settings
  const settings = settingsStore.get()

  // ------------------------------------------------------------ services
  let workspace: WorkspaceId = 'browse'
  let layout: LayoutRequest = { surface: 'browse', tabBounds: null, mediaBounds: [], msgBounds: null }
  let scryProgress: ScryProgress | null = null
  let scryResult: CloneResult | null = null
  let scryReport: ScryReport | null = null
  let scryError: string | null = null
  let scryTargets: AppState['scry']['targets'] = []
  let drawerOpen = false
  const mediaByTab = new Map<string, AppState['mediaAvailable']>()

  let pushTimer: NodeJS.Timeout | null = null
  /**
   * Startup ordering, not politeness: `snapshot` is defined further down, and
   * privacy.start() reports its first stats before that. Without this flag the
   * 40 ms timer fires during an await and hits `snapshot` inside its temporal
   * dead zone, which aborts startup before any IPC handler is registered.
   */
  let stateReady = false
  const sendState = (): void => {
    if (!stateReady || pushTimer) return
    pushTimer = setTimeout(() => {
      pushTimer = null
      if (!stateReady || !win || win.isDestroyed()) return
      win.webContents.send('warden:state', snapshot())
    }, 40)
  }

  const privacy = new PrivacyService(settings, () => sendState())
  await privacy.start()

  const browserWindow = win
  const tabs = new TabManager(browserWindow, privacy, {
    onState: sendState,
    onShortcut: (command, tabId) => handleShortcut(command, tabId),
    onVisited: (url, title) => {
      const list = stores.history.get()
      const last = list[0]
      if (last && last.url === url && Date.now() - last.visitedAt < 3000) return
      stores.history.set(
        [
          {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            url,
            title: title || url,
            visitedAt: Date.now()
          },
          ...list
        ].slice(0, 4000)
      )
    },
    onCookiesCheck: () => {
      void privacy.wipeCookies()
    },
    onMedia: (tabId, source) => {
      const page = tabs.list().find((entry) => entry.id === tabId)?.url ?? ''
      const url = source.url
      const item: MediaItem = {
        id: `media-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`,
        url,
        kind: source.kind,
        title: source.title,
        poster: null,
        width: null,
        height: null,
        duration: null,
        isLive: /\.m3u8(\?|$)/i.test(url),
        playable: !/\.m3u8(\?|$)/i.test(url),
        viewerUrl: url,
        currentTime: 0,
        playing: false,
        source: 'direct',
        pageUrl: page
      }
      media.open(item, page, tabs.getSession(tabId) ?? undefined)
      sendState()
    },
    /**
     * Cookies for a sign-in flow, granted by the click that started it.
     *
     * WARDEN refuses cookies everywhere by default, and an SSO login needs two
     * hosts to keep state: the application and the provider. The operator
     * pressed "Sign in"; this allows exactly the hosts that flow names — never
     * a wildcard, never another site — so the callback can find its state
     * cookie and the provider can keep a session.
     */
    onSignInHosts: (hosts) => {
      const current = privacy.getSettings()
      const missing = hosts
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0 && !current.allowlist.includes(host))
      if (!missing.length) return
      const next = stores.settings.update((settings) => ({
        ...settings,
        allowlist: [...new Set([...settings.allowlist, ...missing])].slice(0, 500)
      }))
      privacy.applySettings(next)
      sendState()
    }
  })

  const media = new MediaDock(browserWindow, () => privacy.createIsolatedSession('media'))
  const terminal = new TerminalService({
    onData: (id, data) => browserWindow.webContents.send('warden:term:data', id, data),
    onExit: (id, code) => {
      browserWindow.webContents.send('warden:term:exit', id, code)
      sendState()
    }
  })

  const vault = new SecretVault(path.join(app.getPath('userData'), 'secrets.json'))
  await vault.load()

  // The WARDEN PIN lives in its own record, not settings.json: settings are
  // handed to the renderer whole, and a credential does not belong in them.
  // Only the salted scrypt hash is stored, never the PIN.
  const lockPinStore = new JsonStore<{ hash: string | null }>(
    path.join(app.getPath('userData'), 'lock-pin.json'),
    { hash: null },
    (value) => {
      const hash = (value as { hash?: unknown } | null)?.hash
      return { hash: typeof hash === 'string' && hash ? hash : null }
    }
  )
  await lockPinStore.load()

  const mailStore = new JsonStore<MailStore>(path.join(app.getPath('userData'), 'mail.json'), {
    accounts: [],
    activeAccountId: null,
    activeFolder: 'INBOX'
  })
  await mailStore.load()
  const mail = new MailService(mailStore, vault, sendState, () => stores.settings.get().autoFraudCheck)
  mail.load()

  const messaging = new MessagingHub(browserWindow, privacy, sendState)
  const downloads = new DownloadManager(sendState)
  privacy.onDownload((item) => downloads.track(item))

  // One definition for both the layout path and the lock screen: while locked
  // every native view is hidden, so nothing shows through the overlay.
  const applySuppressed = (suppressed: boolean): void => {
    if (suppressed) {
      tabs.setVisible(false)
      messaging.setVisible(false)
      media.setVisible(false)
      return
    }
    tabs.setVisible(layout.surface === 'browse')
    messaging.setVisible(layout.surface === 'messages')
    media.setVisible(layout.mediaBounds.length > 0)
  }

  const lock = new LockService({
    parent: () => (browserWindow.isDestroyed() ? null : browserWindow),
    preload: path.join(__dirname, '../preload/index.js'),
    activePage: () => (tabs.activeTabId ? tabs.getWebContents(tabs.activeTabId) : null),
    timeoutMinutes: () => stores.settings.get().lockTimeoutMinutes,
    setSuppressed: applySuppressed,
    pins: {
      get: () => lockPinStore.get().hash,
      // Flushed immediately: a PIN the operator set and then lost to a crash
      // would leave them outside the lock screen they just configured.
      set: async (hash) => {
        lockPinStore.set({ hash })
        await lockPinStore.flush()
      }
    },
    onState: () => {
      if (browserWindow.isDestroyed()) return
      browserWindow.webContents.send('warden:lock:state', lock.snapshot())
      sendState()
    }
  })

  // Find out now, not while the screen is covered: this is the answer Policy
  // shows next to "check Windows Hello", and it costs one short-lived process.
  void lock.helloReport()

  const update = new UpdateService({
    enabled: () => stores.settings.get().autoUpdate,
    onChange: () => {
      if (browserWindow.isDestroyed()) return
      browserWindow.webContents.send('warden:update:state', update.snapshot())
      sendState()
    }
  })

  const scry = new ScryService({
    settings: () => stores.settings.get(),
    outputRoot: () => {
      const configured = stores.settings.get().scryOutputDir
      if (configured) return configured
      return path.join(app.getPath('documents'), 'WARDEN-Scry')
    },
    localTabs: () =>
      tabs.list().map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })),
    localWebContents: (tabId) => tabs.getWebContents(tabId),
    onProgress: (progress) => {
      scryProgress = progress
      browserWindow.webContents.send('warden:scry:progress', progress)
      sendState()
    },
    onReport: (report) => {
      scryReport = report
      sendState()
    },
    blockedCount: () => privacy.snapshot().blockedTotal
  })

  // Genie reads the gateway key from the environment (development) or the OS
  // keychain (set from Policy). It is never written to settings or sent to the
  // renderer, and every call leaves from the main process.
  const genie = new GenieService({
    gatewayUrl: () => process.env.INNOTEL_GATEWAY_URL || 'https://gateway.innotel.us/v1',
    apiKey: () => process.env.INNOTEL_GATEWAY_KEY || vault.get('innotel.gateway'),
    model: () => process.env.GENIE_MODEL || 'auto/best-coding',
    activeContext: async () => {
      const tab = tabs.list().find((entry) => entry.id === tabs.activeTabId)
      return { url: tab?.url ?? '', title: tab?.title ?? '' }
    },
    activeText: async () => {
      const wc = tabs.activeTabId ? tabs.getWebContents(tabs.activeTabId) : null
      if (!wc) return ''
      const text = await wc
        .executeJavaScript('document.body ? document.body.innerText : ""', true)
        .catch(() => '')
      return typeof text === 'string' ? text.slice(0, 8000) : ''
    },
    stats: () => {
      const now = privacy.snapshot()
      return {
        blocked: now.blockedTotal,
        rules: now.rulesLoaded,
        cookiesStripped: now.cookiesStripped,
        trackers: now.trackersBlocked
      }
    },
    scrySummary: () => {
      if (!scryReport) return null
      return JSON.stringify({
        url: scryReport.url,
        title: scryReport.title,
        requests: scryReport.requests,
        technologies: scryReport.technologies.map((entry) => entry.name),
        trackers: scryReport.trackers.map((entry) => entry.host),
        missingSecurityHeaders: scryReport.server.missingSecurityHeaders
      })
    },
    emit: (event) => {
      browserWindow.webContents.send('warden:genie:event', event)
    }
  })

  // Genie exists by now, and its key can appear or vanish mid-session, so the
  // mail service asks both questions at call time.
  mail.setFraudChecker(
    (input) => genie.assessFraud(input),
    () => genie.configured
  )

  const snapshot = (): AppState => ({
    tabs: tabs.list(),
    activeTabId: tabs.activeTabId,
    challenge: tabs.challengeHint(),
    sessionExemptions: privacy.sessionExemptions(),
    workspace,
    settings: stores.settings.get(),
    stats: privacy.snapshot(),
    egress: (() => {
      const report = privacy.egressReport()
      return {
        kind: report.state.kind,
        label: report.label,
        health: report.health,
        killSwitch: report.killSwitch
      }
    })(),
    media: media.snapshot(),
    mediaForTab: tabs.activeTabId,
    mediaAvailable: tabs.activeTabId ? (mediaByTab.get(tabs.activeTabId) ?? []) : [],
    terminal: terminal.active,
    terminals: terminal.list(),
    drawerOpen,
    mail: mail.state,
    messaging: {
      services: messaging.services,
      states: messaging.states(),
      activeId: messaging.active
    },
    scry: { running: scry.busy, progress: scryProgress, result: scryResult, report: scryReport, targets: scryTargets, error: scryError },
    maximized: browserWindow.isMaximized(),
    downloads: downloads.list(),
    history: stores.history.get().slice(0, 200),
    bookmarks: stores.bookmarks.get(),
    update: update.snapshot(),
    lock: lock.snapshot(),
    version: app.getVersion(),
    platform: process.platform
  })

  // Every collaborator the snapshot reads now exists, so state pushes are safe.
  // The pending timer from privacy.start() still returns to the renderer.
  stateReady = true
  sendState()

  const handleShortcut = (command: ShortcutCommand, tabId: string | null): void => {
    const activeId = tabId ?? tabs.activeTabId
    switch (command) {
      case 'new-tab':
        tabs.create('warden://newtab')
        return
      case 'close-tab':
        tabs.closeActive()
        return
      case 'reload':
        if (activeId) tabs.reload(activeId)
        return
      case 'reload-hard':
        if (activeId) tabs.reload(activeId, true)
        return
      case 'back':
        if (activeId) tabs.back(activeId)
        return
      case 'forward':
        if (activeId) tabs.forward(activeId)
        return
      case 'devtools':
        if (activeId) tabs.openDevTools(activeId)
        return
      case 'zoom-in':
        if (activeId) tabs.setZoom(activeId, 0.1)
        return
      case 'zoom-out':
        if (activeId) tabs.setZoom(activeId, -0.1)
        return
      case 'zoom-reset':
        if (activeId) tabs.setZoom(activeId, 'reset')
        return
      case 'next-tab':
        tabs.cycle(1)
        return
      case 'prev-tab':
        tabs.cycle(-1)
        return
      case 'toggle-terminal':
        drawerOpen = !drawerOpen
        if (drawerOpen && !terminal.active) terminal.create(stores.settings.get().terminalShell)
        sendState()
        return
      case 'lock':
        void lock.lock(false)
        return
      default:
        browserWindow.webContents.send('warden:shortcut', command)
    }
  }

  const context: WardenContext = {
    win: browserWindow,
    tabs,
    privacy,
    media,
    terminal,
    mail,
    messaging,
    scry,
    genie,
    downloads,
    update,
    lock,
    stores,
    snapshot,
    sendState,
    getWorkspace: () => workspace,
    setWorkspace: (next) => {
      workspace = next
      tabs.setVisible(next === 'browse')
      messaging.setVisible(next === 'concourse')
      if (next !== 'browse') media.setVisible(false)
      else media.setVisible(true)
      sendState()
    },
    getLayout: () => layout,
    setLayout: (next) => {
      layout = next
      if (next.surface === 'browse' && next.tabBounds) tabs.setBounds(next.tabBounds)
      media.setRects(next.mediaBounds)
      media.setVisible(next.surface === 'browse' || next.mediaBounds.length > 0)
      messaging.setBounds(next.msgBounds)
      tabs.setVisible(next.surface === 'browse')
      messaging.setVisible(next.surface === 'messages')
    },
    setGenieKey: (key) => {
      try {
        if (!key.trim()) {
          vault.delete('innotel.gateway')
          return { ok: true }
        }
        vault.set('innotel.gateway', key.trim())
        return { ok: true }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    },
    setSuppressed: applySuppressed,
    setDrawer: (open) => {
      drawerOpen = open
      sendState()
    },
    setScry: (patch) => {
      if (patch.progress !== undefined) scryProgress = patch.progress
      if (patch.result !== undefined) scryResult = patch.result
      if (patch.report !== undefined) scryReport = patch.report
      if (patch.targets !== undefined) scryTargets = patch.targets
      if (patch.error !== undefined) scryError = patch.error
      sendState()
    }
  }

  registerIpc(context)

  // ------------------------------------------------------------ protocol
  /**
   * WARDEN's own pages, as one handler.
   *
   * `protocol.handle` binds a scheme to a single session, and WARDEN does not
   * run its pages in the default one: a browsing tab has its own partition and
   * Splay's viewer runs in the session of the tab it came from. So the handler
   * is defined here once, registered on the app's session below, and handed to
   * `ensureWardenProtocol` for the sessions that do not inherit it.
   */
  const handleWardenUrl = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const settingsNow = stores.settings.get()
    // `system` resolves here rather than in the page: these documents are built
    // in the main process, which is the side that can ask Windows which
    // appearance is current.
    const theme = resolveThemeId(settingsNow.theme, nativeTheme.shouldUseDarkColors)

    if (url.hostname === 'newtab') {
      return new Response(
        newTabHtml({
          stats: privacy.snapshot(),
          facts: splashFacts(settingsNow, privacy.egressState(), privacy.egressReport().health),
          bookmarks: stores.bookmarks.get().slice(0, 12),
          version: app.getVersion(),
          homepage: settingsNow.homepage,
          theme
        }),
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
      )
    }

    if (url.hostname === 'lock') {
      return new Response(lockPageHtml(), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      })
    }

    if (url.hostname === 'error') {
      return new Response(
        errorHtml(
          url.searchParams.get('code') ?? 'ERR',
          url.searchParams.get('desc') ?? 'Navigation failed',
          url.searchParams.get('url') ?? '',
          theme
        ),
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
      )
    }

    if (url.hostname === 'doc') {
      const doc = readDoc(url.searchParams.get('path') ?? '', theme)
      if (doc) {
        return new Response(doc.html, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
        })
      }
      return new Response(
        errorHtml('DOC', 'That file cannot be shown here', url.searchParams.get('path') ?? '', theme),
        { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
      )
    }

    if (url.hostname === 'viewer') {
      return new Response(
        viewerHtml(
          url.searchParams.get('src') ?? '',
          url.searchParams.get('title') ?? '',
          url.searchParams.get('kind') ?? 'video',
          Number(url.searchParams.get('t') ?? 0)
        ),
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
      )
    }

    return new Response('Not found', { status: 404 })
  }

  setWardenHandler(handleWardenUrl)
  if (!protocolRegistered) {
    protocolRegistered = true
    protocol.handle('warden', handleWardenUrl)
  }
  // The partitions WARDEN opens outside a tab: Splay's own media session, and
  // the browsing partition the new tab is drawn in.
  ensureWardenProtocol(session.fromPartition('warden-media'))
  ensureWardenProtocol(session.fromPartition('warden-browse'))

  /**
   * Follow Windows.
   *
   * A `system` theme has to re-resolve when the OS flips and nothing else
   * notices: the renderer gets `prefers-color-scheme` for free, but WARDEN's own
   * documents are built in this process, and the window frame is painted here.
   */
  const followSystemAppearance = (): void => {
    nativeTheme.themeSource = 'system'
    if (browserWindow.isDestroyed()) return
    const id = resolveThemeId(stores.settings.get().theme, nativeTheme.shouldUseDarkColors)
    browserWindow.setBackgroundColor(themeFor(id).vars['--bg'] ?? '#07090c')
    // Only a `system` setting has anything to redraw; a fixed palette is fixed.
    if (stores.settings.get().theme !== 'system') return
    for (const tab of tabs.list()) {
      if (tab.url.startsWith('warden://')) tabs.reload(tab.id)
    }
  }
  nativeTheme.on('updated', followSystemAppearance)
  followSystemAppearance()

  // ------------------------------------------------------------ page signals
  ipcMain.removeAllListeners('warden:media:found')
  ipcMain.removeAllListeners('warden:hover')

  ipcMain.on('warden:media:found', (event, tabId: string, items: unknown) => {
    if (!Array.isArray(items)) return
    if (tabs.getWebContents(tabId)?.id !== event.sender.id) return
    tabs.setMediaCount(tabId, items.length)
    mediaByTab.set(tabId, items as AppState['mediaAvailable'])
    sendState()

    if (!stores.settings.get().autoDockMedia) return
    if (tabId !== tabs.activeTabId) return

    const playable = items.filter(
      (item) =>
        item &&
        typeof item === 'object' &&
        (item as { playable?: boolean }).playable !== false &&
        (item as { playing?: boolean }).playing === true
    ) as { id: string; url: string }[]

    for (const item of playable.slice(0, MediaDock.slotCount())) {
      if (media.has(item as never)) continue
      const slot = media.open(item as never, tabs.getTabUrl(tabId) ?? '')
      if (slot === null) continue
      tabs.getWebContents(tabId)?.send('warden:media:claim', (item as { url: string }).url)
    }
  })

  // Sensors: answered synchronously at preload time so the page-world shim is
  // installed before the first script runs, and re-read on every reload.
  ipcMain.removeAllListeners('warden:sensors:sync')
  ipcMain.on('warden:sensors:sync', (event) => {
    // The enforcement copy, not the store: a policy applied at runtime has to
    // reach the shim even before the file is written.
    const current = privacy.getSettings()
    event.returnValue = {
      cameraMode: current.cameraMode,
      cameraStrength: current.cameraStrength,
      voiceMode: current.voiceMode,
      cameraBlocked: current.cameraBlocked,
      microphoneBlocked: current.microphoneBlocked
    }
  })

  // Cosmetic filtering: the same shape of answer, read at preload time so the
  // hiding stylesheet is in the document before the page paints its first ad
  // slot — a pass that runs after layout would show the gap and then close it.
  ipcMain.removeAllListeners('warden:cosmetic:sync')
  ipcMain.on('warden:cosmetic:sync', (event) => {
    event.returnValue = privacy.getSettings().cosmeticFiltering !== false
  })

  ipcMain.on('warden:hover', (event, tabId: string, url: string) => {
    if (tabs.getWebContents(tabId)?.id !== event.sender.id) return
    if (typeof url !== 'string') return
    browserWindow.webContents.send('warden:hover', url)
  })

  // ------------------------------------------------------------ window
  // Links opened by the app UI (mail bodies, panels) become WARDEN tabs.
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) tabs.create(url)
    return { action: 'deny' }
  })

  browserWindow.on('resize', sendState)
  browserWindow.on('maximize', sendState)
  browserWindow.on('unmaximize', sendState)
  browserWindow.on('closed', () => {
    win = null
  })

  webContentsGuard()

  // ------------------------------------------------------------ first run
  lock.start()
  update.start()
  await stores.settings.flush()
  tabs.create(stores.settings.get().homepage || 'warden://newtab')
  sendState()

  if (process.env.WARDEN_SMOKE === '1') {
    void runSmoke(context, process.env.WARDEN_SMOKE_URL ?? 'http://127.0.0.1:4321/')
  }

  // contexts for the IPC layer that need late binding
  ;(globalThis as { __wardenContext?: WardenContext }).__wardenContext = context
}

function webContentsGuard(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        shell.openExternal(url).catch(() => undefined)
      }
      return { action: 'deny' }
    })
  })

  // The camera and microphone preview in Policy runs in WARDEN's own window, so
  // that window — and only that window — may ask for media. Pages never use this
  // session: they get their own partition with its own handler, which requires an
  // allowlisted host and still hands out a treated track.
  const appWindowAsks = (wc: Electron.WebContents | null): boolean =>
    Boolean(wc && win && !win.isDestroyed() && wc.id === win.webContents.id)

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media') return callback(appWindowAsks(wc))
    callback(
      permission === 'clipboard-sanitized-write' || permission === 'clipboard-read' || permission === 'fullscreen'
    )
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    if (permission === 'media') return appWindowAsks(wc)
    return permission === 'clipboard-sanitized-write' || permission === 'clipboard-read' || permission === 'fullscreen'
  })
}

app.whenReady().then(async () => {
  app.setName(APP_NAME)
  app.setAppUserModelId('com.warden.browser')

  const stores = buildStores()
  await stores.settings.load()
  await stores.history.load()
  await stores.bookmarks.load()

  await createWindow(stores)

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow(stores)
    }
  })
})

app.on('before-quit', async (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  const context = (globalThis as { __wardenContext?: WardenContext }).__wardenContext
  try {
    context?.lock.forceRelease()
    context?.update.stop()
    context?.lock.stop()
    context?.terminal.killAll()
    await context?.mail.close()
  } catch {
    /* ignore */
  }
  app.quit()
})

app.on('window-all-closed', () => {
  app.quit()
})
