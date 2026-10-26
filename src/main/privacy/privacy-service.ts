/**
 * Bastion — the enforcement layer.
 *
 * Owns every hardened Electron session and applies the pure decisions from
 * cookie-policy.ts / filter-engine.ts to real traffic:
 *
 *   layer 1  request interception  (ads, trackers, types, HTTPS upgrade)
 *   layer 2  header rewriting      (Cookie, Referer, DNT/Sec-GPC, NEL)
 *   layer 3  response rewriting    (Set-Cookie stripping)
 *   layer 4  cookie-store guard    (writes rejected + periodic sweep)
 *   layer 5  permission lockdown   (no prompts, everything denied)
 */

import { session, type DownloadItem, type Session } from 'electron'
import net from 'node:net'
import type { PrivacyStats, Settings } from '@shared/types'
import { builtinRules } from './builtin-lists'
import { parseFilterList, safeHost, FilterEngine, type RequestInfo, type ResourceType } from './filter-engine'
import { hostMatches } from '@shared/urls'
import {
  filterResponseHeaders,
  isAllowlisted,
  isCookieKeptByAllowlist,
  isCookieKeptByCompatibility,
  shouldAcceptCookie,
  shouldSendCookies,
  upgradeToHttps,
  referrerFor,
  type CookieMode
} from './cookie-policy'
import { readListCache, rulesFromCache, syncLists } from './lists'
import { egressLabel, egressVerdict, normalizeProxy, proxyRule, type EgressHealth, type ProxyState } from '@shared/network'

const REQUEST_FILTER = { urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] }

export type DownloadHandler = (item: DownloadItem) => void

interface MutableStats extends PrivacyStats {
  lastEmit: number
}

export class PrivacyService {
  private engine = new FilterEngine()
  private browsing: Session | null = null
  private burners: Session[] = []
  private settings: Settings
  private hostByWebContents = new Map<number, string>()
  private hostCounts = new Map<string, number>()
  private onStats: (stats: PrivacyStats) => void
  private downloadHandler: DownloadHandler | null = null
  private listMeta: PrivacyStats['filterLists'] = []
  private stats: MutableStats
  private warnedHosts = new Set<string>()
  /**
   * Hosts let through for this run only.
   *
   * "Let it work here" is a diagnosis, not a preference: the operator wants to
   * know whether the privacy stack is what broke the page, and wants that page
   * to load without deciding to trust the site from now on. So the same
   * enforcement bypass as compatibility mode is granted in memory, never
   * written to settings, and dropped when WARDEN quits.
   */
  private sessionExempt = new Set<string>()
  /** Compatibility list plus the session exemptions, rebuilt only on change. */
  private compatEntries: string[] | null = null
  private blockedByWc = new Map<number, number>()
  private egress: ProxyState = { kind: 'direct', reason: 'unconfigured' }
  private health: EgressHealth = 'unknown'
  private probeTimer: NodeJS.Timeout | null = null

  constructor(settings: Settings, onStats: (stats: PrivacyStats) => void) {
    this.settings = settings
    this.onStats = onStats
    this.stats = {
      requestsSeen: 0,
      blockedTotal: 0,
      cookiesStripped: 0,
      trackersBlocked: 0,
      httpsUpgrades: 0,
      sessionStartedAt: Date.now(),
      topHosts: [],
      rulesLoaded: 0,
      filterLists: [],
      lastEmit: 0
    }
  }

  async start(): Promise<void> {
    await this.rebuildEngine(null)
    this.browsing = session.fromPartition('warden-browse')
    this.wire(this.browsing)
    await this.wipeCookies(this.browsing)
    await this.applyProxy()
    // Re-check the endpoint while a tunnel is configured: a WireGuard client
    // that dies mid-session must not leave WARDEN quietly going direct.
    if (!this.probeTimer) {
      this.probeTimer = setInterval(() => {
        if (this.egress.kind === 'proxy') void this.probeEgress()
      }, 20_000)
      this.probeTimer.unref?.()
    }
  }

