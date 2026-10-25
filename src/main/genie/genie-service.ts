/**
 * Genie — the in-browser assistant.
 *
 * Talks to the Innotel gateway's OpenAI-compatible endpoint from the main
 * process only, so the API key never reaches the renderer, a page, or the
 * package. It is given a small set of read-only tools over the browser it is
 * sitting in (the active page, privacy counters, the last Scry report), which
 * is what makes it useful without being allowed to act on the machine.
 */
import type { FraudAssessment, FraudInput, GenieEvent } from '@shared/types'

export type { GenieEvent }

export interface GenieToolCall {
  id: string
  name: string
  arguments: string
}

export interface GenieMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: GenieToolCall[]
}

export interface GenieDeps {
  gatewayUrl: () => string
  apiKey: () => string | null
  model: () => string
  /** Facts about the tab the operator is looking at. */
  activeContext: () => Promise<{ url: string; title: string }>
  /** Rendered text of the active page, truncated by the caller. */
  activeText: () => Promise<string>
  stats: () => { blocked: number; rules: number; cookiesStripped: number; trackers: number }
  scrySummary: () => string | null
  emit: (event: GenieEvent) => void
}

const MAX_TOOL_ROUNDS = 3
const MAX_PAGE_TEXT = 8000

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'active_page',
      description:
        'Read the page the operator is currently looking at: its URL, title, and rendered text. Use this before answering anything about "this page".',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'privacy_stats',
      description:
        'Return this session\'s Blocked counters: requests blocked, tracker hosts, cookies refused, and filter rules loaded.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scry_report',
      description:
        'Return the summary of the most recent Scry capture: detected stack, tracker hosts, and missing security headers. Empty when nothing has been captured.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  }
] as const

const FRAUD_PROMPT = `You are a fraud analyst inside WARDEN's mail client. Read one message and judge whether it is a phishing or deception attempt.

Weigh: display name against address, lookalike or free-mail domains where a company should write, urgency and threats, requests for credentials or payment, invoice/refund bait, links whose host does not match the claimed sender, and mismatched reply-to. Treat poor grammar as a weak signal only.

Answer with JSON only, no prose and no code fences:
{"verdict":"clear|suspicious|dangerous","score":0-100,"summary":"one sentence","reasons":["short reason"]}

Never invent evidence that is not in the message. An ordinary message is "clear" with a score under 20. Give at most five reasons, each under 120 characters.`

/**
 * Read Genie's answer into an assessment.
 *
 * The gateway is a general chat endpoint, so it may wrap JSON in prose or a
 * code fence even when told not to. Anything that cannot be read as a valid
 * verdict is rejected rather than guessed at: a wrong "clear" is worse than an
 * error the operator can see.
 */
