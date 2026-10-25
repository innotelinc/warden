import { BrowserWindow, ipcMain, shell } from 'electron'
import { SEARCH_ENGINES } from '@shared/defaults'
import { sanitizeSettings } from '@shared/settings'
import type {
  AppState,
  Bookmark,
  HistoryEntry,
  LayoutRequest,
  MailAccountInput,
  MediaItem,
  ScryProgress,
  CloneResult,
  ScryReport,
  ScryTarget,
  SendMailInput,
  Settings,
  WorkspaceId
} from '@shared/types'
import type { JsonStore } from './store/json-store'
import type { TabManager } from './browser/tabs'
import { resolveInput } from './browser/tabs'
import { docUrl, resolveDocPath } from './browser/local-doc'
import { hostMatches, hostOfUrl } from '@shared/urls'
import { signInHostsFor } from '@shared/auth-flow'
import type { PrivacyService } from './privacy/privacy-service'
import type { MediaDock } from './media/media-dock'
import type { TerminalService } from './terminal/terminal-service'
import type { MailService } from './mail/mail-service'
import type { MessagingHub } from './messaging/hub'
import type { ScryService } from './scry/scry-service'
import type { GenieService } from './genie/genie-service'
import type { DownloadManager } from './browser/downloads'
import type { UpdateService } from './update/update-service'
import type { LockService } from './security/lock-service'

export interface WardenContext {
  win: BrowserWindow
  tabs: TabManager
  privacy: PrivacyService
  media: MediaDock
  terminal: TerminalService
  mail: MailService
  messaging: MessagingHub
  scry: ScryService
  genie: GenieService
  downloads: DownloadManager
  update: UpdateService
  lock: LockService
  stores: {
    settings: JsonStore<Settings>
    history: JsonStore<HistoryEntry[]>
    bookmarks: JsonStore<Bookmark[]>
  }
  snapshot: () => AppState
  sendState: () => void
  getWorkspace: () => WorkspaceId
  setWorkspace: (workspace: WorkspaceId) => void
  getLayout: () => LayoutRequest
  setLayout: (layout: LayoutRequest) => void
  setSuppressed: (suppressed: boolean) => void
  /** Stores (or clears) the gateway key in the OS keychain. Never returns it. */
  setGenieKey: (key: string) => { ok: boolean; error?: string }
  setDrawer: (open: boolean) => void
  setScry: (patch: {
    progress?: ScryProgress | null
    result?: CloneResult | null
    report?: ScryReport | null
    targets?: ScryTarget[]
    error?: string | null
  }) => void
}

let ctx: WardenContext | null = null
let registered = false

function context(): WardenContext {
  if (!ctx) throw new Error('WARDEN context is not ready')
  return ctx
}

function searchUrl(): string {
  const settings = context().stores.settings.get()
  const engine = SEARCH_ENGINES.find((entry) => entry.id === settings.searchEngine) ?? SEARCH_ENGINES[0]!
  return engine.searchUrl
}

const handle = (channel: string, listener: (...args: never[]) => unknown): void => {
  ipcMain.handle(channel, async (_event, ...args) => listener(...(args as never[])))
}

