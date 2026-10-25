import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, LockState, ScryProgress, UpdateState, WardenApi } from '../shared/types'

interface LockBootstrap {
  lock: LockState
  background: string | null
  user: string
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

function subscribe<T extends unknown[]>(channel: string, handler: (...args: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
    handler(...(args as T))
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: WardenApi = {
  bootstrap: () => invoke<AppState>('warden:bootstrap'),
  onState: (listener) => subscribe<[AppState]>('warden:state', listener),
  onTerminalData: (listener) => subscribe<[string, string]>('warden:term:data', listener),
  onTerminalExit: (listener) => subscribe<[string, number | null]>('warden:term:exit', listener),
  onScryProgress: (listener) => subscribe<[ScryProgress]>('warden:scry:progress', listener),
  onShortcut: (listener) => subscribe<[string]>('warden:shortcut', listener),
  onHover: (listener) => subscribe<[string]>('warden:hover', (url) => listener(url)),

  setWorkspace: (id) => invoke('warden:workspace:set', id),
  setLayout: (layout) => invoke('warden:layout', layout),
  setSuppressed: (suppressed) => invoke('warden:layout:suppress', suppressed),

  tab: {
    create: (url, burner) => invoke<string>('warden:tab:create', url, burner ?? false),
    close: (id) => invoke('warden:tab:close', id),
    activate: (id) => invoke('warden:tab:activate', id),
    move: (id, index) => invoke('warden:tab:move', id, index),
    navigate: (id, url) => invoke('warden:tab:navigate', id, url),
    back: (id) => invoke('warden:tab:back', id),
    forward: (id) => invoke('warden:tab:forward', id),
    reload: (id, hard) => invoke('warden:tab:reload', id, hard ?? false),
    stop: (id) => invoke('warden:tab:stop', id),
    mute: (id, muted) => invoke('warden:tab:mute', id, muted),
    find: (id, text, options) => invoke('warden:tab:find', id, text, options ?? {}),
    stopFind: (id, action) => invoke('warden:tab:stopFind', id, action),
    devtools: (id) => invoke('warden:tab:devtools', id),
    contextAction: (action, tabId) => invoke('warden:tab:context', action, tabId),
    playerCommand: (target, id, command, value) =>
      invoke('warden:player:command', target, id, command, value)
  },

  privacy: {
    allow: (host, allowed) => invoke('warden:privacy:allow', host, allowed),
    compatibility: (host, on) => invoke('warden:privacy:compatibility', host, on),
    allowSignIn: (url) => invoke('warden:privacy:allowSignIn', url),
    clearCookies: () => invoke<number>('warden:privacy:clearCookies'),
    syncLists: () => invoke<{ rules: number }>('warden:privacy:sync'),
    refresh: () => invoke('warden:privacy:refresh')
  },

  media: {
    scan: (tabId) => invoke('warden:media:scan', tabId),
    open: (tabId, item) => invoke('warden:media:open', tabId, item),
    close: (slot) => invoke('warden:media:close', slot),
    clear: () => invoke('warden:media:clear'),
    control: (slot, command, value) => invoke('warden:media:control', slot, command, value)
  },

  terminal: {
    create: (shell) => invoke('warden:term:create', shell),
    ssh: (input) => invoke('warden:term:ssh', input),
    input: (id, data) => invoke('warden:term:input', id, data),
    resize: (id, cols, rows) => invoke('warden:term:resize', id, cols, rows),
    kill: (id) => invoke('warden:term:kill', id),
    activate: (id) => invoke('warden:term:activate', id),
    scrollback: (id) => invoke<string>('warden:term:scrollback', id),
    setDrawer: (open) => invoke('warden:term:drawer', open)
  },

  mail: {
    addAccount: (input) => invoke('warden:mail:add', input),
    removeAccount: (id) => invoke('warden:mail:remove', id),
    selectAccount: (id) => invoke('warden:mail:selectAccount', id),
    listFolders: () => invoke('warden:mail:folders'),
    selectFolder: (path) => invoke('warden:mail:folder', path),
    listMessages: (limit) => invoke('warden:mail:messages', limit),
    openMessage: (uid) => invoke('warden:mail:open', uid),
    send: (input) => invoke('warden:mail:send', input),
    setFlag: (uid, flag, value) => invoke('warden:mail:flag', uid, flag, value),
    refresh: () => invoke('warden:mail:refresh')
  },

  messaging: {
    open: (serviceId) => invoke('warden:msg:open', serviceId),
    close: (serviceId) => invoke('warden:msg:close', serviceId),
    activate: (serviceId) => invoke('warden:msg:activate', serviceId),
    reload: (serviceId) => invoke('warden:msg:reload', serviceId),
    focusAddressBar: () => invoke('warden:msg:focus')
  },

  scry: {
    listTargets: (port) => invoke('warden:scry:targets', port),
    capture: (target, options) => invoke('warden:scry:capture', target, options ?? {}),
    clone: (target, options) => invoke('warden:scry:clone', target, options ?? {}),
    innovate: (target, options) => invoke('warden:scry:innovate', target, options ?? {}),
    reconLocalTab: (tabId) => invoke('warden:scry:reconLocal', tabId),
    cloneLocalTab: (tabId, options) => invoke('warden:scry:cloneLocal', tabId, options ?? {}),
    cancel: () => invoke('warden:scry:cancel'),
    reaStatus: () => invoke('warden:scry:reaStatus'),
    runRea: (target) => invoke('warden:scry:runRea', target),
    openOutput: (path) => invoke('warden:scry:openOutput', path)
  },

  genie: {
    status: () => invoke('warden:genie:status'),
    ask: (messages, model) => invoke('warden:genie:ask', messages, model),
    cancel: () => invoke('warden:genie:cancel'),
    setKey: (key) => invoke('warden:genie:key', key),
    onEvent: (listener) => subscribe('warden:genie:event', listener)
  },

  settings: {
    update: (patch) => invoke('warden:settings:update', patch),
    reset: () => invoke('warden:settings:reset')
  },

  history: {
    clear: () => invoke('warden:history:clear')
  },

  bookmarks: {
    toggle: (url, title) => invoke('warden:bookmarks:toggle', url, title),
    remove: (id) => invoke('warden:bookmarks:remove', id)
  },

  update: {
    check: () => invoke<UpdateState>('warden:update:check'),
    install: () => invoke<{ ok: boolean }>('warden:update:install'),
    onState: (listener) => subscribe<[UpdateState]>('warden:update:state', listener)
  },

  lock: {
    lock: () => invoke('warden:lock:lock'),
    unlock: (password) => invoke<{ ok: boolean; error?: string }>('warden:lock:unlock', password),
    bootstrap: () => invoke<LockBootstrap>('warden:lock:bootstrap'),
    onState: (listener) => subscribe<[LockState]>('warden:lock:state', listener)
  },

  app: {
    openExternal: (url) => invoke('warden:app:openExternal', url),
    minimize: () => ipcRenderer.send('warden:window:minimize'),
    maximize: () => ipcRenderer.send('warden:window:maximize'),
    close: () => ipcRenderer.send('warden:window:close'),
    quit: () => ipcRenderer.send('warden:window:quit')
  }
}

contextBridge.exposeInMainWorld('warden', api)
