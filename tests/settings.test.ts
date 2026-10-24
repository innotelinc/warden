import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { sanitizeSettings } from '../src/shared/settings'

describe('sanitizeSettings', () => {
  it('keeps WARDEN\'s debug endpoint closed unless it is explicitly set', () => {
    expect(DEFAULT_SETTINGS.debugPort).toBe(0)
    expect(sanitizeSettings({}).debugPort).toBe(0)
    expect(sanitizeSettings({ debugPort: undefined }).debugPort).toBe(0)
  })

  it('accepts a usable loopback debug port', () => {
    expect(sanitizeSettings({ debugPort: 9223 }).debugPort).toBe(9223)
    expect(sanitizeSettings({ debugPort: '9333' }).debugPort).toBe(9333)
    expect(sanitizeSettings({ debugPort: 65535 }).debugPort).toBe(65535)
  })

  it('rejects ports that cannot be bound safely or are out of range', () => {
    expect(sanitizeSettings({ debugPort: 80 }).debugPort).toBe(0)
    expect(sanitizeSettings({ debugPort: 1023 }).debugPort).toBe(0)
    expect(sanitizeSettings({ debugPort: 65536 }).debugPort).toBe(0)
    expect(sanitizeSettings({ debugPort: -1 }).debugPort).toBe(0)
    expect(sanitizeSettings({ debugPort: 12.5 }).debugPort).toBe(0)
    expect(sanitizeSettings({ debugPort: 'nope' }).debugPort).toBe(0)
  })

  it('still guards the other port and keeps defaults for junk input', () => {
    const sanitized = sanitizeSettings({ scryPort: 1, terminalFontSize: 900 })
    expect(sanitized.scryPort).toBe(1024)
    expect(sanitized.terminalFontSize).toBe(22)
    expect(sanitized.cookieMode).toBe('block')
  })
})
