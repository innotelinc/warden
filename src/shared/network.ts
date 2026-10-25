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

/**
 * Whether the endpoint is answering, checked without carrying any traffic.
 *
 * `unknown` is a real state: the probe has not answered yet, and treating that
 * as a failure would block every page while WARDEN is still starting.
 */
export type EgressHealth = 'unknown' | 'up' | 'down'

export type EgressVerdict =
  | { allow: true; via: 'direct' | 'tunnel' }
  | { allow: false; via: 'kill-switch'; reason: string }

/**
 * The kill switch.
 *
 * A tunnel you believe in is worse than no tunnel: if the endpoint stops
 * answering, Chromium would fall back to direct egress and the operator would
 * not notice until much later. With `vpnKillSwitch` on — the default — a
 * configured tunnel whose endpoint is down refuses page traffic outright.
 *
 * It never blocks when there is no tunnel to protect (nothing configured), and
 * it never blocks internal pages: those come from WARDEN itself.
 */
export function egressVerdict(input: {
  state: ProxyState
  health: EgressHealth
  killSwitch: boolean
  /** WARDEN's own pages and devtools: always allowed. */
  internal?: boolean
}): EgressVerdict {
  if (input.internal) return { allow: true, via: 'direct' }
  if (input.state.kind === 'direct') return { allow: true, via: 'direct' }
  if (input.health !== 'down') return { allow: true, via: 'tunnel' }
  if (!input.killSwitch) return { allow: true, via: 'tunnel' }
  return {
    allow: false,
    via: 'kill-switch',
    reason: 'The tunnel endpoint is not answering, so WARDEN is refusing to send traffic direct.'
  }
}

/** Human-readable one-liner for Policy and the new-tab footer. */
export function egressLabel(settings: ProxySettings, health: EgressHealth = 'unknown'): string {
  const state = proxyRule(settings)
  if (state.kind === 'direct') {
    return state.reason === 'disabled' ? 'direct egress' : 'no endpoint configured'
  }
  if (health === 'down') return `tunnel ${state.rule} · endpoint down`
  if (health === 'up') return `tunnel ${state.rule}`
  return `tunnel ${state.rule} · checking`
}
