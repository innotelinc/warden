import { useEffect, useState } from 'react'
import { Browser } from '@capacitor/browser'
import { StatusBar, Style } from '@capacitor/status-bar'

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

// Each line here has to survive being checked. There is no DNS profile in the
// app and no filter engine yet, so neither is claimed: the posture screen says
// what shipped, and the roadmap is named in the note below it.
const POSTURE = [
  ['No account', 'Nothing to sign in to, and no profile is stored on this device.'],
  ['System browser', 'Pages open in the platform browser view, which this app cannot read.'],
  ['No telemetry', 'The shell has no analytics, crash or ad SDKs.'],
  ['Sensors', 'Camera and microphone are not requested by this app.']
]

// Only destinations that ship with the product belong here. A team's own
// paid services are not part of what a store reviewer, or anybody else who
// installs this, is being given.
const SHORTCUTS = [
  { label: 'WARDEN', url: 'https://github.com/innotelinc/warden' },
  { label: 'Release notes', url: 'https://github.com/innotelinc/warden/releases' },
  { label: 'Privacy', url: 'https://innotelinc.github.io/warden/privacy.html' }
]

export function App(): React.ReactElement {
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined)
    void StatusBar.setBackgroundColor({ color: '#070a0d' }).catch(() => undefined)
  }, [])

  const go = async (input?: string): Promise<void> => {
    const target = resolveTarget(input ?? address)
    if (!target) {
      setError('Type a host or a search.')
      return
    }
    setError(null)
    setAddress('')
    try {
      await Browser.open({ url: target, presentationStyle: 'fullscreen' })
    } catch (problem) {
      setError((problem as Error).message)
    }
  }

  return (
    <div className="shell">
      <header className="splash">
        <div className="mark" aria-hidden="true">
          <svg viewBox="0 0 120 136" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round">
            <path d="M60 4l52 20v52c0 30-22 48-52 56C30 124 8 106 8 76V24L60 4z" />
          </svg>
          <span className="w">W</span>
        </div>
        <h1>Welcome to WARDEN</h1>
        <p className="lede">Read everything. Give nothing.</p>
      </header>

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
          placeholder="Address or search"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Address or search"
        />
        <button type="submit" aria-label="Open">
          ↵
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}

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

      <p className="note">
        Pages open in the platform's private browser surface, not an in-app frame. An embedded engine with blocking and
        per-tab sessions is Phase 2 — see the mobile plan in the repository.
      </p>

      <footer>
        WARDEN {__WARDEN_VERSION__} · us.innotel.warden
      </footer>
    </div>
  )
}
