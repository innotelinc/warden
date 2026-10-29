import { useCallback, useEffect, useState } from 'react'
import type { ScryReport } from '@shared/types'
import { captureScript } from '../operator/capture'
import { reportFromCapture, summarise } from '../operator/scry'
import { scryPage } from '../warden-browser'

/**
 * Scry: read a page the way the desktop reads it, from a phone.
 *
 * The capture is a real page load in WARDEN's own engine, then a script inside
 * the page, then the shared report builder. Nothing is stored: the report lives in
 * this screen's state and is gone when the app is closed, which is the same
 * posture the browser keeps.
 */
export function ScryPanel({
  lastVisited,
  resolve,
  onVisited
}: {
  lastVisited: string | null
  resolve: (input: string) => string | null
  onVisited: (url: string) => void
}): React.ReactElement {
  const [target, setTarget] = useState(lastVisited ?? '')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ScryReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The address the browser last opened is where an operator most often wants to
  // look, so it is offered rather than retyped.
  useEffect(() => {
    if (!target && lastVisited) setTarget(lastVisited)
  }, [lastVisited, target])

  const capture = useCallback(async (): Promise<void> => {
    const url = resolve(target)
    if (!url) {
      setError('Type a host or a search.')
      return
    }
    if (!/^https?:\/\//i.test(url)) {
      setError('Scry reads web pages, so use a http or https address.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const json = await scryPage(url, captureScript())
      const outcome = reportFromCapture(json)
      if (outcome.error) {
        setError(outcome.error)
        setReport(null)
      } else {
        setReport(outcome.report)
        onVisited(url)
      }
    } catch (problem) {
      setError((problem as Error).message)
      setReport(null)
    } finally {
      setBusy(false)
    }
  }, [onVisited, resolve, target])

  return (
    <div className="panel">
      <h2>Scry</h2>
      <p className="lede">
        Open a page in WARDEN, read what it is built from, and close it. The report is held in this screen and
        nowhere else.
      </p>

      <form
        className="address"
        onSubmit={(event) => {
          event.preventDefault()
          void capture()
        }}
      >
        <input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="Host to read"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Host to read"
        />
        <button type="submit" aria-label="Capture" disabled={busy}>
          {busy ? '…' : '◎'}
        </button>
      </form>

      {busy ? <p className="hint">Loading the page and reading it. Large pages take a moment.</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {report ? <Report report={report} /> : null}

      {!report && !busy ? (
        <p className="note">
          A capture runs inside the page, so a request the blocker refused never reaches it. What is listed is what
          got through — a lower bound on a site's footprint, not a measurement of it.
        </p>
      ) : null}
    </div>
  )
}

function Report({ report }: { report: ScryReport }): React.ReactElement {
  return (
    <section className="report">
      <header className="report-head">
        <b>{report.title || report.url}</b>
        <span>{report.url}</span>
        <em>{summarise(report)}</em>
      </header>

      <div className="report-block">
        <h3>Stack</h3>
        {report.technologies.length ? (
          <ul className="chips">
            {report.technologies.map((tech) => (
              <li key={tech.name} title={tech.evidence}>
                <b>{tech.name}</b>
                <span>{tech.evidence}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No framework or server signature matched.</p>
        )}
      </div>

      <div className="report-block">
        <h3>Trackers contacted</h3>
        {report.trackers.length ? (
          <ul className="rows">
            {report.trackers.map((entry) => (
              <li key={entry.host}>
                <b>{entry.host}</b>
                <span>{entry.requests} request{entry.requests === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">None got through. That is the blocker working, not a clean site.</p>
        )}
      </div>

      <div className="report-block">
        <h3>Third parties</h3>
        {report.thirdParties.length ? (
          <ul className="rows">
            {report.thirdParties.slice(0, 12).map((entry) => (
              <li key={entry.host}>
                <b>{entry.host}</b>
                <span>
                  {entry.kind} · {entry.requests}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Everything came from the page's own host.</p>
        )}
      </div>

      {report.endpoints.length ? (
        <div className="report-block">
          <h3>Endpoints</h3>
          <ul className="rows mono">
            {report.endpoints.slice(0, 8).map((endpoint) => (
              <li key={endpoint}>
                <b>{endpoint.replace(/^https?:\/\//, '').slice(0, 80)}</b>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.forms.length ? (
        <div className="report-block">
          <h3>Forms</h3>
          <ul className="rows">
            {report.forms.map((form) => (
              <li key={`${form.action}-${form.method}`}>
                <b>{form.action.replace(/^https?:\/\//, '') || 'same page'}</b>
                <span>
                  {form.method} · {form.fields} field{form.fields === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="report-block">
        <h3>Notes</h3>
        <ul className="notes">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </section>
  )
}
