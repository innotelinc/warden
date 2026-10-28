import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MediaItem, WorkspaceId } from '@shared/types'
import {
  BastionPanel,
  ChallengeBar,
  CommandPalette,
  FindBar,
  Rail,
  StatusBar,
  TabStrip,
  ToastStack,
  Toolbar,
  VideoDock,
  WindowControls,
  type Command
} from './chrome'
import {
  DOCK_DEFAULT,
  DOCK_HEAD,
  DOCK_PAD,
  DRAWER_DEFAULT,
  DRAWER_MIN,
  SLOT_FOOT,
  SLOT_GAP
} from './layout'
import { applyTheme } from '@shared/themes'
import { WardenProvider, useAnimatedNumber, useElementRect, useWarden } from './state'
import { Walkthrough } from './walkthrough'
import { walkthroughDue as tourIsDue } from '@shared/walkthrough'
import { TerminalPane } from './workspaces/TerminalPane'
import { MailWorkspace } from './workspaces/MailWorkspace'
import { MessagingWorkspace } from './workspaces/MessagingWorkspace'
import { ScryWorkspace } from './workspaces/ScryWorkspace'
import { GenieWorkspace } from './workspaces/GenieWorkspace'
import { SettingsWorkspace } from './workspaces/SettingsWorkspace'

