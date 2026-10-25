import { useState } from 'react'
import { SEARCH_ENGINES } from '@shared/defaults'
import { LOCK_TIMEOUTS, timeoutLabel } from '@shared/lock-policy'
import { THEMES, themeSwatch } from '@shared/themes'
import type { Settings, UpdateState } from '@shared/types'
import { IconDownload, IconGear, IconLock, IconShield, IconSpark, IconTrash } from '../icons'

function updateStatus(update: UpdateState): string {
  switch (update.phase) {
    case 'dev':
      return 'source build — updater off'
    case 'unsupported':
      return 'portable build — update by download'
    case 'checking':
      return 'checking GitHub…'
    case 'downloading':
      return `downloading ${update.version ?? ''} · ${update.percent}%`
    case 'ready':
      return `${update.version} downloaded — restart to install`
    case 'current':
      return 'up to date'
    case 'error':
      return update.message ?? 'update check failed'
    default:
      return 'not checked yet'
  }
}
import { formatCount, useWarden } from '../state'

function Toggle({
  title,
  detail,
  on,
  onChange,
  danger
}: {
  title: string
  detail: string
  on: boolean
  onChange: (next: boolean) => void
  danger?: boolean
}) {
  return (
    <div className="toggle">
      <div className="text">
        <b>
          {title} {danger ? <span className="tag red">hard</span> : null}
        </b>
        <span>{detail}</span>
      </div>
      <button className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} aria-label={title} />
    </div>
  )
}

