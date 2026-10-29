import { useCallback, useState } from 'react'
import { clearServiceData } from '../warden-browser'
import { SERVICE_SESSION_NOTE, SERVICES } from '../operator/surfaces'
import { ServiceGrid } from './ServiceGrid'

/**
 * Chat, in the session that survives.
 *
 * The desktop opens each service in its own isolated view with a session of its
 * own. A phone cannot have eight isolated stores, so both platforms give services
 * one store that is separate from the browser: iOS uses the default data store
 * for it, Android runs it in a second process with its own WebView directory. The
 * private browser still wipes everything it touched when it closes.
 */
export function ServicesPanel({ onOpen }: { onOpen: (url: string) => void }): React.ReactElement {
  const [status, setStatus] = useState<string | null>(null)

  const clear = useCallback(async (): Promise<void> => {
    const ok = await clearServiceData()
    setStatus(
      ok
        ? 'Sign-ins cleared on this device. The chat apps will ask again.'
        : 'This build cannot clear service data; sign out in each service.'
    )
  }, [])

  return (
    <div className="panel">
      <h2>Services</h2>
      <p className="lede">{SERVICE_SESSION_NOTE}</p>
      <ServiceGrid entries={SERVICES} onOpen={onOpen} />
      <button className="secondary" onClick={() => void clear()}>
        Sign out of every service
      </button>
      {status ? <p className="hint">{status}</p> : null}
    </div>
  )
}