function Shell() {
  const { state, notify } = useWarden()
  const [workspace, setWorkspace] = useState<WorkspaceId>('browse')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [tourDismissed, setTourDismissed] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [shieldOpen, setShieldOpen] = useState(false)
  const [dockOpen, setDockOpen] = useState(false)
  const [dockWidth, setDockWidth] = useState(DOCK_DEFAULT)
  const [drawerHeight, setDrawerHeight] = useState(DRAWER_DEFAULT)
  const [hover, setHover] = useState('')
  // A tab handed to Scry from the rail button. Scry reads it once and clears it.
  const [scryFocus, setScryFocus] = useState<{ source: 'local' | 'remote'; id: string } | null>(null)

  const [contentRef, rect] = useElementRect<HTMLDivElement>()

  const activeTab = useMemo(
    () => state?.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    [state?.tabs, state?.activeTabId]
  )

  // A loop the operator can end: shown instead of leaving the page as a dead end.
  const challenge = workspace === 'browse' ? (state?.challenge ?? null) : null

  const dockVisible = workspace === 'browse' && (shieldOpen || dockOpen)
  const dockW = useAnimatedNumber(dockVisible ? dockWidth : 0)
  const drawerOpen = workspace === 'browse' && Boolean(state?.drawerOpen)
  const drawerH = useAnimatedNumber(drawerOpen ? drawerHeight : 0)
  // The find bar is renderer chrome, and the page is a native view drawn above
  // it: the strip reserved here must actually cover the bar or the view clips
  // its bottom edge (and with it the rounded corners).
  const findH = workspace === 'browse' && findOpen ? 48 : 0

  const slots = state?.media ?? []
  const available = state?.mediaAvailable ?? []

  useEffect(() => {
    void window.warden.setWorkspace(workspace)
  }, [workspace])

  // The palette lives in one shared list; applying it is a handful of custom
  // properties on <html>, so switching theme never reloads the app.
  //
  // `system` re-resolves from `prefers-color-scheme`, which Chromium answers
  // from Windows — so the flip needs no IPC, only the media query's own change
  // event. That is what makes a Follow-system theme follow the OS live.
  useEffect(() => {
    const light = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      applyTheme(state?.settings.theme, document.documentElement, light.matches)
    }
    apply()
    light.addEventListener('change', apply)
    return () => light.removeEventListener('change', apply)
  }, [state?.settings.theme])

  useEffect(() => {
    if (slots.length) setDockOpen(true)
  }, [slots.length])

  useEffect(() => {
    const off = window.warden.onHover((url) => setHover(url))
    return () => {
      off()
    }
  }, [])

  useEffect(() => {
    setHover('')
  }, [activeTab?.id])

  // The tour is due until settings say it has been seen; the local flag keeps
  // it from flashing back between the click and the settings round-trip.
  const tourDue = Boolean(state) && tourIsDue(state?.settings.walkthroughSeen) && !tourDismissed
  const showTour = tourOpen || tourDue

  const closeTour = useCallback((): void => {
    setTourOpen(false)
    setTourDismissed(true)
    if (!state?.settings.walkthroughSeen) void window.warden.settings.update({ walkthroughSeen: true })
  }, [state?.settings.walkthroughSeen])

  // One call site for both overlays: the page views are native and would draw
  // over anything the renderer paints.
  useEffect(() => {
    void window.warden.setSuppressed(paletteOpen || showTour)
  }, [paletteOpen, showTour])

  useEffect(() => {
    const off = window.warden.onShortcut((command) => {
      if (command === 'focus-address') window.dispatchEvent(new Event('warden:focus-address'))
      if (command === 'command-palette') setPaletteOpen(true)
      if (command === 'find') setFindOpen(true)
      if (command === 'toggle-dock') setDockOpen((current) => !current)
      if (command === 'settings') setWorkspace('settings')
      if (command === 'scry') setWorkspace('scry')
      if (command === 'toggle-terminal') {
        void window.warden.terminal.setDrawer(!state?.drawerOpen)
      }
    })
    return off
  }, [state?.drawerOpen])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // The tour owns the keyboard while it is up; the component handles Escape.
      if (showTour) return
      const target = event.target as HTMLElement | null
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement

      const ctrl = event.ctrlKey || event.metaKey

      if (ctrl && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (ctrl && event.key === '\\') {
        event.preventDefault()
        void window.warden.lock.lock()
        return
      }
      if (event.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false)
        else if (findOpen) setFindOpen(false)
        else if (shieldOpen) setShieldOpen(false)
        return
      }
      if (typing) return

      if (ctrl && event.key.toLowerCase() === 't') {
        event.preventDefault()
        void window.warden.tab.create('warden://newtab')
      } else if (ctrl && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        if (activeTab) void window.warden.tab.cloak(activeTab.id, !activeTab.cloaked)
      } else if (ctrl && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (activeTab) void window.warden.tab.close(activeTab.id)
      } else if (ctrl && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        window.dispatchEvent(new Event('warden:focus-address'))
      } else if (ctrl && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        if (activeTab) setFindOpen(true)
      } else if (ctrl && event.key === '`') {
        event.preventDefault()
        setWorkspace('browse')
        void window.warden.terminal.setDrawer(!state?.drawerOpen)
      } else if (ctrl && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setDockOpen((current) => !current)
      } else if (ctrl && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        setWorkspace('scry')
      } else if (ctrl && event.key === ',') {
        event.preventDefault()
        setWorkspace('settings')
      } else if (ctrl && /^[1-6]$/.test(event.key)) {
        event.preventDefault()
        const order: WorkspaceId[] = ['browse', 'trench', 'relay', 'concourse', 'scry', 'settings']
        const next = order[Number(event.key) - 1]
        if (next) setWorkspace(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTab, findOpen, paletteOpen, shieldOpen, state?.drawerOpen, showTour])

  /** The active tab's page asked for fullscreen and has it. */
  const htmlFullscreen = Boolean(
    state?.fullscreenTabId && activeTab && state.fullscreenTabId === activeTab.id
  )

  const mediaRects = useMemo(() => {
    if (!rect || !dockVisible || shieldOpen) return []
    if (!slots.length) return []
    const dockX = rect.x + rect.width - dockW
    const top = rect.y + DOCK_HEAD + DOCK_PAD
    const areaHeight = rect.height - drawerH - DOCK_HEAD - DOCK_PAD * 2
    const count = slots.length
    if (areaHeight < 60) return []
    const slotHeight = (areaHeight - SLOT_GAP * (count - 1)) / count
    return slots.map((slot, index) => ({
      x: dockX + DOCK_PAD,
      y: top + index * (slotHeight + SLOT_GAP),
      width: Math.max(0, dockW - DOCK_PAD * 2),
      height: Math.max(0, slotHeight - SLOT_FOOT)
    }))
  }, [rect, dockW, drawerH, dockVisible, shieldOpen, slots.length])

  useEffect(() => {
    if (!rect) return
    // A page in fullscreen owns the window: the tab view is a native child on
    // top of this document, so giving it every pixel is what removes the chrome
    // and the dock — and nothing else may claim part of the layout.
    if (htmlFullscreen) {
      void window.warden.setLayout({
        surface: 'browse',
        tabBounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        mediaBounds: [],
        msgBounds: null
      })
      return
    }
    if (workspace === 'concourse') return
    if (workspace !== 'browse') {
      void window.warden.setLayout({ surface: 'hidden', tabBounds: null, mediaBounds: [], msgBounds: null })
      return
    }
    void window.warden.setLayout({
      surface: paletteOpen ? 'hidden' : 'browse',
      tabBounds: {
        x: rect.x,
        y: rect.y + findH,
        width: Math.max(0, rect.width - dockW),
        height: Math.max(0, rect.height - findH - drawerH)
      },
      mediaBounds: paletteOpen ? [] : mediaRects,
      msgBounds: null
    })
  }, [rect, dockW, drawerH, findH, workspace, paletteOpen, mediaRects, htmlFullscreen])

  const openMedia = (item: MediaItem): void => {
    if (!state?.activeTabId) return
    void window.warden.media.open(state.activeTabId, item)
  }

  const commands: Command[] = [
    {
      id: 'new-tab',
      label: 'New tab',
      hint: 'tab',
      keys: 'Ctrl+T',
      run: () => void window.warden.tab.create('warden://newtab')
    },
    {
      id: 'cloak',
      label: 'Toggle cloak on this tab',
      hint: 'privacy',
      keys: 'Ctrl+Shift+N',
      run: () => {
        if (!activeTab) return
        void window.warden.tab.cloak(activeTab.id, !activeTab.cloaked)
      }
    },
    {
      id: 'close-tab',
      label: 'Close current tab',
      hint: 'tab',
      keys: 'Ctrl+W',
      run: () => activeTab && void window.warden.tab.close(activeTab.id)
    },
    {
      id: 'scry',
      label: 'Scry the active page',
      hint: 'deconstruct',
      keys: 'Ctrl+Shift+S',
      run: () => setWorkspace('scry')
    },
    {
      id: 'trench',
      label: 'Open Trench shell',
      hint: 'workspace',
      keys: 'Ctrl+`',
      run: () => {
        setWorkspace('browse')
        void window.warden.terminal.setDrawer(true)
      }
    },
    { id: 'dock', label: 'Toggle Splay video dock', hint: 'view', keys: 'Ctrl+J', run: () => setDockOpen((v) => !v) },
    { id: 'relay', label: 'Open Relay mail', hint: 'workspace', run: () => setWorkspace('relay') },
    { id: 'concourse', label: 'Open Concourse messaging', hint: 'workspace', run: () => setWorkspace('concourse') },
    { id: 'policy', label: 'Open policy settings', hint: 'workspace', keys: 'Ctrl+,', run: () => setWorkspace('settings') },
    {
      id: 'tour',
      label: 'Show the walkthrough',
      hint: 'help',
      run: () => setTourOpen(true)
    },
    {
      id: 'cookies',
      label: 'Purge every cookie now',
      hint: 'privacy',
      run: () =>
        void window.warden.privacy
          .clearCookies()
          .then((count) => notify(`${count} cookies purged`, 'ok'))
    },
    {
      id: 'lists',
      label: 'Sync EasyList + EasyPrivacy',
      hint: 'privacy',
      run: () =>
        void window.warden.privacy
          .syncLists()
          .then((outcome) => notify(`${outcome.rules} rules loaded`, 'ok'), (error: Error) => notify(error.message, 'err'))
    },
    {
      id: 'copy',
      label: 'Copy current URL',
      hint: 'page',
      run: () => {
        if (!activeTab) return
        void navigator.clipboard.writeText(activeTab.url)
        notify('URL copied')
      }
    },
    {
      id: 'bookmark',
      label: 'Bookmark this page',
      hint: 'page',
      run: () => activeTab && void window.warden.bookmarks.toggle(activeTab.url, activeTab.title)
    },
    {
      id: 'allow',
      label: 'Allow cookies for the current site',
      hint: 'privacy',
      run: () => {
        if (!activeTab) return
        try {
          const host = new URL(activeTab.url).hostname
          void window.warden.privacy.allow(host, true)
          notify(`Cookies allowed for ${host}`, 'ok')
        } catch {
          notify('This surface has no host', 'err')
        }
      }
    }
  ]

  if (!state) {
    return (
      <div className="app">
        <div className="titlebar">
          <div className="brand">
            <div className="sigil" />
            <span className="brand-name">WARDEN</span>
          </div>
          <span className="crumb">initialising</span>
          <div className="spacer" />
          <WindowControls maximized={false} />
        </div>
        <div style={{ display: 'grid', placeItems: 'center', color: 'var(--muted)', font: '11px/1.7 var(--mono)' }}>
          starting hardened sessions…
        </div>
      </div>
    )
  }

  const unread = state.messaging.states.reduce((total, entry) => total + entry.unread, 0)

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <div className="sigil" />
          <span className="brand-name">WARDEN</span>
        </div>
        <span className="crumb">{workspace}</span>
        {activeTab?.cloaked ? <span className="crumb" style={{ color: 'var(--amber)' }}>cloak</span> : null}
        <div className="spacer" />
        <div className="status-pill" title="Cookie writes refused this session">
          <span className="dot" />
          {state.settings.cookieMode === 'block' ? 'COOKIELESS' : 'FIRST-PARTY ONLY'}
        </div>
        <WindowControls maximized={state.maximized} />
      </header>

      <div className="body">
        <Rail
          workspace={workspace}
          onWorkspace={setWorkspace}
          blocked={state.stats.blockedTotal}
          unread={unread}
        />

        <div className="stage">
          {workspace === 'browse' ? (
            <>
              <Toolbar
                tab={activeTab}
                busy={Boolean(activeTab?.loading)}
                dockOpen={dockVisible}
                drawerOpen={Boolean(state.drawerOpen)}
                onPalette={() => setPaletteOpen(true)}
                onFind={() => {
                  if (!activeTab) return
                  setFindOpen((open) => !open)
                }}
                onToggleDock={() => setDockOpen((current) => !current)}
                onToggleTerminal={() => void window.warden.terminal.setDrawer(!state.drawerOpen)}
                onShield={() => setShieldOpen((current) => !current)}
                onSendToScry={() => {
                  if (!activeTab) return
                  setScryFocus({ source: 'local', id: activeTab.id })
                  setWorkspace('scry')
                  notify(`Sent ${activeTab.title || activeTab.url} to Scry`)
                }}
              />
              <TabStrip tabs={state.tabs} activeId={state.activeTabId} />
              {challenge ? (
                <ChallengeBar
                  host={challenge.host}
                  kind={challenge.kind}
                  attempts={challenge.attempts}
                  blocked={challenge.blocked}
                  onTryUnfiltered={() => {
                    void window.warden.privacy.unfiltered(challenge.host, true)
                    notify(`${challenge.host} reloaded unfiltered — this run only, nothing saved`, 'ok')
                  }}
                  onCompatibility={() => {
                    void window.warden.privacy.compatibility(challenge.host, true)
                    notify(`${challenge.host} added to the exclusion list`, 'ok')
                  }}
                  onDismiss={() => {
                    if (activeTab) void window.warden.tab.dismissChallenge(activeTab.id, challenge.host)
                  }}
                />
              ) : null}
            </>
          ) : null}

          <div className="content" ref={contentRef}>
            {workspace === 'browse' ? (
              <>
                <div className="content-row">
                  <div className="content-main" />
                  {dockVisible && shieldOpen && activeTab ? (
                    <BastionPanel
                      tab={activeTab}
                      width={dockW}
                      onClose={() => setShieldOpen(false)}
                      onResize={setDockWidth}
                    />
                  ) : null}
                  {dockVisible && !shieldOpen ? (
                    <VideoDock
                      slots={slots}
                      available={available}
                      width={dockW}
                      readOnly={!activeTab}
                      onOpen={openMedia}
                      onClose={(slot) => void window.warden.media.close(slot)}
                      onControl={(slot, command, value) => void window.warden.media.control(slot, command, value)}
                      onResize={setDockWidth}
                    />
                  ) : null}
                </div>

                {findOpen && activeTab ? (
                  <FindBar
                    tabId={activeTab.id}
                    onClose={() => {
                      setFindOpen(false)
                      void window.warden.tab.stopFind(activeTab.id, 'keepSelection')
                    }}
                  />
                ) : null}

                {drawerOpen ? (
                  <div
                    className="drawer-shell"
                    style={{ height: drawerHeight, borderTop: '1px solid var(--line)' }}
                  >
                    <div
                      className="term-resize"
                      onMouseDown={(event) => {
                        event.preventDefault()
                        const startY = event.clientY
                        const startHeight = drawerHeight
                        const move = (moveEvent: MouseEvent): void => {
                          const max = Math.max(DRAWER_MIN + 60, (rect?.height ?? 600) - 160)
                          setDrawerHeight(Math.min(max, Math.max(DRAWER_MIN, startHeight - (moveEvent.clientY - startY))))
                        }
                        const up = (): void => {
                          window.removeEventListener('mousemove', move)
                          window.removeEventListener('mouseup', up)
                        }
                        window.addEventListener('mousemove', move)
                        window.addEventListener('mouseup', up)
                      }}
                    />
                    <TerminalPane variant="drawer" />
                  </div>
                ) : null}
              </>
            ) : workspace === 'concourse' ? (
              <MessagingWorkspace />
            ) : workspace === 'trench' ? (
              <TerminalPane variant="full" />
            ) : workspace === 'relay' ? (
              <MailWorkspace />
            ) : workspace === 'scry' ? (
              <ScryWorkspace focus={scryFocus} onFocusHandled={() => setScryFocus(null)} />
            ) : workspace === 'genie' ? (
              <GenieWorkspace />
            ) : (
              <SettingsWorkspace />
            )}
          </div>

          <StatusBar
            hover={hover}
            tabs={state.tabs.length}
            blocked={state.stats.blockedTotal}
            rules={state.stats.rulesLoaded}
            backend={state.terminal ? `${state.terminal.backend} · ${state.terminal.title}` : ''}
            version={state.version}
            update={state.update}
            activeTab={activeTab}
          />
        </div>
      </div>

      {paletteOpen ? <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} /> : null}
      {showTour ? <Walkthrough onDone={closeTour} /> : null}
      <ToastStack />
    </div>
  )
}

export default function App() {
  return (
    <WardenProvider>
      <Shell />
    </WardenProvider>
  )
}
