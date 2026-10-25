import { describe, expect, it } from 'vitest'
import { LOCK_TIMEOUTS, shouldAutoLock, timeoutLabel } from '../src/shared/lock-policy'

describe('idle lock', () => {
  it('locks only after the configured idle time', () => {
    expect(shouldAutoLock({ idleSeconds: 299, timeoutMinutes: 5, locked: false })).toBe(false)
    expect(shouldAutoLock({ idleSeconds: 300, timeoutMinutes: 5, locked: false })).toBe(true)
    expect(shouldAutoLock({ idleSeconds: 90, timeoutMinutes: 1, locked: false })).toBe(true)
  })

  it('stays off when the timeout is disabled', () => {
    expect(shouldAutoLock({ idleSeconds: 100_000, timeoutMinutes: 0, locked: false })).toBe(false)
  })

  it('never re-locks an app that is already covered', () => {
    expect(shouldAutoLock({ idleSeconds: 5000, timeoutMinutes: 1, locked: true })).toBe(false)
  })

  it('offers a fixed, documented set of timeouts and labels them', () => {
    expect(LOCK_TIMEOUTS).toEqual([0, 1, 5, 15, 30, 60])
    expect(timeoutLabel(0)).toBe('Never')
    expect(timeoutLabel(1)).toBe('1 minute')
    expect(timeoutLabel(15)).toBe('15 minutes')
    expect(timeoutLabel(60)).toBe('1 hour')
  })
})
