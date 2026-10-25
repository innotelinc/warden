import { describe, expect, it } from 'vitest'
import {
  helloAvailabilityMessage,
  helloEnrolled,
  helloMessage,
  parseHelloAvailability,
  parseHelloResult,
  resolveHelloAvailability,
  type HelloAvailability,
  type HelloOutcome
} from '../src/main/security/win-auth'

describe('Windows Hello outcomes', () => {
  it('reads the verifier results Windows emits', () => {
    expect(parseHelloResult('HELLO:Verified')).toBe('verified')
    expect(parseHelloResult('HELLO:Canceled')).toBe('cancelled')
    expect(parseHelloResult('HELLO:Cancelled')).toBe('cancelled')
    expect(parseHelloResult('HELLO:NotConfiguredForUser')).toBe('not-configured')
    expect(parseHelloResult('HELLO:DeviceNotPresent')).toBe('not-present')
    expect(parseHelloResult('HELLO:DisabledByPolicy')).toBe('disabled')
    expect(parseHelloResult('HELLO:DeviceBusy')).toBe('busy')
    expect(parseHelloResult('HELLO:RetriesExhausted')).toBe('retries-exhausted')
  })

  /** A verifier that cannot run must never come back as a pass. */
  it('fails closed on anything it does not recognise', () => {
    for (const junk of ['', 'OK', 'FAIL', 'HELLO:', 'HELLO:SomethingNew', 'garbage', 'HELLO:VerifiedCanceled']) {
      expect(parseHelloResult(junk)).toBe('unavailable')
    }
  })

  /**
   * The availability check runs without a prompt, so it is safe to ask from
   * Policy and from the lock screen before anyone is stuck behind the overlay.
   */
  it('reports whether Hello is enrolled instead of assuming it is', () => {
    expect(parseHelloAvailability('HELLO_AVAIL:Available')).toBe('available')
    expect(parseHelloAvailability('HELLO_AVAIL:NotConfiguredForUser')).toBe('not-configured')
    expect(parseHelloAvailability('HELLO_AVAIL:DeviceNotPresent')).toBe('not-present')
    expect(parseHelloAvailability('HELLO_AVAIL:DisabledByPolicy')).toBe('disabled')
    expect(parseHelloAvailability('HELLO_AVAIL:DeviceBusy')).toBe('busy')
    for (const junk of ['', 'HELLO:Verified', 'HELLO_AVAIL:', 'HELLO_AVAIL:SomethingNew', 'noise']) {
      expect(parseHelloAvailability(junk)).toBe('unavailable')
    }
  })

  it('says what to use when Hello cannot verify', () => {
    expect(helloAvailabilityMessage('available')).toMatch(/PIN/i)
    const blocked: HelloAvailability[] = ['not-configured', 'not-present', 'disabled', 'busy', 'unavailable']
    for (const availability of blocked) {
      expect(helloAvailabilityMessage(availability)).toMatch(/account password/i)
    }
  })

  /**
   * The case that started this: a machine whose owner signs in with a PIN, where
   * `CheckAvailabilityAsync` throws inside the child process. The button used to
   * be disabled and the diagnostic declared no Hello at all.
   */
  it('falls back to the NGC container when the verifier stays silent', () => {
    const silent = 'HELLO_AVAIL:Unavailable\nHELLO_ENROLLED:yes'
    expect(parseHelloAvailability(silent)).toBe('unavailable')
    expect(helloEnrolled(silent)).toBe(true)
    expect(resolveHelloAvailability(silent)).toBe('enrolled')
    expect(helloAvailabilityMessage('enrolled')).toMatch(/try the hello button/i)
    expect(helloAvailabilityMessage('enrolled')).toMatch(/account password/i)
  })

  it('treats a silent verifier with no container as genuinely unavailable', () => {
    expect(resolveHelloAvailability('HELLO_AVAIL:Unavailable\nHELLO_ENROLLED:no')).toBe('unavailable')
    expect(resolveHelloAvailability('HELLO_AVAIL:Unavailable')).toBe('unavailable')
    expect(helloEnrolled('HELLO_ENROLLED:no')).toBe(false)
  })

  it('never lets an enrolment override what the verifier actually said', () => {
    const cases: [string, HelloAvailability][] = [
      ['HELLO_AVAIL:Available\nHELLO_ENROLLED:no', 'available'],
      ['HELLO_AVAIL:NotConfiguredForUser\nHELLO_ENROLLED:yes', 'not-configured'],
      ['HELLO_AVAIL:DisabledByPolicy\nHELLO_ENROLLED:yes', 'disabled'],
      ['HELLO_AVAIL:DeviceBusy\nHELLO_ENROLLED:yes', 'busy'],
      ['HELLO_AVAIL:DeviceNotPresent\nHELLO_ENROLLED:yes', 'enrolled']
    ]
    for (const [output, expected] of cases) {
      expect(resolveHelloAvailability(output)).toBe(expected)
    }
  })

  it('always leaves the password as the way in', () => {
    const failures: HelloOutcome[] = [
      'cancelled',
      'not-configured',
      'not-present',
      'disabled',
      'busy',
      'retries-exhausted',
      'unavailable'
    ]
    for (const outcome of failures) {
      expect(helloMessage(outcome)).toMatch(/account password/i)
    }
    expect(helloMessage('verified')).toBe('')
  })
})
