import { useState } from 'react'
import { MAIL_PROVIDERS, SERVICE_SESSION_NOTE } from '../operator/surfaces'
import { ServiceGrid } from './ServiceGrid'

/**
 * Mail, as far as a phone can have the desktop client.
 *
 * The desktop talks IMAP and SMTP from its main process, analyses a message for
 * fraud and renders sanitised HTML. None of that has a mobile path yet, so this
 * opens the provider's own web client in the service session — the same surface
 * as a chat app, with the same surviving sign-in — and says so instead of
 * implying an IMAP client that is not here.
 */
export function MailPanel({
  onOpen,
  resolve
}: {
  onOpen: (url: string) => void
  resolve: (input: string) => string | null
}): React.ReactElement {
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="panel">
      <h2>Mail</h2>
      <p className="lede">
        Your provider's web client, in WARDEN. This is not the desktop program: an in-app IMAP mailbox, with the
        fraud check and the sanitiser, is not on the phone yet.
      </p>
      <p className="hint">{SERVICE_SESSION_NOTE}</p>

      <ServiceGrid entries={MAIL_PROVIDERS} onOpen={onOpen} />

      <form
        className="address compact"
        onSubmit={(event) => {
          event.preventDefault()
          const url = resolve(address.trim())
          if (!url || !/^https?:\/\//i.test(url)) {
            setError('Type the webmail address, or a provider above.')
            return
          }
          setError(null)
          setAddress('')
          onOpen(url)
        }}
      >
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="Another webmail address"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Another webmail address"
        />
        <button type="submit" aria-label="Open">
          ↵
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </div>
  )
}
