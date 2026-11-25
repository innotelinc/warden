import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StatusBar, Style } from '@capacitor/status-bar'
import { resolveInput } from '@shared/urls'
import {
  clearServiceData,
  forgetSiteRules,
  openPage,
  openService,
  siteRules,
  WardenBrowser,
  type BrowserSurface,
  type SiteRule
} from './warden-browser'
import { ScryPanel } from './panels/ScryPanel'
import { ServicesPanel } from './panels/ServicesPanel'
import { MailPanel } from './panels/MailPanel'
import { SERVICE_SESSION_NOTE } from './operator/surfaces'
import {
  IconArrowRight,
  IconChat,
  IconClose,
  IconCommand,
  IconCrosshair,
  IconGear,
  IconGlobe,
  IconLock,
  IconMail,
  IconShield
} from './icons'

declare const __WARDEN_VERSION__: string

/** The shell's search engine. One place, so the Scry field agrees with the bar. */
const SEARCH_URL = 'https://duckduckgo.com/?q=%s'

/** Where a typed string goes. Shared with the desktop, so the rules are one set. */
export function resolveTarget(input: string): string | null {
  return resolveInput(input, SEARCH_URL)
}

/**
 * What this build actually does.
 *
 * Every line here is checked against the native surface it describes, because a
 * posture screen that overstates the product is worse than no screen at all: it
 * tells an operator they are covered when they are not.
 */
const POSTURE: [string, string][] = [
  [
    'A real engine',
    'Pages render in the platform WebView with WARDEN’s own address bar, back, forward and reload — not in another app’s browser.'
  ],
  ['Ad and tracker blocking', 'Requests to ad and tracker hosts are refused before they leave the app, on both platforms.'],
  ['The slot goes too', 'A refused ad leaves an empty box; the page script removes the container and closes the gap.'],
  ['No third-party cookies', 'A page keeps its own session cookie so a login still works. Cross-site cookies are off.'],
  [
    'Session wiped',
    'Cookies, web storage and cache are cleared when a browser page closes. Chat and mail keep a sign-in of their own, and Sign out ends it.'
  ],
  ['No telemetry', 'No analytics, crash or ad SDKs in this app, and no account to sign in to.']
]

/**
 * What the browser is, stated the way the App Store actually works.
 *
 * iOS has no browser engines you can link against: every browser in the store —
 * Chrome, Firefox, Edge, this one — renders with WebKit. So the product does not
 * claim a renderer it did not write. It claims, accurately, the layer above it:
 * the rules, the cookie policy, the fingerprint shim, the tab model, the chrome,
 * the reader, the downloads and the teardown.
 */
const ENGINE: [string, string][] = [
  ['Renderer', 'WebKit, provided by iOS — the only engine an App Store browser may use.'],
  ['Rules', 'WARDEN’s own ad and tracker lists, compiled into a content rule list per tab.'],
  ['Cookies', 'Non-persistent store, a JavaScript lock for hosts without an allowance, and a purge after every page.'],
  ['Fingerprint', 'A shim injected before the page’s first script, with generic values rather than unique ones.'],
  ['Chrome', 'Address field, tabs, shield, find, reader, share and downloads — all in the app, none handed to another browser.']
]

// Only destinations that ship with the product belong here. A team's own paid
// services are not part of what a store reviewer, or anybody else who installs
// this, is being given.
const SHORTCUTS = [
  { label: 'WARDEN', url: 'https://github.com/innotelinc/warden' },
  { label: 'Release notes', url: 'https://github.com/innotelinc/warden/releases' },
  { label: 'Privacy', url: 'https://innotelinc.github.io/warden/privacy.html' }
]

type WorkspaceId = 'browse' | 'concourse' | 'relay' | 'scry' | 'policy'