  /**
   * Egress: a direct connection, or the operator's own SOCKS/HTTPS endpoint.
   * Chromium applies this below the page, so fetch, WebSocket and the resolver
   * all take the same path; a rule that names no endpoint stays direct and the
   * UI is told why instead of showing a tunnel that is not there.
   */
  async applyProxy(): Promise<void> {
    const settings = this.settings
    const configured = {
      mode: settings.vpnMode,
      host: settings.vpnHost,
      port: settings.vpnPort,
      bypass: settings.vpnBypass
    }
    const state = proxyRule(configured)
    const active = settings.vpnEnabled && state.kind === 'proxy' ? state : { kind: 'direct' as const, reason: 'disabled' as const }
    this.egress = active
    // A changed endpoint has not been checked yet: `unknown` keeps the kill
    // switch from blocking pages before the first probe can answer.
    this.health = 'unknown'
    void this.probeEgress()
    const sessions = [this.browsing, ...this.burners].filter((entry): entry is Session => Boolean(entry))
    await Promise.all(
      sessions.map((ses) =>
        active.kind === 'proxy'
          ? ses.setProxy({ proxyRules: active.rule, proxyBypassRules: configured.bypass })
          : ses.setProxy({ mode: 'direct' })
      )
    )
  }

  /** What the sessions are actually doing, for the UI. */
  egressState(): ProxyState {
    return this.egress
  }

  /** Whether the configured endpoint is answering, and the one-line label. */
  egressReport(): { state: ProxyState; health: EgressHealth; label: string; killSwitch: boolean } {
    const settings = this.settings
    const configured = {
      mode: settings.vpnMode,
      host: settings.vpnHost,
      port: settings.vpnPort,
      bypass: settings.vpnBypass
    }
    return {
      state: this.egress,
      health: this.health,
      label: egressLabel(configured, this.health),
      killSwitch: settings.vpnKillSwitch
    }
  }

  /**
   * Is the tunnel endpoint alive?
   *
   * A TCP connect to the configured host and port, nothing more: it opens no
   * page and leaks no request, and a WireGuard client answering on its local
   * proxy is exactly what this sees. A tunnel that is down is the case the kill
   * switch exists for, so this answer decides whether traffic is allowed.
   */
  probeEgressNow(): Promise<EgressHealth> {
    return this.probeEgress()
  }

