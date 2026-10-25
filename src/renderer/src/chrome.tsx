import { useEffect, useMemo, useRef, useState } from 'react'
import type { Bookmark, MediaItem, MediaSlot, TabState, WorkspaceId } from '@shared/types'
import {
  IconAlert,
  IconArrowRight,
  IconBack,
  IconBug,
  IconChat,
  IconClose,
  IconCrosshair,
  IconDownload,
  IconForward,
  IconGear,
  IconLock,
  IconMail,
  IconMenu,
  IconPanelRight,
  IconPause,
  IconPlay,
  IconPlus,
  IconReload,
  IconShield,
  IconSpark,
  IconStar,
  IconTerminal,
  IconUnlock,
  IconVolume,
  IconVolumeOff
} from './icons'
import { signInHostsFor } from '@shared/auth-flow'
import { formatCount, useWarden } from './state'
import { DOCK_HEAD, SLOT_FOOT, SLOT_GAP, DOCK_PAD } from './layout'

const WORKSPACES: { id: WorkspaceId; label: string; icon: typeof IconShield; hint: string }[] = [
  { id: 'browse', label: 'Browse', icon: IconShield, hint: 'Browse — Ctrl+1' },
  { id: 'trench', label: 'Trench', icon: IconTerminal, hint: 'Trench shell — Ctrl+`' },
  { id: 'relay', label: 'Relay', icon: IconMail, hint: 'Relay mail' },
  { id: 'concourse', label: 'Concourse', icon: IconChat, hint: 'Concourse messaging' },
  { id: 'scry', label: 'Scry', icon: IconCrosshair, hint: 'Scry — Ctrl+Shift+S' },
  { id: 'genie', label: 'Genie', icon: IconSpark, hint: 'Genie assistant' },
  { id: 'settings', label: 'Policy', icon: IconGear, hint: 'Policy & settings — Ctrl+,' }
]

export function Rail({
  workspace,
  onWorkspace,
  blocked,
  unread
}: {
  workspace: WorkspaceId
  onWorkspace: (id: WorkspaceId) => void
  blocked: number
  unread: number
}) {
  return (
    <nav className="rail" aria-label="Workspaces">
      {WORKSPACES.map((entry) => {
        const Glyph = entry.icon
        return (
          <button
            key={entry.id}
            className={`rail-btn ${workspace === entry.id ? 'active' : ''}`}
            onClick={() => onWorkspace(entry.id)}
            title={entry.hint}
            aria-label={entry.label}
          >
            <Glyph size={17} />
            {entry.id === 'concourse' && unread > 0 ? (
              <span className="badge">{unread > 99 ? '99+' : unread}</span>
            ) : null}
            <span className="tip">{entry.hint}</span>
          </button>
        )
      })}
      <div className="rail-spacer" />
      <div className="rail-meter" title="Requests blocked this session">
        <IconShield size={13} />
        <b>{formatCount(blocked)}</b>
      </div>
    </nav>
  )
}

