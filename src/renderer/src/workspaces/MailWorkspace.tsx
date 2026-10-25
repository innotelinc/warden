import { useEffect, useRef, useState } from 'react'
import { MAIL_PROVIDERS, guessEndpoints, providerById, providerForEmail } from '@shared/mail-setup'
import {
  addressLine,
  forwardSeed,
  replySeed,
  UNIFIED_MAILBOX_ID,
  type ComposeSeed
} from '@shared/mail-view'
import type { MailAccountPublic } from '@shared/types'
import { IconAlert, IconMail, IconPlus, IconReload, IconSend, IconStar, IconTrash } from '../icons'
import { timeAgo, useWarden } from '../state'

/** Name and address together: the address is the part worth checking. */
function AddressList({ list }: { list: { name: string; address: string }[] }) {
  return <>{addressLine(list)}</>
}

/**
 * Genie's verdict on the open message, next to the headers it was drawn from.
 *
 * A verdict is a tag with its reasons in the tooltip; the button is always
 * there, so a message Genie skipped can still be checked on demand.
 */
function FraudRow({
  fraud,
  busy,
  error
}: {
  fraud: { verdict: 'clear' | 'suspicious' | 'dangerous'; score: number; summary: string; reasons: string[] } | null
  busy: boolean
  error: string | null
}) {
  const label = fraud
    ? fraud.verdict === 'clear'
      ? `Genie: clear · ${fraud.score}`
      : fraud.verdict === 'suspicious'
        ? `Genie: suspicious · ${fraud.score}`
        : `Genie: likely fraud · ${fraud.score}`
    : ''
  return (
    <>
      {busy ? <span className="tag amber">Genie is reading this message…</span> : null}
      {!busy && fraud ? (
        <span
          className={`tag ${fraud.verdict === 'clear' ? 'mint' : fraud.verdict === 'suspicious' ? 'amber' : 'red'}`}
          title={[fraud.summary, ...fraud.reasons].filter(Boolean).join('\n')}
        >
          {label}
        </span>
      ) : null}
      {!busy && error ? <span className="tag red" title={error}>Genie: {error}</span> : null}
      {!busy ? (
        <button className="chip" onClick={() => void window.warden.mail.checkFraud()} title="Ask Genie to read this message for fraud">
          {fraud || error ? 'Re-check with Genie' : 'Check with Genie'}
        </button>
      ) : null}
    </>
  )
}