  private probeEgress(): Promise<EgressHealth> {
    if (this.egress.kind !== 'proxy') {
      this.health = 'unknown'
      return Promise.resolve(this.health)
    }
    const configured = normalizeProxy({
      mode: this.settings.vpnMode,
      host: this.settings.vpnHost,
      port: this.settings.vpnPort,
      bypass: this.settings.vpnBypass
    })
    if (!configured.port) {
      this.health = 'down'
      this.emit(true)
      return Promise.resolve(this.health)
    }
    return new Promise<EgressHealth>((resolve) => {
      let settled = false
      const finish = (value: EgressHealth): void => {
        if (settled) return
        settled = true
        this.health = value
        this.emit(true)
        resolve(value)
      }
      const socket = net.connect({ host: configured.host || '127.0.0.1', port: configured.port })
      const timer = setTimeout(() => {
        socket.destroy()
        finish('down')
      }, 1500)
      timer.unref?.()
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.destroy()
        finish('up')
      })
      socket.once('error', () => {
        clearTimeout(timer)
        socket.destroy()
        finish('down')
      })
    })
  }

  get browsingSession(): Session {
    if (!this.browsing) throw new Error('privacy service not started')
    return this.browsing
  }

  /** A throwaway session for a cloaked tab. Nothing survives the tab. */
  createBurnerSession(): Session {
    const ses = session.fromPartition(`warden-burn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    this.burners.push(ses)
    this.wire(ses)
    return ses
  }

  /**
   * An isolated memory-only session for a first-party app surface (Concourse
   * services, the Splay viewer). Cookies are allowed for the surface's own
   * origin so logins work, but never for third parties and never on disk.
   */
  createIsolatedSession(name: string, mode: CookieMode = 'first-party'): Session {
    const ses = session.fromPartition(`warden-${name}`)
    this.burners.push(ses)
    this.wire(ses, mode)
    return ses
  }

  onDownload(handler: DownloadHandler): void {
    this.downloadHandler = handler
  }

  getSettings(): Settings {
    return this.settings
  }

  applySettings(settings: Settings): void {
    this.compatEntries = null
    const engineAffecting =
      settings.blockAds !== this.settings.blockAds ||
      settings.blockTrackers !== this.settings.blockTrackers ||
      settings.customRules !== this.settings.customRules
    this.settings = settings
    if (engineAffecting) void this.rebuildEngine(null)
    void this.applyProxy()
  }

  setHostForWebContents(id: number, host: string | null): void {
    if (host) this.hostByWebContents.set(id, host)
    else this.hostByWebContents.delete(id)
  }

  blockedForWebContents(id: number | undefined): number {
    if (id === undefined) return 0
    return this.blockedByWc.get(id) ?? 0
  }

  /**
   * A window.open the browser refused. It belongs in the same count as a
   * blocked request: from the visitor's side both are "something the page tried
   * to load, and this browser said no".
   */
  noteBlockedPopup(id?: number): void {
    this.stats.blockedTotal += 1
    if (id !== undefined && id >= 0) {
      this.blockedByWc.set(id, (this.blockedByWc.get(id) ?? 0) + 1)
    }
  }

  snapshot(): PrivacyStats {
    const topHosts = [...this.hostCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([host, count]) => ({ host, count }))

    return {
      requestsSeen: this.stats.requestsSeen,
      blockedTotal: this.stats.blockedTotal,
      cookiesStripped: this.stats.cookiesStripped,
      trackersBlocked: this.stats.trackersBlocked,
      httpsUpgrades: this.stats.httpsUpgrades,
      sessionStartedAt: this.stats.sessionStartedAt,
      topHosts,
      rulesLoaded: this.engine.size,
      filterLists: this.listMeta
    }
  }

  async refreshListsFromCache(): Promise<void> {
    const cache = await readListCache()
    await this.rebuildEngine(cache)
  }

  async syncRemoteLists(): Promise<number> {
    const { cache } = await syncLists()
    await this.rebuildEngine(cache)
    return this.engine.size
  }

  /** Remove every cookie the policy would not accept. Returns how many. */
  async wipeCookies(target?: Session): Promise<number> {
    const sessions = target ? [target] : [this.browsingSession, ...this.burners]
    let removed = 0
    for (const ses of sessions) {
      try {
        const cookies = await ses.cookies.get({})
        for (const cookie of cookies) {
          const host = cookie.domain?.replace(/^\./, '') || ''
          // Compatibility sites are policy-accepted, exactly like allowlisted
          // ones; purging them would just break the site again. Both accept a
          // cookie written to the parent of the exempted host, because that is
          // where a session cookie lands (`www.amazon.com` → `.amazon.com`).
          if (this.keepsCookieForCompatibility(host)) continue
          // A parent-domain cookie belongs to the allowlisted site that set it
          // (`auth.example.com` → `.example.com`), so the purge keeps it too.
          if (isCookieKeptByAllowlist(host, this.settings.allowlist)) continue
          if (!shouldAcceptCookie(this.cookieContext(host), host, cookie.domain)) {
            const scheme = cookie.secure ? 'https' : 'http'
            const url = `${scheme}://${host}${cookie.path || '/'}`
            await ses.cookies.remove(url, cookie.name)
            removed += 1
          }
        }
      } catch {
        /* session may be tearing down */
      }
    }
    if (removed) {
      this.stats.cookiesStripped += removed
      this.emit()
    }
    return removed
  }

  /**
   * Sites the operator has put into compatibility mode.
   *
   * A challenge page or a bank portal that refuses to work through a privacy
   * stack needs WARDEN to behave like a plain browser for that host and nothing
   * else — so every layer here checks this first, and the page preload asks the
   * same question synchronously before it injects anything.
   */
  isCompatible(host: string | null): boolean {
    return host !== null && hostMatches(host, this.compatibilityEntries())
  }

  /**
   * Every host WARDEN currently steps aside for, stored or not.
   *
   * Cached because this is asked once per request, per header and per document;
   * a fresh array per call would be allocated thousands of times a second.
   */
  private compatibilityEntries(): string[] {
    if (!this.compatEntries) {
      this.compatEntries = [...this.settings.compatibility, ...this.sessionExempt]
    }
    return this.compatEntries
  }

  /** Hosts exempt for this run only, as the UI reports them. */
  sessionExemptions(): string[] {
    return [...this.sessionExempt]
  }

  /**
   * Grant or revoke a session exemption.
   *
   * Nothing is stored and no engine is rebuilt: every enforcement layer asks
   * `isCompatible` at request time, and the page preload asks again on each
   * document, so the next load already sees the new answer.
   */
  setSessionExemption(host: string, on: boolean): string[] {
    const normalized = host.trim().toLowerCase()
    if (!normalized) return this.sessionExemptions()
    if (on) this.sessionExempt.add(normalized)
    else this.sessionExempt.delete(normalized)
    this.compatEntries = null
    return this.sessionExemptions()
  }

  /**
   * Does compatibility mode keep a cookie stored on `cookieHost`?
   *
   * `isCompatible` answers for the host the operator exempted. A cookie's domain
   * can be the parent of that host, so the store guard and the purge ask this
   * instead of judging the cookie by its own domain alone.
   */
  private keepsCookieForCompatibility(cookieHost: string): boolean {
    // The effective list, so a session exemption keeps a parent-domain cookie
    // exactly like a stored one does — `www.example.com` exempted, cookie on
    // `.example.com`, which is where a site's session usually lands.
    return this.isCompatible(cookieHost) || isCookieKeptByCompatibility(cookieHost, this.compatibilityEntries())
  }

  /**
   * May the page's own JavaScript touch cookies for this host?
   *
   * Asked by the content preload at document start, synchronously, so granting
   * an allowance and reloading takes effect immediately instead of waiting for a
   * tab to be recreated with a newer argument list.
   */
  cookiesAllowedFor(host: string | null): boolean {
    if (!host) return false
    if (this.settings.cookieMode === 'first-party') return true
    return isAllowlisted(host, this.settings.allowlist) || this.isCompatible(host)
  }

  private cookieContext(siteHost: string | null, mode: CookieMode = this.settings.cookieMode) {
    return {
      mode,
      allowlist: this.settings.allowlist,
      siteHost
    }
  }

  private async rebuildEngine(cache: Awaited<ReturnType<typeof readListCache>> | null): Promise<void> {
    const rules = []
    const lists: PrivacyStats['filterLists'] = []

    if (this.settings.blockAds || this.settings.blockTrackers) {
      const builtin = parseFilterList(builtinRules().join('\n'), 'ads')
      rules.push(...builtin)
      lists.push({ name: 'Bastion seed', rules: builtin.length, updatedAt: null })
    }
    if (this.settings.customRules.trim()) {
      const custom = parseFilterList(this.settings.customRules, 'custom')
      rules.push(...custom)
      lists.push({ name: 'User rules', rules: custom.length, updatedAt: null })
    }
    const cached = cache ?? (await readListCache())
    if (cached) {
      const remote = rulesFromCache(cached)
      rules.push(...remote)
      lists.push({ name: 'EasyList + EasyPrivacy', rules: remote.length, updatedAt: cached.updatedAt })
    }

    this.engine = new FilterEngine(rules)
    this.listMeta = lists
    this.emit(true)
  }

  private wire(ses: Session, mode: CookieMode = this.settings.cookieMode): void {
    ses.webRequest.onBeforeRequest(REQUEST_FILTER, (details, callback) => {
      try {
        const decision = this.inspect(details)
        if (decision.redirectURL) return callback({ redirectURL: decision.redirectURL })
        if (decision.cancel) return callback({ cancel: true })
        callback({})
      } catch {
        callback({})
      }
    })

    ses.webRequest.onBeforeSendHeaders(REQUEST_FILTER, (details, callback) => {
      try {
        // Compatibility mode sends the request exactly as the page built it:
        // no cookie removal, no Referer trimming, no added DNT/GPC, and none of
        // the client-hint headers deleted below.
        if (this.isCompatible(this.siteHostFor(details.webContentsId))) {
          return callback({})
        }
        callback({ requestHeaders: this.hardenHeaders(details, mode) })
      } catch {
        callback({})
      }
    })

    ses.webRequest.onHeadersReceived(REQUEST_FILTER, (details, callback) => {
      try {
        const host = safeHost(details.url)
        const siteHost = this.siteHostFor(details.webContentsId) ?? host
        if (this.isCompatible(siteHost)) return callback({})
        const { headers, stripped } = filterResponseHeaders(
          (details.responseHeaders ?? {}) as Record<string, string | string[]>,
          this.cookieContext(siteHost, mode),
          host
        )
        if (stripped) {
          this.stats.cookiesStripped += stripped
          this.emit()
        }
        // No blanket delete here: filterResponseHeaders has already dropped
        // every cookie the policy rejects, and deleting the key again would
        // throw away the cookies an allowlisted site just set. That is what
        // made an allowed login impossible — the store was always empty.
        callback({ responseHeaders: headers as Record<string, string[]> })
      } catch {
        callback({})
      }
    })

    // Camera and microphone are the one permission WARDEN can grant, and only
    // to a site the operator allowlisted: everything else — notifications,
    // geolocation, MIDI, clipboard read, HID, serial — is refused without a
    // prompt. Even when media is granted the page gets a processed track, and
    // a blocked sensor is refused here before any device is opened.
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      if (permission !== 'media') return callback(false)
      const host = this.siteHostFor(wc.id)
      if (!host) return callback(false)
      const mediaAllowed = this.settings.cameraBlocked && this.settings.microphoneBlocked
      callback(!mediaAllowed && isAllowlisted(host, this.settings.allowlist))
    })
    ses.setPermissionCheckHandler((wc, permission) => {
      if (permission !== 'media' || !wc) return false
      if (this.settings.cameraBlocked && this.settings.microphoneBlocked) return false
      const host = this.siteHostFor(wc.id)
      return Boolean(host && isAllowlisted(host, this.settings.allowlist))
    })
    ses.setDevicePermissionHandler(() => false)
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      callback({})
    })
    ses.setSpellCheckerEnabled(false)

    ses.on('will-download', (event, item) => {
      // The page asks; the operator answers in Policy. Cancelling here means the
      // file never reaches a temp path, so nothing is left to clean up.
      if (!this.settings.allowDownloads) {
        event.preventDefault()
        return
      }
      this.downloadHandler?.(item)
    })

    this.guardCookieStore(ses, mode)
  }

  private guardCookieStore(ses: Session, mode: CookieMode = this.settings.cookieMode): void {
    const cookies = ses.cookies as unknown as {
      set: (details: Electron.CookiesSetDetails) => Promise<void>
      __wardenPatched?: boolean
    }
    if (cookies.__wardenPatched) return
    const original = cookies.set.bind(cookies)
    cookies.set = (details) => {
      let host = ''
      try {
        if (details.domain) host = details.domain.replace(/^\./, '')
        else if (details.url) host = safeHost(details.url)
      } catch {
        host = ''
      }
      // The site setting the cookie is the request's own host when the store is
      // written outside a tracked tab navigation.
      const siteHost = (details.url ? safeHost(details.url) : '') || host
      if (this.keepsCookieForCompatibility(host) || this.isCompatible(siteHost)) {
        return original(details)
      }
      if (!host || !shouldAcceptCookie(this.cookieContext(siteHost, mode), host, details.domain)) {
        this.stats.cookiesStripped += 1
        this.emit()
        return Promise.resolve()
      }
      return original(details)
    }
    cookies.__wardenPatched = true
  }

  private siteHostFor(webContentsId: number | undefined): string | null {
    if (webContentsId === undefined || webContentsId < 0) return null
    return this.hostByWebContents.get(webContentsId) ?? null
  }

  private headerSource(details: Electron.OnBeforeSendHeadersListenerDetails): string {
    const site = this.siteHostFor(details.webContentsId)
    if (site) return `https://${site}/`
    return details.referrer || ''
  }

  private hardenHeaders(
    details: Electron.OnBeforeSendHeadersListenerDetails,
    mode: CookieMode = this.settings.cookieMode
  ): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = { ...(details.requestHeaders ?? {}) }
    const requestHost = safeHost(details.url)
    const siteHost = this.siteHostFor(details.webContentsId) ?? requestHost
    const ctx = this.cookieContext(siteHost, mode)

    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase()
      if (lower === 'cookie' && !shouldSendCookies(ctx, requestHost)) {
        delete headers[key]
        this.stats.cookiesStripped += 1
      } else if (lower === 'referer' && this.settings.stripReferrer) {
        const trimmed = referrerFor(this.headerSource(details))
        if (trimmed) headers[key] = trimmed
        else delete headers[key]
      } else if (lower === 'x-client-data' || lower === 'sec-ch-ua-full-version-list') {
        delete headers[key]
      }
    }

    if (this.settings.globalPrivacyControl) {
      headers['DNT'] = '1'
      headers['Sec-GPC'] = '1'
    }
    return headers
  }

  private inspect(details: Electron.OnBeforeRequestListenerDetails): { cancel?: boolean; redirectURL?: string } {
    this.stats.requestsSeen += 1

    // The kill switch comes before everything else. When a tunnel is configured
    // and its endpoint is not answering, letting the request out would send it
    // direct — the exact leak the operator believes they are protected from.
    const verdict = egressVerdict({
      state: this.egress,
      health: this.health,
      killSwitch: this.settings.vpnKillSwitch
    })
    if (!verdict.allow) {
      if (details.resourceType === 'mainFrame') {
        return {
          redirectURL: `warden://error?code=EGRESS_BLOCKED&desc=${encodeURIComponent(verdict.reason)}&url=${encodeURIComponent(details.url)}`
        }
      }
      this.stats.blockedTotal += 1
      return { cancel: true }
    }

    if (details.resourceType === 'mainFrame' && this.settings.httpsOnly) {
      const upgraded = upgradeToHttps(details.url)
      if (upgraded) {
        this.stats.httpsUpgrades += 1
        this.emit()
        return { redirectURL: upgraded }
      }
    }

    // Nothing is filtered on a compatible site, including its own analytics and
    // the third-party scripts a challenge needs.
    if (this.isCompatible(this.siteHostFor(details.webContentsId))) {
      this.emit()
      return {}
    }

    if (!this.settings.javascriptEnabled && details.resourceType === 'script') {
      return { cancel: true }
    }
    if (!this.settings.imagesEnabled && details.resourceType === 'image') {
      return { cancel: true }
    }
    if (this.settings.blockWebSockets && details.resourceType === 'webSocket') {
      return { cancel: true }
    }
    if (!this.settings.blockAds && !this.settings.blockTrackers) return {}

    const siteHost = this.siteHostFor(details.webContentsId) ?? null
    const request: RequestInfo = {
      url: details.url,
      type: details.resourceType as ResourceType,
      documentHost: siteHost
    }
    const decision = this.engine.check(request)
    if (!decision.block) {
      this.emit()
      return {}
    }

    const host = safeHost(details.url) || 'unknown'
    this.stats.blockedTotal += 1
    if (details.webContentsId !== undefined && details.webContentsId >= 0) {
      this.blockedByWc.set(details.webContentsId, (this.blockedByWc.get(details.webContentsId) ?? 0) + 1)
    }
    this.hostCounts.set(host, (this.hostCounts.get(host) ?? 0) + 1)
    if (decision.rule?.list !== 'custom') this.stats.trackersBlocked += 1
    if (this.hostCounts.size > 800) {
      for (const key of this.hostCounts.keys()) {
        this.hostCounts.delete(key)
        break
      }
    }
    this.emit()
    return { cancel: true }
  }

  private emit(force = false): void {
    const now = Date.now()
    if (!force && now - this.stats.lastEmit < 400) return
    this.stats.lastEmit = now
    this.onStats(this.snapshot())
  }

  noteWarning(host: string): void {
    if (this.warnedHosts.has(host)) return
    this.warnedHosts.add(host)
  }
}
