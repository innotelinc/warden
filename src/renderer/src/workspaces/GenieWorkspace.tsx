import { useEffect, useRef, useState } from 'react'
import type { GenieEvent } from '@shared/types'
import { IconSpark } from '../icons'
import { useWarden } from '../state'

interface Turn {
  role: 'user' | 'assistant'
  content: string
  tools: { name: string; detail: string }[]
}

const SUGGESTIONS = [
  'What is this page and what does it expose?',
  'Which trackers were blocked on this page?',
  'Summarise the last Scry capture.',
  'Does this response carry the security headers it should?'
]

export function GenieWorkspace() {
  const { state, notify } = useWarden()
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [model, setModel] = useState('auto/best-coding')
  const scroller = useRef<HTMLDivElement | null>(null)

  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId) ?? null

  useEffect(() => {
    void window.warden.genie
      .status()
      .then((info) => setConfigured(info.configured))
      .catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    const off = window.warden.genie.onEvent((event: GenieEvent) => {
      if (event.type === 'delta') {
        setTurns((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, content: last.content + event.text }
          } else {
            next.push({ role: 'assistant', content: event.text, tools: [] })
          }
          return next
        })
        return
      }
      if (event.type === 'tool') {
        setTurns((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last && last.role === 'assistant') {
            next[next.length - 1] = {
              ...last,
              tools: [...last.tools, { name: event.name, detail: event.detail }]
            }
          }
          return next
        })
        return
      }
      if (event.type === 'status') {
        setStatus(event.message)
        return
      }
      if (event.type === 'done') {
        setBusy(false)
        setStatus('')
        return
      }
      if (event.type === 'error') {
        setBusy(false)
        setStatus('')
        notify(event.message, 'err')
      }
    })
    return off
  }, [notify])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [turns, busy])

  const send = async (text?: string): Promise<void> => {
    const content = (text ?? draft).trim()
    if (!content || busy) return
    const history = [...turns, { role: 'user' as const, content, tools: [] }]
    setTurns(history)
    setDraft('')
    setBusy(true)
    setStatus('thinking')
    try {
      await window.warden.genie.ask(
        history.map((turn) => ({ role: turn.role, content: turn.content })),
        model.trim() || undefined
      )
    } catch (error) {
      setBusy(false)
      setStatus('')
      notify((error as Error).message, 'err')
    }
  }

  const stop = (): void => {
    void window.warden.genie.cancel()
    setBusy(false)
  }

  const saveKey = async (): Promise<void> => {
    const result = await window.warden.genie.setKey(keyDraft)
    if (result.ok) {
      setKeyDraft('')
      setConfigured(true)
      notify(keyDraft.trim() ? 'Gateway key stored in the OS keychain' : 'Gateway key cleared', 'ok')
    } else {
      notify(result.error ?? 'Could not store the key', 'err')
    }
  }

  return (
    <div className="workspace">
      <div className="ws-head">
        <IconSpark size={15} />
        <h1>Genie</h1>
        <span className="sub">
          gateway-backed · reads the active tab and session counters · cannot act on the machine
        </span>
        <span className="spacer" />
        <span className="tag mint tiny">{configured ? 'key loaded' : 'no key'}</span>
      </div>

      <div className="ws-body">
        <div className="ws-col" style={{ flex: 1, minWidth: 0 }}>
          <div ref={scroller} className="scroll-y" style={{ flex: 1, padding: 16, display: 'grid', gap: 12, alignContent: 'start' }}>
            {activeTab ? (
              <div className="faint tiny mono selectable">
                context · {activeTab.title || activeTab.url} — {activeTab.url}
              </div>
            ) : null}

            {!turns.length ? (
              <div className="panel panel-pad" style={{ display: 'grid', gap: 8 }}>
                <div className="panel-title">
                  <IconSpark size={11} /> Ask about what you are looking at
                </div>
                {SUGGESTIONS.map((line) => (
                  <button
                    key={line}
                    className="btn sm"
                    style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => void send(line)}
                  >
                    {line}
                  </button>
                ))}
                <div className="faint tiny" style={{ lineHeight: 1.7 }}>
                  Every reply is generated through your gateway. Page text is sent only when a tool call asks for it,
                  and the key never leaves the main process.
                </div>
              </div>
            ) : null}

            {turns.map((turn, index) => (
              <div
                key={`${turn.role}-${index}`}
                className="panel panel-pad"
                style={{
                  background: turn.role === 'user' ? 'var(--panel-2)' : 'var(--panel)',
                  borderColor: turn.role === 'user' ? 'var(--line)' : 'var(--line-soft)'
                }}
              >
                <div className="panel-title" style={{ marginBottom: 6 }}>
                  {turn.role === 'user' ? 'You' : 'Genie'}
                </div>
                <div className="selectable" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65 }}>
                  {turn.content || (turn.role === 'assistant' && busy ? '…' : '')}
                </div>
                {turn.tools.length ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    {turn.tools.map((tool, toolIndex) => (
                      <span key={`${tool.name}-${toolIndex}`} className="tag violet tiny mono" title={tool.detail}>
                        {tool.name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}

            {busy ? <div className="faint tiny mono">{status || 'working'}…</div> : null}
          </div>

          <div style={{ borderTop: '1px solid var(--line-soft)', padding: 12, display: 'grid', gap: 8 }}>
            {configured === false ? (
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="input mono"
                  type="password"
                  placeholder="gateway key (stored in the OS keychain)"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveKey()
                  }}
                />
                <button className="btn sm" onClick={() => void saveKey()}>
                  save key
                </button>
              </div>
            ) : null}
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input"
                placeholder="Ask Genie about this page…"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) void send()
                }}
              />
              {busy ? (
                <button className="btn sm" onClick={stop}>
                  stop
                </button>
              ) : (
                <button className="btn primary sm" disabled={!draft.trim()} onClick={() => void send()}>
                  send
                </button>
              )}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input mono tiny"
                style={{ width: 220 }}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                title="Gateway model id"
              />
              <button
                className="btn sm"
                disabled={busy || !turns.length}
                onClick={() => {
                  setTurns([])
                  setStatus('')
                }}
              >
                clear
              </button>
              <span className="faint tiny">tool calls are read-only</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