export function parseFraudAssessment(raw: string, uid: number): FraudAssessment | null {
  const text = raw.replace(/```[a-z]*\n?/gi, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const verdict = record.verdict
  if (verdict !== 'clear' && verdict !== 'suspicious' && verdict !== 'dangerous') return null

  const scoreRaw = Number(record.score)
  const score = Number.isFinite(scoreRaw) ? Math.min(100, Math.max(0, Math.round(scoreRaw))) : 0
  const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, 240) : ''
  const reasons = Array.isArray(record.reasons)
    ? record.reasons
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim().slice(0, 180))
        .slice(0, 5)
    : []
  return { uid, verdict, score, summary, reasons, checkedAt: Date.now() }
}

const SYSTEM_PROMPT = `You are Genie, the assistant inside WARDEN — a privacy-first operations browser used by security and network administrators.

Rules:
- You can read the active page, this session's privacy counters, and the last Scry capture through tools. Call them instead of guessing about the page or the session.
- You cannot change settings, run commands, install anything, or act on the network. If asked to do something like that, say what the operator should do in WARDEN instead of pretending you did it.
- Be terse and technical. Prefer concrete findings (headers, hosts, versions) over generic advice.
- Never invent URLs, CVEs, versions, or evidence. If a tool returns nothing, say so.
- Answer in the operator's language.`

/** Parse one SSE line into a JSON payload, or null for comments/blank lines. */
export function parseSseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return null
  try {
    const parsed: unknown = JSON.parse(data)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch {
    /* keep-alive or partial frame */
  }
  return null
}

/** Accumulate streamed tool-call deltas keyed by index. */
export function accumulateToolCalls(
  target: Map<number, GenieToolCall>,
  deltas: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
): void {
  for (const delta of deltas) {
    const index = typeof delta.index === 'number' ? delta.index : 0
    const entry = target.get(index) ?? { id: '', name: '', arguments: '' }
    if (delta.id) entry.id = delta.id
    if (delta.function?.name) entry.name = delta.function.name
    if (delta.function?.arguments) entry.arguments += delta.function.arguments
    target.set(index, entry)
  }
}

export class GenieService {
  private abort: AbortController | null = null
  private busy = false

  constructor(private readonly deps: GenieDeps) {}

  get configured(): boolean {
    return Boolean(this.deps.apiKey())
  }

  get running(): boolean {
    return this.busy
  }

  cancel(): void {
    this.abort?.abort()
  }

  private async runTool(name: string): Promise<string> {
    if (name === 'active_page') {
      const context = await this.deps.activeContext()
      let text = ''
      try {
        text = (await this.deps.activeText()).slice(0, MAX_PAGE_TEXT)
      } catch {
        text = ''
      }
      return JSON.stringify({
        url: context.url,
        title: context.title,
        text: text || '(no readable text — the page may be an internal WARDEN page or still loading)'
      })
    }
    if (name === 'privacy_stats') {
      return JSON.stringify(this.deps.stats())
    }
    if (name === 'scry_report') {
      return this.deps.scrySummary() ?? JSON.stringify({ note: 'No Scry capture has been run yet.' })
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` })
  }

  /**
   * Read one message for fraud. Separate from the chat turn: it does not stream,
   * does not touch the panel's history, and cannot collide with an answer the
   * operator is reading.
   */
  async assessFraud(input: FraudInput): Promise<FraudAssessment> {
    const key = this.deps.apiKey()
    if (!key) {
      throw new Error('No gateway key. Set one in Policy → Genie, or start WARDEN with INNOTEL_GATEWAY_KEY set.')
    }
    const abort = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, 45000)
    try {
      const response = await fetch(`${this.deps.gatewayUrl().replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: this.deps.model(),
          stream: false,
          temperature: 0,
          messages: [
            { role: 'system', content: FRAUD_PROMPT },
            { role: 'user', content: JSON.stringify(input).slice(0, 12000) }
          ]
        }),
        signal: abort.signal
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Gateway ${response.status}: ${detail.slice(0, 200) || response.statusText}`)
      }
      const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] }
      const content = payload.choices?.[0]?.message?.content ?? ''
      const assessment = parseFraudAssessment(content, input.uid)
      if (!assessment) throw new Error('Genie returned an unreadable assessment.')
      return assessment
    } catch (error) {
      if (timedOut) throw new Error('Genie did not answer within 45s. Try again when the gateway is up.')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async ask(messages: GenieMessage[], model?: string): Promise<{ ok: boolean }> {
    if (this.busy) {
      this.deps.emit({ type: 'error', message: 'Genie is still answering the previous turn.' })
      return { ok: false }
    }
    const key = this.deps.apiKey()
    if (!key) {
      this.deps.emit({
        type: 'error',
        message: 'No gateway key. Set one in Policy → Genie, or start WARDEN with INNOTEL_GATEWAY_KEY set.'
      })
      return { ok: false }
    }

    this.busy = true
    this.abort = new AbortController()
    // A gateway that accepts the connection and never answers is worse than one
    // that refuses: without this the panel would sit on "thinking" forever.
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      this.abort?.abort()
    }, 60000)
    const history: GenieMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
    let answer = ''

    try {
      this.deps.emit({ type: 'status', message: 'thinking' })

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const response = await fetch(`${this.deps.gatewayUrl().replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`
          },
          body: JSON.stringify({
            model: model || this.deps.model(),
            stream: true,
            messages: history,
            tools: TOOLS,
            tool_choice: 'auto'
          }),
          signal: this.abort.signal
        })

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => '')
          throw new Error(`Gateway ${response.status}: ${detail.slice(0, 300) || response.statusText}`)
        }

        const toolCalls = new Map<number, GenieToolCall>()
        let roundText = ''
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const payload = parseSseLine(line)
            if (!payload) continue
            const choice = (payload.choices as { delta?: Record<string, unknown> }[] | undefined)?.[0]
            const delta = choice?.delta
            if (!delta) continue
            const content = delta.content
            if (typeof content === 'string' && content) {
              roundText += content
              this.deps.emit({ type: 'delta', text: content })
            }
            const calls = delta.tool_calls as
              | { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
              | undefined
            if (calls) accumulateToolCalls(toolCalls, calls)
          }
        }

        answer += roundText

        if (toolCalls.size === 0) {
          this.deps.emit({ type: 'done', text: answer.trim() })
          return { ok: true }
        }

        // Run every requested tool, feed the results back, and let the model continue.
        const calls = [...toolCalls.values()].filter((call) => call.name)
        history.push({
          role: 'assistant',
          content: roundText,
          tool_calls: calls.map((call) => ({
            id: call.id || `call_${call.name}`,
            name: call.name,
            arguments: call.arguments || '{}'
          }))
        })
        for (const call of calls) {
          this.deps.emit({ type: 'tool', name: call.name, detail: 'running' })
          const result = await this.runTool(call.name)
          this.deps.emit({
            type: 'tool',
            name: call.name,
            detail: result.slice(0, 160).replace(/\s+/g, ' ')
          })
          history.push({
            role: 'tool',
            content: result,
            tool_call_id: call.id || `call_${call.name}`
          })
        }
        this.deps.emit({ type: 'status', message: 'reading tool results' })
      }

      this.deps.emit({ type: 'done', text: answer.trim() || 'No answer.' })
      return { ok: true }
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError'
      const message = timedOut
        ? 'The gateway did not answer within 60s. Check that the endpoint is up, then try again.'
        : aborted
          ? 'Cancelled.'
          : (error as Error).message
      this.deps.emit({ type: 'error', message })
      return { ok: false }
    } finally {
      clearTimeout(timeout)
      this.busy = false
      this.abort = null
    }
  }
}
