import { describe, expect, it } from 'vitest'
import { accumulateToolCalls, parseFraudAssessment, parseSseLine, type GenieToolCall } from '../src/main/genie/genie-service'

describe('parseFraudAssessment', () => {
  it('reads a clean verdict', () => {
    const result = parseFraudAssessment(
      '{"verdict":"dangerous","score":92,"summary":"Invoice bait","reasons":["lookalike domain","payment request"]}',
      7
    )
    expect(result?.uid).toBe(7)
    expect(result?.verdict).toBe('dangerous')
    expect(result?.score).toBe(92)
    expect(result?.reasons).toHaveLength(2)
  })

  it('tolerates a code fence and prose around the JSON', () => {
    const result = parseFraudAssessment(
      'Here is my read:\n```json\n{"verdict":"clear","score":4,"summary":"Routine notice","reasons":[]}\n```\nDone.',
      1
    )
    expect(result?.verdict).toBe('clear')
    expect(result?.score).toBe(4)
  })

  it('rejects an unknown verdict instead of guessing', () => {
    expect(parseFraudAssessment('{"verdict":"fine","score":3}', 1)).toBeNull()
    expect(parseFraudAssessment('not json at all', 1)).toBeNull()
  })

  it('clamps the score and caps the reasons', () => {
    const result = parseFraudAssessment(
      JSON.stringify({ verdict: 'suspicious', score: 150, summary: 'x', reasons: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      2
    )
    expect(result?.score).toBe(100)
    expect(result?.reasons).toHaveLength(5)
  })

  it('drops empty strings from the reasons', () => {
    const result = parseFraudAssessment('{"verdict":"clear","score":2,"reasons":["","  ","ok"]}', 3)
    expect(result?.reasons).toEqual(['ok'])
  })
})

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
