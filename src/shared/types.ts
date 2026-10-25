/**
 * WARDEN — shared type contract.
 * Imported by main, preload and renderer. Types only, no runtime side effects
 * except the small constant tables at the bottom of shared/defaults.ts.
 */

export type WorkspaceId = 'browse' | 'trench' | 'relay' | 'concourse' | 'scry' | 'genie' | 'settings'

/** Streamed Genie events: the renderer never talks to the gateway itself. */
export type GenieEvent =
  | { type: 'status'; message: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string }

export type SecureState = 'secure' | 'insecure' | 'internal' | 'blocked'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface TabState {
  id: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isBurner: boolean
  muted: boolean
  crashed: boolean
  secure: SecureState
  blocked: number
  mediaCount: number
}

export type CookieMode = 'block' | 'first-party'

export interface Settings {
  /** block = only allowlisted sites may store or send cookies. */
  cookieMode: CookieMode
  blockAds: boolean
  blockTrackers: boolean
  httpsOnly: boolean
  fingerprintHardening: boolean
  stripReferrer: boolean
  globalPrivacyControl: boolean
  blockWebSockets: boolean
  javascriptEnabled: boolean
  imagesEnabled: boolean
  webrtcLeakProtection: boolean
  /** Hosts permitted to keep cookies for this session. Nothing persists to disk. */
  allowlist: string[]
  /**
   * Hosts where WARDEN steps out of the way: no filtering, no header
   * rewriting, no cookie stripping, no fingerprint noise. For sites that refuse
   * to work through a privacy stack (challenge pages, banking portals, SSO).
   */
  compatibility: string[]
  customRules: string
  searchEngine: string
  homepage: string
  terminalShell: string
  terminalFontSize: number
  autoDockMedia: boolean
  lastMailAccountId: string | null
  scryPort: number
  scryOutputDir: string | null
  /** Admin palette id from the shared theme list. */
  theme: string
  /**
   * Expose WARDEN's own CDP endpoint on loopback so external tooling can
   * inspect its tabs. 0 = off. Applied at startup, so changing it needs a
   * restart; Scry itself never needs it for WARDEN tabs.
   */
  debugPort: number
}

export interface BlockedHost {
  host: string
  count: number
}

export interface PrivacyStats {
  requestsSeen: number
  blockedTotal: number
  cookiesStripped: number
  trackersBlocked: number
  httpsUpgrades: number
  sessionStartedAt: number
  topHosts: BlockedHost[]
  rulesLoaded: number
  filterLists: { name: string; rules: number; updatedAt: number | null }[]
}

export interface HistoryEntry {
  id: string
  url: string
  title: string
  visitedAt: number
}

export interface Bookmark {
  id: string
  url: string
  title: string
  createdAt: number
}

export type MediaKind = 'video' | 'audio' | 'embed' | 'hls'

export interface MediaItem {
  id: string
  url: string
  kind: MediaKind
  title: string
  poster: string | null
  width: number | null
  height: number | null
  duration: number | null
  isLive: boolean
  /** True when the item can be handed to a native <video> element directly. */
  playable: boolean
  /** Where the dock should point its viewer. */
  viewerUrl: string
  currentTime: number
  playing: boolean
  source: 'direct' | 'iframe'
  pageUrl: string
}

export interface MediaSlot {
  slot: number
  item: MediaItem
  muted: boolean
  paused: boolean
  rate: number
}

export interface MailCredentials {
  host: string
  port: number
  secure: boolean
  user: string
}

export interface MailAccountPublic {
  id: string
  label: string
  email: string
  imap: MailCredentials
  smtp: MailCredentials
  color: string
  hasPassword: boolean
  lastError: string | null
}

export interface MailFolder {
  path: string
  name: string
  specialUse: string | null
  unread: number
  total: number
}

export interface MailAddress {
  name: string
  address: string
}

export interface MailSummary {
  uid: number
  subject: string
  from: MailAddress[]
  to: MailAddress[]
  date: string
  seen: boolean
  flagged: boolean
  hasAttachments: boolean
  preview: string
  size: number
}

export interface MailBody {
  uid: number
  subject: string
  from: MailAddress[]
  to: MailAddress[]
  cc: MailAddress[]
  date: string
  text: string
  html: string | null
  remoteContentCount: number
  attachments: { filename: string; size: number; contentType: string }[]
}

export interface SendMailInput {
  accountId: string
  to: string
  cc?: string
  subject: string
  text: string
}

