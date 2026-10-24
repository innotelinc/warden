import { useState } from 'react'
import { SEARCH_ENGINES } from '@shared/defaults'
import type { Settings } from '@shared/types'
import { IconGear, IconShield, IconTrash } from '../icons'
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