export function Toolbar({
  tab,
  onPalette,
  onFind,
  onToggleDock,
  onToggleTerminal,
  onShield,
  onSendToScry,
  dockOpen,
  drawerOpen,
  busy
}: {
  tab: TabState | null
  onPalette: () => void
  onFind: () => void
  onToggleDock: () => void
  onToggleTerminal: () => void
  onShield: () => void
  onSendToScry: () => void
  dockOpen: boolean
  drawerOpen: boolean
  busy: boolean
}) {
  const { state, notify } = useWarden()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const focused = useRef(false)
  // First click on an unfocused address bar selects the whole URL, like Chrome.
  const selectOnRelease = useRef(false)
  // The tab whose address bar was already focused, so a re-render on the same
  // new tab cannot steal focus back from the page.
  const addressedTab = useRef<string | null>(null)

  useEffect(() => {
    if (!focused.current) setDraft(tab?.url ?? '')
  }, [tab?.url])

  // A fresh tab should be ready to type into: focus the bar and select what is
  // there, so the first keystroke replaces `warden://newtab` instead of
  // appending to it.
  useEffect(() => {
    if (!tab) return
    const blank = !tab.url || tab.url.startsWith('warden://newtab') || tab.url === 'about:blank'
    if (!blank) {
      addressedTab.current = tab.id
      return
    }
    if (addressedTab.current === tab.id) return
    addressedTab.current = tab.id
    const timer = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 60)
    return () => clearTimeout(timer)
  }, [tab?.id, tab?.url])

  useEffect(() => {
    const focus = (): void => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('warden:focus-address', focus)
    return () => window.removeEventListener('warden:focus-address', focus)
  }, [])

  const bookmarked = useMemo(
    () => Boolean(state?.bookmarks.some((mark: Bookmark) => mark.url === tab?.url)),
    [state?.bookmarks, tab?.url]
  )

  const submit = (): void => {
    if (!tab) {
      void window.warden.tab.create(draft || state?.settings.homepage || 'warden://newtab')
      return
    }
    if (!draft.trim()) return
    void window.warden.tab.navigate(tab.id, draft)
    inputRef.current?.blur()
  }

  const scheme = tab?.secure ?? 'internal'

  return (
    <div className="toolbar">
      <button className="icon-btn" disabled={!tab?.canGoBack} onClick={() => tab && void window.warden.tab.back(tab.id)} title="Back (Alt+←)">
        <IconBack />
      </button>
      <button
        className="icon-btn"
        disabled={!tab?.canGoForward}
        onClick={() => tab && void window.warden.tab.forward(tab.id)}
        title="Forward (Alt+→)"
      >
        <IconForward />
      </button>
      <button
        className="icon-btn"
        disabled={!tab}
        onClick={() => {
          if (!tab) return
          if (tab.loading) void window.warden.tab.stop(tab.id)
          else void window.warden.tab.reload(tab.id)
        }}
        title={tab?.loading ? 'Stop' : 'Reload (Ctrl+R)'}
      >
        {busy || tab?.loading ? <IconClose size={15} /> : <IconReload />}
      </button>

      <div className="address">
        <span className={`scheme ${scheme}`}>
          {scheme === 'secure' ? <IconLock size={12} /> : scheme === 'insecure' ? <IconAlert size={12} /> : <IconShield size={12} />}
          {scheme === 'secure' ? 'https' : scheme === 'insecure' ? 'http' : 'local'}
        </span>
        <input
          ref={inputRef}
          value={draft}
          spellCheck={false}
          placeholder="Search DuckDuckGo or enter a target"
          onMouseDown={() => {
            selectOnRelease.current = document.activeElement !== inputRef.current
          }}
          onFocus={() => {
            focused.current = true
          }}
          onMouseUp={() => {
            if (!selectOnRelease.current) return
            selectOnRelease.current = false
            inputRef.current?.select()
          }}
          onBlur={() => {
            focused.current = false
            setDraft(tab?.url ?? '')
          }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') {
              setDraft(tab?.url ?? '')
              inputRef.current?.blur()
            }
          }}
        />
        <button
          className="icon-btn tiny"
          title={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
          onClick={() => {
            if (!tab) return
            void window.warden.bookmarks.toggle(tab.url, tab.title)
            notify(bookmarked ? 'Bookmark removed' : 'Bookmarked')
          }}
        >
          <IconStar size={14} filled={bookmarked} />
        </button>
      </div>

      <button
        className={`shield-pill ${tab && tab.blocked > 0 ? '' : 'warn'}`}
        onClick={onShield}
        title="Bastion — what this page tried to load"
      >
        <IconShield size={13} />
        <b>{tab ? formatCount(tab.blocked) : '0'}</b>
      </button>

      <button
        className="icon-btn scry-send"
        disabled={!tab}
        onClick={onSendToScry}
        title="Send this tab to Scry — recon, clone or innovate (Ctrl+Shift+S)"
      >
        <IconCrosshair size={15} />
      </button>

      <button
        className={`icon-btn ${dockOpen ? 'on' : ''}`}
        onClick={onToggleDock}
        title="Splay video dock (Ctrl+J)"
      >
        <IconPanelRight />
      </button>
      <button className={`icon-btn ${drawerOpen ? 'on' : ''}`} onClick={onToggleTerminal} title="Trench terminal (Ctrl+`)">
        <IconTerminal />
      </button>
      <button className="icon-btn" onClick={onFind} title="Find in page (Ctrl+F)">
        <IconArrowRight size={15} />
      </button>
      <button className="icon-btn" onClick={onPalette} title="Command palette (Ctrl+K)">
        <IconMenu />
      </button>
    </div>
  )
}

