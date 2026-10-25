import { describe, expect, it } from 'vitest'
import { egressLabel, egressVerdict, proxyRule, type EgressHealth, type ProxyState } from '../src/shared/network'

const proxy: ProxyState = { kind: 'proxy', rule: 'socks5://127.0.0.1:1080' }
const direct: ProxyState = { kind: 'direct', reason: 'unconfigured' }

const verdict = (state: ProxyState, health: EgressHealth, killSwitch = true, internal = false) =>
  egressVerdict({ state, health, killSwitch, internal })

describe('kill switch', () => {
  it('lets traffic out direct when no tunnel is configured', () => {
    expect(verdict(direct, 'unknown')).toEqual({ allow: true, via: 'direct' })
    expect(verdict(direct, 'down')).toEqual({ allow: true, via: 'direct' })
  })

  it('sends traffic through a tunnel that is answering', () => {
    expect(verdict(proxy, 'up')).toEqual({ allow: true, via: 'tunnel' })
  })

  /** A probe that has not answered yet must not break every page at startup. */
  it('does not block before the first probe answers', () => {
    expect(verdict(proxy, 'unknown')).toEqual({ allow: true, via: 'tunnel' })
  })

  it('refuses page traffic when the endpoint is down', () => {
    expect(verdict(proxy, 'down')).toMatchObject({ allow: false, via: 'kill-switch' })
  })

  it('can be told to allow direct egress instead', () => {
    expect(verdict(proxy, 'down', false)).toEqual({ allow: true, via: 'tunnel' })
  })

  it('never blocks WARDEN itself', () => {
    expect(verdict(proxy, 'down', true, true)).toEqual({ allow: true, via: 'direct' })
  })
})

describe('egress label', () => {
  const configured = { mode: 'socks5' as const, host: '127.0.0.1', port: 1080, bypass: '<local>' }

  it('says which state the tunnel is in', () => {
    expect(egressLabel(configured, 'up')).toBe('tunnel socks5://127.0.0.1:1080')
    expect(egressLabel(configured, 'unknown')).toContain('checking')
    expect(egressLabel(configured, 'down')).toContain('endpoint down')
  })

  it('does not claim a tunnel it was not given', () => {
    expect(egressLabel({ ...configured, mode: 'off' })).toBe('direct egress')
    expect(egressLabel({ ...configured, port: 0 })).toBe('no endpoint configured')
  })

  it('agrees with the rule Chromium is handed', () => {
    expect(proxyRule(configured)).toEqual(proxy)
  })
})