interface Workspace {
  id: WorkspaceId
  /** The name the phone has always used, and the one in the store listing. */
  label: string
  /** The desktop's own word for the same surface, so the rail reads as one product. */
  module: string
  hint: string
  icon: (props: { size?: number }) => React.ReactElement
}

const WORKSPACES: Workspace[] = [
  { id: 'browse', label: 'Browser', module: 'Bastion', hint: 'WARDEN’s own browser', icon: IconShield },
  { id: 'concourse', label: 'Services', module: 'Concourse', hint: 'Chat web clients', icon: IconChat },
  { id: 'relay', label: 'Mail', module: 'Relay', hint: 'Mail providers', icon: IconMail },
  { id: 'scry', label: 'Scry', module: 'Scry', hint: 'Read the page in front of you', icon: IconCrosshair },
  { id: 'policy', label: 'Policy', module: 'Policy', hint: 'What is enforced, and where', icon: IconGear }
]

/** The host alone, for a line that has to stay one line. */
export function prettyHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** `secure` / `insecure` / `internal`, the same three the desktop's bar shows. */
function schemeOf(url: string): 'secure' | 'insecure' | 'internal' {
  if (/^https:/i.test(url)) return 'secure'
  if (/^http:/i.test(url)) return 'insecure'
  return 'internal'
}

interface Command {
  id: string
  label: string
  hint: string
  run: () => void
}

