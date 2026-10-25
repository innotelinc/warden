import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TerminalInfo } from '@shared/types'

const SCROLLBACK_LIMIT = 240_000

export interface ShellSpec {
  file: string
  args: string[]
  label: string
}

export function resolveShell(preference: string): ShellSpec {
  if (preference.trim()) {
    return { file: preference.trim(), args: [], label: path.basename(preference.trim()) }
  }
  if (process.platform === 'win32') {
    const candidates: { cmd: string; file: string; args: string[] }[] = [
      { cmd: 'pwsh.exe', file: 'pwsh.exe', args: ['-NoLogo'] },
      {
        cmd: 'powershell.exe',
        file: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass']
      }
    ]
    for (const candidate of candidates) {
      try {
        execFileSync('where', [candidate.cmd], { stdio: 'ignore', timeout: 2500 })
        return { file: candidate.file, args: candidate.args, label: candidate.file.replace('.exe', '') }
      } catch {
        /* try next */
      }
    }
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { file: comspec, args: [], label: path.basename(comspec) }
  }
  const shell = process.env.SHELL || '/bin/bash'
  return { file: shell, args: ['-l'], label: path.basename(shell) }
}

/**
 * Locate the system OpenSSH client.
 *
 * WARDEN does not bundle an SSH implementation: the platform client already
 * knows about the user's keys, agent and known_hosts, and it prompts inside the
 * PTY exactly as it would in a normal terminal. Returns null when the host has
 * no client (Windows before the OpenSSH optional feature, minimal images).
 */
export function resolveSsh(): string | null {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  for (const candidate of ['ssh.exe', 'ssh']) {
    try {
      const output = execFileSync(probe, [candidate], { timeout: 2500, encoding: 'utf8' })
      const line = output.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
      if (line && fs.existsSync(line)) return line
    } catch {
      /* try the next name */
    }
  }
  return null
}

/**
 * Accept `host`, `user@host` and `[2001:db8::1]`, nothing that could be read as
 * an option or split into extra arguments.
 */
export function normalizeSshTarget(raw: string): string {
  const target = raw.trim()
  if (!target) throw new Error('Enter a host to connect to')
  if (target.startsWith('-')) throw new Error('A host cannot start with a dash')
  if (/\s/.test(target)) throw new Error('A host cannot contain spaces')
  if (!/^[A-Za-z0-9._@:\[\]-]+$/.test(target)) {
    throw new Error('Use a host, user@host, or [ipv6] — no paths or options')
  }
  return target
}

type PtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: Record<string, string | undefined>
    }
  ) => {
    onData: (cb: (data: string) => void) => void
    onExit: (cb: (event: { exitCode: number }) => void) => void
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    kill: () => void
    pid: number
  }
}

function loadPty(): PtyModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node-pty') as PtyModule
    return typeof mod?.spawn === 'function' ? mod : null
  } catch {
    return null
  }
}

interface SessionState {
  info: TerminalInfo
  buffer: string
  pty: ReturnType<PtyModule['spawn']> | null
  child: ChildProcessWithoutNullStreams | null
  pendingLine: string
}

export interface TerminalEvents {
  onData: (id: string, data: string) => void
  onExit: (id: string, code: number | null) => void
}

/**
 * Trench. Prefers a real ConPTY/Unix PTY so full-screen tools behave, and
 * degrades to a line-buffered pipe shell when the native module is
 * unavailable for the Electron ABI.
 */
export class TerminalService {
  private sessions = new Map<string, SessionState>()
  private counter = 0
  private activeId: string | null = null

  constructor(private readonly events: TerminalEvents) {}

  private get pty(): PtyModule | null {
    return loadPty()
  }

  create(shellPreference = ''): TerminalInfo {
    const spec = resolveShell(shellPreference)
    return this.launch({ file: spec.file, args: spec.args, label: spec.label, kind: 'shell' })
  }

  createSsh(input: { target: string; port?: number }): TerminalInfo {
    const ssh = resolveSsh()
    if (!ssh) {
      throw new Error('No ssh client found on this host — install the OpenSSH client and retry')
    }
    const target = normalizeSshTarget(input.target)
    const port = Number(input.port)
    const args: string[] = []
    if (Number.isInteger(port) && port > 0 && port <= 65535) args.push('-p', String(port))
    args.push(target)
    return this.launch({ file: ssh, args, label: `ssh ${target}`, kind: 'ssh', target })
  }

