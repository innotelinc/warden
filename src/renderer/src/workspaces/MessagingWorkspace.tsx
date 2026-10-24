import { useEffect } from 'react'
import { IconChat, IconClose, IconReload, IconSend } from '../icons'
import { useElementRect, useWarden } from '../state'

export function MessagingWorkspace() {
  const { state, notify } = useWarden()
  const [stageRef, rect] = useElementRect<HTMLDivElement>()

  const services = state?.messaging.services ?? []
  const states = state?.messaging.states ?? []
  const activeId = state?.messaging.activeId ?? null
  const active = services.find((service) => service.id === activeId) ?? null
  const activeState = states.find((entry) => entry.id === activeId) ?? null

  useEffect(() => {
    if (!rect) return
    void window.warden.setLayout({
      surface: 'messages',
      tabBounds: null,
      mediaBounds: [],
      msgBounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
  }, [rect])

  const unreadOf = (id: string): number => states.find((entry) => entry.id === id)?.unread ?? 0

  return (
    <div className="workspace">
      <div className="ws-head">
        <IconChat size={15} />
        <h1>Concourse</h1>
        <span className="sub">isolated memory vaults · first-party cookies only · third parties cut</span>
        <span className="spacer" />
        {active ? (
          <>
            <span className="tag">{active.name}</span>
            <button className="btn sm" onClick={() => void window.warden.messaging.reload(active.id)}>
              <IconReload size={11} /> reload
            </button>
            <button className="btn sm danger" onClick={() => void window.warden.messaging.close(active.id)}>
              <IconClose size={11} /> close
            </button>
          </>
        ) : null}
      </div>

      <div className="ws-body">
        <div className="msg-rail">
          {services.map((service) => {
            const entry = states.find((candidate) => candidate.id === service.id)
            const unread = unreadOf(service.id)
            return (
              <button
                key={service.id}
                className={`svc ${activeId === service.id ? 'active' : ''} ${entry?.opened ? '' : 'off'}`}
                style={{ background: `linear-gradient(160deg, ${service.color}, ${service.color}99)` }}
                title={`${service.name}${entry?.opened ? '' : ' — not opened'}`}
                onClick={() => {
                  if (entry?.opened) {
                    void window.warden.messaging.activate(service.id)
                  } else {
                    void window.warden.messaging.open(service.id).catch((error: Error) => notify(error.message, 'err'))
                  }
                }}
              >
                {service.glyph}
                {unread > 0 ? <span className="unread">{unread > 99 ? '99+' : unread}</span> : null}
              </button>
            )
          })}
        </div>

        <div className="msg-stage" ref={stageRef}>
          {active ? (
            <>
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
                <div style={{ textAlign: 'center', color: 'var(--faint)' }}>
                  <div className="mono" style={{ fontSize: 11, letterSpacing: '0.16em' }}>
                    {activeState?.loading ? 'connecting…' : activeState?.failed ? 'service failed to load' : `${active.name} pane`}
                  </div>
                  {activeState?.lastError ? (
                    <div className="mono" style={{ fontSize: 10, marginTop: 6, color: 'var(--amber)', maxWidth: 420 }}>
                      {activeState.lastError}
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div>
                <b style={{ color: 'var(--text-dim)' }}>No service open</b>
                Pick a service on the left. Each runs in its own memory-only session, so signing out is as simple as
                closing the pane — and nothing survives a quit.
                <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {services.slice(0, 4).map((service) => (
                    <button
                      key={service.id}
                      className="btn sm"
                      onClick={() => void window.warden.messaging.open(service.id)}
                    >
                      <IconSend size={11} /> {service.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