export interface MessagingService {
  id: string
  name: string
  url: string
  color: string
  glyph: string
}

export interface MessagingState {
  id: string
  opened: boolean
  unread: number
  title: string
  loading: boolean
  failed: boolean
  lastError: string | null
}

export interface ScryTarget {
  id: string
  title: string
  url: string
  type: string
  source: 'remote' | 'local'
  attached: boolean
}

export interface ScryAsset {
  url: string
  localPath: string
  kind: 'document' | 'stylesheet' | 'script' | 'image' | 'font' | 'media' | 'json' | 'other'
  bytes: number
  status: number
}

export interface ScryReport {
  origin: string
  url: string
  title: string
  capturedAt: number
  durationMs: number
  requests: number
  transferredBytes: number
  technologies: { name: string; evidence: string }[]
  server: { headers: Record<string, string>; missingSecurityHeaders: string[] }
  thirdParties: { host: string; requests: number; kind: string }[]
  trackers: { host: string; requests: number }[]
  cookies: { name: string; domain: string; secure: boolean; httpOnly: boolean }[]
  mixedContent: string[]
  endpoints: string[]
  forms: { action: string; method: string; fields: number }[]
  designTokens: DesignTokens
  notes: string[]
}

export interface DesignTokens {
  colors: { value: string; count: number }[]
  fonts: { value: string; count: number }[]
  fontSizes: { value: string; count: number }[]
  radii: { value: string; count: number }[]
  shadows: { value: string; count: number }[]
  spacing: { value: string; count: number }[]
  breakpoints: { value: string; count: number }[]
}

export interface ScryProgress {
  phase: 'queued' | 'attaching' | 'capturing' | 'writing' | 'report' | 'done' | 'error'
  message: string
  requests: number
  bytes: number
  error?: string
}

export interface InnovationReport {
  scripts: number
  droppedScripts: number
  behaviors: number
  rewrittenBehaviors: number
  features: string[]
  warnings: string[]
}

export interface CloneResult {
  outputDir: string
  capturePath: string
  clonePath: string
  scaffoldPath: string
  reportPath: string
  pages: number
  files: number
  bytes: number
  /** Innovate output, present only for the innovate mode. */
  modernPath?: string | null
  innovation?: InnovationReport | null
}

export interface TerminalInfo {
  id: string
  title: string
  shell: string
  backend: 'pty' | 'pipe'
  cols: number
  rows: number
  cwd: string
  alive: boolean
  exitCode: number | null
}

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadItem {
  id: string
  filename: string
  url: string
  state: DownloadState
  received: number
  total: number
  savePath: string
}

export interface AppState {
  tabs: TabState[]
  activeTabId: string | null
  workspace: WorkspaceId
  settings: Settings
  stats: PrivacyStats
  media: MediaSlot[]
  mediaForTab: string | null
  mediaAvailable: MediaItem[]
  terminal: TerminalInfo | null
  terminals: TerminalInfo[]
  drawerOpen: boolean
  mail: {
    accounts: MailAccountPublic[]
    activeAccountId: string | null
    folders: MailFolder[]
    activeFolder: string
    messages: MailSummary[]
    selected: MailBody | null
    busy: boolean
    error: string | null
  }
  messaging: {
    services: MessagingService[]
    states: MessagingState[]
    activeId: string | null
  }
  scry: {
    running: boolean
    progress: ScryProgress | null
    result: CloneResult | null
    report: ScryReport | null
    targets: ScryTarget[]
    error: string | null
  }
  downloads: DownloadItem[]
  history: HistoryEntry[]
  bookmarks: Bookmark[]
  version: string
  platform: string
}

export interface LayoutRequest {
  surface: 'browse' | 'messages' | 'hidden'
  tabBounds: Rect | null
  mediaBounds: Rect[]
  msgBounds: Rect | null
}

export interface MailAccountInput {
  label: string
  email: string
  password: string
  imap: MailCredentials
  smtp: MailCredentials
}

export interface WardenApi {
  bootstrap(): Promise<AppState>
  onState(listener: (state: AppState) => void): () => void
  onTerminalData(listener: (id: string, data: string) => void): () => void
  onTerminalExit(listener: (id: string, code: number | null) => void): () => void
  onScryProgress(listener: (progress: ScryProgress) => void): () => void
  onShortcut(listener: (command: string) => void): () => void
  onHover(listener: (url: string) => void): () => void