export function TabStrip({ tabs, activeId }: { tabs: TabState[]; activeId: string | null }) {
  // Dragged tab and the slot the pointer is currently over. Index-based, so the
  // drop lands exactly where the operator sees the gap.
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const commitDrop = (index: number | null): void => {
    if (dragging && index !== null) void window.warden.tab.move(dragging, index)
    setDragging(null)
    setDropIndex(null)
  }

  return (
    <div
      className="tabstrip"
      onDragOver={(event) => {
        if (dragging) event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        commitDrop(dropIndex)
      }}
    >
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          className={`tab ${tab.id === activeId ? 'active' : ''} ${dragging === tab.id ? 'dragging' : ''} ${
            dropIndex === index && dragging !== tab.id ? 'drop-target' : ''
          }`}
          draggable
          onDragStart={(event) => {
            setDragging(tab.id)
            event.dataTransfer.effectAllowed = 'move'
            // Firefox refuses to start a drag without payload.
            event.dataTransfer.setData('text/plain', tab.id)
          }}
          onDragEnter={() => setDropIndex(index)}
          onDragOver={(event) => {
            if (!dragging) return
            event.preventDefault()
            setDropIndex(index)
          }}
          onDragEnd={() => commitDrop(null)}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropIndex((current) => (current === index ? null : current))
            }
          }}
          onClick={() => void window.warden.tab.activate(tab.id)}
          onAuxClick={(event) => {
            if (event.button === 1) void window.warden.tab.close(tab.id)
          }}
          title={`${tab.title}\n${tab.url}\nDrag to reorder`}
        >
          {tab.loading ? (
            <span className="spin" />
          ) : (
            <span className={`fav ${tab.isBurner ? 'burner' : ''}`} title={tab.isBurner ? 'Burner tab — discarded on close' : ''} />
          )}
          <span className="title">{tab.title || 'Untitled'}</span>
          {tab.isBurner ? <span className="tag amber tiny">burn</span> : null}
          <span
            className="close"
            onClick={(event) => {
              event.stopPropagation()
              void window.warden.tab.close(tab.id)
            }}
          >
            <IconClose size={11} />
          </span>
        </div>
      ))}
      <button
        className="tab-new"
        onClick={() => void window.warden.tab.create('warden://newtab')}
        title="New tab (Ctrl+T)"
      >
        <IconPlus size={14} />
      </button>
      <button
        className="tab-new"
        onClick={() => void window.warden.tab.create('warden://newtab', true)}
        title="Burner tab — isolated memory session, discarded on close"
      >
        <span className="tag amber tiny">burn</span>
      </button>
    </div>
  )
}