export function MailWorkspace() {
  const { state, notify } = useWarden()
  const [composeOpen, setComposeOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const autoLoaded = useRef<string | null>(null)

  const mail = state?.mail
  const active = mail?.accounts.find((account) => account.id === mail.activeAccountId) ?? null
  const selected = mail?.selected ?? null
  /** The mailbox the open message actually belongs to. */
  const selectedAccount = selected
    ? (mail?.accounts.find((account) => account.id === selected.accountId) ?? null)
    : null
  /** Compose from the mailbox being read; otherwise the selected one. */
  const composeAccount = selectedAccount ?? active ?? mail?.accounts[0] ?? null
  const [composeSeed, setComposeSeed] = useState<ComposeSeed | null>(null)

  useEffect(() => {
    if (!mail?.activeAccountId) return
    if (autoLoaded.current === mail.activeAccountId) return
    autoLoaded.current = mail.activeAccountId
    void window.warden.mail.refresh().catch((error: Error) => notify(error.message, 'err'))
  }, [mail?.activeAccountId, notify])

  // Every hook has run; from here the pane needs the state to draw anything.
  if (!mail) return <div className="workspace" />

  const selectFolder = (folder: string): void => {
    void window.warden.mail.selectFolder(folder).catch((error: Error) => notify(error.message, 'err'))
  }

  const mailAction = (run: Promise<unknown>): void => {
    void run.catch((error: Error) => notify(error.message, 'err'))
  }

  const compose = (seed: ComposeSeed | null): void => {
    setComposeSeed(seed)
    setComposeOpen(true)
  }

  return (
    <div className="workspace">
      <div className="ws-head">
        <IconMail size={15} />
        <h1>Relay</h1>
        <span className="sub">IMAP / SMTP · credentials in the OS keychain · remote images withheld</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setAddOpen(true)}>
          <IconPlus size={11} /> account
        </button>
        <button
          className="btn sm"
          onClick={() => {
            void window.warden.mail.refresh().catch((error: Error) => notify(error.message, 'err'))
          }}
        >
          <IconReload size={11} /> sync
        </button>
        <button className="btn sm primary" disabled={!composeAccount} onClick={() => compose(null)}>
          <IconSend size={11} /> compose
        </button>
      </div>

      {mail?.error ? (
        <div className="row" style={{ padding: '8px 18px', borderBottom: '1px solid var(--line-soft)', color: 'var(--amber)' }}>
          <IconAlert size={13} />
          <span className="small selectable">{mail.error}</span>
        </div>
      ) : null}

      <div className="ws-body">
        <aside className="ws-col" style={{ width: 252, borderRight: '1px solid var(--line-soft)', padding: '10px 8px' }}>
          <div className="panel-title" style={{ padding: '0 6px' }}>Mailboxes</div>
          {mail?.accounts.length > 1 ? (
            <button
              className={`mail-account ${mail.unified ? 'active' : ''}`}
              onClick={() => {
                void window.warden.mail.selectAccount(UNIFIED_MAILBOX_ID).catch((error: Error) => notify(error.message, 'err'))
              }}
              title="Every account's copy of this folder in one list"
            >
              <span className="swatch unified" />
              <span className="who">
                <b>All mailboxes</b>
                <span>{mail.accounts.length} accounts · {mail.activeFolder}</span>
              </span>
            </button>
          ) : null}
          {mail?.accounts.length ? (
            mail.accounts.map((account) => (
              <button
                key={account.id}
                className={`mail-account ${
                  // In a unified list the highlighted mailbox is the one the open
                  // message belongs to, so nothing pretends to be the source.
                  account.id === (mail.unified ? selected?.accountId : mail.activeAccountId) ? 'active' : ''
                }`}
                onClick={() => {
                  void window.warden.mail.selectAccount(account.id).catch((error: Error) => notify(error.message, 'err'))
                }}
              >
                <span className="swatch" style={{ background: account.color }} />
                <span className="who">
                  <b>{account.label}</b>
                  <span>{account.email}</span>
                </span>
                <span
                  className="icon-btn tiny"
                  role="button"
                  title="Remove account"
                  onClick={(event) => {
                    event.stopPropagation()
                    void window.warden.mail.removeAccount(account.id)
                  }}
                >
                  <IconTrash size={11} />
                </span>
              </button>
            ))
          ) : (
            <div className="faint small" style={{ padding: '4px 6px 12px' }}>
              No account yet. Add one to bring mail into WARDEN.
            </div>
          )}

          <div className="panel-title" style={{ padding: '14px 6px 6px' }}>Folders</div>
          <div className="scroll-y" style={{ flex: 1 }}>
            {mail?.folders.map((folder) => (
              <button
                key={folder.path}
                className={`folder ${folder.path === mail.activeFolder ? 'active' : ''}`}
                onClick={() => selectFolder(folder.path)}
                title={folder.path}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder.name}</span>
                {folder.unread ? <span className="un">{folder.unread}</span> : null}
                <span className="n">{folder.total}</span>
              </button>
            ))}
            {!mail?.folders.length ? <div className="faint small" style={{ padding: '4px 6px' }}>No folders loaded.</div> : null}
          </div>
        </aside>

        <div className="ws-col" style={{ width: 348, borderRight: '1px solid var(--line-soft)' }}>
          <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line-soft)' }}>
            <span className="panel-title" style={{ margin: 0 }}>{mail?.activeFolder ?? 'INBOX'}</span>
            <span style={{ flex: 1 }} />
            <span className="tag faint">{mail?.messages.length ?? 0}</span>
          </div>
          <div className="mail-list">
            {mail?.messages.map((message) => (
              <div
                key={message.uid}
                className={`msg-row ${message.seen ? '' : 'unread'} ${mail.selected?.uid === message.uid ? 'active' : ''}`}
                onClick={() => {
                  mailAction(window.warden.mail.openMessage(message.uid, message.accountId))
                }}
              >
                <div className="line1">
                  {mail.unified ? (
                    <span
                      className="msg-account"
                      title={mail.accounts.find((account) => account.id === message.accountId)?.email ?? ''}
                    >
                      <i
                        style={{
                          background: mail.accounts.find((account) => account.id === message.accountId)?.color ?? 'var(--mint)'
                        }}
                      />
                      {mail.accounts.find((account) => account.id === message.accountId)?.label ?? 'mailbox'}
                    </span>
                  ) : null}
                  <span className="from">
                    <AddressList list={message.from} />
                  </span>
                  <span className="when">{timeAgo(message.date)}</span>
                </div>
                <div className="subject">{message.subject}</div>
                {message.hasAttachments ? <span className="tag tiny">attachment</span> : null}
              </div>
            ))}
            {mail && !mail.messages.length ? (
              <div className="empty-state" style={{ padding: 30 }}>
                <div>
                  <b>Folder is empty</b>
                  {mail.accounts.length ? 'Nothing here yet.' : 'Add an account to begin.'}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="mail-reader">
          {selected ? (
            <>
              <div className="reader-head">
                <div className="reader-title">
                  <h2>{selected.subject}</h2>
                  {selectedAccount ? (
                    <span className="mail-owner" title={`${selectedAccount.label} · ${selectedAccount.email}`}>
                      <i style={{ background: selectedAccount.color }} />
                      {selectedAccount.label}
                    </span>
                  ) : null}
                </div>
                <dl className="meta">
                  <dt>from</dt>
                  <dd>{addressLine(selected.from) || '—'}</dd>
                  <dt>to</dt>
                  <dd>{addressLine(selected.to) || '—'}</dd>
                  {selected.cc.length ? (
                    <>
                      <dt>cc</dt>
                      <dd>{addressLine(selected.cc)}</dd>
                    </>
                  ) : null}
                  <dt>date</dt>
                  <dd>{new Date(selected.date).toLocaleString()}</dd>
                </dl>
                <div className="row wrap mail-actions">
                  <button className="btn sm" onClick={() => compose(replySeed(selected))} title="Reply to the sender">
                    reply
                  </button>
                  <button className="btn sm" onClick={() => compose(forwardSeed(selected))} title="Forward this message">
                    forward
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => mailAction(window.warden.mail.setFlag(selected.uid, 'seen', !selected.seen, selected.accountId))}
                    title={selected.seen ? 'Mark this message unread' : 'Mark this message read'}
                  >
                    {selected.seen ? 'mark unread' : 'mark read'}
                  </button>
                  <button
                    className={`btn sm ${selected.flagged ? 'on' : ''}`}
                    onClick={() =>
                      mailAction(window.warden.mail.setFlag(selected.uid, 'flagged', !selected.flagged, selected.accountId))
                    }
                    title={selected.flagged ? 'Remove the star' : 'Star this message'}
                  >
                    <IconStar size={11} filled={selected.flagged} /> {selected.flagged ? 'unstar' : 'star'}
                  </button>
                  <button
                    className="btn sm danger"
                    onClick={() => mailAction(window.warden.mail.deleteMessage(selected.uid, selected.accountId))}
                    title="Move this message to Trash"
                  >
                    <IconTrash size={11} /> delete
                  </button>
                </div>
                <div className="row wrap" style={{ marginTop: 8 }}>
                  {selected.remoteContentCount > 0 ? (
                    <span className="tag amber">{selected.remoteContentCount} remote references withheld</span>
                  ) : null}
                  {selected.attachments.map((attachment) => (
                    <span key={`${attachment.filename}-${attachment.size}`} className="tag faint" title={attachment.contentType}>
                      {attachment.filename} · {Math.max(1, Math.round(attachment.size / 1024))} KB
                    </span>
                  ))}
                  <FraudRow
                    fraud={mail.fraud && mail.fraud.uid === selected.uid && mail.fraud.accountId === selected.accountId ? mail.fraud : null}
                    busy={mail.fraudBusy}
                    error={mail.fraudError}
                  />
                </div>
              </div>
              <div className="reader-body">
                <iframe
                  title="message"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  srcDoc={selected.html ?? ''}
                />
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div>
                <b>No message selected</b>
                Pick a message to read it with remote content blocked.
              </div>
            </div>
          )}
        </div>
      </div>

      {composeOpen && composeAccount ? (
        <ComposeDialog
          key={composeSeed ? composeSeed.subject : 'blank'}
          account={composeAccount}
          seed={composeSeed}
          onClose={() => {
            setComposeOpen(false)
            setComposeSeed(null)
          }}
        />
      ) : null}
      {addOpen ? <AddAccountDialog onClose={() => setAddOpen(false)} /> : null}
    </div>
  )
}

