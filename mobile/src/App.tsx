import { useCallback, useEffect, useState } from 'react'
import { StatusBar, Style } from '@capacitor/status-bar'
import { openPage, WardenBrowser, type BrowserSurface } from './warden-browser'

declare const __WARDEN_VERSION__: string

/** Where a typed string goes. Bare hosts become https, words become a search. */
export function resolveTarget(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  if (/^(https?|warden):\/\//i.test(value)) return value
  const looksLikeHost = /^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)
  if (looksLikeHost) return `https://${value}`
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(value)) return `https://${value}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
}

/**
 * What this build actually does.
 *
 * Every line here is checked against the native surface it describes, because a
 * posture screen that overstates the product is worse than no screen at all: it
 * tells an operator they are covered when they are not. Blocking, the cosmetic
 * pass and the in-memory session are implemented on both platforms
 * (`WardenAdBlock.kt` / `WardenAdBlocker.swift`), and the shell only claims what
 * those two files do.
 */
const POSTURE: [string, string][] = [
  ['A real engine', 'Pages render in the platform WebView with WARDEN’s own address bar, back, forward and reload — not in another app’s browser.'],
  ['Ad and tracker blocking', 'Requests to ad and tracker hosts are refused before they leave the app, on both platforms.'],
  ['The slot goes too', 'A refused ad leaves an empty box; the page script removes the container and closes the gap.'],
  ['No third-party cookies', 'A page keeps its own session cookie so a login still works. Cross-site cookies are off.'],
  ['Session wiped', 'Cookies, web storage and cache are cleared when the browser closes.'],
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

/** The host alone, for a line that has to stay one line. */
export function prettyHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function App(): React.ReactElement {
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [surface, setSurface] = useState<BrowserSurface | null>(null)
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="mark small" aria-hidden="true">
          <svg viewBox="0 0 120 136" fill="none" stroke="currentColor" strokeWidth="4" strokeLinejoin="round">
            <path d="M60 4l52 20v52c0 30-22 48-52 56C30 124 8 106 8 76V24L60 4z" />
          </svg>
          <span className="w">W</span>
        </div>

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
      </header>
      {error ? <p className="error">{error}</p> : null}

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

      <footer>WARDEN Mobile {__WARDEN_VERSION__} · us.innotel.warden</footer>
    </div>
  )
}