export function VideoDock({
  slots,
  available,
  width,
  onOpen,
  onClose,
  onControl,
  onResize,
  readOnly
}: {
  slots: MediaSlot[]
  available: MediaItem[]
  width: number
  onOpen: (item: MediaItem) => void
  onClose: (slot: number) => void
  onControl: (slot: number, command: 'play' | 'pause' | 'mute' | 'unmute' | 'rate' | 'seek', value?: number) => void
  onResize: (width: number) => void
  readOnly: boolean
}) {
  const docked = new Set(slots.map((slot) => slot.item.id))
  const spare = available.filter((item) => !docked.has(item.id)).slice(0, 4)
  const count = Math.max(slots.length, 1)

  return (
    <div className="dock" style={{ width }}>
      <div className="dock-head">
        <span className="label">Splay</span>
        <span className="count">{slots.length}/3</span>
        <span className="spacer" />
        {slots.length ? (
          <button className="chip" onClick={() => slots.forEach((slot) => onClose(slot.slot))} title="Close every docked video">
            clear
          </button>
        ) : null}
      </div>

      <div className="dock-slots">
        {slots.map((slot) => (
          <div className="slot" key={slot.slot}>
            <div
              style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#2b3745', font: '10px/1.6 var(--mono)' }}
            >
              loading viewer…
            </div>
            <div className="slot-foot">
              <span className="name" title={slot.item.title}>
                {slot.item.source === 'iframe' ? '⌁ ' : ''}
                {slot.item.title || 'Media'}
              </span>
              <button
                className="chip"
                title={slot.muted ? 'Unmute' : 'Mute'}
                onClick={() => onControl(slot.slot, slot.muted ? 'unmute' : 'mute')}
              >
                {slot.muted ? <IconVolumeOff size={11} /> : <IconVolume size={11} />}
              </button>
              <button className="chip" title="Close" onClick={() => onClose(slot.slot)}>
                <IconClose size={11} />
              </button>
            </div>
          </div>
        ))}

        {Array.from({ length: Math.max(0, 3 - slots.length) }).map((_, index) => (
          <div className="slot-empty" key={`empty-${index}`}>
            {readOnly ? 'no docked media' : slots.length === 0 && index === 0 ? 'videos branch here\nautomatically' : 'open'}
          </div>
        ))}
      </div>

      {spare.length ? (
        <div className="dock-manual">
          {spare.map((item) => (
            <button className="row" key={item.id} onClick={() => onOpen(item)} title={`Dock ${item.url}`}>
              <span className="kind">{item.source === 'iframe' ? 'embed' : item.kind}</span>
              <span className="t">{item.title || item.url}</span>
              <IconArrowRight size={12} />
            </button>
          ))}
        </div>
      ) : null}

      <div
        className="dock-resize"
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0 }}
        onMouseDown={(event) => {
          event.preventDefault()
          const startX = event.clientX
          const startWidth = width
          const move = (moveEvent: MouseEvent): void => {
            const next = Math.min(620, Math.max(300, startWidth - (moveEvent.clientX - startX)))
            onResize(next)
          }
          const up = (): void => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }}
      />
    </div>
  )
}

