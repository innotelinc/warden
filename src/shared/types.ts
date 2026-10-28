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
  /** Cloak on: the tab is in its own throwaway memory session. */
  cloaked: boolean
  muted: boolean
  crashed: boolean
  secure: SecureState
  blocked: number
  mediaCount: number
}

/**
 * A tab that keeps loading the same page instead of navigating: the shape of a
 * challenge loop (bot wall, cookie gate, restarting login) that WARDEN's own
 * cookie policy is usually the reason for. The remedy is per-site compatibility
 * mode, so the hint names the host to exempt and never decides for the operator.
 */
export interface ChallengeHint {
  host: string
  /**
   * `loop` = the tab keeps reloading; `wall` = the page is a captcha gate;
   * `broken` = the document arrived and drew nothing, with requests blocked.
   */
  kind: 'loop' | 'wall' | 'broken'
  /** Loop only: main-frame loads of that host inside the observation window. */
  attempts?: number
  /** Broken only: requests WARDEN blocked in that tab. */
  blocked?: number
}

export type CookieMode = 'block' | 'first-party'

export interface Settings {
  /** block = only allowlisted sites may store or send cookies. */
  cookieMode: CookieMode
  blockAds: boolean
  blockTrackers: boolean
  /**
   * Remove the ad containers a blocked request leaves behind. Cosmetic only:
   * it hides what the network layer already refused and loads nothing new, so a
   * page closes up instead of showing the slot the ad did not fill.
   */
  cosmeticFiltering: boolean
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
  /** Palette id from the shared theme list, or 'system' to follow Windows. */
  theme: string
  /**
   * Expose WARDEN's own CDP endpoint on loopback so external tooling can
   * inspect its tabs. 0 = off. Applied at startup, so changing it needs a
   * restart; Scry itself never needs it for WARDEN tabs.
   */
  debugPort: number
  /** Check GitHub for a newer WARDEN and download it in the background. */
  autoUpdate: boolean
  /** Genie reads each mail message it opens and flags fraud and deception. */
  autoFraudCheck: boolean
  /** The first-launch walkthrough has been finished or skipped. */
  walkthroughSeen: boolean
  /** Minutes of no keyboard or mouse input before the lock screen covers WARDEN. 0 = off. */
  lockTimeoutMinutes: number
  /** Resolve DNS over HTTPS instead of the system resolver. Needs a relaunch. */
  dnsOverHttps: boolean
  /** Id from the provider list in shared/dns.ts. */
  dnsProvider: string
  /**
   * New tabs start in a fresh in-memory session, so nothing follows them.
   *
   * Off by default: burn mode is a decision about one tab. It used to default
   * on, and `settingsVersion` below carries profiles that were saved under that
   * default over to the current one.
   */
  privateByDefault: boolean
  /** Schema version of this file, so a changed default can reach an old profile. */
  settingsVersion: number
  /**
   * Let a page write a download to disk. Off means `will-download` is cancelled:
   * nothing reaches the Downloads folder and nothing is listed.
   */
  allowDownloads: boolean
  /** Route every session through an operator-supplied proxy endpoint. */
  vpnEnabled: boolean
  vpnMode: 'off' | 'socks5' | 'https'
  vpnHost: string
  vpnPort: number
  vpnBypass: string
  /**
   * Fail closed: when a tunnel is configured but its endpoint is not answering,
   * page traffic is refused instead of quietly going out direct. On by default.
   */
  vpnKillSwitch: boolean
  cameraMode: 'off' | 'soften' | 'portrait' | 'pixelate' | 'silhouette'
  /** 0-100; scales blur radius and pixel size. */
  cameraStrength: number
  voiceMode: 'off' | 'deep' | 'bright' | 'robot'
  cameraBlocked: boolean
  microphoneBlocked: boolean
}

export interface UpdateState {
  /**
   * dev        not a packaged build, so there is no release feed
   * unsupported the portable exe cannot replace itself
   * idle       nothing checked yet
   * checking   talking to the release feed
   * downloading a newer installer is coming down
   * ready      downloaded; restart installs it
   * current    already on the newest release
   * error      last check failed; see message
   */
  phase: 'dev' | 'unsupported' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error'
  current: string
  version: string | null
  percent: number
  message: string | null
  checkedAt: number | null
  automatic: boolean
}

