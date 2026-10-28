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

  /**
   * The kill switch is the default: a tunnel that quietly falls back to direct
   * egress is the failure mode it exists to prevent, so leaving it unset must
   * read as on, and only an explicit false turns it off.
   */
  it('fails closed on egress unless the operator opts out', () => {
    expect(DEFAULT_SETTINGS.vpnKillSwitch).toBe(true)
    expect(sanitizeSettings({}).vpnKillSwitch).toBe(true)
    expect(sanitizeSettings({ vpnKillSwitch: 'yes' }).vpnKillSwitch).toBe(true)
    expect(sanitizeSettings({ vpnKillSwitch: false }).vpnKillSwitch).toBe(false)
  })

  /**
   * A new tab is not cloaked unless the operator asks: the default is the
   * shared session, and every tab still has its own cape to change that.
   */
  it('opens new tabs in the shared session unless cloaking is opted into', () => {
    expect(DEFAULT_SETTINGS.privateByDefault).toBe(false)
    expect(sanitizeSettings({}).privateByDefault).toBe(false)
    expect(sanitizeSettings({ privateByDefault: undefined }).privateByDefault).toBe(false)
    expect(sanitizeSettings({ privateByDefault: 'yes' }).privateByDefault).toBe(false)
    expect(sanitizeSettings({ privateByDefault: true, settingsVersion: 2 }).privateByDefault).toBe(true)
  })

  /**
   * Burn mode used to default on, so a profile saved under that default says
   * `true` whether or not the operator chose it and every new tab opened
   * cloaked. The first load at version 2 turns it off, once; the switch still
   * turns it back on.
   */
  it('turns off the burn mode an older profile inherited', () => {
    expect(DEFAULT_SETTINGS.settingsVersion).toBe(2)
    expect(sanitizeSettings({ privateByDefault: true }).privateByDefault).toBe(false)
    expect(sanitizeSettings({ privateByDefault: true, settingsVersion: 1 }).privateByDefault).toBe(false)
    expect(
      sanitizeSettings({ privateByDefault: true, settingsVersion: 1 }).settingsVersion
    ).toBe(2)
  })

  /**
   * Page downloads are allowed unless the operator turns them off: the switch
   * exists so a page cannot quietly write to disk, not to break saving files.
   */
  it('allows page downloads unless they are explicitly refused', () => {
    expect(DEFAULT_SETTINGS.allowDownloads).toBe(true)
    expect(sanitizeSettings({}).allowDownloads).toBe(true)
    expect(sanitizeSettings({ allowDownloads: undefined }).allowDownloads).toBe(true)
    expect(sanitizeSettings({ allowDownloads: 'no' }).allowDownloads).toBe(true)
    expect(sanitizeSettings({ allowDownloads: false }).allowDownloads).toBe(false)
  })

  it('still guards the other port and keeps defaults for junk input', () => {
    const sanitized = sanitizeSettings({ scryPort: 1, terminalFontSize: 900 })
    expect(sanitized.scryPort).toBe(1024)
    expect(sanitized.terminalFontSize).toBe(22)
    expect(sanitized.cookieMode).toBe('block')
  })
})