export function BastionPanel({
  tab,
  width,
  onClose,
  onResize
}: {
  tab: TabState | null
  width: number
  onClose: () => void
  onResize: (width: number) => void
}) {
  const { state, notify } = useWarden()
  if (!tab || !state) return null

  let host = ''
  try {
    host = new URL(tab.url).hostname
  } catch {
    host = ''
  }
  const allowed = host
    ? state.settings.allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`))
    : false
  const compatible = host
    ? state.settings.compatibility.some((entry) => host === entry || host.endsWith(`.${entry}`))
    : false
  // A login spans the provider and the application; work out both so one click
  // can allow the pair instead of making the operator diagnose the flow.
  const signIn = signInHostsFor(tab.url)
  const signInHosts = signIn
    ? [signIn.provider, signIn.application].filter((entry): entry is string => Boolean(entry))
    : []
  const signInMissing = signInHosts.filter(
    (entry) => !state.settings.allowlist.some((allowed) => entry === allowed || entry.endsWith(`.${allowed}`))
  )

  return (
    <div className="dock fade-in" style={{ width }}>
      <div className="dock-head">
        <IconShield size={14} />
        <span className="label">Bastion</span>
        <span className="count">{formatCount(tab.blocked)}</span>
        <span className="spacer" />
        <button className="chip" onClick={onClose} title="Close inspector">
          <IconClose size={11} />
        </button>
      </div>
      <div className="popover-body" style={{ overflowY: 'auto' }}>
        <div className="kv">
          <dt>Site</dt>
          <dd>{host || tab.url}</dd>
          <dt>Cookie policy</dt>
          <dd>{state.settings.cookieMode === 'block' ? 'block unless allowed' : 'first-party only'}</dd>
          <dt>Compatibility</dt>
          <dd style={compatible ? { color: 'var(--amber)' } : undefined}>
            {compatible ? 'plain browser for this site' : 'full privacy stack'}
          </dd>
          <dt>This session</dt>
          <dd>
            {formatCount(state.stats.requestsSeen)} inspected · {formatCount(state.stats.cookiesStripped)} cookies refused
          </dd>
        </div>

        {host ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className={`btn ${allowed ? 'danger' : 'primary'}`}
              onClick={() => {
                void window.warden.privacy.allow(host, !allowed)
                notify(allowed ? `Cookies blocked again for ${host}` : `Cookies allowed for ${host} (memory only)`, allowed ? 'info' : 'ok')
              }}
            >
              {allowed ? 'Revoke cookie allowance' : 'Allow cookies for this site'}
            </button>
            {signIn && signInMissing.length ? (
              <button
                className="btn primary"
                onClick={() => {
                  void window.warden.privacy.allowSignIn(tab.url).then((result) => {
                    notify(
                      result.allowed.length
                        ? `Cookies allowed for ${result.allowed.join(' + ')} — sign-in retried`
                        : 'No sign-in flow in this URL',
                      result.allowed.length ? 'ok' : 'info'
                    )
                  })
                }}
                title="Allow cookies for the identity provider and the application it returns to, then reload"
              >
                Allow cookies for this sign-in
              </button>
            ) : null}
            {signIn && signInMissing.length ? (
              <div className="faint small" style={{ lineHeight: 1.5 }}>
                Sign-in spans {signIn.provider}
                {signIn.application ? ` → ${signIn.application}` : ''}. Both need cookies to
                complete; they stay memory-only like every other allowance.
              </div>
            ) : null}
            <button
              className={`btn ${compatible ? 'danger' : ''}`}
              onClick={() => {
                void window.warden.privacy.compatibility(host, !compatible)
                notify(
                  compatible
                    ? `${host} is back under the full privacy stack`
                    : `${host} reloaded as a plain browser: no filtering, cookies kept`,
                  compatible ? 'info' : 'ok'
                )
              }}
              title="For challenge pages, SSO and portals that refuse to load through the privacy stack"
            >
              {compatible ? 'Leave compatibility mode' : 'Reload in compatibility mode'}
            </button>
          </div>
        ) : null}

        <div>
          <div className="panel-title" style={{ margin: '4px 0 6px' }}>
            Top blocked this session
          </div>
          <div className="host-list">
            {state.stats.topHosts.length ? (
              state.stats.topHosts.map((entry) => (
                <div className="host-row" key={entry.host}>
                  <span className="h">{entry.host}</span>
                  <span className="n">{entry.count}</span>
                </div>
              ))
            ) : (
              <div className="faint small">Nothing blocked yet.</div>
            )}
          </div>
        </div>

        <button
          className="btn"
          onClick={() => {
            void window.warden.privacy.clearCookies().then((count) => notify(`${count} cookies removed`, 'ok'))
          }}
        >
          Purge all cookies now
        </button>
      </div>
      <div
        className="dock-resize"
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0 }}
        onMouseDown={(event) => {
          event.preventDefault()
          const startX = event.clientX
          const startWidth = width
          const move = (moveEvent: MouseEvent): void => {
            onResize(Math.min(620, Math.max(300, startWidth - (moveEvent.clientX - startX))))
          }
          const up = (): void => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }}
      />
    </div>
  )
}

export function FindBar({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const [text, setText] = useState('')
  const [hits, setHits] = useState({ matches: 0, active: 0 })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      void window.warden.tab.stopFind(tabId, 'clearSelection')
    }
  }, [tabId])

  const run = (findNext: boolean): void => {
    if (!text) return
    void window.warden.tab.find(tabId, text, { findNext, forward: true }).then(setHits)
  }

  return (
    <div className="findbar fade-in">
      <IconArrowRight size={13} />
      <input
        ref={inputRef}
        value={text}
        placeholder="find in page"
        onChange={(event) => {
          setText(event.target.value)
          void window.warden.tab.find(tabId, event.target.value, { findNext: false }).then(setHits)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') run(true)
          if (event.key === 'Escape') {
            void window.warden.tab.stopFind(tabId, 'clearSelection')
            onClose()
          }
        }}
      />
      <span className="hits">{text ? `${hits.active}/${hits.matches}` : '—'}</span>
      <button className="icon-btn tiny" onClick={() => run(true)} title="Next">
        <IconForward size={12} />
      </button>
      <button className="icon-btn tiny" onClick={onClose} title="Close">
        <IconClose size={12} />
      </button>
    </div>
  )
}

export interface Command {
  id: string
  label: string
  hint: string
  keys?: string
  run: () => void
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    return commands.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(needle))
  }, [commands, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="palette" onClick={(event) => event.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder="Command or URL…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setIndex((current) => Math.min(filtered.length - 1, current + 1))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setIndex((current) => Math.max(0, current - 1))
            }
            if (event.key === 'Enter') {
              const chosen = filtered[index]
              if (chosen) {
                chosen.run()
                onClose()
              } else if (query.trim()) {
                void window.warden.tab.create(query.trim())
                onClose()
              }
            }
          }}
        />
        <div className="palette-list">
          {filtered.map((command, position) => (
            <div
              key={command.id}
              className={`palette-item ${position === index ? 'sel' : ''}`}
              onMouseEnter={() => setIndex(position)}
              onClick={() => {
                command.run()
                onClose()
              }}
            >
              <span className="k">{command.hint}</span>
              <span>{command.label}</span>
              {command.keys ? <span className="d">{command.keys}</span> : null}
            </div>
          ))}
          {!filtered.length ? (
            <div className="palette-item">
              <span className="k">new tab</span>
              <span>Open “{query}”</span>
              <span className="d">enter</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function StatusBar({
  hover,
  tabs,
  blocked,
  rules,
  backend,
  version,
  activeTab
}: {
  hover: string
  tabs: number
  blocked: number
  rules: number
  backend: string
  version: string
  activeTab: TabState | null
}) {
  return (
    <div className="statusbar">
      <span className="hover">{hover || activeTab?.url || 'warden://newtab'}</span>
      <span className="sep" />
      <span className="stat">
        <IconShield size={11} /> <b>{formatCount(blocked)}</b> blocked
      </span>
      <span className="stat">
        <IconBug size={11} /> {formatCount(rules)} rules
      </span>
      <span className="stat">
        <IconDownload size={11} /> memory-only
      </span>
      {backend ? (
        <span className="stat">
          <IconTerminal size={11} /> {backend}
        </span>
      ) : null}
      <span className="sep" />
      <span className="stat">{tabs} tabs</span>
      <span className="stat">v{version}</span>
    </div>
  )
}

export function ToastStack() {
  const { toasts, dismiss } = useWarden()
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} onClick={() => dismiss(toast.id)}>
          {toast.kind === 'err' ? <IconAlert size={13} /> : <IconShield size={13} />}
          {toast.message}
        </div>
      ))}
    </div>
  )
}

export function slotFootHeight(): number {
  return SLOT_FOOT
}

export function dockGeometry(): { head: number; gap: number; pad: number } {
  return { head: DOCK_HEAD, gap: SLOT_GAP, pad: DOCK_PAD }
}
