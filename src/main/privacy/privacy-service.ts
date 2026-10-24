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
import type { PrivacyStats, Settings } from '@shared/types'
import { builtinRules } from './builtin-lists'
import { parseFilterList, safeHost, FilterEngine, type RequestInfo, type ResourceType } from './filter-engine'
import {
  filterResponseHeaders,
  shouldAcceptCookie,
  shouldSendCookies,
  upgradeToHttps,
  referrerFor,
  type CookieMode
} from './cookie-policy'
import { readListCache, rulesFromCache, syncLists } from './lists'

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
  private blockedByWc = new Map<number, number>()

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
  }

  get browsingSession(): Session {
    if (!this.browsing) throw new Error('privacy service not started')
    return this.browsing
  }

  /** A throwaway session for a burner tab. Nothing survives the tab. */
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
    const engineAffecting =
      settings.blockAds !== this.settings.blockAds ||
      settings.blockTrackers !== this.settings.blockTrackers ||
      settings.customRules !== this.settings.customRules
    this.settings = settings
    if (engineAffecting) void this.rebuildEngine(null)
  }

  setHostForWebContents(id: number, host: string | null): void {
    if (host) this.hostByWebContents.set(id, host)
    else this.hostByWebContents.delete(id)
  }

  blockedForWebContents(id: number | undefined): number {
    if (id === undefined) return 0
    return this.blockedByWc.get(id) ?? 0
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
        callback({ requestHeaders: this.hardenHeaders(details, mode) })
      } catch {
        callback({})
      }
    })

    ses.webRequest.onHeadersReceived(REQUEST_FILTER, (details, callback) => {
      try {
        const host = safeHost(details.url)
        const siteHost = this.siteHostFor(details.webContentsId) ?? host
        const { headers, stripped } = filterResponseHeaders(
          (details.responseHeaders ?? {}) as Record<string, string | string[]>,
          this.cookieContext(siteHost, mode),
          host
        )
        if (stripped) {
          this.stats.cookiesStripped += stripped
          this.emit()
        }
        if (mode === 'block') {
          delete (headers as Record<string, unknown>)['set-cookie']
        }
        callback({ responseHeaders: headers as Record<string, string[]> })
      } catch {
        callback({})
      }
    })

    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      callback({})
    })
    ses.setSpellCheckerEnabled(false)

    ses.on('will-download', (_event, item) => {
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
      if (!host || !shouldAcceptCookie(this.cookieContext(this.siteHostFor(-1) ?? host, mode), host, details.domain)) {
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

    if (details.resourceType === 'mainFrame' && this.settings.httpsOnly) {
      const upgraded = upgradeToHttps(details.url)
      if (upgraded) {
        this.stats.httpsUpgrades += 1
        this.emit()
        return { redirectURL: upgraded }
      }
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