  private launch(spec: {
    file: string
    args: string[]
    label: string
    kind: 'shell' | 'ssh'
    target?: string
  }): TerminalInfo {
    this.counter += 1
    const id = `trench-${this.counter}`
    const cwd = os.homedir()
    const ptyModule = this.pty
    // Without a PTY the remote would reject the interactive login; -tt asks ssh
    // to allocate one anyway. It has to precede the destination argument.
    const args = [...spec.args]
    if (!ptyModule && spec.kind === 'ssh' && args.length) args.splice(args.length - 1, 0, '-tt')

    const info: TerminalInfo = {
      id,
      title: spec.label,
      shell: spec.file,
      kind: spec.kind,
      target: spec.target ?? null,
      backend: ptyModule ? 'pty' : 'pipe',
      cols: 120,
      rows: 30,
      cwd,
      alive: true,
      exitCode: null
    }

    const state: SessionState = { info, buffer: '', pty: null, child: null, pendingLine: '' }
    this.sessions.set(id, state)

    if (ptyModule) {
      try {
        const handle = ptyModule.spawn(spec.file, args, {
          name: 'xterm-256color',
          cols: info.cols,
          rows: info.rows,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color', WARDEN: '1', WARDEN_TERM: id }
        })
        state.pty = handle
        handle.onData((data) => this.push(id, data))
        handle.onExit(({ exitCode }) => {
          info.alive = false
          info.exitCode = exitCode
          this.events.onExit(id, exitCode)
        })
      } catch {
        info.backend = 'pipe'
      }
    }

    if (info.backend === 'pipe' || !state.pty) {
      // A pipe-backed ssh already carries -tt; appending -i would make ssh read
      // it as the remote command.
      this.startPipe(state, { file: spec.file, args, label: spec.label }, cwd, spec.kind === 'shell')
    }

    this.activeId = id
    return info
  }

  private startPipe(state: SessionState, spec: ShellSpec, cwd: string, interactive = true): void {
    const args =
      interactive && process.platform !== 'win32' ? [...spec.args, '-i'] : [...spec.args]
    const child = spawn(spec.file, args, {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', WARDEN: '1' },
      windowsHide: true
    }) as ChildProcessWithoutNullStreams
    state.child = child

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.push(state.info.id, chunk.replace(/\r?\n/g, '\r\n')))
    child.stderr.on('data', (chunk: string) => this.push(state.info.id, chunk.replace(/\r?\n/g, '\r\n')))
    child.on('exit', (code) => {
      state.info.alive = false
      state.info.exitCode = code ?? 0
      this.push(state.info.id, `\r\n\x1b[38;5;244m[warden] shell exited (${code ?? 0})\x1b[0m\r\n`)
      this.events.onExit(state.info.id, code ?? 0)
    })
    child.on('error', (error) => {
      state.info.alive = false
      this.push(state.info.id, `\r\n\x1b[31m[warden] ${error.message}\x1b[0m\r\n`)
    })
  }

  private push(id: string, data: string): void {
    const state = this.sessions.get(id)
    if (!state) return
    state.buffer += data
    if (state.buffer.length > SCROLLBACK_LIMIT) {
      state.buffer = state.buffer.slice(state.buffer.length - SCROLLBACK_LIMIT)
    }
    this.events.onData(id, data)
  }

  write(id: string, data: string): void {
    const state = this.sessions.get(id)
    if (!state) return
    if (state.pty) {
      state.pty.write(data)
      return
    }
    if (!state.child || !state.info.alive) return

    // Minimal line discipline for the pipe fallback: echo input, handle
    // backspace and enter, ignore other control sequences.
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        this.push(id, '\r\n')
        state.child.stdin.write(`${state.pendingLine}\n`)
        state.pendingLine = ''
      } else if (char === '\x7f' || char === '\b') {
        if (state.pendingLine.length) {
          state.pendingLine = state.pendingLine.slice(0, -1)
          this.push(id, '\b \b')
        }
      } else if (char === '\x03') {
        this.push(id, '^C\r\n')
        state.pendingLine = ''
        if (process.platform === 'win32') state.child.stdin.write('\x03')
      } else if (char === '\x0c') {
        this.push(id, '\x1b[2J\x1b[H')
      } else if (char >= ' ') {
        state.pendingLine += char
        this.push(id, char)
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const state = this.sessions.get(id)
    if (!state) return
    state.info.cols = Math.max(20, Math.min(400, Math.round(cols)))
    state.info.rows = Math.max(5, Math.min(200, Math.round(rows)))
    try {
      state.pty?.resize(state.info.cols, state.info.rows)
    } catch {
      /* terminal closed */
    }
  }

  kill(id: string): void {
    const state = this.sessions.get(id)
    if (!state) return
    try {
      state.pty?.kill()
    } catch {
      /* already gone */
    }
    try {
      state.child?.kill()
    } catch {
      /* already gone */
    }
    state.info.alive = false
    this.sessions.delete(id)
    if (this.activeId === id) {
      this.activeId = this.sessions.keys().next().value ?? null
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  activate(id: string): TerminalInfo | null {
    const state = this.sessions.get(id)
    if (!state) return null
    this.activeId = id
    return state.info
  }

  get active(): TerminalInfo | null {
    return this.activeId ? (this.sessions.get(this.activeId)?.info ?? null) : null
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((state) => state.info)
  }

  scrollback(id: string): string {
    return this.sessions.get(id)?.buffer ?? ''
  }

  cwdFor(id: string): string {
    return this.sessions.get(id)?.info.cwd ?? os.homedir()
  }

  /** Resolve a path for terminal-initiated file operations. */
  resolve(id: string, target: string): string {
    const base = this.cwdFor(id)
    return path.isAbsolute(target) ? target : path.join(base, target)
  }

  exists(target: string): boolean {
    try {
      return fs.existsSync(target)
    } catch {
      return false
    }
  }
}