  setWorkspace(id: WorkspaceId): Promise<void>
  setLayout(layout: LayoutRequest): Promise<void>
  setSuppressed(suppressed: boolean): Promise<void>

  tab: {
    create(url?: string, burner?: boolean): Promise<string>
    close(id: string): Promise<void>
    activate(id: string): Promise<void>
    navigate(id: string, url: string): Promise<void>
    back(id: string): Promise<void>
    forward(id: string): Promise<void>
    reload(id: string, hard?: boolean): Promise<void>
    stop(id: string): Promise<void>
    mute(id: string, muted: boolean): Promise<void>
    find(id: string, text: string, options?: { forward?: boolean; findNext?: boolean }): Promise<{ matches: number; active: number }>
    stopFind(id: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection'): Promise<void>
    devtools(id: string): Promise<void>
    contextAction(action: string, tabId: string): Promise<void>
    playerCommand(target: 'tab' | 'media', id: string, command: string, value?: number): Promise<void>
  }

  genie: {
    status(): Promise<{ configured: boolean; running: boolean }>
    ask(
      messages: { role: 'user' | 'assistant'; content: string }[],
      model?: string
    ): Promise<{ ok: boolean }>
    cancel(): Promise<void>
    setKey(key: string): Promise<{ ok: boolean; error?: string }>
    onEvent(listener: (event: GenieEvent) => void): () => void
  }

  privacy: {
    allow(host: string, allowed: boolean): Promise<void>
    /** Steps WARDEN aside for one host; resolves with the stored settings. */
    compatibility(host: string, on: boolean): Promise<Settings>
    clearCookies(): Promise<number>
    syncLists(): Promise<{ rules: number }>
    refresh(): Promise<PrivacyStats>
  }

  media: {
    scan(tabId: string): Promise<MediaItem[]>
    open(tabId: string, item: MediaItem): Promise<void>
    close(slot: number): Promise<void>
    clear(): Promise<void>
    control(slot: number, command: 'play' | 'pause' | 'mute' | 'unmute' | 'rate' | 'seek', value?: number): Promise<void>
  }

  terminal: {
    create(shell?: string): Promise<TerminalInfo>
    input(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    kill(id: string): Promise<void>
    activate(id: string): Promise<void>
    scrollback(id: string): Promise<string>
    setDrawer(open: boolean): Promise<void>
  }

  mail: {
    addAccount(input: MailAccountInput): Promise<MailAccountPublic>
    removeAccount(id: string): Promise<void>
    selectAccount(id: string): Promise<void>
    listFolders(): Promise<MailFolder[]>
    selectFolder(path: string): Promise<void>
    listMessages(limit?: number): Promise<MailSummary[]>
    openMessage(uid: number): Promise<MailBody>
    send(input: SendMailInput): Promise<void>
    setFlag(uid: number, flag: 'seen' | 'flagged', value: boolean): Promise<void>
    refresh(): Promise<void>
  }

  messaging: {
    open(serviceId: string): Promise<void>
    close(serviceId: string): Promise<void>
    activate(serviceId: string): Promise<void>
    reload(serviceId: string): Promise<void>
    focusAddressBar(): Promise<void>
  }

  scry: {
    listTargets(port?: number): Promise<ScryTarget[]>
    capture(target: { source: 'remote' | 'local'; id: string }, options?: { label?: string }): Promise<ScryReport>
    clone(target: { source: 'remote' | 'local'; id: string }, options?: { label?: string; includeScripts?: boolean }): Promise<CloneResult>
    innovate(target: { source: 'remote' | 'local'; id: string }, options?: { label?: string }): Promise<CloneResult>
    reconLocalTab(tabId: string): Promise<ScryReport>
    cloneLocalTab(tabId: string, options?: { includeScripts?: boolean }): Promise<CloneResult>
    cancel(): Promise<void>
    reaStatus(): Promise<{ installed: boolean; version: string | null; path: string | null }>
    runRea(target: { source: 'remote' | 'local'; id: string }): Promise<{ ok: boolean; output: string }>
    openOutput(path: string): Promise<void>
  }

  settings: {
    update(patch: Partial<Settings>): Promise<Settings>
    reset(): Promise<Settings>
  }

  history: {
    clear(): Promise<void>
  }

  bookmarks: {
    toggle(url: string, title: string): Promise<void>
    remove(id: string): Promise<void>
  }

  app: {
    openExternal(url: string): Promise<{ opened: boolean; reason?: string }>
    minimize(): void
    maximize(): void
    close(): void
    quit(): void
  }
}
