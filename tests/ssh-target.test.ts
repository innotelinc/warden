import { describe, expect, it } from 'vitest'
import { normalizeSshTarget, resolveSsh } from '../src/main/terminal/terminal-service'

/**
 * The destination ends up as an argv element of `ssh`, so the validation is the
 * boundary that keeps a typed host from becoming an option or a second argument.
 */
describe('normalizeSshTarget', () => {
  it('accepts a bare host, user@host and bracketed ipv6', () => {
    expect(normalizeSshTarget('server.internal')).toBe('server.internal')
    expect(normalizeSshTarget('ops@10.0.0.5')).toBe('ops@10.0.0.5')
    expect(normalizeSshTarget('[2001:db8::1]')).toBe('[2001:db8::1]')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeSshTarget('  user@host  ')).toBe('user@host')
  })

  it('refuses anything that could be read as an option', () => {
    expect(() => normalizeSshTarget('-oProxyCommand=calc.exe')).toThrow(/dash/)
    expect(() => normalizeSshTarget('host -oProxyCommand=calc')).toThrow(/spaces/)
  })

  it('refuses shell metacharacters and paths', () => {
    for (const bad of ['host;reboot', 'host|cat', 'host&whoami', 'host`id`', 'host$(id)', 'C:/keys/id_rsa']) {
      expect(() => normalizeSshTarget(bad)).toThrow()
    }
  })

  it('refuses an empty destination', () => {
    expect(() => normalizeSshTarget('   ')).toThrow(/Enter a host/)
  })
})

describe('resolveSsh', () => {
  it('finds the platform client or reports it missing, never throws', () => {
    const path = resolveSsh()
    expect(path === null || typeof path === 'string').toBe(true)
    if (path) expect(path.toLowerCase()).toContain('ssh')
  })
})