export function App(): React.ReactElement {
  const [workspace, setWorkspace] = useState<WorkspaceId>('browse')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [surface, setSurface] = useState<BrowserSurface | null>(null)
  const [serviceSurface, setServiceSurface] = useState<BrowserSurface | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [recents, setRecents] = useState<string[]>([])
  const [rules, setRules] = useState<SiteRule[]>([])
  const [palette, setPalette] = useState(false)
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const notify = useCallback((text: string): void => setToast(text), [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3400)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    void StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined)
    void StatusBar.setBackgroundColor({ color: '#070a0d' }).catch(() => undefined)
  }, [])

  /**
   * The surface reports where it goes, so this screen can keep the session's
   * pages. The listeners are best-effort: a build without the native plugin has
   * no events to give, and the address field still works there.
   */
  useEffect(() => {
    const handles: { remove: () => Promise<void> }[] = []
    const keep = (handle: { remove: () => Promise<void> }): void => {
      handles.push(handle)
    }
    void WardenBrowser.addListener('navigated', (data) => {
      setCurrent(data.url)
      setRecents((list) => [data.url, ...list.filter((entry) => entry !== data.url)].slice(0, 12))
    })
      .then(keep)
      .catch(() => undefined)
    void WardenBrowser.addListener('closed', () => {
      // Coming back to the browser should leave the address you were last on in
      // the field, ready to continue — not an empty box that forgets the session.
      setAddress((value) => (value ? value : current ?? ''))
    })
      .then(keep)
      .catch(() => undefined)
    return () => {
      for (const handle of handles) void handle.remove().catch(() => undefined)
    }
  }, [current])

  // Site rules live in the browser surface, so Policy re-reads them when it is
  // opened rather than caching a picture of them from launch.
  useEffect(() => {
    if (workspace !== 'policy') return
    let live = true
    void siteRules().then((list) => {
      if (live) setRules(list)
    })
    return () => {
      live = false
    }
  }, [workspace])

  const go = useCallback(
    async (input?: string): Promise<void> => {
      const target = resolveTarget(input ?? address)
      if (!target) {
        setError('Type a host or a search.')
        return
      }
      setError(null)
      try {
        const where = await openPage(target)
        setSurface(where)
        setCurrent(target)
        setAddress('')
        setRecents((list) => [target, ...list.filter((entry) => entry !== target)].slice(0, 12))
        if (where === 'system') {
          notify('Opened in the system browser — this build is missing the WARDEN surface.')
        }
      } catch (problem) {
        setError((problem as Error).message)
      }
    },
    [address, notify]
  )

  /** Services and mail open in the session that survives, not the browser's. */
  const openInService = useCallback(async (url: string): Promise<void> => {
    setError(null)
    try {
      const where = await openService(url)
      setServiceSurface(where)
      setCurrent(url)
      setRecents((list) => [url, ...list.filter((entry) => entry !== url)].slice(0, 12))
    } catch (problem) {
      setError((problem as Error).message)
    }
  }, [])

  const signOutServices = useCallback(async (): Promise<void> => {
    const ok = await clearServiceData()
    notify(
      ok
        ? 'Service sign-ins cleared on this device. The chat and mail apps will ask again.'
        : 'This build cannot clear service data; sign out in each service.'
    )
  }, [notify])

  const clearSession = useCallback((): void => {
    setRecents([])
    setCurrent(null)
    setSurface(null)
    notify('This session’s pages are gone. Nothing was stored.')
  }, [notify])

  const forgetRules = useCallback(async (): Promise<void> => {
    const ok = await forgetSiteRules()
    if (!ok) {
      notify('This surface has no per-site rules to forget.')
      return
    }
    setRules([])
    notify('Every site rule forgotten. Filtering is back on, cookies refused, everywhere.')
  }, [notify])

  const commands = useMemo<Command[]>(
    () => [
      ...WORKSPACES.map((entry) => ({
        id: entry.id,
        label: `Go to ${entry.label}`,
        hint: entry.module,
        run: () => setWorkspace(entry.id)
      })),
      {
        id: 'scry-current',
        label: current ? `Scry ${prettyHost(current)}` : 'Scry a page',
        hint: 'Scry',
        run: () => setWorkspace('scry')
      },
      { id: 'sign-out', label: 'Sign out of every service', hint: 'Concourse', run: () => void signOutServices() },
      { id: 'clear-session', label: 'Clear this session', hint: 'Policy', run: clearSession }
    ],
    [clearSession, current, signOutServices]
  )

  const shown = address || current || ''
  const scheme = schemeOf(shown)

  const submit = (): void => {
    void go()
    setPalette(false)
  }

  return (
    <div className="app">
      <header className="titlebar">
        <span className="sigil" aria-hidden="true" />
        <span className="brand-name">WARDEN</span>
        <span className="crumb">Mobile</span>
        <span className="spacer" />
        <span className="status-pill" title="A browser session that is not written to disk">
          <span className="dot" />
          memory-only
        </span>
        <button
          className="icon-btn"
          onClick={() => setPalette(true)}
          title="Command palette"
          aria-label="Command palette"
        >
          <IconCommand />
        </button>
      </header>

      <div className="body">
        <nav className="rail" aria-label="Workspaces">
          {WORKSPACES.map((entry) => {
            const Glyph = entry.icon
            return (
              <button
                key={entry.id}
                className={`rail-btn ${workspace === entry.id ? 'active' : ''}`}
                onClick={() => setWorkspace(entry.id)}
                title={`${entry.label} — ${entry.hint}`}
                aria-label={entry.label}
                aria-current={workspace === entry.id ? 'page' : undefined}
              >
                <Glyph size={17} />
                <span className="rail-label">{entry.module}</span>
              </button>
            )
          })}
          <span className="rail-spacer" />
          <div className="rail-meter" title="Pages opened this session">
            <IconGlobe size={12} />
            <b>{recents.length}</b>
          </div>
        </nav>

        <main className="stage">
          <div className="toolbar">
            <form
              className="address"
              onSubmit={(event) => {
                event.preventDefault()
                submit()
              }}
            >
              <span className={`scheme ${scheme}`} aria-hidden="true">
                {scheme === 'secure' ? <IconLock size={11} /> : <IconGlobe size={11} />}
                {scheme === 'secure' ? 'https' : scheme === 'insecure' ? 'http' : 'local'}
              </span>
              <input
                ref={inputRef}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="Search DuckDuckGo or enter a target"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Search or enter address"
              />
              {address ? (
                <button
                  type="button"
                  className="icon-btn tiny"
                  onClick={() => setAddress('')}
                  title="Clear"
                  aria-label="Clear address"
                >
                  <IconClose />
                </button>
              ) : null}
              <button type="submit" className="go" title="Open in WARDEN" aria-label="Open in WARDEN">
                <IconArrowRight />
              </button>
            </form>
            <button
              className="shield-pill"
              onClick={() => setWorkspace('policy')}
              title="Bastion — what this browser refuses, and where"
            >
              <IconShield size={13} />
              <b>shield</b>
            </button>
          </div>

          <div className="tabstrip" role="tablist" aria-label="Pages this session">
            {recents.map((url) => (
              <div key={url} className={`surface-tab ${current === url ? 'active' : ''}`} title={url}>
                <IconGlobe size={11} />
                <button className="title" onClick={() => void go(url)}>
                  {prettyHost(url)}
                </button>
                <button
                  className="x"
                  onClick={() => setRecents((list) => list.filter((entry) => entry !== url))}
                  aria-label={`Close ${url}`}
                >
                  <IconClose size={11} />
                </button>
              </div>
            ))}
            <button
              className="tab-new"
              onClick={() => {
                setWorkspace('browse')
                inputRef.current?.focus()
              }}
              title="New page"
              aria-label="New page"
            >
              +
            </button>
          </div>

          <div className="content">
            {error ? <p className="shell-error">{error}</p> : null}

            {workspace === 'browse' ? (
              <div className="workspace scroll">
                <div className="ws-pad">
                  <section className="splash">
                    <div className="mark" aria-hidden="true">
                      <svg viewBox="0 0 120 136" fill="none" stroke="currentColor" strokeWidth="4" strokeLinejoin="round">
                        <path d="M60 4l52 20v52c0 30-22 48-52 56C30 124 8 106 8 76V24L60 4z" />
                      </svg>
                      <span className="w">W</span>
                    </div>
                    <h1>Read everything. Give nothing.</h1>
                    <p className="lede">WARDEN Mobile · us.innotel.warden</p>
                    <div className="chip-row">
                      <span className="tag mint">own chrome</span>
                      <span className="tag mint">rules before requests</span>
                      <span className="tag">memory-only</span>
                      <span className="tag">no account</span>
                    </div>
                  </section>

                  {current ? (
                    <section className="surface">
                      <div className="surface-row">
                        <span className="dot" aria-hidden="true" />
                        <div className="surface-text">
                          <b>{prettyHost(current)}</b>
                          <span>
                            {surface === 'system'
                              ? 'opened in the system browser — this build is missing the WARDEN surface'
                              : 'this session · reopened in WARDEN'}
                          </span>
                        </div>
                        <button className="btn primary" onClick={() => void go(current)}>
                          Reopen
                        </button>
                      </div>
                    </section>
                  ) : null}

                  <section>
                    <h2 className="section-title">The browser</h2>
                    <ul className="facts">
                      {ENGINE.map(([name, value]) => (
                        <Fact key={name} name={name} value={value} />
                      ))}
                    </ul>
                  </section>

                  <section>
                    <h2 className="section-title">This session</h2>
                    {recents.length ? (
                      <ul className="surface-list">
                        {recents.map((url) => (
                          <li key={url}>
                            <button onClick={() => void go(url)} title={url}>
                              <span className="u">{prettyHost(url)}</span>
                              <span className="p">{url.replace(/^https?:\/\//, '').slice(0, 46)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="hint">Nothing opened yet. Type an address, or pick a destination below.</p>
                    )}
                  </section>

                  <section>
                    <h2 className="section-title">Session posture</h2>
                    <ul className="posture">
                      {POSTURE.map(([title, detail]) => (
                        <li key={title}>
                          <i />
                          <div>
                            <b>{title}</b>
                            <span>{detail}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section>
                    <h2 className="section-title">Quick destinations</h2>
                    <div className="shortcut-grid">
                      {SHORTCUTS.map((entry) => (
                        <button key={entry.url} onClick={() => void go(entry.url)}>
                          {entry.label}
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            ) : null}

            {workspace === 'scry' ? (
              <div className="workspace">
                <header className="ws-head">
                  <h1>Scry</h1>
                  <span className="sub">deconstructor · runs in this build</span>
                  <span className="spacer" />
                  <span className="tag violet">native</span>
                </header>
                <div className="ws-body scroll">
                  <div className="ws-pad">
                    <ScryPanel
                      lastVisited={current}
                      resolve={resolveTarget}
                      onVisited={(url) =>
                        setRecents((list) => [url, ...list.filter((entry) => entry !== url)].slice(0, 12))
                      }
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {workspace === 'concourse' ? (
              <div className="workspace">
                <header className="ws-head">
                  <h1>Concourse</h1>
                  <span className="sub">messaging · own session</span>
                  <span className="spacer" />
                  <span className="tag mint">native</span>
                </header>
                <div className="ws-body scroll">
                  <div className="ws-pad">
                    {serviceSurface === 'system' ? (
                      <p className="hint">
                        This build has no WARDEN surface, so the service opened in the system browser. Its sign-in
                        stays there, not in WARDEN.
                      </p>
                    ) : null}
                    <ServicesPanel onOpen={(url) => void openInService(url)} />
                    <p className="note">{SERVICE_SESSION_NOTE}</p>
                  </div>
                </div>
              </div>
            ) : null}

            {workspace === 'relay' ? (
              <div className="workspace">
                <header className="ws-head">
                  <h1>Relay</h1>
                  <span className="sub">mail · provider web client</span>
                  <span className="spacer" />
                  <span className="tag amber">web client</span>
                </header>
                <div className="ws-body scroll">
                  <div className="ws-pad">
                    <MailPanel onOpen={(url) => void openInService(url)} resolve={resolveTarget} />
                  </div>
                </div>
              </div>
            ) : null}

            {workspace === 'policy' ? (
              <div className="workspace scroll">
                <header className="ws-head">
                  <h1>Policy</h1>
                  <span className="sub">every switch, with the enforcement point stated</span>
                </header>
                <div className="ws-pad">
                  <section>
                    <h2 className="section-title">Enforced on this build</h2>
                    <ul className="facts">
                      <Fact name="Request rules" value="on — a content rule list compiled per tab, applied before page scripts" />
                      <Fact name="Cookie policy" value="non-persistent store; JavaScript cookie lock without an allowance; purge after load" />
                      <Fact name="HTTPS only" value="on — a top-level http address is upgraded before it leaves the app" />
                      <Fact name="Fingerprint shim" value="on — injected at document start, generic values" />
                      <Fact name="Pages" value="up to six engines, one session store, in-app chrome" />
                      <Fact name="Telemetry" value="none — no SDK, no account, no crash reporter" />
                      <Fact name="Sensors" value="camera, microphone and location are never requested" />
                    </ul>
                  </section>

                  <section>
                    <h2 className="section-title">Site rules</h2>
                    {rules.length ? (
                      <>
                        <ul className="facts">
                          {rules.map((rule) => (
                            <Fact
                              key={rule.host}
                              name={rule.host}
                              value={`${rule.blocking ? 'filtering' : 'not filtering'} · cookies ${rule.cookies ? 'allowed' : 'refused'}`}
                            />
                          ))}
                        </ul>
                        <div className="button-row">
                          <button className="btn danger" onClick={() => void forgetRules()}>
                            Forget all site rules
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="hint">
                        No site has an exception. The shield in the browser sets one per site, for this run only — the
                        list is in memory and ends with the app.
                      </p>
                    )}
                  </section>

                  <section>
                    <h2 className="section-title">Not in this build</h2>
                    <ul className="facts">
                      <Fact name="A browser engine of our own" value="iOS allows none; WebKit is the only engine a store browser may use" />
                      <Fact name="DNS over HTTPS" value="needs a network extension entitlement" />
                      <Fact name="Isolated tabs" value="one session store per surface, shared by its pages" />
                      <Fact name="IMAP mail and fraud check" value="web client instead, and the panel says so" />
                      <Fact name="Genie assistant" value="needs a gateway key the phone will not store" />
                      <Fact name="Device-unlock lock screen" value="Face ID gate is the next native piece, not here yet" />
                    </ul>
                  </section>

                  <section>
                    <h2 className="section-title">This session</h2>
                    <div className="button-row">
                      <button className="btn" onClick={clearSession}>
                        Clear session history
                      </button>
                      <button className="btn danger" onClick={() => void signOutServices()}>
                        Sign out of every service
                      </button>
                    </div>
                    <p className="hint">
                      Clearing history forgets the pages this screen is holding; it does not touch a page that is still
                      open, and nothing was written to disk to delete.
                    </p>
                  </section>

                  <section>
                    <h2 className="section-title">Build</h2>
                    <ul className="facts">
                      <Fact name="Version" value={__WARDEN_VERSION__} />
                      <Fact name="Bundle" value="us.innotel.warden" />
                      <Fact name="Surface" value="Capacitor shell · WKWebView engine · WARDEN policy" />
                      <Fact name="Account" value="none" />
                    </ul>
                  </section>
                </div>
              </div>
            ) : null}
          </div>

          <footer className="statusbar">
            <span className="hover">{current ?? 'warden://newtab'}</span>
            <span className="sep" />
            <span className="stat">
              <IconShield size={11} /> <b>shield</b>
            </span>
            <span className="stat">
              <IconLock size={11} /> memory-only
            </span>
            <span className="sep" />
            <span className="stat">{recents.length} pages</span>
            <span className="stat">v{__WARDEN_VERSION__}</span>
          </footer>
        </main>
      </div>

      {palette ? (
        <div className="overlay" onClick={() => setPalette(false)}>
          <div className="palette" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus
              value={query}
              placeholder="Command or address…"
              aria-label="Command or address"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setPalette(false)
                if (event.key === 'Enter') {
                  const needle = query.trim().toLowerCase()
                  const match = commands.find((command) =>
                    `${command.label} ${command.hint}`.toLowerCase().includes(needle)
                  )
                  if (needle && !match) {
                    setAddress(query.trim())
                    setPalette(false)
                    setWorkspace('browse')
                    void go(query.trim())
                    return
                  }
                  if (match) match.run()
                  setPalette(false)
                  setQuery('')
                }
              }}
            />
            <div className="palette-list">
              {commands
                .filter((command) =>
                  `${command.label} ${command.hint}`.toLowerCase().includes(query.trim().toLowerCase())
                )
                .map((command) => (
                  <button
                    key={command.id}
                    className="palette-item"
                    onClick={() => {
                      command.run()
                      setPalette(false)
                      setQuery('')
                    }}
                  >
                    <span className="k">{command.hint}</span>
                    <span>{command.label}</span>
                  </button>
                ))}
              {query.trim() ? (
                <button
                  className="palette-item new"
                  onClick={() => {
                    void go(query.trim())
                    setPalette(false)
                    setQuery('')
                  }}
                >
                  <span className="k">new page</span>
                  <span>Open “{query.trim()}” in WARDEN</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="toast-stack" role="status">
          <div className="toast" onClick={() => setToast(null)}>
            <IconShield size={13} />
            {toast}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** One row of Policy: the switch, and the thing that enforces it. */
function Fact({ name, value }: { name: string; value: string }): React.ReactElement {
  return (
    <li>
      <b>{name}</b>
      <span>{value}</span>
    </li>
  )
}