export function SettingsWorkspace() {
  const { state, notify } = useWarden()
  const settings = state?.settings
  const [allowInput, setAllowInput] = useState('')
  const [compatInput, setCompatInput] = useState('')
  const [rules, setRules] = useState<string | null>(null)
  const [homepage, setHomepage] = useState<string | null>(null)
  const [shell, setShell] = useState<string | null>(null)
  const [scryDir, setScryDir] = useState<string | null>(null)

  if (!settings) return <div className="workspace" />

  const update = (patch: Partial<Settings>): void => {
    void window.warden.settings.update(patch).catch((error: Error) => notify(error.message, 'err'))
  }

  return (
    <div className="workspace">
      <div className="ws-head">
        <IconGear size={15} />
        <h1>Policy</h1>
        <span className="sub">every switch is enforced in the main process, not by the page</span>
        <span className="spacer" />
        <span className="tag mint">{formatCount(state.stats.rulesLoaded)} rules armed</span>
      </div>

      <div className="scroll-y" style={{ padding: 18 }}>
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', alignItems: 'start' }}>
          <section className="panel panel-pad" style={{ gridColumn: '1 / -1' }}>
            <div className="panel-title">
              <IconSpark size={11} /> Theme
            </div>
            <div className="theme-grid">
              {THEMES.map((theme) => {
                const active = settings.theme === theme.id
                return (
                  <button
                    key={theme.id}
                    className={`theme-card ${active ? 'on' : ''}`}
                    onClick={() => update({ theme: theme.id })}
                    title={theme.blurb}
                  >
                    <span className="swatches">
                      {themeSwatch(theme).map((color, index) => (
                        <i key={index} style={{ background: color }} />
                      ))}
                    </span>
                    <b>{theme.name}</b>
                    <span>{theme.blurb}</span>
                    {active ? <em>active</em> : null}
                  </button>
                )
              })}
            </div>
            <div className="faint tiny" style={{ marginTop: 10 }}>
              Palettes are applied live to the chrome only — page content is never restyled, so nothing a site renders can
              be mistaken for WARDEN's own interface.
            </div>
          </section>

          <section className="panel panel-pad">
            <div className="panel-title">
              <IconShield size={11} /> Cookies & tracking
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Cookie policy</label>
              <select
                className="select"
                value={settings.cookieMode}
                onChange={(event) => update({ cookieMode: event.target.value as Settings['cookieMode'] })}
              >
                <option value="block">Block everything unless the site is allowed</option>
                <option value="first-party">Allow first-party cookies only (never third-party)</option>
              </select>
            </div>
            <div className="faint tiny" style={{ marginBottom: 8, lineHeight: 1.7 }}>
              WARDEN never shows a cookie prompt. Requests are stripped of Cookie headers, responses lose Set-Cookie,
              and the cookie store rejects writes the policy does not allow. Nothing persists after exit.
            </div>
            <Toggle
              title="Block ads"
              detail="Seed ad network hosts and ad-path patterns"
              on={settings.blockAds}
              onChange={(next) => update({ blockAds: next })}
            />
            <Toggle
              title="Block trackers"
              detail="Analytics, session replay, consent and fingerprint vendors"
              on={settings.blockTrackers}
              onChange={(next) => update({ blockTrackers: next })}
            />
            <Toggle
              title="HTTPS only"
              detail="Upgrade top-level http:// navigation before any request leaves"
              on={settings.httpsOnly}
              onChange={(next) => update({ httpsOnly: next })}
            />
            <Toggle
              title="Strip Referer"
              detail="Send only the origin, or nothing at all for file/internal pages"
              on={settings.stripReferrer}
              onChange={(next) => update({ stripReferrer: next })}
            />
            <Toggle
              title="Global Privacy Control"
              detail="Send DNT: 1 and Sec-GPC: 1 on every request"
              on={settings.globalPrivacyControl}
              onChange={(next) => update({ globalPrivacyControl: next })}
            />
            <Toggle
              title="Fingerprint hardening"
              detail="Canvas, WebGL, audio, navigator and screen surface noise (new tabs)"
              on={settings.fingerprintHardening}
              onChange={(next) => update({ fingerprintHardening: next })}
            />
            <Toggle
              title="WebRTC leak protection"
              detail="Disables non-proxied UDP; takes effect on restart"
              on={settings.webrtcLeakProtection}
              onChange={(next) => update({ webrtcLeakProtection: next })}
            />
            <Toggle
              title="Block WebSockets"
              detail="Cuts live telemetry channels at the cost of realtime features"
              on={settings.blockWebSockets}
              onChange={(next) => update({ blockWebSockets: next })}
            />
            <Toggle
              title="JavaScript"
              detail="Applies to newly opened tabs"
              on={settings.javascriptEnabled}
              onChange={(next) => update({ javascriptEnabled: next })}
            />
            <Toggle
              title="Load images"
              detail="Turn off to read text-only with zero image beacons"
              on={settings.imagesEnabled}
              onChange={(next) => update({ imagesEnabled: next })}
            />
            <Toggle
              title="Auto-dock playing video"
              detail="Splay branches a playing video into the right dock automatically"
              on={settings.autoDockMedia}
              onChange={(next) => update({ autoDockMedia: next })}
            />
          </section>

          <section className="panel panel-pad">
            <div className="panel-title">Cookie allowlist</div>
            <div className="row" style={{ marginBottom: 10 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="app.internal.example"
                value={allowInput}
                onChange={(event) => setAllowInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  const host = allowInput.trim().toLowerCase()
                  if (!host) return
                  void window.warden.privacy.allow(host, true)
                  setAllowInput('')
                }}
              />
              <button
                className="btn sm primary"
                onClick={() => {
                  const host = allowInput.trim().toLowerCase()
                  if (!host) return
                  void window.warden.privacy.allow(host, true)
                  setAllowInput('')
                }}
              >
                allow
              </button>
            </div>
            <div className="row wrap" style={{ minHeight: 26 }}>
              {settings.allowlist.length ? (
                settings.allowlist.map((host) => (
                  <button key={host} className="tag mint" onClick={() => void window.warden.privacy.allow(host, false)} title="Revoke">
                    {host} ✕
                  </button>
                ))
              ) : (
                <span className="faint small">No site may store cookies. That is the default.</span>
              )}
            </div>

            <div className="panel-title" style={{ marginTop: 18 }}>Compatibility mode</div>
            <div className="row" style={{ marginBottom: 10 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="challenge.example.com"
                value={compatInput}
                onChange={(event) => setCompatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  const host = compatInput.trim().toLowerCase()
                  if (!host) return
                  void window.warden.privacy.compatibility(host, true)
                  setCompatInput('')
                }}
              />
              <button
                className="btn sm"
                onClick={() => {
                  const host = compatInput.trim().toLowerCase()
                  if (!host) return
                  void window.warden.privacy.compatibility(host, true)
                  setCompatInput('')
                }}
              >
                exempt
              </button>
            </div>
            <div className="row wrap" style={{ minHeight: 26 }}>
              {settings.compatibility.length ? (
                settings.compatibility.map((host) => (
                  <button
                    key={host}
                    className="tag amber"
                    onClick={() => void window.warden.privacy.compatibility(host, false)}
                    title="Return this site to the full privacy stack"
                  >
                    {host} ✕
                  </button>
                ))
              ) : (
                <span className="faint small">
                  No exemptions. Every site gets filtering, header rewriting and cookie blocking.
                </span>
              )}
            </div>
            <p className="faint small" style={{ marginTop: 8 }}>
              A compatible site is loaded as if WARDEN were a plain browser: no ad or
              tracker filtering, no Referer trimming, no cookie stripping, no injected
              fingerprint shims, and its cookies are kept rather than purged. Use it for
              challenge pages, banking portals and SSO — never as a default.
            </p>

            <div className="panel-title" style={{ marginTop: 18 }}>Search & start</div>
            <div className="grid-2">
              <div className="field">
                <label>Search engine</label>
                <select
                  className="select"
                  value={settings.searchEngine}
                  onChange={(event) => update({ searchEngine: event.target.value })}
                >
                  {SEARCH_ENGINES.map((engine) => (
                    <option key={engine.id} value={engine.id}>
                      {engine.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Homepage</label>
                <input
                  className="input"
                  value={homepage ?? settings.homepage}
                  onChange={(event) => setHomepage(event.target.value)}
                  onBlur={() => {
                    if (homepage !== null) update({ homepage })
                  }}
                />
              </div>
            </div>

            <div className="panel-title" style={{ marginTop: 18 }}>Filters</div>
            <textarea
              className="textarea"
              rows={6}
              spellCheck={false}
              placeholder="Adblock syntax, one rule per line"
              value={rules ?? settings.customRules}
              onChange={(event) => setRules(event.target.value)}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn sm primary"
                onClick={() => {
                  update({ customRules: rules ?? settings.customRules })
                  notify('Custom rules applied', 'ok')
                }}
              >
                apply rules
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  void window.warden.privacy.syncLists().then(
                    (outcome) => {
                      notify(`${outcome.rules} remote rules loaded`, 'ok')
                      setRules(null)
                    },
                    (error: Error) => notify(error.message, 'err')
                  )
                }}
              >
                sync EasyList + EasyPrivacy
              </button>
            </div>
            <div className="host-list" style={{ marginTop: 10 }}>
              {state.stats.filterLists.map((list) => (
                <div className="host-row" key={list.name}>
                  <span className="h">{list.name}</span>
                  <span className="n">{list.rules}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel panel-pad">
            <div className="panel-title">Trench</div>
            <div className="grid-2">
              <div className="field">
                <label>Shell override</label>
                <input
                  className="input"
                  placeholder="auto (pwsh / powershell / bash)"
                  value={shell ?? settings.terminalShell}
                  onChange={(event) => setShell(event.target.value)}
                  onBlur={() => {
                    if (shell !== null) update({ terminalShell: shell })
                  }}
                />
              </div>
              <div className="field">
                <label>Font size · {settings.terminalFontSize}px</label>
                <input
                  type="range"
                  min={10}
                  max={20}
                  value={settings.terminalFontSize}
                  onChange={(event) => update({ terminalFontSize: Number(event.target.value) })}
                />
              </div>
            </div>
            <div className="faint tiny" style={{ marginTop: 10, lineHeight: 1.7 }}>
              Trench prefers a real PTY (ConPTY on Windows). If the native module cannot load for this Electron build it
              falls back to a line-buffered shell and labels itself <span className="mono">pipe</span>.
            </div>

            <div className="panel-title" style={{ marginTop: 18 }}>Scry</div>
            <div className="grid-2">
              <div className="field">
                <label>Chrome debug port</label>
                <input
                  className="input"
                  value={String(settings.scryPort)}
                  onChange={(event) => update({ scryPort: Number(event.target.value.replace(/\D/g, '')) || 9222 })}
                />
              </div>
              <div className="field">
                <label>Debug mode (self debug port)</label>
                <input
                  className="input"
                  value={String(settings.debugPort)}
                  onChange={(event) => {
                    const next = Number(event.target.value.replace(/\D/g, '')) || 0
                    update({ debugPort: next === 0 || next >= 1024 ? next : 0 })
                  }}
                />
              </div>
              <div className="field">
                <label>Output directory</label>
                <input
                  className="input"
                  placeholder="Documents/WARDEN-Scry"
                  value={scryDir ?? settings.scryOutputDir ?? ''}
                  onChange={(event) => setScryDir(event.target.value)}
                  onBlur={() => {
                    if (scryDir !== null) update({ scryOutputDir: scryDir || null })
                  }}
                />
              </div>
            </div>
            <div className="faint tiny" style={{ marginTop: 8, lineHeight: 1.7 }}>
              Debug mode exposes WARDEN's own CDP endpoint on loopback so REA, DevTools or curl /json can inspect the
              tabs WARDEN is already running. 0 keeps it off; changing it takes effect after a restart. Scry does not
              need it for WARDEN tabs.
            </div>
          </section>

          <section className="panel panel-pad" id="session-lock">
            <div className="panel-title">
              <IconLock size={11} /> Session lock
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Lock after inactivity</label>
              <select
                className="select"
                value={String(settings.lockTimeoutMinutes)}
                onChange={(event) => update({ lockTimeoutMinutes: Number(event.target.value) })}
              >
                {LOCK_TIMEOUTS.map((minutes) => (
                  <option key={minutes} value={String(minutes)}>
                    {timeoutLabel(minutes)}
                  </option>
                ))}
              </select>
            </div>
            <div className="row wrap">
              <button className="btn sm" onClick={() => void window.warden.lock.lock()}>
                <IconLock size={11} /> lock now
              </button>
              <span className="faint tiny" style={{ alignSelf: 'center' }}>
                {state.lock.locked
                  ? 'locked'
                  : state.lock.attempts > 0
                    ? `${state.lock.attempts} failed unlock attempt(s)`
                    : `${Math.round(state.lock.idleSeconds / 60)} min idle`}
              </span>
            </div>
            <div className="faint tiny" style={{ marginTop: 10, lineHeight: 1.7 }}>
              Ctrl + \ covers the window with a blurred capture of the page and disables the app underneath. Only this
              Windows account's password clears it; the lock also comes down on its own when the machine has been idle
              for the selected time, and when the Windows session locks. Use your Windows sign-in password, not a
              WARDEN passphrase — the check runs through LogonUser, so Microsoft accounts need the account email.
            </div>

            <div className="panel-title" style={{ marginTop: 18 }}>
              <IconDownload size={11} /> Updates
            </div>
            <div className="kv" style={{ marginBottom: 10 }}>
              <dt>Version</dt>
              <dd className="mono">
                {state.update.current}
                {state.update.version && state.update.phase === 'ready' ? ` → ${state.update.version}` : ''}
              </dd>
              <dt>Channel</dt>
              <dd className="mono">github · innotelinc/warden</dd>
              <dt>Status</dt>
              <dd>{updateStatus(state.update)}</dd>
            </div>
            <Toggle
              title="Install updates automatically"
              detail="Checks GitHub every four hours, downloads in the background, installs on quit"
              on={settings.autoUpdate}
              onChange={(next) => update({ autoUpdate: next })}
            />
            <div className="row wrap" style={{ marginTop: 10 }}>
              <button
                className="btn sm"
                disabled={state.update.phase === 'checking' || state.update.phase === 'downloading'}
                onClick={() => {
                  void window.warden.update
                    .check()
                    .then((next) => {
                      if (next.phase === 'error') notify(next.message ?? 'Update check failed', 'err')
                      else if (next.phase === 'current') notify(`WARDEN ${next.current} is current`, 'ok')
                    })
                    .catch((error: Error) => notify(error.message, 'err'))
                }}
              >
                check now
              </button>
              {state.update.phase === 'ready' ? (
                <button className="btn sm primary" onClick={() => void window.warden.update.install()}>
                  restart and install {state.update.version}
                </button>
              ) : null}
            </div>
            <div className="faint tiny" style={{ marginTop: 10, lineHeight: 1.7 }}>
              {state.update.phase === 'dev'
                ? 'Running from source: the updater is inactive outside a packaged build.'
                : state.update.phase === 'unsupported'
                  ? 'Portable builds have no installer to replace. Download the next WARDEN-Portable exe from the release page instead.'
                  : 'Builds are unsigned, so Windows SmartScreen may ask once per release. Updates only ever come from the public release feed, over HTTPS.'}
            </div>
          </section>

          <section className="panel panel-pad">
            <div className="panel-title">Data</div>
            <div className="kv" style={{ marginBottom: 12 }}>
              <dt>Session started</dt>
              <dd>{new Date(state.stats.sessionStartedAt).toLocaleTimeString()}</dd>
              <dt>Requests seen</dt>
              <dd>{formatCount(state.stats.requestsSeen)}</dd>
              <dt>Blocked</dt>
              <dd>{formatCount(state.stats.blockedTotal)}</dd>
              <dt>Cookies refused</dt>
              <dd>{formatCount(state.stats.cookiesStripped)}</dd>
              <dt>History rows</dt>
              <dd>{state.history.length}</dd>
            </div>
            <div className="row wrap">
              <button
                className="btn sm"
                onClick={() => {
                  void window.warden.privacy.clearCookies().then((count) => notify(`${count} cookies purged`, 'ok'))
                }}
              >
                <IconTrash size={11} /> purge cookies
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  void window.warden.history.clear().then(() => notify('History cleared', 'ok'))
                }}
              >
                clear history
              </button>
              <button
                className="btn sm danger"
                onClick={() => {
                  void window.warden.settings.reset().then(() => notify('Policy reset to defaults', 'ok'))
                  setRules(null)
                  setHomepage(null)
                  setShell(null)
                  setScryDir(null)
                }}
              >
                reset policy
              </button>
            </div>
            <div className="faint tiny" style={{ marginTop: 12, lineHeight: 1.7 }}>
              WARDEN keeps no session file, no cache directory entries for browsed pages and no cookie database on disk.
              Settings, bookmarks and history are the only local state, and history can be wiped here.
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