/**
 * What Windows Hello can do here, as far as WARDEN has checked.
 *
 * `unknown` means the check has not run yet — it is never treated as a yes.
 */
export type LockHelloStatus =
  | 'available'
  /** Enrolled, but the verifier did not answer: try it, password still works. */
  | 'enrolled'
  | 'not-configured'
  | 'not-present'
  | 'disabled'
  | 'busy'
  | 'unavailable'
  | 'unknown'

export interface LockHelloReport {
  hello: LockHelloStatus
  /** One sentence for the UI: what works here, and what to use instead. */
  note: string
}

export interface LockState {
  locked: boolean
  /** Password attempts in this lock session. */
  attempts: number
  busy: boolean
  error: string | null
  timeoutMinutes: number
  /** Seconds of system-wide inactivity, refreshed while WARDEN is open. */
  idleSeconds: number
  /** True when the lock was raised by the idle timer rather than Ctrl+\ . */
  byTimeout: boolean
  /** Cached Windows Hello availability; see `helloStatus` for a fresh check. */
  hello: LockHelloStatus
  /** A WARDEN PIN is set, so this screen unlocks without the Windows account. */
  pinSet: boolean
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
  /** UIDs are per mailbox, so a message is only identified with its account. */
  accountId: string
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

export type FraudVerdict = 'clear' | 'suspicious' | 'dangerous'

/** What Genie is given to judge: the message, reduced to what matters. */
export interface FraudInput {
  uid: number
  subject: string
  from: string[]
  to: string[]
  date: string
  text: string
  links: string[]
}

/** Genie's read on one message: what it is, how risky, and why. */
export interface FraudAssessment {
  /** The message it belongs to, so a stale verdict cannot dress a new one. */
  uid: number
  /** The mailbox it belongs to: uids repeat across accounts. */
  accountId?: string
  verdict: FraudVerdict
  /** 0-100; higher is more dangerous. */
  score: number
  summary: string
  reasons: string[]
  checkedAt: number
}

export interface MailBody {
  accountId: string
  uid: number
  subject: string
  from: MailAddress[]
  to: MailAddress[]
  cc: MailAddress[]
  date: string
  text: string
  /** Flags as they were when the message was opened, for the reader's toggles. */
  seen: boolean
  flagged: boolean
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
  /** A local shell, or an ssh login running in the same PTY. */
  kind?: 'shell' | 'ssh'
  /** The ssh destination (`user@host`), null for local shells. */
  target?: string | null
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
  /** Set when the active tab is stuck, blank, or stuck behind a challenge page. */
  challenge: ChallengeHint | null
  /**
   * Hosts the operator let through for this run only. The same enforcement
   * bypass as the compatibility list, but never written to settings and gone
   * when WARDEN quits.
   */
  sessionExemptions: string[]
  workspace: WorkspaceId
  settings: Settings
  stats: PrivacyStats
  /**
   * Egress posture, including whether the tunnel endpoint answered. `down` with
   * the kill switch on means page traffic is being refused, not sent direct.
   */
  egress: {
    kind: 'direct' | 'proxy'
    label: string
    health: 'unknown' | 'up' | 'down'
    killSwitch: boolean
  }
  media: MediaSlot[]
  mediaForTab: string | null
  mediaAvailable: MediaItem[]
  terminal: TerminalInfo | null
  terminals: TerminalInfo[]
  drawerOpen: boolean
  mail: {
    accounts: MailAccountPublic[]
    /** A real account id, or `UNIFIED_MAILBOX_ID` when every mailbox is shown. */
    activeAccountId: string | null
    /** The list is every account's copy of the active folder, merged. */
    unified: boolean
    folders: MailFolder[]
    activeFolder: string
    messages: MailSummary[]
    selected: MailBody | null
    busy: boolean
    error: string | null
    /** Genie's fraud read on the selected message, when there is one. */
    fraud: FraudAssessment | null
    fraudBusy: boolean
    fraudError: string | null
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
  /** Drives the restore/maximize glyph, and mirrors what Windows actually did. */
  maximized: boolean
  downloads: DownloadItem[]
  history: HistoryEntry[]
  bookmarks: Bookmark[]
  update: UpdateState
  lock: LockState
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
    /** Reorder the strip; index is the destination slot. */
    move(id: string, index: number): Promise<void>
    activate(id: string): Promise<void>
    /** Silence the challenge hint for this tab until it loops again. */
    dismissChallenge(id: string, host: string): Promise<void>
    /**
     * Turn the cloak on or off. The session is fixed when a view is created, so
     * the page reopens in a new tab on the other session and the old one closes;
     * history does not carry over.
     */
    cloak(id: string, on: boolean): Promise<void>
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
    /**
     * Steps WARDEN aside for one host until WARDEN quits, without storing it.
     * Resolves with the hosts currently exempt for this run.
     */
    unfiltered(host: string, on: boolean): Promise<string[]>
    /**
     * Allows cookies for an SSO login identified from the page URL: the identity
     * provider and the application it returns to, and nothing else.
     */
    allowSignIn(url: string): Promise<{ allowed: string[]; settings: Settings }>
    clearCookies(): Promise<number>
    /** TCP-connect the configured tunnel endpoint; no page traffic involved. */
    probeEgress(): Promise<'unknown' | 'up' | 'down'>
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
    /** Open an ssh login in a new Trench session. */
    ssh(input: { target: string; port?: number }): Promise<TerminalInfo>
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
    /** Open a message through the mailbox it belongs to, not the active one. */
    openMessage(uid: number, accountId?: string): Promise<MailBody>
    /** Move a message to Trash, or delete it where the server has no Trash. */
    deleteMessage(uid: number, accountId?: string): Promise<void>
    /** Save one attachment of the open message into the Downloads folder. */
    downloadAttachment(index: number): Promise<{ path: string }>
    /** Save the open message as an .eml file, exactly as it arrived. */
    saveMessage(): Promise<{ path: string }>
    send(input: SendMailInput): Promise<void>
    setFlag(uid: number, flag: 'seen' | 'flagged', value: boolean, accountId?: string): Promise<void>
    refresh(): Promise<void>
    /** Ask Genie to read the selected message for fraud, ignoring the cache. */
    checkFraud(): Promise<FraudAssessment | null>
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

  update: {
    check(): Promise<UpdateState>
    install(): Promise<{ ok: boolean }>
    onState(listener: (state: UpdateState) => void): () => void
  }

  lock: {
    /** Raise the lock screen now; the same thing Ctrl+\ does. */
    lock(): Promise<void>
    /** Verify the Windows password and, on success, uncover the app. */
    unlock(password: string): Promise<{ ok: boolean; error?: string }>
    /** Unlock with the Windows Hello PIN, fingerprint or face. */
    hello(): Promise<{ ok: boolean; error?: string }>
    /**
     * Unlock with the WARDEN PIN — the way in when the Windows account has no
     * Hello enrolment and no password to type.
     */
    unlockWithPin(pin: string): Promise<{ ok: boolean; error?: string }>
    /** Set or replace the WARDEN PIN (4–10 digits). Refused while locked. */
    setPin(pin: string): Promise<{ ok: boolean; error?: string }>
    /** Remove the WARDEN PIN. Refused while locked. */
    clearPin(): Promise<{ ok: boolean; error?: string }>
    /**
     * Is Windows Hello enrolled and usable? Never prompts, so it can be asked
     * from Policy and from the lock screen before anything is verified.
     */
    helloStatus(): Promise<LockHelloReport>
    /** State for the lock window itself. */
    bootstrap(): Promise<{ lock: LockState; background: string | null; user: string }>
    onState(listener: (state: LockState) => void): () => void
  }

  app: {
    openExternal(url: string): Promise<{ opened: boolean; reason?: string }>
    minimize(): void
    maximize(): void
    close(): void
    quit(): void
  }
}
