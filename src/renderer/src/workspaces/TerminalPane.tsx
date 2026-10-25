import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { IconClose, IconPlus, IconTerminal, IconTrash } from '../icons'
import { useWarden } from '../state'
import { DRAWER_HEAD } from '../layout'

const TERM_THEME = {
  background: '#05080b',
  foreground: '#cfe0ee',
  cursor: '#4fe3c1',
  cursorAccent: '#04110e',
  selectionBackground: 'rgba(79, 227, 193, 0.26)',
  black: '#0b1116',
  red: '#ff6b81',
  green: '#4fe3c1',
  yellow: '#f5b95b',
  blue: '#7aa2ff',
  magenta: '#a78bfa',
  cyan: '#66e0ff',
  white: '#dbe5f1',
  brightBlack: '#4e5d6e',
  brightRed: '#ff8f9e',
  brightGreen: '#7cf3d8',
  brightYellow: '#ffd08a',
  brightBlue: '#a5beff',
  brightMagenta: '#c7b3ff',
  brightCyan: '#9df1ff',
  brightWhite: '#f2f7fc'
}

export function TerminalPane({ variant }: { variant: 'drawer' | 'full' }) {
  const { state, notify } = useWarden()
  const holder = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [mode, setMode] = useState<'shell' | 'ssh'>('shell')
  const [target, setTarget] = useState('')
  const [port, setPort] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeId = state?.terminal?.id ?? null
  const fontSize = state?.settings.terminalFontSize ?? 13
  const shell = state?.settings.terminalShell ?? ''

  const connect = (): void => {
    const destination = target.trim()
    if (!destination) {
      setError('Enter a host or user@host')
      return
    }
    setConnecting(true)
    setError(null)
    void window.warden.terminal
      .ssh({ target: destination, port: Number(port) || undefined })
      .then((info) => notify(`ssh ${info.target ?? destination} — session open`))
      .catch((failure: unknown) => {
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      })
      .finally(() => setConnecting(false))
  }

  useEffect(() => {
    const element = holder.current
    if (!element || !activeId) return

    const terminal = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: variant === 'full' ? fontSize + 1 : fontSize,
      lineHeight: 1.28,
      letterSpacing: 0.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: false,
      scrollback: 12000,
      theme: TERM_THEME,
      macOptionIsMeta: true,
      convertEol: false
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void window.warden.tab.create(uri)
      })
    )
    terminal.open(element)
    termRef.current = terminal

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
        const selection = terminal.getSelection()
        if (selection) void navigator.clipboard.writeText(selection)
        return false
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
        void navigator.clipboard.readText().then((text) => {
          if (text) void window.warden.terminal.input(activeId, text)
        })
        return false
      }
      return true
    })

    const dataDisposable = terminal.onData((data) => {
      void window.warden.terminal.input(activeId, data)
    })

    const offData = window.warden.onTerminalData((id, data) => {
      if (id === activeId) terminal.write(data)
    })
    const offExit = window.warden.onTerminalExit((id, code) => {
      if (id === activeId && code !== null) {
        terminal.write(`\r\n\x1b[38;5;244m[warden] session closed (${code})\x1b[0m\r\n`)
      }
    })

    void window.warden.terminal.scrollback(activeId).then((buffer) => {
      if (buffer) terminal.write(buffer)
      terminal.focus()
    })

    const size = (): void => {
      try {
        fit.fit()
        void window.warden.terminal.resize(activeId, terminal.cols, terminal.rows)
      } catch {
        /* not laid out yet */
      }
    }
    requestAnimationFrame(size)
    const observer = new ResizeObserver(() => size())
    observer.observe(element)

    return () => {
      observer.disconnect()
      offData()
      offExit()
      dataDisposable.dispose()
      termRef.current = null
      terminal.dispose()
    }
  }, [activeId, fontSize, variant])

  const terminals = state?.terminals ?? []

  return (
    <div className="term-drawer" style={{ flex: 1, minHeight: 0, height: variant === 'full' ? '100%' : undefined }}>
      <div className="term-head" style={{ height: variant === 'full' ? 38 : DRAWER_HEAD }}>
        <IconTerminal size={13} />
        <span style={{ font: '9.5px/1 var(--mono)', letterSpacing: '0.2em', color: 'var(--faint)', marginRight: 4 }}>TRENCH</span>
        <div className="term-mode" role="group" aria-label="Session type">
          <button
            className={`tchip ${mode === 'shell' ? 'active' : ''}`}
            onClick={() => setMode('shell')}
            title="A shell on this machine"
          >
            SHELL
          </button>
          <button
            className={`tchip ${mode === 'ssh' ? 'active' : ''}`}
            onClick={() => setMode('ssh')}
            title="An ssh login, in the same PTY"
          >
            SSH
          </button>
        </div>
        {terminals.map((entry) => (
          <button
            key={entry.id}
            className={`tchip ${entry.id === activeId ? 'active' : ''}`}
            onClick={() => void window.warden.terminal.activate(entry.id)}
            title={`${entry.shell} · ${entry.cwd}`}
          >
            {entry.title}
            {entry.alive ? '' : ' ·dead'}
          </button>
        ))}
        <button
          className="tchip"
          title="New shell"
          onClick={() => {
            void window.warden.terminal.create(shell).then(() => notify('Shell started'))
          }}
        >
          <IconPlus size={11} />
        </button>
        <span style={{ flex: 1 }} />
        <span className={`backend ${state?.terminal?.backend ?? ''}`}>
          {state?.terminal?.backend ?? 'idle'}
        </span>
        <button
          className="icon-btn tiny"
          title="Clear scrollback"
          onClick={() => {
            termRef.current?.clear()
            termRef.current?.focus()
          }}
        >
          <IconTrash size={12} />
        </button>
        <button
          className="icon-btn tiny"
          title="Kill this shell"
          onClick={() => {
            if (!activeId) return
            void window.warden.terminal.kill(activeId)
          }}
        >
          <IconClose size={12} />
        </button>
        {variant === 'drawer' ? (
          <button className="icon-btn tiny" title="Close drawer (Ctrl+`)" onClick={() => void window.warden.terminal.setDrawer(false)}>
            <IconClose size={12} />
          </button>
        ) : null}
      </div>

      {mode === 'ssh' ? (
        <div className="ssh-bar">
          <span className="ssh-tag">SSH</span>
          <input
            className="input ssh-target"
            placeholder="user@host"
            spellCheck={false}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') connect()
            }}
            aria-label="ssh destination"
          />
          <input
            className="input ssh-port"
            placeholder="22"
            inputMode="numeric"
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') connect()
            }}
            aria-label="ssh port"
          />
          <button className="btn sm primary" disabled={connecting} onClick={connect}>
            {connecting ? 'connecting' : 'connect'}
          </button>
          {error ? <span className="ssh-error">{error}</span> : null}
        </div>
      ) : null}

      <div className="term-body" ref={holder}>
        {!activeId ? (
          <div className="term-empty">
            <div>
              <b style={{ color: 'var(--text-dim)' }}>Trench is cold</b>
              {mode === 'ssh' ? (
                <div>Enter a destination above to open an ssh login.</div>
              ) : (
                <div>Start a shell to work on this machine.</div>
              )}
              <button
                className="btn primary"
                style={{ marginTop: 12 }}
                onClick={() => (mode === 'ssh' ? connect() : void window.warden.terminal.create(shell))}
              >
                {mode === 'ssh' ? 'Connect' : 'Start shell'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