export function registerIpc(warden: WardenContext): void {
  ctx = warden
  if (registered) return
  registered = true

  handle('warden:bootstrap', () => context().snapshot())

  handle('warden:workspace:set', (workspace: WorkspaceId) => {
    context().setWorkspace(workspace)
  })

  handle('warden:layout', (layout: LayoutRequest) => {
    context().setLayout(layout)
  })

  handle('warden:layout:suppress', (suppressed: boolean) => {
    context().setSuppressed(Boolean(suppressed))
  })

  // --------------------------------------------------------------- tabs
  /**
   * Where an address-bar string goes.
   *
   * A path to a document on this machine is not a search and not a `file://`
   * navigation the page guard would refuse: it opens the read-only reader.
   */
  const targetFor = (input: string): string => {
    const doc = resolveDocPath(input)
    if (doc) return docUrl(doc)
    return resolveInput(input, searchUrl()) ?? 'warden://newtab'
  }

  handle('warden:tab:create', (url: string, burner: boolean) => {
    const target = url ? targetFor(url) : 'warden://newtab'
    return context().tabs.create(target, Boolean(burner))
  })

  handle('warden:tab:close', (id: string) => context().tabs.close(id))
  handle('warden:tab:activate', (id: string) => context().tabs.activate(id))
  handle('warden:tab:dismissChallenge', (id: string, host: string) => {
    context().tabs.dismissChallenge(id, host)
    context().sendState()
  })
  handle('warden:tab:cloak', (id: string, on: boolean) => {
    context().tabs.setCloak(id, Boolean(on))
    context().sendState()
  })
  handle('warden:tab:move', (id: string, index: number) => {
    context().tabs.move(id, index)
    context().sendState()
  })

  handle('warden:tab:navigate', (id: string, input: string) => {
    if (!input.trim()) return
    context().tabs.navigate(id, targetFor(input))
  })

  handle('warden:tab:back', (id: string) => context().tabs.back(id))
  handle('warden:tab:forward', (id: string) => context().tabs.forward(id))
  handle('warden:tab:reload', (id: string, hard: boolean) => context().tabs.reload(id, Boolean(hard)))
  handle('warden:tab:stop', (id: string) => context().tabs.stop(id))
  handle('warden:tab:mute', (id: string, muted: boolean) => context().tabs.mute(id, Boolean(muted)))
  handle('warden:tab:find', (id: string, text: string, options: { forward?: boolean; findNext?: boolean }) =>
    context().tabs.find(id, text, options ?? {})
  )
  handle('warden:tab:stopFind', (id: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection') =>
    context().tabs.stopFind(id, action)
  )
  handle('warden:tab:devtools', (id: string) => context().tabs.openDevTools(id))

  handle('warden:tab:context', (action: string, tabId: string) => {
    const wc = context().tabs.getWebContents(tabId)
    if (!wc) return
    if (action === 'copy-url') wc.copy()
  })

  handle(
    'warden:player:command',
    (target: 'tab' | 'media', id: string, command: string, value?: number) => {
      if (target === 'media') {
        return context().media.control(Number(id), command as never, value)
      }
      const wc = context().tabs.getWebContents(id)
      if (!wc) return
      const action =
        command === 'play'
          ? 'v.play().catch(() => {})'
          : command === 'pause'
            ? 'v.pause()'
            : command === 'mute'
              ? 'v.muted = true'
              : command === 'unmute'
                ? 'v.muted = false'
                : command === 'rate'
                  ? `v.playbackRate = ${Math.min(4, Math.max(0.25, value ?? 1))}`
                  : 'false'
      void wc.executeJavaScript(
        `(() => { const v = document.querySelector('video'); if (!v) return false; ${action}; return true })()`,
        true
      )
    }
  )

  // ------------------------------------------------------------ privacy
  handle('warden:privacy:allow', async (host: string, allowed: boolean) => {
    const normalized = host.trim().toLowerCase()
    if (!normalized) return
    const next = context().stores.settings.update((current) => {
      const set = new Set(current.allowlist)
      if (allowed) set.add(normalized)
      else set.delete(normalized)
      return { ...current, allowlist: [...set] }
    })
    context().privacy.applySettings(next)
    if (!allowed) await context().privacy.wipeCookies()
    context().sendState()
  })

  /**
   * Per-site compatibility mode.
   *
   * Turning it on stops filtering, header rewriting and cookie stripping for
   * that host and reloads every tab on it, because the page preload decides at
   * document start whether to inject the hardening shims.
   */
  handle('warden:privacy:compatibility', (host: string, on: boolean) => {
    const normalized = host.trim().toLowerCase()
    const current = context().privacy.getSettings()
    if (!normalized) return current
    const next = context().stores.settings.update((settings) => {
      const set = new Set(settings.compatibility)
      if (on) set.add(normalized)
      else set.delete(normalized)
      return { ...settings, compatibility: [...set].slice(0, 100) }
    })
    context().privacy.applySettings(next)
    for (const tab of context().tabs.list()) {
      if (hostMatches(hostOfUrl(tab.url), [normalized])) context().tabs.reload(tab.id)
    }
    context().sendState()
    return next
  })

  /**
   * One click for an SSO login.
   *
   * An OAuth/OIDC flow spans two hosts — the provider keeps the CSRF token and
   * session, the application sets its own session after the callback — and
   * WARDEN refuses cookies on both by default. This reads the host pair out of
   * the login URL, allows exactly those, and reloads the tabs on them so the
   * flow restarts with cookies permitted.
   */
  handle('warden:privacy:allowSignIn', (url: string) => {
    const hosts = signInHostsFor(String(url ?? ''))
    const current = context().privacy.getSettings()
    if (!hosts) return { allowed: [], settings: current }
    const wanted = [hosts.provider, hosts.application].filter((host): host is string => Boolean(host))
    const next = context().stores.settings.update((settings) => {
      const set = new Set(settings.allowlist)
      for (const host of wanted) set.add(host)
      return { ...settings, allowlist: [...set].slice(0, 500) }
    })
    context().privacy.applySettings(next)
    for (const tab of context().tabs.list()) {
      if (hostMatches(hostOfUrl(tab.url), wanted)) context().tabs.reload(tab.id)
    }
    context().sendState()
    return { allowed: wanted, settings: next }
  })

  handle('warden:privacy:clearCookies', () => context().privacy.wipeCookies())
  /** Is the configured tunnel endpoint answering? Adds no traffic of its own. */
  handle('warden:privacy:probeEgress', () => context().privacy.probeEgressNow())
  handle('warden:privacy:sync', async () => {
    const rules = await context().privacy.syncRemoteLists()
    context().sendState()
    return { rules }
  })
  handle('warden:privacy:refresh', () => context().privacy.snapshot())

  // --------------------------------------------------------------- media
  handle('warden:media:scan', async (tabId: string) => {
    const wc = context().tabs.getWebContents(tabId)
    if (!wc) return []
    wc.send('warden:media:scan')
    return []
  })

  handle('warden:media:open', (tabId: string, item: MediaItem) => {
    const url = context().tabs.getTabUrl(tabId) ?? ''
    const slot = context().media.open(item, url, context().tabs.getSession(tabId) ?? undefined)
    if (slot !== null) {
      context().tabs.getWebContents(tabId)?.send('warden:media:claim', item.url)
      context().sendState()
    }
  })

  handle('warden:media:close', (slot: number) => {
    context().media.close(slot)
    context().sendState()
  })
  handle('warden:media:clear', () => {
    context().media.clear()
    context().sendState()
  })
  handle('warden:media:control', (slot: number, command: string, value?: number) =>
    context().media.control(slot, command as never, value)
  )

  // ------------------------------------------------------------ terminal
  handle('warden:term:create', (shell?: string) => {
    const info = context().terminal.create(shell || context().stores.settings.get().terminalShell)
    context().setDrawer(true)
    context().sendState()
    return info
  })
  handle('warden:term:ssh', (input: { target: string; port?: number }) => {
    const info = context().terminal.createSsh({
      target: String(input?.target ?? ''),
      port: Number(input?.port) || undefined
    })
    context().setDrawer(true)
    context().sendState()
    return info
  })
  handle('warden:term:input', (id: string, data: string) => context().terminal.write(id, data))
  handle('warden:term:resize', (id: string, cols: number, rows: number) =>
    context().terminal.resize(id, cols, rows)
  )
  handle('warden:term:kill', (id: string) => {
    context().terminal.kill(id)
    context().sendState()
  })
  handle('warden:term:activate', (id: string) => {
    const info = context().terminal.activate(id)
    context().sendState()
    return info
  })
  handle('warden:term:scrollback', (id: string) => context().terminal.scrollback(id))
  handle('warden:term:drawer', (open: boolean) => {
    if (open && !context().terminal.active) {
      context().terminal.create(context().stores.settings.get().terminalShell)
    }
    context().setDrawer(open)
  })

  // ---------------------------------------------------------------- mail
  handle('warden:mail:add', (input: MailAccountInput) => context().mail.addAccount(input))
  handle('warden:mail:remove', (id: string) => context().mail.removeAccount(id))
  handle('warden:mail:selectAccount', (id: string) => context().mail.selectAccount(id))
  handle('warden:mail:folders', () => context().mail.refreshFolders())
  handle('warden:mail:folder', (path: string) => context().mail.selectFolder(path))
  handle('warden:mail:messages', (limit?: number) => context().mail.refreshMessages(limit ?? 50))
  handle('warden:mail:open', (uid: number) => context().mail.openMessage(uid))
  handle('warden:mail:send', (input: SendMailInput) => context().mail.send(input))
  handle('warden:mail:flag', (uid: number, flag: 'seen' | 'flagged', value: boolean) =>
    context().mail.setFlag(uid, flag, value)
  )
  handle('warden:mail:fraud', () => context().mail.checkSelected())
  handle('warden:mail:refresh', async () => {
    await context().mail.refreshFolders()
    await context().mail.refreshMessages()
  })

  // ----------------------------------------------------------- messaging
  handle('warden:msg:open', (serviceId: string) => context().messaging.open(serviceId))
  handle('warden:msg:close', (serviceId: string) => context().messaging.close(serviceId))
  handle('warden:msg:activate', (serviceId: string) => context().messaging.activate(serviceId))
  handle('warden:msg:reload', (serviceId: string) => context().messaging.reload(serviceId))
  handle('warden:msg:focus', () => context().messaging.focusActive())

  // ---------------------------------------------------------------- scry
  handle('warden:scry:targets', async (port?: number) => {
    const targets = await context().scry.listTargets(port)
    context().setScry({ targets })
    return targets
  })

  handle('warden:scry:capture', async (target: { source: 'remote' | 'local'; id: string }) => {
    context().setScry({ error: null, result: null })
    try {
      const report = await context().scry.capture(target)
      context().setScry({ report })
      return report
    } catch (error) {
      context().setScry({ error: (error as Error).message })
      throw error
    }
  })

  handle(
    'warden:scry:clone',
    async (target: { source: 'remote' | 'local'; id: string }, options?: { label?: string; includeScripts?: boolean }) => {
      context().setScry({ error: null })
      try {
        const result = await context().scry.clone(target, options ?? {})
        context().setScry({ result, report: context().snapshot().scry.report })
        return result
      } catch (error) {
        context().setScry({ error: (error as Error).message })
        throw error
      }
    }
  )

  handle(
    'warden:scry:innovate',
    async (target: { source: 'remote' | 'local'; id: string }, options?: { label?: string }) => {
      try {
        const result = await context().scry.innovate(target, options ?? {})
        context().setScry({ result, report: context().snapshot().scry.report })
        return result
      } catch (error) {
        const message = (error as Error).message
        context().setScry({ error: message })
        throw new Error(message)
      }
    }
  )

  handle('warden:scry:reconLocal', async (tabId: string) => {
    const report = await context().scry.capture({ source: 'local', id: tabId })
    context().setScry({ report })
    return report
  })

  handle('warden:scry:cloneLocal', async (tabId: string, options?: { includeScripts?: boolean }) => {
    const result = await context().scry.clone({ source: 'local', id: tabId }, options ?? {})
    context().setScry({ result })
    return result
  })

  handle('warden:scry:cancel', () => context().scry.cancel())
  handle('warden:scry:reaStatus', () => context().scry.reaStatus())
  handle('warden:scry:runRea', (target: { source: 'remote' | 'local'; id: string }) =>
    context().scry.runRea(target)
  )
  handle('warden:scry:openOutput', async (target: string) => {
    if (typeof target !== 'string' || !target) return
    await shell.openPath(target)
  })

  // ------------------------------------------------------------ genie
  handle('warden:genie:status', () => ({
    configured: context().genie.configured,
    running: context().genie.running
  }))

  handle('warden:genie:ask', async (messages: { role: string; content: string }[], model?: string) => {
    if (!Array.isArray(messages)) throw new Error('messages must be an array')
    const cleaned = messages
      .filter(
        (entry) =>
          entry &&
          (entry.role === 'user' || entry.role === 'assistant') &&
          typeof entry.content === 'string'
      )
      .slice(-20)
      .map((entry) => ({
        role: entry.role as 'user' | 'assistant',
        content: entry.content.slice(0, 20000)
      }))
    if (!cleaned.length) throw new Error('nothing to send')
    return context().genie.ask(cleaned, typeof model === 'string' ? model.slice(0, 120) : undefined)
  })

  handle('warden:genie:cancel', () => context().genie.cancel())

  handle('warden:genie:key', (key: string) => context().setGenieKey(typeof key === 'string' ? key : ''))

  // ------------------------------------------------------------ settings
  handle('warden:settings:update', (patch: Partial<Settings>) => {
    const merged = sanitizeSettings({ ...context().stores.settings.get(), ...patch })
    context().stores.settings.set(merged)
    context().privacy.applySettings(merged)
    context().tabs.setVisible(context().getWorkspace() === 'browse')
    context().update.applyEnabled(merged.autoUpdate)
    context().sendState()
    return merged
  })

  handle('warden:settings:reset', () => {
    const defaults = sanitizeSettings({})
    context().stores.settings.set(defaults)
    context().privacy.applySettings(defaults)
    context().sendState()
    return defaults
  })

  // ------------------------------------------------------------- history
  handle('warden:history:clear', () => {
    context().stores.history.set([])
    context().sendState()
  })

  handle('warden:bookmarks:toggle', (url: string, title: string) => {
    context().stores.bookmarks.update((list) => {
      const existing = list.find((entry) => entry.url === url)
      if (existing) return list.filter((entry) => entry.url !== url)
      return [
        {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          url,
          title: title || url,
          createdAt: Date.now()
        },
        ...list
      ].slice(0, 400)
    })
    context().sendState()
  })

  handle('warden:bookmarks:remove', (id: string) => {
    context().stores.bookmarks.update((list) => list.filter((entry) => entry.id !== id))
    context().sendState()
  })

  // -------------------------------------------------------------- updates
  handle('warden:update:check', () => context().update.check())
  handle('warden:update:install', () => context().update.install())

  // ----------------------------------------------------------------- lock
  handle('warden:lock:lock', () => context().lock.lock(false))
  handle('warden:lock:unlock', (password: string) =>
    context().lock.unlock(typeof password === 'string' ? password : '')
  )
  handle('warden:lock:hello', () => context().lock.unlockWithHello())
  handle('warden:lock:unlockWithPin', (pin: string) =>
    context().lock.unlockWithPin(typeof pin === 'string' ? pin : '')
  )
  handle('warden:lock:setPin', (pin: string) =>
    context().lock.setPin(typeof pin === 'string' ? pin : '')
  )
  handle('warden:lock:clearPin', () => context().lock.clearPin())
  handle('warden:lock:helloStatus', () => context().lock.helloReport())
  handle('warden:lock:bootstrap', () => ({
    lock: context().lock.snapshot(),
    background: context().lock.backdrop(),
    user: context().lock.user()
  }))

  // ----------------------------------------------------------------- app
  handle('warden:app:openExternal', (url: string) => {
    if (!/^https?:/i.test(url)) return { opened: false, reason: 'Only http(s) handoff is considered, and WARDEN refuses it.' }
    return {
      opened: false,
      reason: 'WARDEN does not hand pages to another browser. Open it in a cloaked tab instead.'
    }
  })

  // The content preload asks this before any page script runs, so the answer
  // has to be synchronous: a reload after the operator flips the toggle must
  // land on a document that knows the site is compatible.
  ipcMain.on('warden:compat:sync', (event, host: unknown) => {
    event.returnValue = context().privacy.isCompatible(typeof host === 'string' && host ? host : null)
  })

  // Same reason: the page-level cookie lock has to reflect the current policy
  // on every document, not the allowlist as it stood when the tab was created.
  ipcMain.on('warden:cookie:sync', (event, host: unknown) => {
    event.returnValue = context().privacy.cookiesAllowedFor(
      typeof host === 'string' && host ? host : null
    )
  })

  // The content preload answers whether the document it just loaded is a
  // human-verification wall. A tab's own view is the only sender that may speak
  // for it, and the answer is replaced on every load, so a solved wall clears
  // the prompt instead of leaving it behind.
  ipcMain.on('warden:challenge:wall', (event, tabId: unknown, reason: unknown) => {
    if (typeof tabId !== 'string' || !tabId) return
    if (context().tabs.getWebContents(tabId)?.id !== event.sender.id) return
    const changed = context().tabs.setChallengeWall(tabId, typeof reason === 'string' ? reason : null)
    if (changed) context().sendState()
  })

  ipcMain.on('warden:window:minimize', () => context().win.minimize())
  ipcMain.on('warden:window:maximize', () => {
    const win = context().win
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('warden:window:close', () => context().win.close())
  ipcMain.on('warden:window:quit', () => {
    const { app } = require('electron') as typeof import('electron')
    app.quit()
  })
}
