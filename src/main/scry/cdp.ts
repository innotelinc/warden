import WebSocket from 'ws'
import type { ScryTarget } from '@shared/types'

export interface ProtocolSession {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  onEvent(handler: (method: string, params: Record<string, unknown>) => void): void
  detach(): Promise<void>
}

interface RemoteTarget {
  id: string
  title: string
  url: string
  type: string
  webSocketDebuggerUrl?: string
}

/** List page targets on a Chrome instance started with --remote-debugging-port. */
export async function listRemoteTargets(port = 9222, timeoutMs = 2500): Promise<ScryTarget[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal })
    if (!response.ok) throw new Error(`CDP ${response.status}`)
    const targets = (await response.json()) as RemoteTarget[]
    return targets
      .filter((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
      .map((target) => ({
        id: target.id,
        title: target.title || target.url,
        url: target.url,
        type: target.type,
        source: 'remote' as const,
        attached: false
      }))
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve the debugger socket for a target on a Chrome debug port. */
export async function remoteDebuggerUrl(port: number, targetId: string): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return null
    const targets = (await response.json()) as RemoteTarget[]
    return targets.find((target) => target.id === targetId)?.webSocketDebuggerUrl ?? null
  } catch {
    return null
  }
}

export async function connectRemoteTarget(port: number, targetId: string): Promise<WebSocketSession> {
  const socketUrl = await remoteDebuggerUrl(port, targetId)
  if (!socketUrl) throw new Error(`Target ${targetId} is not on port ${port}`)
  return WebSocketSession.connect(socketUrl)
}

export class WebSocketSession implements ProtocolSession {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private listeners: ((method: string, params: Record<string, unknown>) => void)[] = []

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      let message: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> }
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (typeof message.id === 'number') {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(message.error.message))
        else entry.resolve(message.result ?? {})
        return
      }
      if (message.method) {
        if (process.env.WARDEN_SCRY_DEBUG === '1' && message.method.startsWith('Page.')) {
          console.error(`[cdp] <- ${message.method}`)
        }
        for (const listener of this.listeners) {
          try {
            listener(message.method, message.params ?? {})
          } catch {
            /* a broken listener must not kill the session */
          }
        }
      }
    })
  }

  static connect(url: string, timeoutMs = 12000): Promise<WebSocketSession> {
    const debug = process.env.WARDEN_SCRY_DEBUG === '1'
    if (debug) console.error(`[cdp] connecting ${url}`)
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: timeoutMs, perMessageDeflate: false })
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error(`CDP connection to ${url} timed out`))
      }, timeoutMs)

      socket.once('open', () => {
        clearTimeout(timer)
        if (debug) console.error('[cdp] socket open')
        resolve(new WebSocketSession(socket))
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        if (debug) console.error(`[cdp] socket error ${error.message}`)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      socket.once('unexpected-response', (_request, response) => {
        if (debug) console.error(`[cdp] unexpected response ${response.statusCode}`)
      })
    })
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (process.env.WARDEN_SCRY_DEBUG === '1') console.error(`[cdp] -> ${method}`)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command ${method} timed out`))
      }, 30000)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  onEvent(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.listeners.push(handler)
  }

  async detach(): Promise<void> {
    for (const [, entry] of this.pending) clearTimeout(entry.timer)
    this.pending.clear()
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
  }
}

/** Adapter that drives a tab's built-in debugger with the same interface. */
export class DebuggerSession implements ProtocolSession {
  private listeners: ((method: string, params: Record<string, unknown>) => void)[] = []

  constructor(
    private readonly debuggerApi: Electron.Debugger,
    private readonly attached: boolean
  ) {
    if (!this.attached) {
      debuggerApi.attach('1.3')
    }
    debuggerApi.on('message', (_event, method, params) => {
      for (const listener of this.listeners) {
        try {
          listener(method, params as Record<string, unknown>)
        } catch {
          /* ignore */
        }
      }
    })
    debuggerApi.on('detach', () => {
      this.listeners = []
    })
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.debuggerApi.sendCommand(method, params) as Promise<T>
  }

  onEvent(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.listeners.push(handler)
  }

  async detach(): Promise<void> {
    this.listeners = []
    try {
      if (this.debuggerApi.isAttached()) this.debuggerApi.detach()
    } catch {
      /* tab closed */
    }
  }
}
