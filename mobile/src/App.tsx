import { useCallback, useEffect, useState } from 'react'
import { StatusBar, Style } from '@capacitor/status-bar'
import { resolveInput } from '@shared/urls'
import { openPage, openService, WardenBrowser, type BrowserSurface } from './warden-browser'
import { ScryPanel } from './panels/ScryPanel'
import { ServicesPanel } from './panels/ServicesPanel'
import { MailPanel } from './panels/MailPanel'

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

// Only destinations that ship with the product belong here. A team's own paid
// services are not part of what a store reviewer, or anybody else who installs
// this, is being given.
const SHORTCUTS = [
  { label: 'WARDEN', url: 'https://github.com/innotelinc/warden' },
  { label: 'Release notes', url: 'https://github.com/innotelinc/warden/releases' },
  { label: 'Privacy', url: 'https://innotelinc.github.io/warden/privacy.html' }
]

const TABS = [
  { id: 'browser', label: 'Browser' },
  { id: 'scry', label: 'Scry' },
  { id: 'services', label: 'Services' },
  { id: 'mail', label: 'Mail' }
] as const

type TabId = (typeof TABS)[number]['id']

/** The host alone, for a line that has to stay one line. */
export function prettyHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function App(): React.ReactElement {
  const [tab, setTab] = useState<TabId>('browser')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [surface, setSurface] = useState<BrowserSurface | null>(null)
  const [serviceSurface, setServiceSurface] = useState<BrowserSurface | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [recents, setRecents] = useState<string[]>([])

  useEffect(() => {
    void StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined)
    void StatusBar.setBackgroundColor({ color: '#070a0d' }).catch(() => undefined)
  }, [])

  /**
   * The surface reports where it goes, so this screen can keep the session's
   * history. The listeners are best-effort: a build without the native plugin has
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
      } catch (problem) {
        setError((problem as Error).message)
      }
    },
    [address]
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="mark small" aria-hidden="true">
          <svg viewBox="0 0 120 136" fill="none" stroke="currentColor" strokeWidth="4" strokeLinejoin="round">
            <path d="M60 4l52 20v52c0 30-22 48-52 56C30 124 8 106 8 76V24L60 4z" />
          </svg>
          <span className="w">W</span>
        </div>

        {tab === 'browser' ? (
          <form
            className="address"
            onSubmit={(event) => {
              event.preventDefault()
              void go()
            }}
          >
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Search or enter address"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Search or enter address"
            />
            <button type="submit" aria-label="Open">
              ↵
            </button>
          </form>
        ) : (
          <div className="topbar-title">{TABS.find((entry) => entry.id === tab)?.label}</div>
        )}
      </header>

      <nav className="tabbar" role="tablist" aria-label="Work surfaces">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? 'tab on' : 'tab'}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {error ? <p className="error">{error}</p> : null}

      {tab === 'services' || tab === 'mail' ? (
        serviceSurface === 'system' ? (
          <p className="hint">
            This build has no WARDEN surface, so the service opened in the system browser. Its sign-in stays there,
            not in WARDEN.
          </p>
        ) : null
      ) : null}

      {tab === 'browser' ? (
        <>
          {current ? (
            <section className="surface">
              <div className="surface-row">
                <span className="dot" aria-hidden="true" />
                <div className="surface-text">
                  <b>{prettyHost(current)}</b>
                  <span>
                    {surface === 'system'
                      ? 'opened in the system browser — this build is missing the WARDEN surface'
                      : 'this session'}
                  </span>
                </div>
                <button onClick={() => void go(current)}>Reopen</button>
              </div>
            </section>
          ) : null}

          {recents.length ? (
            <section className="recents">
              <h2>This session</h2>
              <ul>
                {recents.map((url) => (
                  <li key={url}>
                    <button onClick={() => void go(url)} title={url}>
                      <span className="u">{prettyHost(url)}</span>
                      <span className="p">{url.replace(/^https?:\/\//, '').slice(0, 46)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="posture">
            <h2>Session posture</h2>
            <ul>
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

          <section className="shortcuts">
            <h2>Quick destinations</h2>
            <div className="grid">
              {SHORTCUTS.map((entry) => (
                <button key={entry.url} onClick={() => void go(entry.url)}>
                  {entry.label}
                </button>
              ))}
            </div>
          </section>
        </>
      ) : null}

      {tab === 'scry' ? (
        <ScryPanel
          lastVisited={current}
          resolve={resolveTarget}
          onVisited={(url) => setRecents((list) => [url, ...list.filter((entry) => entry !== url)].slice(0, 12))}
        />
      ) : null}

      {tab === 'services' ? <ServicesPanel onOpen={(url) => void openInService(url)} /> : null}

      {tab === 'mail' ? (
        <MailPanel onOpen={(url) => void openInService(url)} resolve={resolveTarget} />
      ) : null}

      <footer>WARDEN Mobile {__WARDEN_VERSION__} · us.innotel.warden</footer>
    </div>
  )
}
