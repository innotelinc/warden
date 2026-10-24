import { useEffect, useMemo, useState } from 'react'
import type { ScryReport } from '@shared/types'
import { IconAlert, IconCrosshair, IconFolder, IconReload, IconSpark } from '../icons'
import { formatBytes, formatCount, useWarden } from '../state'

type TargetRef = { source: 'remote' | 'local'; id: string }

export function ScryWorkspace() {
  const { state, notify } = useWarden()
  const [port, setPort] = useState(String(state?.settings.scryPort ?? 9222))
  const [selected, setSelected] = useState<TargetRef | null>(null)
  const [rea, setRea] = useState<{ installed: boolean; version: string | null } | null>(null)
  const [reaOutput, setReaOutput] = useState<string | null>(null)
  const [includeScripts, setIncludeScripts] = useState(false)

  const localTargets = useMemo(
    () =>
      (state?.tabs ?? []).map((tab) => ({
        id: tab.id,
        title: tab.title || tab.url,
        url: tab.url,
        source: 'local' as const
      })),
    [state?.tabs]
  )

  const remoteTargets = (state?.scry.targets ?? []).filter((target) => target.source === 'remote')
  const progress = state?.scry.progress
  const running = state?.scry.running ?? false
  const report: ScryReport | null = state?.scry.report ?? null
  const result = state?.scry.result ?? null

  useEffect(() => {
    void window.warden.scry.reaStatus().then(setRea)
  }, [])

  useEffect(() => {
    if (!selected && localTargets.length) {
      setSelected({ source: 'local', id: localTargets[0]!.id })
    }
  }, [localTargets, selected])

  const scan = (): void => {
    void window.warden.scry
      .listTargets(Number(port) || 9222)
      .then((targets) => {
        const remote = targets.filter((target) => target.source === 'remote').length
        notify(remote ? `${remote} Chrome target(s) on ${port}` : `No Chrome target on ${port}`, remote ? 'ok' : 'err')
      })
      .catch((error: Error) => notify(error.message, 'err'))
  }

  const capture = (): void => {
    if (!selected) return
    setReaOutput(null)
    void window.warden.scry.capture(selected).then(
      (next) => notify(`Captured ${next.title || next.url}`, 'ok'),
      (error: Error) => notify(error.message, 'err')
    )
  }

  const clone = (): void => {
    if (!selected) return
    void window.warden.scry.clone(selected, { includeScripts }).then(
      (next) => notify(`Clone written to ${next.outputDir}`, 'ok'),
      (error: Error) => notify(error.message, 'err')
    )
  }

  const runRea = (): void => {
    if (!selected) return
    setReaOutput('running rea analyze-web-bundle…')
    void window.warden.scry.runRea(selected).then((outcome) => {
      setReaOutput(outcome.output || '(no output)')
      notify(outcome.ok ? 'REA analysis finished' : 'REA reported a problem', outcome.ok ? 'ok' : 'err')
    })
  }

  return (
    <div className="workspace">
      <div className="ws-head">
        <IconCrosshair size={15} />
        <h1>Scry</h1>
        <span className="sub">deconstruct a running site · capture · recon · clone · scaffold</span>
        <span className="spacer" />
        {rea ? (
          <span className={`tag ${rea.installed ? 'violet' : ''}`} title="Optional external analyzer">
            REA {rea.installed ? (rea.version ?? 'ready') : 'not installed'}
          </span>
        ) : null}
      </div>

      <div className="ws-body">
        <aside className="ws-col" style={{ width: 320, borderRight: '1px solid var(--line-soft)' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line-soft)' }}>
            <div className="row">
              <input
                className="input"
                style={{ width: 92 }}
                value={port}
                onChange={(event) => setPort(event.target.value.replace(/\D/g, '').slice(0, 5))}
                title="Chrome remote debugging port"
              />
              <button className="btn sm" onClick={scan}>
                <IconReload size={11} /> scan port
              </button>
            </div>
            <div className="faint tiny" style={{ marginTop: 7, lineHeight: 1.6 }}>
              WARDEN tabs use the built-in debugger — no port, no Chrome. To reach another browser:
              <br />
              <span className="mono selectable">--remote-debugging-port={port || 9222}</span>
            </div>
          </div>

          <div className="panel-title" style={{ padding: '10px 12px 6px' }}>WARDEN tabs</div>
          <div className="scroll-y" style={{ maxHeight: '34%' }}>
            {localTargets.map((target) => (
              <div
                key={target.id}
                className={`scry-target ${selected?.source === 'local' && selected.id === target.id ? 'active' : ''}`}
                onClick={() => setSelected({ source: 'local', id: target.id })}
              >
                <span className="tag mint tiny">tab</span>
                <span className="t">
                  <b>{target.title}</b>
                  <span>{target.url}</span>
                </span>
              </div>
            ))}
            {!localTargets.length ? <div className="faint small" style={{ padding: 12 }}>No tabs open.</div> : null}
          </div>

          <div className="panel-title" style={{ padding: '10px 12px 6px' }}>Remote debug targets (optional)</div>
          <div className="scroll-y" style={{ flex: 1 }}>
            {remoteTargets.map((target) => (
              <div
                key={target.id}
                className={`scry-target ${selected?.source === 'remote' && selected.id === target.id ? 'active' : ''}`}
                onClick={() => setSelected({ source: 'remote', id: target.id })}
              >
                <span className="tag violet tiny">cdn</span>
                <span className="t">
                  <b>{target.title}</b>
                  <span>{target.url}</span>
                </span>
              </div>
            ))}
            {!remoteTargets.length ? (
              <div className="faint small" style={{ padding: 12, lineHeight: 1.7 }}>
                Nothing on this port. WARDEN tabs above need no port; this is only for tearing down another browser.
              </div>
            ) : null}
          </div>
        </aside>

        <div className="ws-col" style={{ flex: 1 }}>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-soft)', gap: 8 }}>
            <button className="btn primary" disabled={!selected || running} onClick={capture}>
              <IconCrosshair size={12} /> capture & recon
            </button>
            <button className="btn" disabled={!selected || running} onClick={clone}>
              <IconSpark size={12} /> clone + scaffold
            </button>
            <button
              className={`btn sm ${includeScripts ? 'danger' : ''}`}
              onClick={() => setIncludeScripts(!includeScripts)}
              title="Scripts are stripped by default; including them produces a runnable but unsafe copy"
            >
              scripts {includeScripts ? 'included' : 'stripped'}
            </button>
            <button
              className="btn sm"
              disabled={!selected || selected.source !== 'remote' || running}
              onClick={runRea}
              title="Escalate to the REA CLI for static bundle analysis"
            >
              rea analyze
            </button>
            <span style={{ flex: 1 }} />
            {running ? (
              <button className="btn sm danger" onClick={() => void window.warden.scry.cancel()}>
                cancel
              </button>
            ) : null}
          </div>

          {progress ? (
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line-soft)' }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="tag violet">{progress.phase}</span>
                <span className="small faint">{progress.message}</span>
                <span style={{ flex: 1 }} />
                <span className="tiny mono faint">
                  {formatCount(progress.requests)} req · {formatBytes(progress.bytes)}
                </span>
              </div>
              <div className="progress-rail">
                <i
                  style={{
                    width:
                      progress.phase === 'done' ? '100%' : progress.phase === 'error' ? '100%' : progress.phase === 'writing' ? '82%' : progress.phase === 'capturing' ? '56%' : '18%'
                  }}
                />
              </div>
              {progress.error ? <div className="red small" style={{ marginTop: 6 }}>{progress.error}</div> : null}
            </div>
          ) : null}

          {result ? (
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line-soft)' }} className="row wrap">
              <span className="tag mint">clone ready</span>
              <span className="mono tiny selectable" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {result.outputDir}
              </span>
              <button className="btn sm" onClick={() => void window.warden.scry.openOutput(result.outputDir)}>
                <IconFolder size={11} /> open folder
              </button>
              <button className="btn sm" onClick={() => void window.warden.scry.openOutput(result.scaffoldPath)}>
                scaffold
              </button>
              <button className="btn sm" onClick={() => void window.warden.scry.openOutput(result.clonePath)}>
                static clone
              </button>
            </div>
          ) : null}

          {reaOutput ? (
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line-soft)' }}>
              <div className="panel-title">REA output</div>
              <pre
                className="mono selectable"
                style={{
                  margin: 0,
                  maxHeight: 160,
                  overflow: 'auto',
                  fontSize: 10.5,
                  lineHeight: 1.5,
                  background: '#080c11',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: 10,
                  color: 'var(--text-dim)'
                }}
              >
                {reaOutput}
              </pre>
            </div>
          ) : null}

          {report ? <ReportView report={report} /> : (
            <div className="empty-state">
              <div>
                <b>Nothing scryed yet</b>
                Pick a target, then capture. Scry reloads the target with the network recorder armed, so every asset and
                request is observed rather than guessed.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ReportView({ report }: { report: ScryReport }) {
  return (
    <div className="report-grid scroll-y">
      <div className="panel panel-pad">
        <div className="panel-title">Target</div>
        <div className="kv">
          <dt>URL</dt>
          <dd>{report.url}</dd>
          <dt>Title</dt>
          <dd>{report.title}</dd>
          <dt>Requests</dt>
          <dd>
            {formatCount(report.requests)} · {formatBytes(report.transferredBytes)}
          </dd>
          <dt>Elapsed</dt>
          <dd>{report.durationMs} ms</dd>
          <dt>Cookies seen</dt>
          <dd>{report.cookies.length}</dd>
        </div>
      </div>

      <div className="panel panel-pad">
        <div className="panel-title">Detected stack</div>
        <div className="row wrap">
          {report.technologies.length ? (
            report.technologies.map((tech) => (
              <span className="tag violet" key={tech.name} title={tech.evidence}>
                {tech.name}
              </span>
            ))
          ) : (
            <span className="faint small">No signature matched.</span>
          )}
        </div>
      </div>

      <div className="panel panel-pad">
        <div className="panel-title">Security headers</div>
        {report.server.missingSecurityHeaders.length ? (
          <div className="row wrap">
            {report.server.missingSecurityHeaders.map((header) => (
              <span className="tag amber" key={header}>
                {header} missing
              </span>
            ))}
          </div>
        ) : (
          <span className="tag mint">all baseline headers present</span>
        )}
        <div className="kv" style={{ marginTop: 10 }}>
          <dt>Server</dt>
          <dd>{report.server.headers.server ?? 'not disclosed'}</dd>
          <dt>Powered by</dt>
          <dd>{report.server.headers['x-powered-by'] ?? 'not disclosed'}</dd>
        </div>
      </div>

      <div className="panel panel-pad">
        <div className="panel-title">Trackers observed</div>
        {report.trackers.length ? (
          <div className="host-list">
            {report.trackers.map((tracker) => (
              <div className="host-row tracker" key={tracker.host}>
                <span className="h">{tracker.host}</span>
                <span className="n">{tracker.requests}</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="mint small">None matched the Bastion tracker set.</span>
        )}
      </div>

      <div className="panel panel-pad">
        <div className="panel-title">Third parties</div>
        <div className="host-list">
          {report.thirdParties.slice(0, 24).map((party) => (
            <div className="host-row" key={party.host}>
              <span className="h">{party.host}</span>
              <span className="tiny faint">{party.kind.toLowerCase()}</span>
              <span className="n">{party.requests}</span>
            </div>
          ))}
          {!report.thirdParties.length ? <span className="faint small">Same-origin only.</span> : null}
        </div>
      </div>

      <div className="panel panel-pad">
        <div className="panel-title">Design tokens</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {report.designTokens.colors.slice(0, 14).map((color) => (
            <code className="swatchline" key={color.value}>
              <i style={{ background: color.value }} />
              {color.value}
            </code>
          ))}
        </div>
        <div className="mono tiny faint" style={{ marginTop: 10, lineHeight: 1.8 }}>
          {report.designTokens.fonts.slice(0, 3).map((font) => font.value).join(' · ') || 'no fonts detected'}
        </div>
      </div>

      <div className="panel panel-pad" style={{ gridColumn: 'span 2' }}>
        <div className="panel-title">Findings</div>
        <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.8 }}>
          {report.notes.length ? report.notes.map((note) => <li key={note}>{note}</li>) : <li>No findings.</li>}
        </ul>
      </div>

      <div className="panel panel-pad" style={{ gridColumn: 'span 2' }}>
        <div className="panel-title">API endpoints seen ({report.endpoints.length})</div>
        <div className="host-list">
          {report.endpoints.slice(0, 30).map((endpoint) => (
            <div className="host-row" key={endpoint}>
              <span className="h">{endpoint}</span>
            </div>
          ))}
          {!report.endpoints.length ? <span className="faint small">No XHR/Fetch traffic captured.</span> : null}
        </div>
      </div>

      {report.mixedContent.length ? (
        <div className="panel panel-pad" style={{ gridColumn: 'span 2' }}>
          <div className="panel-title">
            <IconAlert size={11} /> Mixed content
          </div>
          <div className="host-list">
            {report.mixedContent.map((url) => (
              <div className="host-row tracker" key={url}>
                <span className="h">{url}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
