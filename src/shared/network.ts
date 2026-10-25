/**
 * Egress configuration: the "VPN" half of WARDEN's network story.
 *
 * WARDEN does not ship a tunnel of its own — a VPN is a subscription and an
 * endpoint, neither of which can be invented in a browser. What it can do is
 * route every session through an endpoint the operator already trusts: a
 * WireGuard/OpenVPN client exposing a local SOCKS proxy, a corporate HTTP
 * proxy, or a hosted SOCKS5 endpoint. Chromium applies it below the page, so
 * HTTP, WebSocket and DNS traffic all take the same path and WebRTC is already
 * pinned off.
 */

export type ProxyMode = 'off' | 'socks5' | 'https'

export interface ProxySettings {
  mode: ProxyMode
  host: string
  port: number
  /** Applied only to the proxy hop; cookies/trackers rules are unchanged. */
  bypass: string
}

export function normalizeProxy(input: Partial<ProxySettings>): ProxySettings {
  const mode: ProxyMode =
    input.mode === 'socks5' || input.mode === 'https' ? input.mode : 'off'
  const host = (input.host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    // A pasted endpoint usually carries its port; the port field owns that.
    .replace(/:\d+$/, '')
  const port = Number(input.port)
  return {
    mode,
    host: /^[a-z0-9.:-]{1,253}$/.test(host) ? host : '',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
    bypass: (input.bypass ?? '<local>').trim().slice(0, 300) || '<local>'
  }
}

export type ProxyState =
  | { kind: 'direct'; reason: 'disabled' | 'unconfigured' }
  | { kind: 'proxy'; rule: string }

/**
 * The rule Chromium is given. An enabled policy with no endpoint must not
 * quietly fall back to direct without the UI knowing, so it reports why.
 */
export function proxyRule(settings: ProxySettings): ProxyState {
  const clean = normalizeProxy(settings)
  if (clean.mode === 'off') return { kind: 'direct', reason: 'disabled' }
  if (!clean.host || !clean.port) return { kind: 'direct', reason: 'unconfigured' }
  const scheme = clean.mode === 'socks5' ? 'socks5' : 'https'
  return { kind: 'proxy', rule: `${scheme}://${clean.host}:${clean.port}` }
}

/** Human-readable one-liner for Policy and the new-tab footer. */
export function egressLabel(settings: ProxySettings): string {
  const state = proxyRule(settings)
  if (state.kind === 'proxy') return `tunnel ${state.rule}`
  return state.reason === 'disabled' ? 'direct egress' : 'no endpoint configured'
}
