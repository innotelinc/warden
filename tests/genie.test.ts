import { describe, expect, it } from 'vitest'
import { accumulateToolCalls, parseSseLine, type GenieToolCall } from '../src/main/genie/genie-service'

describe('parseSseLine', () => {
  it('parses a data frame', () => {
    const payload = parseSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}')
    expect(payload).not.toBeNull()
    expect((payload as { choices: unknown[] }).choices).toHaveLength(1)
  })

  it('ignores terminators, comments and blank lines', () => {
    expect(parseSseLine('data: [DONE]')).toBeNull()
    expect(parseSseLine(': keep-alive')).toBeNull()
    expect(parseSseLine('')).toBeNull()
    expect(parseSseLine('event: message')).toBeNull()
  })

  it('returns null instead of throwing on a partial frame', () => {
    expect(parseSseLine('data: {"choices":[')).toBeNull()
    expect(parseSseLine('data: 42')).toBeNull()
  })
})

describe('accumulateToolCalls', () => {
  it('joins streamed argument fragments under one call', () => {
    const calls = new Map<number, GenieToolCall>()
    accumulateToolCalls(calls, [{ index: 0, id: 'call_1', function: { name: 'active_page' } }])
    accumulateToolCalls(calls, [{ index: 0, function: { arguments: '{"a"' } }])
    accumulateToolCalls(calls, [{ index: 0, function: { arguments: ':1}' } }])

    const call = calls.get(0)
    expect(call?.id).toBe('call_1')
    expect(call?.name).toBe('active_page')
    expect(call?.arguments).toBe('{"a":1}')
  })

  it('keeps parallel calls separate by index', () => {
    const calls = new Map<number, GenieToolCall>()
    accumulateToolCalls(calls, [
      { index: 0, id: 'a', function: { name: 'active_page', arguments: '{}' } },
      { index: 1, id: 'b', function: { name: 'privacy_stats', arguments: '{}' } }
    ])
    expect(calls.size).toBe(2)
    expect(calls.get(0)?.name).toBe('active_page')
    expect(calls.get(1)?.name).toBe('privacy_stats')
  })

  it('tolerates a delta with no index', () => {
    const calls = new Map<number, GenieToolCall>()
    accumulateToolCalls(calls, [{ function: { name: 'scry_report' } }])
    expect(calls.get(0)?.name).toBe('scry_report')
  })
})