function ComposeDialog({
  account,
  seed,
  onClose
}: {
  account: MailAccountPublic
  seed: ComposeSeed | null
  onClose: () => void
}) {
  const { notify } = useWarden()
  const [to, setTo] = useState(seed?.to ?? '')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState(seed?.subject ?? '')
  const [body, setBody] = useState(seed?.text ?? '')
  const [sending, setSending] = useState(false)

  const send = async (): Promise<void> => {
    if (!to.trim()) {
      notify('Add a recipient', 'err')
      return
    }
    setSending(true)
    try {
      await window.warden.mail.send({ accountId: account.id, to, cc, subject, text: body })
      notify('Message handed to SMTP', 'ok')
      onClose()
    } catch (error) {
      notify((error as Error).message, 'err')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="overlay" style={{ paddingTop: '8vh' }} onClick={onClose}>
      <div className="panel" style={{ width: 680 }} onClick={(event) => event.stopPropagation()}>
        <div className="panel-pad" style={{ display: 'grid', gap: 10 }}>
          <div className="row">
            <span className="panel-title" style={{ margin: 0 }}>Compose</span>
            <span className="tag mint">{account.email}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={onClose}>close</button>
          </div>
          <div className="field">
            <label>To</label>
            <input className="input" value={to} onChange={(event) => setTo(event.target.value)} placeholder="operator@example.net" />
          </div>
          <div className="field">
            <label>Cc</label>
            <input className="input" value={cc} onChange={(event) => setCc(event.target.value)} />
          </div>
          <div className="field">
            <label>Subject</label>
            <input className="input" value={subject} onChange={(event) => setSubject(event.target.value)} />
          </div>
          <div className="field">
            <label>Body</label>
            <textarea className="textarea" rows={12} value={body} onChange={(event) => setBody(event.target.value)} />
          </div>
          <div className="row">
            <span className="faint tiny">Sent directly over SMTP. WARDEN adds no tracking and no HTML.</span>
            <span style={{ flex: 1 }} />
            <button className="btn primary" disabled={sending} onClick={() => void send()}>
              <IconSend size={12} /> {sending ? 'sending…' : 'send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const { notify } = useWarden()
  const [label, setLabel] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [imapHost, setImapHost] = useState('')
  const [imapPort, setImapPort] = useState('993')
  const [imapSecure, setImapSecure] = useState(true)
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('465')
  const [smtpSecure, setSmtpSecure] = useState(true)
  const [busy, setBusy] = useState(false)
  const [providerId, setProviderId] = useState('custom')

  const provider = providerById(providerId)

  const applyProvider = (id: string): void => {
    const preset = providerById(id)
    if (!preset) return
    setProviderId(preset.id)
    if (preset.id === 'custom') return
    setImapHost(preset.imap.host)
    setImapPort(String(preset.imap.port))
    setImapSecure(preset.imap.secure)
    setSmtpHost(preset.smtp.host)
    setSmtpPort(String(preset.smtp.port))
    setSmtpSecure(preset.smtp.secure)
  }

  /**
   * Fill the servers from the provider the address belongs to. A provider that
   * needs an app password says so before the connection is attempted, and one
   * that has retired password sign-in says that instead of failing later.
   */
  const guess = (value: string): void => {
    setEmail(value)
    const domain = value.split('@')[1]
    if (!domain) return
    const preset = providerForEmail(value)
    if (preset) {
      applyProvider(preset.id)
      return
    }
    // Unknown domain: keep whatever hosts the operator typed, otherwise start
    // from the usual imap./smtp. names.
    setProviderId('custom')
    if (!imapHost && !smtpHost) {
      const guessed = guessEndpoints(domain)
      setImapHost(guessed.imap.host)
      setSmtpHost(guessed.smtp.host)
    }
  }

  const passwordAccepted = provider?.passwordWorks !== false

  const submit = async (): Promise<void> => {
    if (!passwordAccepted) {
      notify('This provider needs OAuth; a password cannot be verified here.', 'err')
      return
    }
    setBusy(true)
    try {
      await window.warden.mail.addAccount({
        label: label || email,
        email,
        password,
        imap: { host: imapHost, port: Number(imapPort), secure: imapSecure, user: email },
        smtp: { host: smtpHost, port: Number(smtpPort), secure: smtpSecure, user: email }
      })
      notify('Account verified and added', 'ok')
      onClose()
    } catch (error) {
      notify((error as Error).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" style={{ width: 560 }} onClick={(event) => event.stopPropagation()}>
        <div className="panel-pad" style={{ display: 'grid', gap: 10 }}>
          <span className="panel-title" style={{ margin: 0 }}>Add mail account</span>
          <div className="grid-2">
            <div className="field">
              <label>Label</label>
              <input className="input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Ops" />
            </div>
            <div className="field">
              <label>Email</label>
              <input className="input" value={email} onChange={(event) => guess(event.target.value)} />
            </div>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {MAIL_PROVIDERS.map((preset) => (
              <button
                key={preset.id}
                className={`chip ${providerId === preset.id ? 'on' : ''}`}
                onClick={() => applyProvider(preset.id)}
                title={preset.note}
              >
                {preset.name}
              </button>
            ))}
          </div>
          {provider ? (
            <div
              className="faint tiny"
              style={{ lineHeight: 1.6, color: passwordAccepted ? undefined : 'var(--danger)' }}
            >
              {provider.note}
            </div>
          ) : null}
          <div className="field">
            <label>Password / app password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="grid-2">
            <div className="field">
              <label>IMAP host</label>
              <input
                className="input"
                value={imapHost}
                onChange={(event) => {
                  setImapHost(event.target.value)
                  setProviderId('custom')
                }}
              />
            </div>
            <div className="field">
              <label>IMAP port</label>
              <input className="input" value={imapPort} onChange={(event) => setImapPort(event.target.value)} />
            </div>
            <div className="field">
              <label>SMTP host</label>
              <input
                className="input"
                value={smtpHost}
                onChange={(event) => {
                  setSmtpHost(event.target.value)
                  setProviderId('custom')
                }}
              />
            </div>
            <div className="field">
              <label>SMTP port</label>
              <input className="input" value={smtpPort} onChange={(event) => setSmtpPort(event.target.value)} />
            </div>
          </div>
          <div className="row wrap">
            <button className={`btn sm ${imapSecure ? 'primary' : ''}`} onClick={() => setImapSecure(!imapSecure)}>
              IMAP TLS {imapSecure ? 'on' : 'off'}
            </button>
            <button className={`btn sm ${smtpSecure ? 'primary' : ''}`} onClick={() => setSmtpSecure(!smtpSecure)}>
              SMTP TLS {smtpSecure ? 'on' : 'off'}
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={onClose}>cancel</button>
            <button
              className="btn sm primary"
              disabled={busy || !email || !password || !passwordAccepted}
              title={passwordAccepted ? undefined : 'This provider requires OAuth, which WARDEN does not implement yet'}
              onClick={() => void submit()}
            >
              {busy ? 'verifying…' : 'verify & add'}
            </button>
          </div>
          <div className="faint tiny">
            WARDEN verifies both IMAP and SMTP before saving, and names the failure if one of them refuses: a wrong host, a
            port and TLS mode that disagree, or a password the provider no longer accepts. The password is encrypted with
            the OS keychain and never written to the settings file.
          </div>
        </div>
      </div>
    </div>
  )
}
