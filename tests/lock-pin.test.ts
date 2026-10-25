import { describe, expect, it } from 'vitest'
import { PIN_MAX, PIN_MIN, normalizePin, pinProblem } from '../src/shared/lock-pin'
import { hashPin, verifyPin } from '../src/main/security/lock-pin'

describe('WARDEN PIN rules', () => {
  it('accepts digit strings inside the documented length', () => {
    expect(PIN_MIN).toBe(4)
    expect(PIN_MAX).toBe(10)
    expect(pinProblem('1234')).toBeNull()
    expect(pinProblem('4829130756')).toBeNull()
  })

  it('refuses what the numeric field cannot mean', () => {
    expect(pinProblem('')).toBe('Enter a PIN.')
    expect(pinProblem('   ')).toBe('Enter a PIN.')
    expect(pinProblem('12a4')).toBe('A PIN is digits only.')
    expect(pinProblem('12 34')).toBeNull()
    expect(pinProblem('123')).toMatch(/at least 4/)
    expect(pinProblem('12345678901')).toMatch(/at most 10/)
  })

  /** A PIN pasted from a note with spaces is the same PIN, not a different one. */
  it('normalises whitespace instead of treating it as part of the secret', () => {
    expect(normalizePin(' 12 34 ')).toBe('1234')
    expect(normalizePin('12\t34')).toBe('1234')
  })
})

describe('WARDEN PIN storage', () => {
  it('stores only a salted scrypt hash, never the pin', async () => {
    const hash = await hashPin('4821')
    expect(hash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/)
    expect(hash).not.toContain('4821')
  })

  it('salts each record, so the same pin hashes differently every time', async () => {
    const first = await hashPin('4821')
    const second = await hashPin('4821')
    expect(first).not.toBe(second)
    expect(await verifyPin('4821', first)).toBe(true)
    expect(await verifyPin('4821', second)).toBe(true)
  })

  it('accepts only the pin that produced the hash', async () => {
    const hash = await hashPin('4821')
    expect(await verifyPin('4821', hash)).toBe(true)
    expect(await verifyPin('4822', hash)).toBe(false)
    expect(await verifyPin('', hash)).toBe(false)
    expect(await verifyPin('04821', hash)).toBe(false)
  })

  /** An unreadable or foreign record must leave the screen covered. */
  it('fails closed on records it did not write', async () => {
    for (const stored of [
      '',
      '4821',
      'scrypt$',
      'scrypt$00$00',
      'bcrypt$ab$cd',
      `scrypt$${'00'.repeat(16)}$${'00'.repeat(31)}`
    ]) {
      expect(await verifyPin('4821', stored)).toBe(false)
    }
  })

  it('treats an unset pin as unverifiable', async () => {
    expect(await verifyPin('4821', null)).toBe(false)
  })
})
